import importlib.util
import io
from datetime import datetime, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.api.v1 import print_jobs as print_jobs_api
from app.core.security import generate_token_secret, hash_token
from app.models import (
    Filament,
    Manufacturer,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    PrintJob,
    Role,
    Spool,
    SpoolEvent,
    SpoolStatus,
    User,
    UserRole,
    UserSession,
)
from app.services import print_job_service as svc
from PIL import Image
from sqlalchemy import select

MIGRATION = Path(__file__).parents[1] / "alembic" / "versions" / "c3e9a17d5f42_add_print_jobs.py"


async def _spool(
    db,
    *,
    remaining=800.0,
    purchase_price=None,
    initial_total=None,
    empty=None,
    filament_price=None,
    raw_weight=None,
):
    mfr = Manufacturer(name=f"Mfr-{datetime.now(timezone.utc).timestamp()}")
    db.add(mfr)
    await db.flush()
    filament = Filament(
        manufacturer_id=mfr.id,
        designation="PLA Basic",
        material_type="PLA",
        diameter_mm=1.75,
        price=filament_price,
        raw_material_weight_g=raw_weight,
    )
    db.add(filament)
    await db.flush()
    status = await db.scalar(select(SpoolStatus).where(SpoolStatus.key == "new"))
    spool = Spool(
        filament_id=filament.id,
        status_id=status.id,
        remaining_weight_g=remaining,
        purchase_price=purchase_price,
        initial_total_weight_g=initial_total,
        empty_spool_weight_g=empty,
    )
    db.add(spool)
    await db.commit()
    return await svc.SpoolService(db).get_spool(spool.id)


async def _job(db, usages, **kwargs):
    job = PrintJob(name="Benchy", status="pending", source="manual", **kwargs)
    job.usages = await svc.build_usages(db, kwargs.get("printer_id"), usages)
    db.add(job)
    await db.commit()
    return await svc.get_job(db, job.id)


async def _login_as_role(client, db, role_key):
    user = User(
        email=f"{role_key}@example.com", password_hash="x", display_name=role_key, is_superadmin=False, is_active=True
    )
    db.add(user)
    await db.commit()
    role = await db.scalar(select(Role).where(Role.key == role_key))
    db.add(UserRole(user_id=user.id, role_id=role.id))
    secret = generate_token_secret()
    session = UserSession(user_id=user.id, session_token_hash=hash_token(secret))
    db.add(session)
    await db.commit()
    client.cookies.set("session_id", f"sess.{session.id}.{secret}")
    client.cookies.set("csrf_token", "csrf-test")
    client.headers["X-CSRF-Token"] = "csrf-test"


# ---------------------------------------------------------------- cost


def test_price_per_gram_prefers_spool_price_over_net_start_weight():
    spool = Spool(purchase_price=20.0, initial_total_weight_g=1200.0, empty_spool_weight_g=200.0)
    spool.filament = Filament(price=99.0, raw_material_weight_g=1000.0)
    assert svc.price_per_gram(spool) == pytest.approx(0.02)
    assert svc.compute_cost(spool, 50) == pytest.approx(1.0)


def test_price_per_gram_falls_back_to_filament_price():
    spool = Spool(purchase_price=None)
    spool.filament = Filament(price=25.0, raw_material_weight_g=1000.0)
    assert svc.price_per_gram(spool) == pytest.approx(0.025)


def test_price_per_gram_uses_filament_weight_when_spool_has_no_start_weight():
    spool = Spool(purchase_price=18.0)
    spool.filament = Filament(price=None, raw_material_weight_g=900.0)
    assert svc.price_per_gram(spool) == pytest.approx(0.02)


def test_no_price_means_no_cost():
    spool = Spool()
    spool.filament = Filament(price=None, raw_material_weight_g=1000.0)
    assert svc.price_per_gram(spool) is None
    assert svc.compute_cost(spool, 10) is None
    spool.filament = Filament(price=25.0, raw_material_weight_g=None)
    assert svc.compute_cost(spool, 10) is None


# ---------------------------------------------------------------- service


@pytest.mark.asyncio
async def test_complete_books_once_with_events_and_cost(db_session):
    spool = await _spool(db_session, purchase_price=20.0, initial_total=1200, empty=200)
    job = await _job(db_session, [svc.UsageInput(spool_id=spool.id, planned_weight_g=40)])
    usage_id = job.usages[0].id

    done = await svc.complete_job(db_session, job, {usage_id: 50.0})

    assert done.status == "completed"
    usage = done.usages[0]
    assert usage.used_weight_g == 50.0
    assert usage.cost == pytest.approx(1.0)
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == pytest.approx(750.0)
    event = await db_session.get(SpoolEvent, usage.spool_event_id)
    assert event.source == "print_job"
    assert event.delta_weight_g == -50.0
    assert event.meta["print_job_id"] == job.id

    with pytest.raises(svc.PrintJobStateError):
        await svc.complete_job(db_session, done)
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == pytest.approx(750.0)
    events = (await db_session.scalars(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id, SpoolEvent.event_type == "print_consumption"))).all()
    assert len(events) == 1


