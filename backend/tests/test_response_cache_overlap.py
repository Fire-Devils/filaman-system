"""A notice received during a query must prevent an obsolete cache fill."""

import json

import pytest
from sqlalchemy import select

from app.api.v1.filaments import list_filament_filter_options, list_filament_types
from app.api.v1.spools import list_spool_filter_options
from app.core.cache import response_cache
from app.core.event_bus import event_bus
from app.models import Filament, Manufacturer, Spool, SpoolStatus


@pytest.mark.parametrize("endpoint", [list_filament_types, list_filament_filter_options, list_spool_filter_options])
async def test_notice_during_query_does_not_cache_obsolete_snapshot(endpoint, db_session, monkeypatch):
    manufacturer = Manufacturer(name="Cache overlap fixture")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation="Fixture", material_type="BoundaryBefore",
        diameter_mm=1.75,
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).where(SpoolStatus.key == "new"))
    db_session.add(Spool(filament_id=filament.id, status_id=status_id))
    await db_session.commit()
    response_cache.clear()
    execute = db_session.execute
    interrupted = False

    async def query_crossing_notice(*args, **kwargs):
        nonlocal interrupted
        result = await execute(*args, **kwargs)
        if not interrupted:
            interrupted = True
            # Old rows are buffered; commit the change before the query caller resumes.
            filament.material_type = "BoundaryAfter"
            await db_session.commit()
            await event_bus.publish({"event": "resync"})
        return result

    monkeypatch.setattr(db_session, "execute", query_crossing_notice)
    await endpoint(db_session, None)
    fresh = await endpoint(db_session, None)
    payload = fresh.model_dump() if hasattr(fresh, "model_dump") else fresh
    assert "BoundaryAfter" in json.dumps(payload)
    assert "BoundaryBefore" not in json.dumps(payload)
    response_cache.clear()


@pytest.fixture
async def db_engine(tmp_path):
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.models import Base

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'inventory.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


def _read_inventory_before_poll(database_url, runtime, session_cookie, channel):
    import asyncio
    from pathlib import Path

    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.api import deps
    from app.core import database, middleware, primary_socket
    from app.main import app

    async def run():
        engine = create_async_engine(database_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        database.async_session_maker = middleware.async_session_maker = deps.async_session_maker = factory
        primary_socket._runtime_dir = Path(runtime)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test",
                               cookies={"session_id": session_cookie}) as client, event_bus.run():
            async def read():
                responses = [await client.get(path) for path in (
                    "/api/v1/filaments/types", "/api/v1/filaments/filter-options", "/api/v1/spools/filter-options",
                )]
                assert all(response.status_code == 200 for response in responses)
                return [response.json() for response in responses]

            # A worker can answer a new request before its next journal poll.
            async with event_bus._exchange_lock:
                channel.send(await read())
                await asyncio.to_thread(channel.recv)
                channel.send(await read())
        await engine.dispose()

    try:
        asyncio.run(run())
    finally:
        channel.close()


async def test_authenticated_refetch_on_another_worker_is_current_before_its_next_poll(
    auth_client, db_engine, tmp_path, monkeypatch,
):
    import asyncio
    import multiprocessing

    from app.core import primary_socket

    client, csrf = auth_client
    runtime = tmp_path / "private"
    monkeypatch.setattr(primary_socket, "_runtime_dir", runtime)
    context = multiprocessing.get_context("spawn")
    local, remote = context.Pipe()
    worker = context.Process(target=_read_inventory_before_poll, args=(
        str(db_engine.url), str(runtime), client.cookies.get("session_id"), remote,
    ))
    try:
        async with event_bus.run(), event_bus.subscribe() as notices:
            worker.start()
            async with asyncio.timeout(10):
                before = await asyncio.to_thread(local.recv)
            manufacturer = await client.post("/api/v1/manufacturers", json={"name": "Boundary maker"},
                                             headers={"X-CSRF-Token": csrf})
            assert manufacturer.status_code == 201, manufacturer.text
            filament = await client.post("/api/v1/filaments", json={
                "manufacturer_id": manufacturer.json()["id"], "designation": "Fixture",
                "material_type": "BOUNDARY", "diameter_mm": 1.75,
            }, headers={"X-CSRF-Token": csrf})
            assert filament.status_code == 201, filament.text
            spool = await client.post("/api/v1/spools", json={"filament_id": filament.json()["id"]},
                                      headers={"X-CSRF-Token": csrf})
            assert spool.status_code == 201, spool.text
            events = [json.loads(await anext(notices))["event"] for _ in range(3)]
            assert events == ["manufacturers_changed", "filaments_changed", "spools_changed"]
            local.send("refetch")
            async with asyncio.timeout(10):
                after = await asyncio.to_thread(local.recv)
            assert "BOUNDARY" not in json.dumps(before)
            assert "BOUNDARY" in after[0]
            assert "BOUNDARY" in after[1]["types"]
            assert any("BOUNDARY" in scope["materials"] for scope in after[2]["by_status"].values())
        await asyncio.to_thread(worker.join, 5)
        assert worker.exitcode == 0
    finally:
        if worker.pid is not None:
            if worker.is_alive():
                worker.terminate()
            worker.join(5)
        local.close()
        remote.close()


async def test_cancelled_tag_resolution_publishes_all_committed_changes(db_session, tmp_path, monkeypatch):
    import asyncio

    from app.api.v1.filaments import (
        ResolveFilamentFromTagRequest,
        resolve_filament_from_tag,
    )
    from app.core import primary_socket

    monkeypatch.setattr(primary_socket, "_runtime_dir", tmp_path / "private")
    async with event_bus.run(), event_bus.subscribe() as notices:
        await list_filament_types(db_session, None)
        request = asyncio.create_task(resolve_filament_from_tag(
            ResolveFilamentFromTagRequest(brand="Cancel boundary", type="BOUNDARY"), db_session,
        ))
        try:
            assert json.loads(await anext(notices))["event"] == "manufacturers_changed"
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert (await db_session.scalars(select(Filament.material_type))).all() == ["BOUNDARY"]
            assert json.loads(await asyncio.wait_for(anext(notices), 1))["event"] == "filaments_changed"
            assert "BOUNDARY" in await list_filament_types(db_session, None)
        finally:
            if not request.done():
                request.cancel()
            await asyncio.gather(request, return_exceptions=True)
