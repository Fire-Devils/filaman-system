import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

from app.models import SpoolEvent
from app.services.spool_service import SpoolService
from tests.test_devices import (
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _get_status,
)
from tests.test_rbac import viewer_auth_client, viewer_user  # noqa: F401

_counter = 0


async def _spool(db, status_key="new", material="PETG", **kwargs):
    global _counter
    _counter += 1
    manufacturer = await _create_manufacturer(db, name=f"M-{_counter}")
    filament = await _create_filament(db, manufacturer.id, material_type=material)
    status = await _get_status(db, status_key)
    return await _create_spool(db, filament.id, status.id, **kwargs)


def _h(csrf):
    return {"X-CSRF-Token": csrf}


class TestOpenedAtOnCreate:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("status_key,expect", [("active", True), ("new", False)])
    async def test_create_sets_opened_at_for_opening_status(
        self, auth_client, db_session, status_key, expect
    ):
        client, csrf = auth_client
        manufacturer = await _create_manufacturer(db_session, name=f"C-{status_key}")
        filament = await _create_filament(db_session, manufacturer.id, material_type="PETG")
        status_obj = await _get_status(db_session, status_key)
        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": filament.id, "status_id": status_obj.id},
            headers=_h(csrf),
        )
        assert response.status_code == 201, response.text
        assert (response.json()["opened_at"] is not None) is expect