@pytest.mark.asyncio
async def test_two_jobs_on_one_spool_do_not_merge_events(db_session):
    spool = await _spool(db_session)
    for _ in range(2):
        job = await _job(db_session, [svc.UsageInput(spool_id=spool.id, planned_weight_g=10)])
        await svc.complete_job(db_session, job)
    events = (await db_session.scalars(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id, SpoolEvent.event_type == "print_consumption"))).all()
    assert len(events) == 2
    assert len({e.meta["print_job_id"] for e in events}) == 2


@pytest.mark.asyncio
async def test_failed_job_still_consumes(db_session):
    spool = await _spool(db_session, filament_price=30.0, raw_weight=1000.0)
    job = await _job(db_session, [svc.UsageInput(spool_id=spool.id, planned_weight_g=100)])

    done = await svc.complete_job(db_session, job, success=False)

    assert done.status == "failed"
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == pytest.approx(700.0)
    assert done.usages[0].cost == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_cancel_books_nothing_and_blocks_completion(db_session):
    spool = await _spool(db_session)
    job = await _job(db_session, [svc.UsageInput(spool_id=spool.id, planned_weight_g=100)])

    cancelled = await svc.cancel_job(db_session, job)

    assert cancelled.status == "cancelled"
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == 800.0
    assert (await db_session.scalars(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id, SpoolEvent.event_type == "print_consumption"))).all() == []
    with pytest.raises(svc.PrintJobStateError):
        await svc.complete_job(db_session, cancelled)


@pytest.mark.asyncio
async def test_unknown_usage_override_is_rejected_without_booking(db_session):
    spool = await _spool(db_session)
    job = await _job(db_session, [svc.UsageInput(spool_id=spool.id, planned_weight_g=10)])
    with pytest.raises(svc.PrintJobValidationError):
        await svc.complete_job(db_session, job, {999999: 5.0})
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == 800.0


@pytest.mark.asyncio
async def test_resolve_spool_for_slot(db_session):
    spool = await _spool(db_session)
    printer = Printer(name="P1", driver_key="manual")
    db_session.add(printer)
    await db_session.flush()
    slot = PrinterSlot(printer_id=printer.id, slot_no=2)
    empty_slot = PrinterSlot(printer_id=printer.id, slot_no=3)
    db_session.add_all([slot, empty_slot])
    await db_session.flush()
    db_session.add(PrinterSlotAssignment(slot_id=slot.id, spool_id=spool.id, present=True))
    await db_session.commit()

    assert (await svc.resolve_spool_for_slot(db_session, printer.id, 2)).id == spool.id
    assert await svc.resolve_spool_for_slot(db_session, printer.id, 3) is None
    assert await svc.resolve_spool_for_slot(db_session, printer.id, 9) is None

    usages = await svc.build_usages(
        db_session, printer.id, [svc.UsageInput(slot_no=2, planned_weight_g=12)]
    )
    assert usages[0].spool_id == spool.id and usages[0].slot_no == 2
    with pytest.raises(svc.PrintJobValidationError):
        await svc.build_usages(db_session, None, [svc.UsageInput(slot_no=2, planned_weight_g=1)])


# ---------------------------------------------------------------- API


