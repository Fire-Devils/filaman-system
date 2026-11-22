import math

import pytest
from app.api.v1 import slicer_link as api
from app.core.security import generate_token_secret, hash_token
from app.models import (
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    PrintJob,
    Role,
    User,
    UserApiKey,
    UserRole,
    UserSession,
)
from sqlalchemy import select
from tests.test_print_jobs import _login_as_role, _spool

URL = "/api/v1/slicer-link"


@pytest.fixture(autouse=True)
def _contacts_file(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "CONTACTS_FILE", tmp_path / "contacts.json")


async def _printer(db, slot_nos=(1, 2, 3), assign=None, inactive=()):
    printer = Printer(name="Ender", driver_key="manual")
    db.add(printer)
    await db.flush()
    slots = {}
    for no in slot_nos:
        slot = PrinterSlot(printer_id=printer.id, slot_no=no, is_active=no not in inactive)
        db.add(slot)
        await db.flush()
        slots[no] = slot
    for no, spool in (assign or {}).items():
        db.add(PrinterSlotAssignment(slot_id=slots[no].id, spool_id=spool.id, present=True))
    await db.commit()
    return printer


def _body(printer, filaments, **extra):
    return {
        "printer_id": printer.id,
        "job_name": "Benchy",
        "slicer": "PrusaSlicer",
        "script_version": "1.0.0",
        "filaments": filaments,
        **extra,
    }


@pytest.mark.asyncio
async def test_default_mapping_uses_ith_active_slot_by_slot_no(client, db_session):
    s0, s2 = await _spool(db_session), await _spool(db_session)
    # slot 1 is inactive, so index 0 -> slot 2, index 1 -> slot 3 (empty), index 2 -> none
    printer = await _printer(db_session, slot_nos=(3, 1, 2), assign={2: s0, 3: s2}, inactive=(1,))
    await _login_as_role(client, db_session, "user")

    resp = await client.post(
        f"{URL}/jobs",
        json=_body(printer, [{"index": 0, "weight_g": 5}, {"index": 1, "weight_g": 6}, {"index": 2, "weight_g": 7}]),
    )
    assert resp.status_code == 201, resp.text
    mapping = {m["index"]: m for m in resp.json()["mapping"]}
    assert (mapping[0]["slot_no"], mapping[0]["spool_id"], mapping[0]["reason"]) == (2, s0.id, None)
    assert (mapping[1]["slot_no"], mapping[1]["spool_id"]) == (3, s2.id)
    assert (mapping[2]["slot_no"], mapping[2]["spool_id"], mapping[2]["reason"]) == (None, None, "no_slot")

    job = await db_session.get(PrintJob, resp.json()["job_id"])
    assert job.status == "pending" and job.source == "slicer_link"
    assert job.meta["slicer"] == "PrusaSlicer" and job.meta["slot_map_explicit"] is False
    assert len(job.meta["mapping"]) == 3


@pytest.mark.asyncio
async def test_explicit_map_and_empty_slot(client, db_session):
    spool = await _spool(db_session)
    printer = await _printer(db_session, assign={3: spool})
    await _login_as_role(client, db_session, "user")

    resp = await client.post(
        f"{URL}/jobs",
        json=_body(printer, [{"index": 0, "weight_g": 5}, {"index": 1, "weight_g": 6}, {"index": 2, "weight_g": 4}],
                   slot_map={"0": 3, "1": 2, "2": 99}),
    )
    assert resp.status_code == 201, resp.text
    mapping = {m["index"]: m for m in resp.json()["mapping"]}
    assert mapping[0]["spool_id"] == spool.id and mapping[0]["slot_no"] == 3
    assert (mapping[1]["slot_no"], mapping[1]["spool_id"], mapping[1]["reason"]) == (2, None, "slot_empty")
    assert (mapping[2]["slot_no"], mapping[2]["reason"]) == (None, "no_slot")  # slot 99 does not exist
    assert (await db_session.get(PrintJob, resp.json()["job_id"])).meta["slot_map_explicit"] is True


@pytest.mark.asyncio
async def test_meters_become_grams_with_filament_density_and_default(client, db_session):
    spool = await _spool(db_session)
    spool.filament.density_g_cm3 = 1.27
    spool.filament.diameter_mm = 2.85
    await db_session.commit()
    printer = await _printer(db_session, slot_nos=(1, 2), assign={1: spool})
    await _login_as_role(client, db_session, "user")

    resp = await client.post(f"{URL}/jobs", json=_body(printer, [
        {"index": 0, "length_mm": 1000}, {"index": 1, "length_mm": 1000},
    ]))
    assert resp.status_code == 201, resp.text
    weights = {m["index"]: m["weight_g"] for m in resp.json()["mapping"]}
    assert weights[0] == pytest.approx(math.pi * 0.1425**2 * 100 * 1.27, abs=0.01)
    assert weights[1] == pytest.approx(math.pi * 0.0875**2 * 100 * 1.24, abs=0.01)  # 1.24 g/cm3, 1.75 mm
    job = await db_session.get(PrintJob, resp.json()["job_id"])
    await db_session.refresh(job, ["usages"])
    assert sum(u.planned_weight_g for u in job.usages) == pytest.approx(sum(weights.values()))


