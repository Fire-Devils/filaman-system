"""Successful measurements persist, and relative changes use the current balance."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1.schemas_spool import SpoolUpdate
from app.api.v1.spools import update_spool
from app.models import Base, Spool, SpoolEvent
from app.services.spool_service import SpoolService
from tests.test_spool_service import _create_test_spool


@pytest.fixture
async def db_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'balances.db'}")
    async with engine.begin() as connection:
        await connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        await connection.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.mark.parametrize("remaining", [None, 123.0])
async def test_measurement_without_tare_persists_after_request_session_closes(
    auth_client, db_session, db_engine, remaining,
):
    client, csrf = auth_client
    spool = await _create_test_spool(
        db_session, remaining_weight_g=remaining, empty_spool_weight_g=None,
        filament_default_spool_weight_g=None,
    )
    spool_id = spool.id
    response = await client.post(
        f"/api/v1/spools/{spool_id}/measurements",
        json={"measured_weight_g": 500.0, "note": "Unknown tare fixture"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200, response.text
    event_id = response.json()["id"]
    await db_session.close()

    async with async_sessionmaker(db_engine)() as fresh:
        event = await fresh.get(SpoolEvent, event_id)
        assert event is not None
        assert event.spool_id == spool_id
        assert event.event_type == "measurement"
        assert event.measured_weight_g == 500.0
        assert event.meta == {"tara_missing": True}
        assert event.note == "Unknown tare fixture"
        assert event.source == "ui" and event.user_id is not None
        assert (await fresh.get(Spool, spool_id)).remaining_weight_g == remaining


@pytest.mark.parametrize("timing", ["stale-read", "overlapping-writes"])
@pytest.mark.parametrize(("first_operation", "second_operation"), [
    ("consume", "adjust"), ("adjust", "consume"), ("adjust", "adjust"),
    ("consume", "tare"), ("tare", "adjust"),
])
async def test_relative_changes_preserve_both_balances_across_sessions(
    db_session, db_engine, monkeypatch, timing, first_operation, second_operation,
):
    spool = await _create_test_spool(
        db_session, remaining_weight_g=100.0, empty_spool_weight_g=250.0, status_key="opened",
    )
    spool_id = spool.id
    sessions = async_sessionmaker(db_engine, expire_on_commit=False)
    now = datetime.now(UTC)

    async def change(db, current, operation, grams, at):
        service = SpoolService(db)
        if operation == "consume":
            return await service.record_consumption(current, grams, at, source_event_key=f"fixture:{grams}")
        if operation == "adjust":
            return await service.record_adjustment(current, "relative", at, delta_weight_g=-grams)
        return await update_spool(current.id, SpoolUpdate(empty_spool_weight_g=250.0 + grams), db, None)

    async with sessions() as first, sessions() as second:
        first_spool = await SpoolService(first).get_spool(spool_id)
        second_spool = await SpoolService(second).get_spool(spool_id)
        assert first_spool.remaining_weight_g == second_spool.remaining_weight_g == 100.0
        if timing == "stale-read":
            await change(first, first_spool, first_operation, 10.0, now)
            await change(second, second_spool, second_operation, 5.0, now + timedelta(seconds=1))
        else:
            first_ready = asyncio.Event()
            second_started = asyncio.Event()
            commit = first.commit

            async def commit_after_second_starts():
                first_ready.set()
                await second_started.wait()
                await commit()

            monkeypatch.setattr(first, "commit", commit_after_second_starts)

            async def change_second():
                await first_ready.wait()
                second_started.set()
                await change(second, second_spool, second_operation, 5.0, now + timedelta(seconds=1))

            await asyncio.wait_for(asyncio.gather(
                change(first, first_spool, first_operation, 10.0, now), change_second(),
            ), timeout=5)

    async with sessions() as fresh:
        assert (await fresh.get(Spool, spool_id)).remaining_weight_g == 85.0
        events = list(await fresh.scalars(select(SpoolEvent).where(SpoolEvent.spool_id == spool_id)))
        assert len(events) == 2
        assert sorted(event.delta_weight_g for event in events) == [-10.0, -5.0]


@pytest.mark.parametrize("operation", ["measurement", "absolute"])
async def test_gross_weight_uses_tare_committed_after_spool_load(db_session, db_engine, operation):
    spool = await _create_test_spool(
        db_session, remaining_weight_g=100.0, empty_spool_weight_g=250.0, status_key="opened",
    )
    sessions = async_sessionmaker(db_engine, expire_on_commit=False)
    async with sessions() as weighing, sessions() as editing:
        service = SpoolService(weighing)
        current = await service.get_spool(spool.id)
        update = SpoolUpdate(empty_spool_weight_g=260.0, spool_core_weight_g=5.0)
        await update_spool(spool.id, update, editing, None)
        if operation == "measurement":
            await service.record_measurement(current, 365.0, datetime.now(UTC))
        else:
            await service.record_adjustment(current, "absolute", datetime.now(UTC), measured_weight_g=365.0)

    async with sessions() as fresh:
        stored = await fresh.get(Spool, spool.id)
        assert stored.empty_spool_weight_g == 260.0
        assert stored.remaining_weight_g == 100.0