@pytest.mark.asyncio
async def test_api_create_complete_and_project_totals(auth_client, db_session):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    spool = await _spool(db_session, purchase_price=20.0, initial_total=1200, empty=200)

    project = (await client.post("/api/v1/print-projects", json={"name": "Vase"}, headers=headers)).json()
    created = await client.post(
        "/api/v1/print-jobs",
        json={
            "name": "Vase v1",
            "project_id": project["id"],
            "usages": [{"spool_id": spool.id, "planned_weight_g": 40}],
        },
        headers=headers,
    )
    assert created.status_code == 201
    job = created.json()
    assert job["status"] == "pending"
    assert job["project_name"] == "Vase"

    # pending jobs do not count in the project sums
    listing = (await client.get("/api/v1/print-projects")).json()
    assert listing[0]["job_count"] == 0 and listing[0]["total_weight_g"] == 0

    done = await client.post(
        f"/api/v1/print-jobs/{job['id']}/complete",
        json={"success": True, "usages": [{"usage_id": job["usages"][0]["id"], "used_weight_g": 50}]},
        headers=headers,
    )
    assert done.status_code == 200, done.text
    assert done.json()["total_cost"] == pytest.approx(1.0)

    again = await client.post(f"/api/v1/print-jobs/{job['id']}/complete", json={}, headers=headers)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "print_job_not_pending"

    # a cancelled and a failed job: only the failed one is summed
    await client.post(
        "/api/v1/print-jobs",
        json={"name": "Fail", "project_id": project["id"], "complete": True, "success": False,
              "usages": [{"spool_id": spool.id, "planned_weight_g": 10}]},
        headers=headers,
    )
    cancelled = (await client.post(
        "/api/v1/print-jobs",
        json={"name": "Nope", "project_id": project["id"], "usages": [{"spool_id": spool.id, "planned_weight_g": 500}]},
        headers=headers,
    )).json()
    assert (await client.post(f"/api/v1/print-jobs/{cancelled['id']}/cancel", headers=headers)).status_code == 200

    listing = (await client.get("/api/v1/print-projects")).json()
    assert listing[0]["job_count"] == 2
    assert listing[0]["total_weight_g"] == pytest.approx(60)
    assert listing[0]["total_cost"] == pytest.approx(1.2)

    filtered = (await client.get(f"/api/v1/print-jobs?project_id={project['id']}&status=failed")).json()
    assert [j["name"] for j in filtered["items"]] == ["Fail"]
    by_spool = (await client.get(f"/api/v1/spools/{spool.id}/print-jobs")).json()
    assert by_spool["total"] == 3


@pytest.mark.asyncio
async def test_api_slot_usage_resolves_via_printer(auth_client, db_session):
    client, csrf = auth_client
    spool = await _spool(db_session)
    printer = Printer(name="P2", driver_key="manual")
    db_session.add(printer)
    await db_session.flush()
    slot = PrinterSlot(printer_id=printer.id, slot_no=1)
    db_session.add(slot)
    await db_session.flush()
    db_session.add(PrinterSlotAssignment(slot_id=slot.id, spool_id=spool.id, present=True))
    await db_session.commit()

    resp = await client.post(
        "/api/v1/print-jobs",
        json={"name": "Slot", "printer_id": printer.id, "source": "slicer_link",
              "usages": [{"slot_no": 1, "planned_weight_g": 5}]},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 201
    assert resp.json()["usages"][0]["spool_id"] == spool.id
    assert resp.json()["source"] == "slicer_link"


@pytest.mark.asyncio
async def test_api_delete_rules_and_project_delete_keeps_jobs(auth_client, db_session):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    spool = await _spool(db_session)
    project = (await client.post("/api/v1/print-projects", json={"name": "P"}, headers=headers)).json()
    job = (await client.post(
        "/api/v1/print-jobs",
        json={"name": "J", "project_id": project["id"], "complete": True,
              "usages": [{"spool_id": spool.id, "planned_weight_g": 5}]},
        headers=headers,
    )).json()

    blocked = await client.delete(f"/api/v1/print-jobs/{job['id']}", headers=headers)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "print_job_has_bookings"

    assert (await client.delete(f"/api/v1/print-projects/{project['id']}", headers=headers)).status_code == 204
    kept = (await client.get(f"/api/v1/print-jobs/{job['id']}")).json()
    assert kept["project_id"] is None

    assert (await client.delete(f"/api/v1/print-jobs/{job['id']}?force=true", headers=headers)).status_code == 204
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == pytest.approx(795.0)


@pytest.mark.asyncio
async def test_api_photo_upload(auth_client, db_session, tmp_path, monkeypatch):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    monkeypatch.setattr(print_jobs_api, "PRINT_JOB_PHOTO_DIR", tmp_path)
    job = (await client.post("/api/v1/print-jobs", json={"name": "Foto", "usages": []}, headers=headers)).json()

    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buffer, "PNG")
    ok = await client.post(
        f"/api/v1/print-jobs/{job['id']}/photo", files={"file": ("a.png", buffer.getvalue(), "image/png")}, headers=headers
    )
    assert ok.status_code == 200 and ok.json()["has_photo"] is True
    got = await client.get(f"/api/v1/print-jobs/{job['id']}/photo")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"

    bad = await client.post(
        f"/api/v1/print-jobs/{job['id']}/photo", files={"file": ("a.txt", b"hello", "text/plain")}, headers=headers
    )
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_permissions_viewer_cannot_write_user_can_log_only_admin_deletes(client, db_session):
    await _login_as_role(client, db_session, "viewer")
    resp = await client.post("/api/v1/print-jobs", json={"name": "x", "usages": []})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
    assert (await client.post("/api/v1/print-projects", json={"name": "x"})).status_code == 403
    assert (await client.get("/api/v1/print-jobs")).status_code == 200
    assert (await client.get("/api/v1/print-projects")).status_code == 200

    await _login_as_role(client, db_session, "user")
    job = await client.post("/api/v1/print-jobs", json={"name": "x", "usages": []})
    assert job.status_code == 201
    assert (await client.post(f"/api/v1/print-jobs/{job.json()['id']}/cancel")).status_code == 200
    denied = await client.delete(f"/api/v1/print-jobs/{job.json()['id']}")
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "forbidden"