class TestAutoOpenedAt:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("target", ["opened", "active", "drying"])
    async def test_status_endpoint_sets_opened_at_from_new(
        self, auth_client, db_session, target
    ):
        client, csrf = auth_client
        spool = await _spool(db_session, "new")
        response = await client.post(
            f"/api/v1/spools/{spool.id}/status",
            json={"status": target},
            headers=_h(csrf),
        )
        assert response.status_code == 200
        await db_session.refresh(spool)
        assert spool.opened_at is not None

    @pytest.mark.asyncio
    async def test_existing_opened_at_is_not_overwritten(self, db_session):
        original = datetime(2026, 1, 1, tzinfo=timezone.utc)
        spool = await _spool(db_session, "new", opened_at=original)
        service = SpoolService(db_session)
        loaded = await service.get_spool(spool.id)
        await service.change_status(loaded, "opened", datetime.now(timezone.utc))
        await db_session.refresh(spool)
        assert spool.opened_at == original

    @pytest.mark.asyncio
    async def test_other_transitions_do_not_set_opened_at(self, db_session):
        spool = await _spool(db_session, "opened")
        service = SpoolService(db_session)
        loaded = await service.get_spool(spool.id)
        await service.change_status(loaded, "active", datetime.now(timezone.utc))
        await db_session.refresh(spool)
        assert spool.opened_at is None

    @pytest.mark.asyncio
    async def test_bulk_status_sets_opened_at(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool(db_session, "new")
        response = await client.post(
            "/api/v1/spools/bulk/status",
            json={"spool_ids": [spool.id], "status": "active"},
            headers=_h(csrf),
        )
        assert response.status_code == 200
        await db_session.refresh(spool)
        assert spool.opened_at is not None

    @pytest.mark.asyncio
    async def test_weight_change_auto_open_sets_opened_at(self, db_session):
        spool = await _spool(db_session, "new")
        service = SpoolService(db_session)
        loaded = await service.get_spool(spool.id)
        await service._handle_auto_opened(loaded, datetime.now(timezone.utc))
        assert loaded.opened_at is not None

    @pytest.mark.asyncio
    async def test_patch_status_id_sets_opened_at(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool(db_session, "new")
        active = await _get_status(db_session, "active")
        response = await client.patch(
            f"/api/v1/spools/{spool.id}",
            json={"status_id": active.id},
            headers=_h(csrf),
        )
        assert response.status_code == 200
        assert response.json()["opened_at"] is not None


class TestDryEndpoints:
    @pytest.mark.asyncio
    async def test_dry_sets_last_dried_at_and_event(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool(db_session, "opened")
        response = await client.post(
            f"/api/v1/spools/{spool.id}/dry",
            json={
                "temp_c": 55,
                "duration_hours": 6,
                "note": "dryer",
                "dried_at": "2026-11-01T10:00:00Z",
            },
            headers=_h(csrf),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["event_type"] == "dried"
        assert body["meta"] == {"temp_c": 55.0, "duration_hours": 6.0}
        assert body["note"] == "dryer"
        await db_session.refresh(spool)
        assert spool.last_dried_at == datetime(2026, 11, 1, 10, tzinfo=timezone.utc)

    @pytest.mark.asyncio
    async def test_dry_without_values_uses_now(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool(db_session, "opened")
        response = await client.post(
            f"/api/v1/spools/{spool.id}/dry", json={}, headers=_h(csrf)
        )
        assert response.status_code == 200
        assert response.json()["meta"] is None
        await db_session.refresh(spool)
        assert abs(datetime.now(timezone.utc) - spool.last_dried_at) < timedelta(
            minutes=1
        )

    @pytest.mark.asyncio
    async def test_back_dated_dry_keeps_newer_last_dried_at(
        self, auth_client, db_session
    ):
        client, csrf = auth_client
        spool = await _spool(db_session, "opened")
        for when in ("2026-11-10T00:00:00Z", "2026-11-01T00:00:00Z"):
            await client.post(
                f"/api/v1/spools/{spool.id}/dry",
                json={"dried_at": when},
                headers=_h(csrf),
            )
        await db_session.refresh(spool)
        assert spool.last_dried_at == datetime(2026, 11, 10, tzinfo=timezone.utc)

    @pytest.mark.asyncio
    async def test_dry_unknown_spool_404(self, auth_client):
        client, csrf = auth_client
        response = await client.post(
            "/api/v1/spools/99999/dry", json={}, headers=_h(csrf)
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_dry_rejects_invalid_values(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool(db_session, "opened")
        response = await client.post(
            f"/api/v1/spools/{spool.id}/dry",
            json={"duration_hours": -1},
            headers=_h(csrf),
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_bulk_dry(self, auth_client, db_session):
        client, csrf = auth_client
        a = await _spool(db_session, "opened", material="PA")
        b = await _spool(db_session, "active", material="TPU")
        response = await client.post(
            "/api/v1/spools/dry",
            json={"spool_ids": [a.id, b.id, 99999], "temp_c": 50},
            headers=_h(csrf),
        )
        assert response.status_code == 200
        assert response.json() == {"success": True, "count": 2}
        for spool in (a, b):
            await db_session.refresh(spool)
            assert spool.last_dried_at is not None
        events = (
            (
                await db_session.execute(
                    select(SpoolEvent).where(SpoolEvent.event_type == "dried")
                )
            )
            .scalars()
            .all()
        )
        assert len(events) == 2
        assert all(e.meta == {"temp_c": 50.0} for e in events)

    @pytest.mark.asyncio
    async def test_bulk_dry_requires_ids(self, auth_client):
        client, csrf = auth_client
        response = await client.post(
            "/api/v1/spools/dry", json={"spool_ids": []}, headers=_h(csrf)
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_viewer_cannot_dry(self, viewer_auth_client, db_session):  # noqa: F811
        client, csrf = viewer_auth_client
        spool = await _spool(db_session, "opened")
        single = await client.post(
            f"/api/v1/spools/{spool.id}/dry", json={}, headers=_h(csrf)
        )
        bulk = await client.post(
            "/api/v1/spools/dry", json={"spool_ids": [spool.id]}, headers=_h(csrf)
        )
        assert single.status_code == 403
        assert bulk.status_code == 403
        await db_session.refresh(spool)
        assert spool.last_dried_at is None


class TestApiPayloads:
    @pytest.mark.asyncio
    async def test_detail_and_list_include_moisture(self, auth_client, db_session):
        client, _ = auth_client
        opened = datetime.now(timezone.utc) - timedelta(days=20)
        spool = await _spool(db_session, "opened", material="PA", opened_at=opened)

        detail = (await client.get(f"/api/v1/spools/{spool.id}")).json()
        assert detail["opened_at"] is not None
        assert detail["last_dried_at"] is None
        assert detail["moisture"]["level"] == "wet"
        assert detail["moisture"]["days_exposed"] == 20
        assert detail["moisture"]["sensitivity"] == "high"

        listing = (await client.get("/api/v1/spools")).json()["items"]
        assert listing[0]["moisture"]["level"] == "wet"

    @pytest.mark.asyncio
    async def test_moisture_is_null_for_new_spool(self, auth_client, db_session):
        client, _ = auth_client
        spool = await _spool(db_session, "new", material="PA")
        body = (await client.get(f"/api/v1/spools/{spool.id}")).json()
        assert body["moisture"] is None

    @pytest.mark.asyncio
    async def test_dashboard_moisture_attention(self, auth_client, db_session):
        client, _ = auth_client
        now = datetime.now(timezone.utc)
        wet = await _spool(
            db_session, "opened", material="PA", opened_at=now - timedelta(days=30)
        )
        damp = await _spool(
            db_session, "active", material="PA", opened_at=now - timedelta(days=10)
        )
        await _spool(
            db_session, "active", material="PA", opened_at=now - timedelta(days=1)
        )
        await _spool(
            db_session, "archived", material="PA", opened_at=now - timedelta(days=99)
        )
        await _spool(db_session, "new", material="PA")
        await _spool(
            db_session, "opened", material="PLA", opened_at=now - timedelta(days=60)
        )

        items = (await client.get("/api/v1/dashboard/stats")).json()[
            "moisture_attention"
        ]
        assert [i["spool_id"] for i in items] == [wet.id, damp.id]
        assert items[0]["level"] == "wet"
        assert items[1]["level"] == "damp"
        assert items[0]["filament_type"] == "PA"

    @pytest.mark.asyncio
    async def test_dashboard_moisture_attention_limit(self, auth_client, db_session):
        client, _ = auth_client
        manufacturer = await _create_manufacturer(db_session, name="Bulk M")
        filament = await _create_filament(
            db_session, manufacturer.id, material_type="PA"
        )
        status = await _get_status(db_session, "opened")
        old = datetime.now(timezone.utc) - timedelta(days=100)
        for _ in range(25):
            await _create_spool(db_session, filament.id, status.id, opened_at=old)
        items = (await client.get("/api/v1/dashboard/stats")).json()[
            "moisture_attention"
        ]
        assert len(items) == 20


MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "c3e9a71f2d85_add_spool_moisture_tracking.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "spool_moisture_migration", MIGRATION_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_adds_columns_and_backfills_opened_at():
    migration = _load_migration()
    assert migration.down_revision == "b8f2d6a41c93"
    ts_col = lambda name: sa.Column(name, sa.DateTime(timezone=True), nullable=False)  # noqa: E731
    metadata = sa.MetaData()
    statuses = sa.Table(
        "spool_statuses",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("key", sa.String, nullable=False),
        sa.Column("label", sa.String, nullable=False),
        ts_col("created_at"),
        ts_col("updated_at"),
    )
    spools = sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        ts_col("created_at"),
        ts_col("updated_at"),
    )
    events = sa.Table(
        "spool_events",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("spool_id", sa.Integer, nullable=False),
        sa.Column("event_type", sa.String, nullable=False),
        ts_col("event_at"),
        sa.Column("to_status_id", sa.Integer),
        ts_col("created_at"),
    )
    engine = sa.create_engine("sqlite://")
    metadata.create_all(engine)
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    first = datetime(2026, 2, 1, 8, tzinfo=timezone.utc)
    later = datetime(2026, 3, 1, 8, tzinfo=timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            statuses.insert(),
            [
                {"id": i, "key": k, "label": k, "created_at": ts, "updated_at": ts}
                for i, k in enumerate(["new", "opened", "active", "empty"], start=1)
            ],
        )
        conn.execute(
            spools.insert(),
            [{"id": i, "created_at": ts, "updated_at": ts} for i in (1, 2, 3)],
        )
        rows = [
            # spool 1: active later, opened first -> the first one wins
            (1, "active", later, 3),
            (1, "opened", first, 2),
            (1, "new", ts, 1),
            # spool 2: only non-opening events; spool 3: no events at all
            (2, "empty", later, 4),
        ]
        conn.execute(
            events.insert(),
            [
                {
                    "spool_id": s,
                    "event_type": t,
                    "event_at": at,
                    "to_status_id": st,
                    "created_at": ts,
                }
                for s, t, at, st in rows
            ],
        )

    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()

    with engine.connect() as conn:
        columns = {c["name"] for c in sa.inspect(conn).get_columns("spools")}
        assert {"opened_at", "last_dried_at"} <= columns
        result = dict(conn.execute(sa.text("SELECT id, opened_at FROM spools")).all())
        assert str(result[1]).startswith("2026-02-01 08:00")
        assert result[2] is None
        assert result[3] is None
        count = conn.execute(
            sa.text("SELECT COUNT(*) FROM spools WHERE last_dried_at IS NOT NULL")
        ).scalar()
        assert count == 0
