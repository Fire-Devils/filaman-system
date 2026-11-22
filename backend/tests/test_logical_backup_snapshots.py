"""Logical backups keep one snapshot and distinguish full restores."""

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.v1 import system
from app.models import Base, Filament, InstalledPlugin, Manufacturer, User


@pytest.mark.parametrize("marker", ["exported", "legacy", "complete", "inventory_with_core_tables"])
async def test_inventory_json_cannot_replace_accounts(
    auth_client, db_engine, tmp_path, monkeypatch, marker
):
    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    client, csrf = auth_client
    exported = await client.get("/api/v1/admin/system/backup/export-inventory")
    assert exported.status_code == 200
    payload = exported.json()
    if marker == "legacy":
        payload["metadata"].pop("kind", None)
    elif marker == "complete":
        payload["metadata"]["kind"] = "complete"
    elif marker == "inventory_with_core_tables":
        payload["metadata"]["kind"] = "inventory"
        payload["data"].update(users=[], roles=[], permissions=[], spool_statuses=[])

    async with AsyncSession(db_engine) as fresh:
        users = await fresh.scalar(select(func.count(User.id)))
    assert users
    response = await client.post(
        "/api/v1/admin/system/backup/import",
        files={"file": ("inventory.json", json.dumps(payload), "application/json")},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 422, response.text
    async with AsyncSession(db_engine) as fresh:
        assert await fresh.scalar(select(func.count(User.id))) == users
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("operation", ["complete", "inventory", "automatic"])
async def test_export_keeps_snapshot_across_table_reads(tmp_path, monkeypatch, operation):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stock.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("PRAGMA journal_mode=WAL"))
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("CREATE TABLE alembic_version (version_num TEXT)"))
        original_stream = AsyncSession.stream

        async def stream_with_concurrent_write(db, statement):
            entity = statement.column_descriptions[0]["entity"]
            if entity is InstalledPlugin:
                async with AsyncSession(engine) as writer:
                    writer.add(InstalledPlugin(
                        plugin_key="during-export", name="New plugin", version="1", installed_by=1
                    ))
                    await writer.commit()
            if entity is Filament:
                async with AsyncSession(engine) as writer:
                    maker = Manufacturer(name="New brand")
                    writer.add(maker)
                    await writer.flush()
                    writer.add(Filament(
                        manufacturer_id=maker.id, designation="New PLA", material_type="PLA", diameter_mm=1.75
                    ))
                    await writer.commit()
            return await original_stream(db, statement)

        monkeypatch.setattr(AsyncSession, "stream", stream_with_concurrent_write)
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        principal = SimpleNamespace(user_id=1, is_superadmin=True)
        async with AsyncSession(engine) as caller:
            if operation == "automatic":
                path = await system._create_auto_backup(caller)
                records = [json.loads(line) for line in path.read_text().splitlines()]
                assert not any(record.get("table") == "filaments" for record in records)
            else:
                route = system.export_backup if operation == "complete" else system.export_inventory_backup
                response = await route(caller, principal, format="json")
                try:
                    payload = json.loads(response.path.read_text())
                finally:
                    response.path.unlink()
                assert not payload["data"]["filaments"]
                if operation == "complete":
                    assert not payload["metadata"]["plugins"]
                    assert not payload["data"]["installed_plugins"]
                assert payload["metadata"]["kind"] == operation
        async with AsyncSession(engine) as fresh:
            assert await fresh.scalar(select(func.count(Filament.id))) == 1
    finally:
        await engine.dispose()


async def test_export_leaves_callers_pending_transaction_open(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stock.db'}")
    try:
        async with engine.begin() as setup:
            await setup.execute(text("PRAGMA journal_mode=WAL"))
            await setup.run_sync(Base.metadata.create_all)
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        async with engine.connect() as connection, AsyncSession(connection) as caller:
            caller.add(Manufacturer(name="Uncommitted"))
            await caller.flush()
            snapshot = await system._create_auto_backup(caller)
            records = [json.loads(line) for line in snapshot.read_text().splitlines()]
            assert not any(record.get("table") == "manufacturers" for record in records)
            assert await caller.scalar(select(Manufacturer.name)) == "Uncommitted"
            await caller.rollback()
        async with AsyncSession(engine) as fresh:
            assert await fresh.scalar(select(Manufacturer.name)) is None
    finally:
        await engine.dispose()