@pytest.mark.asyncio
async def test_completing_requires_consumption_permission(client, db_session):
    from app.models import Permission, RolePermission
    from sqlalchemy import delete

    role = await db_session.scalar(select(Role).where(Role.key == "user"))
    permission = await db_session.scalar(
        select(Permission).where(Permission.key == "spool_events:create_consumption")
    )
    await db_session.execute(
        delete(RolePermission).where(
            RolePermission.role_id == role.id, RolePermission.permission_id == permission.id
        )
    )
    await db_session.commit()
    await _login_as_role(client, db_session, "user")

    booked = await client.post("/api/v1/print-jobs", json={"name": "x", "usages": [], "complete": True})
    assert booked.status_code == 403
    job = await client.post("/api/v1/print-jobs", json={"name": "y", "usages": []})
    assert job.status_code == 201
    denied = await client.post(f"/api/v1/print-jobs/{job.json()['id']}/complete", json={"success": True, "usages": []})
    assert denied.status_code == 403
    assert (await client.get(f"/api/v1/print-jobs/{job.json()['id']}")).json()["status"] == "pending"


@pytest.mark.asyncio
async def test_unauthenticated_requests_are_rejected(client):
    assert (await client.get("/api/v1/print-jobs")).status_code == 401
    assert (await client.get("/api/v1/print-projects")).status_code == 401


# ---------------------------------------------------------------- MCP


def test_mcp_exposes_print_job_tools_with_write_gate():
    from app.api.mcp_server import TOOLS_BY_NAME

    assert not TOOLS_BY_NAME["list_print_jobs"].write
    assert not TOOLS_BY_NAME["list_print_projects"].write
    assert TOOLS_BY_NAME["create_print_job"].write


# ---------------------------------------------------------------- backup


def test_print_tables_are_part_of_backups():
    from app.api.v1 import system

    inventory = {name for name, _ in system.INVENTORY_BACKUP_TABLES}
    complete = {name for name, _ in system.COMPLETE_BACKUP_TABLES}
    new = {"print_projects", "print_jobs", "print_job_usages"}
    assert new <= inventory and new <= complete
    order = [name for name, _ in system.INVENTORY_BACKUP_TABLES]
    assert order.index("print_projects") < order.index("print_jobs") < order.index("print_job_usages")
    assert order.index("spool_events") < order.index("print_job_usages")


# ---------------------------------------------------------------- migration


def _load_migration():
    spec = importlib.util.spec_from_file_location("print_jobs_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_creates_and_drops_tables(tmp_path):
    migration = _load_migration()
    assert migration.down_revision == "b8f2d6a41c93"
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'm.db'}")
    metadata = sa.MetaData()
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    sa.Table("users", metadata, sa.Column("id", sa.Integer, primary_key=True))
    sa.Table("printers", metadata, sa.Column("id", sa.Integer, primary_key=True))
    sa.Table("spools", metadata, sa.Column("id", sa.Integer, primary_key=True))
    sa.Table("spool_events", metadata, sa.Column("id", sa.Integer, primary_key=True))
    with engine.begin() as connection:
        metadata.create_all(connection)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        inspector = sa.inspect(connection)
        assert {"print_projects", "print_jobs", "print_job_usages"} <= set(inspector.get_table_names())
        connection.execute(
            sa.text("INSERT INTO print_projects (name, created_at, updated_at) VALUES ('P', :n, :n)"), {"n": now}
        )
        connection.execute(
            sa.text("INSERT INTO print_jobs (name, project_id, created_at, updated_at) VALUES ('J', 1, :n, :n)"),
            {"n": now},
        )
        connection.execute(sa.text("INSERT INTO print_job_usages (print_job_id) VALUES (1)"))
        row = connection.execute(
            sa.text("SELECT status, source, is_archived FROM print_jobs, print_projects")
        ).one()
        assert tuple(row) == ("pending", "manual", 0)

        migration.downgrade()
        assert not {"print_projects", "print_jobs", "print_job_usages"} & set(
            sa.inspect(connection).get_table_names()
        )
    engine.dispose()