@pytest.mark.asyncio
async def test_zero_gram_entries_are_skipped_and_all_zero_is_rejected(client, db_session):
    printer = await _printer(db_session)
    await _login_as_role(client, db_session, "user")

    ok = await client.post(f"{URL}/jobs", json=_body(printer, [{"index": 0, "weight_g": 0}, {"index": 1, "weight_g": 3}]))
    assert ok.status_code == 201
    assert [m["index"] for m in ok.json()["mapping"]] == [1]

    none = await client.post(f"{URL}/jobs", json=_body(printer, [{"index": 0, "weight_g": 0}]))
    assert none.status_code == 422 and none.json()["detail"]["code"] == "no_filament_usage"

    unknown = await client.post(f"{URL}/jobs", json={**_body(printer, [{"index": 0, "weight_g": 1}]), "printer_id": 9999})
    assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "invalid_printer"


@pytest.mark.asyncio
async def test_viewer_gets_403_and_job_can_be_completed_later(client, db_session):
    spool = await _spool(db_session, remaining=100)
    printer = await _printer(db_session, assign={1: spool})
    await _login_as_role(client, db_session, "viewer")
    denied = await client.post(f"{URL}/jobs", json=_body(printer, [{"index": 0, "weight_g": 5}]))
    assert denied.status_code == 403
    assert (await client.post(f"{URL}/ping", json={})).status_code == 403

    await _login_as_role(client, db_session, "user")
    created = await client.post(f"{URL}/jobs", json=_body(printer, [{"index": 0, "weight_g": 5}]))
    job_id = created.json()["job_id"]
    done = await client.post(f"/api/v1/print-jobs/{job_id}/complete", json={"success": True, "usages": []})
    assert done.status_code == 200
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == pytest.approx(95.0)


@pytest.mark.asyncio
async def test_api_key_authentication_and_scope(client, db_session):
    printer = await _printer(db_session)
    user = User(email="key@example.com", password_hash="x", display_name="k", is_superadmin=False, is_active=True)
    db_session.add(user)
    await db_session.commit()
    role = await db_session.scalar(select(Role).where(Role.key == "user"))
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    secrets = {}
    for name, scopes in (("ok", None), ("narrow", ["spools:read"])):
        secrets[name] = generate_token_secret()
        key = UserApiKey(user_id=user.id, name=name, key_hash=hash_token(secrets[name]), scopes=scopes)
        db_session.add(key)
        await db_session.flush()
        secrets[name] = f"uak.{key.id}.{secrets[name]}"
    await db_session.commit()

    body = _body(printer, [{"index": 0, "weight_g": 2}])
    assert (await client.post(f"{URL}/jobs", json=body)).status_code == 401
    good = await client.post(f"{URL}/jobs", json=body, headers={"Authorization": f"ApiKey {secrets['ok']}"})
    assert good.status_code == 201, good.text
    assert (await db_session.get(PrintJob, good.json()["job_id"])).user_id == user.id
    narrow = await client.post(f"{URL}/jobs", json=body, headers={"Authorization": f"ApiKey {secrets['narrow']}"})
    assert narrow.status_code == 403


@pytest.mark.asyncio
async def test_ping_creates_no_job_but_status_shows_contact_and_update(client, db_session):
    printer = await _printer(db_session)
    await _login_as_role(client, db_session, "user")

    idle = (await client.get(f"{URL}/status")).json()
    entry = next(p for p in idle["printers"] if p["printer_id"] == printer.id)
    assert entry["last_contact_at"] is None
    assert [s["slot_no"] for s in entry["slots"]] == [1, 2, 3]

    ping = await client.post(f"{URL}/ping", json={"printer_id": printer.id, "script_version": "0.1.0"})
    assert ping.status_code == 200
    assert ping.json()["ok"] is True and ping.json()["update_available"] is True
    assert ping.json()["latest_script_version"] == api.script_version()
    assert (await db_session.scalars(select(PrintJob))).all() == []

    after = (await client.get(f"{URL}/status")).json()
    entry = next(p for p in after["printers"] if p["printer_id"] == printer.id)
    assert entry["last_contact_at"] and entry["update_available"] is True
    assert after["recent_jobs"] == []

    current = await client.post(f"{URL}/ping", json={"printer_id": printer.id, "script_version": api.script_version()})
    assert current.json()["update_available"] is False

    await client.post(f"{URL}/jobs", json=_body(printer, [{"index": 0, "weight_g": 2}]))
    recent = (await client.get(f"{URL}/status")).json()["recent_jobs"]
    assert len(recent) == 1 and recent[0]["name"] == "Benchy" and recent[0]["status"] == "pending"


@pytest.mark.asyncio
async def test_script_download_matches_file_and_requires_auth(client, db_session):
    assert (await client.get(f"{URL}/script")).status_code == 401
    await _login_as_role(client, db_session, "viewer")
    resp = await client.get(f"{URL}/script")
    assert resp.status_code == 200
    assert resp.content == api.SCRIPT_PATH.read_bytes()
    assert "filaman_slicer_link.py" in resp.headers["content-disposition"]
    assert f'SCRIPT_VERSION = "{api.script_version()}"'.encode() in resp.content


def test_grams_from_length_fallbacks():
    assert api.grams_from_length(1000, None, None) == pytest.approx(2.98, abs=0.01)
    assert api.grams_from_length(1000, 0, 0) == api.grams_from_length(1000, None, None)
