"""Community-Beiträge an die FilaMan-DB (Etappe 4): Schlüssel, Token, Senden, Abgleich."""

import json
import stat

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core import app_secret
from app.models import (
    Color,
    Filament,
    FilamentColor,
    FilamentDBContribution,
    FilamentPrinterProfile,
    Manufacturer,
    Printer,
    Spool,
    SpoolStatus,
)
from app.services import filamentdb_contrib_client as client_mod
from tests.test_rbac import _create_session, viewer_auth_client, viewer_user  # noqa: F401

TOKEN = "fdb_" + "a" * 40
TOKEN2 = "fdb_" + "b" * 40
BASE = "/api/v1/filamentdb"


def _h(csrf):
    return {"X-CSRF-Token": csrf}


# ─── Schlüssel ────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolated_key(tmp_path, monkeypatch):
    monkeypatch.setattr(app_secret, "DATA_DIR", tmp_path)
    monkeypatch.delenv("FILAMAN_ENC_KEY", raising=False)
    monkeypatch.setattr(client_mod, "_TRANSPORT", None)


def test_key_file_is_created_with_mode_600(tmp_path):
    token = app_secret.encrypt_app_secret("geheim")
    key_file = tmp_path / ".filaman_enc.key"
    assert key_file.is_file()
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    first_key = key_file.read_bytes()
    assert app_secret.decrypt_app_secret(token) == "geheim"
    app_secret.encrypt_app_secret("x")  # zweiter Aufruf lässt die Datei unberührt
    assert key_file.read_bytes() == first_key
    assert list(tmp_path.glob(".filaman_enc.tmp*")) == []


def test_env_key_takes_precedence_over_file(tmp_path, monkeypatch):
    file_token = app_secret.encrypt_app_secret("a")
    monkeypatch.setenv("FILAMAN_ENC_KEY", "env-key")
    env_token = app_secret.encrypt_app_secret("b")
    assert app_secret.decrypt_app_secret(env_token) == "b"
    with pytest.raises(app_secret.AppSecretError):
        app_secret.decrypt_app_secret(file_token)


def test_wrong_key_raises_app_secret_error(monkeypatch):
    monkeypatch.setenv("FILAMAN_ENC_KEY", "one")
    token = app_secret.encrypt_app_secret("a")
    monkeypatch.setenv("FILAMAN_ENC_KEY", "two")
    with pytest.raises(app_secret.AppSecretError):
        app_secret.decrypt_app_secret(token)


# ─── Fake FilaMan-DB ──────────────────────────────────────────────────────


class FakeDB:
    def __init__(self):
        self.requests: list[tuple[str, str, dict]] = []
        self.next_id = 100
        self.submissions: dict[int, dict] = {}
        self.matches: dict[str, list] = {}
        self.fail: dict[str, tuple[int, dict]] = {}
        self.materials = [{"id": 5, "key": "pla", "name": "PLA"}]
        self.profiles: dict[int, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1")
        body = json.loads(request.content) if request.content else {}
        self.requests.append((request.method, path, body))
        key = f"{request.method} {path}"
        if key in self.fail:
            code, detail = self.fail[key]
            return httpx.Response(code, json={"detail": detail})
        auth = request.headers.get("authorization")
        if path == "/token/whoami":
            if auth not in (f"Bearer {TOKEN}", f"Bearer {TOKEN2}"):
                return httpx.Response(401, json={"detail": {"code": "invalid_token", "message": "no"}})
            name = "Maker" if auth == f"Bearer {TOKEN}" else "Second"
            return httpx.Response(200, json={"user_id": 1, "display_name": name, "scopes": ["contribute", "rate"]})
        if path == "/materials":
            return httpx.Response(200, json={"items": self.materials})
        if path == "/contribute/check":
            return httpx.Response(200, json={"matches": self.matches.get(body["type"], [])})
        if path == "/contribute" and request.method == "POST":
            self.next_id += 1
            if body["type"] == "print_profile":
                self.profiles[self.next_id] = body["data"]
                return httpx.Response(201, json={"print_profile_id": self.next_id, "status": "published"})
            self.submissions[self.next_id] = {
                "submission_id": self.next_id,
                "type": body["type"],
                "status": "pending",
                "entity_id": None,
                "body": body,
            }
            return httpx.Response(201, json={"submission_id": self.next_id, "status": "pending"})
        if path == "/me/submissions":
            ids = [int(i) for i in request.url.params["ids"].split(",")]
            return httpx.Response(
                200,
                json=[{k: v for k, v in self.submissions[i].items() if k != "body"} for i in ids],
            )
        if path.startswith("/print-profiles/") and request.method == "PUT" and not path.endswith("rating"):
            self.profiles[int(path.rsplit("/", 1)[1])] = body
            return httpx.Response(200, json={})
        if path.endswith("/rating"):
            return httpx.Response(200, json={"rating_avg": 4.5, "rating_count": 2, "my_rating": body["stars"]})
        if path.endswith("/report"):
            return httpx.Response(201, json={})
        if path.startswith("/print-profiles/") and request.method == "GET":
            return httpx.Response(200, json=self.profiles[int(path.rsplit("/", 1)[1])])
        if path == "/print-profiles":
            return httpx.Response(200, json={"items": [{"id": 1, "is_own": bool(auth)}], "total": 1})
        return httpx.Response(404, json={"detail": {"code": "not_found", "message": path}})

    def sent(self, method, path):
        return [b for m, p, b in self.requests if (m, p) == (method, path)]

    def approve(self, submission_id, entity_id):
        self.submissions[submission_id]["status"] = "approved"
        self.submissions[submission_id]["entity_id"] = entity_id


@pytest.fixture
def fake_db(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(client_mod, "_TRANSPORT", httpx.MockTransport(fake.handler))
    return fake


@pytest_asyncio.fixture
async def entities(db_session):
    mfr = Manufacturer(name="Acme")
    db_session.add(mfr)
    await db_session.flush()
    color = Color(name="Rot", hex_code="#FF0000")
    fil = Filament(
        manufacturer_id=mfr.id,
        designation="Acme PLA Rot",
        material_type="PLA",
        diameter_mm=1.75,
        price=24.9,
        shop_url="https://shop.example/x",
        extruder_temp_range_c={"min": 190, "max": 230},
        bed_temp_range_c={"min": 60, "max": 60},
        drying_temp_c=45,
        manufacturer_sku="SKU1",
    )
    printer = Printer(
        name="Mein Drucker",
        driver_key="x",
        printer_manufacturer="Bambu Lab",
        printer_model="X1C",
        nozzle_diameter_mm=0.4,
    )
    db_session.add_all([color, fil, printer])
    await db_session.flush()
    db_session.add(FilamentColor(filament_id=fil.id, color_id=color.id, position=1))
    profile = FilamentPrinterProfile(
        filament_id=fil.id,
        printer_id=printer.id,
        profile_name="Standard",
        printer_manufacturer="Bambu Lab",
        printer_model="X1C",
        nozzle_diameter_mm=0.4,
        nozzle_temp_c=215,
        bed_temp_c=60,
        build_plate="Textured PEI",
        material_notes="läuft gut",
    )
    db_session.add(profile)
    await db_session.commit()
    return {"mfr": mfr, "fil": fil, "printer": printer, "profile": profile}


async def _save_token(client, csrf):
    resp = await client.put(f"{BASE}/token", json={"token": TOKEN}, headers=_h(csrf))
    assert resp.status_code == 200, resp.text
    return resp


async def _submit(client, csrf, type_, local_id, **extra):
    return await client.post(
        f"{BASE}/contributions/submit",
        json={"type": type_, "local_id": local_id, **extra},
        headers=_h(csrf),
    )


# ─── Token ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_token_set_never_returned_and_testable(auth_client, fake_db, db_session):
    client, csrf = auth_client
    resp = await _save_token(client, csrf)
    assert resp.json() == {"saved": True, "display_name": "Maker", "scopes": ["contribute", "rate"]}
    assert TOKEN not in resp.text

    status = await client.get(f"{BASE}/token")
    assert status.json()["saved"] is True and TOKEN not in status.text
    from app.models import User

    stored = (await db_session.scalar(select(User).where(User.is_superadmin.is_(True)))).filamentdb_token_enc
    assert stored and TOKEN not in stored  # verschlüsselt

    assert (await client.post(f"{BASE}/token/test", headers=_h(csrf))).json()["display_name"] == "Maker"

    removed = await client.delete(f"{BASE}/token", headers=_h(csrf))
    assert removed.json() == {"saved": False, "display_name": None, "scopes": None}
    again = await client.post(f"{BASE}/token/test", headers=_h(csrf))
    assert again.status_code == 400 and again.json()["detail"]["code"] == "filamentdb_token_missing"


@pytest.mark.asyncio
async def test_token_is_stored_per_user(auth_client, normal_user, fake_db, db_session):
    from app.models import User

    client, csrf = auth_client
    await _save_token(client, csrf)
    admin_status = (await client.get(f"{BASE}/contributions/status")).json()
    assert admin_status["token_saved"] is True

    # User B (Rolle user): sieht den Token von A nicht und hat einen eigenen.
    client_b, csrf_b = await _create_session(client, db_session, normal_user.id)
    assert (await client_b.get(f"{BASE}/token")).json()["saved"] is False
    assert (await client_b.get(f"{BASE}/contributions/status")).json()["token_saved"] is False
    ref = {"type": "manufacturer", "local_id": 1}
    miss = await client_b.post(f"{BASE}/contributions/preview", json=ref, headers=_h(csrf_b))
    assert miss.status_code == 400 and miss.json()["detail"]["code"] == "filamentdb_token_missing"
    miss = await client_b.post(f"{BASE}/token/test", headers=_h(csrf_b))
    assert miss.json()["detail"]["code"] == "filamentdb_token_missing"

    put = await client_b.put(f"{BASE}/token", json={"token": TOKEN2}, headers=_h(csrf_b))
    assert put.status_code == 200 and put.json()["display_name"] == "Second"
    assert (await client_b.get(f"{BASE}/token")).json()["display_name"] == "Second"

    # A bleibt unberührt.
    client_a, _ = await _create_session(client, db_session, (
        await db_session.scalar(select(User).where(User.is_superadmin.is_(True)))
    ).id)
    assert (await client_a.get(f"{BASE}/token")).json()["display_name"] == "Maker"
    users = {u.email: u for u in (await db_session.scalars(select(User))).all()}
    assert users["test-user@example.com"].filamentdb_token_enc != users["test-admin@example.com"].filamentdb_token_enc


@pytest.mark.asyncio
async def test_submit_uses_callers_token_and_list_is_scoped(
    auth_client, normal_user, fake_db, entities, db_session, monkeypatch
):
    client, csrf = auth_client
    seen: list[str | None] = []
    orig = fake_db.handler

    def spy(request):
        seen.append(request.headers.get("authorization"))
        return orig(request)

    monkeypatch.setattr(client_mod, "_TRANSPORT", httpx.MockTransport(spy))
    await _save_token(client, csrf)
    sent_a = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    assert sent_a.status_code == 200
    assert f"Bearer {TOKEN}" in seen and f"Bearer {TOKEN2}" not in seen

    client_b, csrf_b = await _create_session(client, db_session, normal_user.id)
    await client_b.put(f"{BASE}/token", json={"token": TOKEN2}, headers=_h(csrf_b))
    # Fremde, noch offene Einreichung ist für B nicht sichtbar.
    assert (await client_b.get(f"{BASE}/contributions")).json()["items"] == []
    seen.clear()
    resent = await _submit(client_b, csrf_b, "manufacturer", entities["mfr"].id)
    assert resent.status_code == 200, resent.text
    assert set(seen) == {f"Bearer {TOKEN2}"}
    # Neue Einreichung unter dem Konto von B.
    assert resent.json()["created_by"] == normal_user.id
    assert resent.json()["remote_submission_id"] != sent_a.json()["remote_submission_id"]
    assert len(fake_db.sent("POST", "/contribute")) == 2
    assert len((await client_b.get(f"{BASE}/contributions")).json()["items"]) == 1


@pytest.mark.asyncio
async def test_refresh_skips_users_without_token(auth_client, normal_user, fake_db, entities, db_session):
    from app.services import filamentdb_contribution_service as svc

    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    sub_id = resp.json()["remote_submission_id"]
    # Beitrag eines Users ohne Token (oder mit nicht entschlüsselbarem Token).
    other = FilamentDBContribution(
        entity_type="filament", local_id=entities["fil"].id, status="pending",
        remote_submission_id=999, created_by=normal_user.id,
    )
    db_session.add(other)
    await db_session.commit()
    fake_db.approve(sub_id, 42)

    await svc.refresh(db_session, None)
    await db_session.refresh(other)
    assert other.status == "pending" and other.last_checked_at is None
    mine = await db_session.scalar(
        select(FilamentDBContribution).where(FilamentDBContribution.entity_type == "manufacturer")
    )
    assert mine.status == "approved"
    asked = [b for m, p, b in fake_db.requests if p == "/me/submissions"]
    assert len(asked) == 1


@pytest.mark.asyncio
async def test_admin_sees_all_contributions_with_sender(
    auth_client, normal_user, fake_db, entities, db_session
):
    client, csrf = auth_client
    db_session.add(
        FilamentDBContribution(
            entity_type="filament", local_id=entities["fil"].id, status="pending",
            remote_submission_id=5, created_by=normal_user.id,
        )
    )
    await db_session.commit()
    items = (await client.get(f"{BASE}/contributions")).json()["items"]
    assert len(items) == 1 and items[0]["created_by_name"] == "Test User"
    assert (await client.get(f"{BASE}/contributions")).json()["all_users"] is True
    client_b, _ = await _create_session(client, db_session, normal_user.id)
    own = (await client_b.get(f"{BASE}/contributions")).json()
    assert own["all_users"] is False and len(own["items"]) == 1


@pytest.mark.asyncio
async def test_api_key_principal_without_user_cannot_manage_token(auth_client, fake_db, monkeypatch):
    from types import SimpleNamespace

    from app.api.v1 import filamentdb_contributions as mod

    with pytest.raises(Exception) as exc:
        await mod._own_user(None, SimpleNamespace(user_id=None))
    assert exc.value.detail["code"] == "filamentdb_token_user_required"


@pytest.mark.asyncio
async def test_invalid_token_is_not_401(auth_client, fake_db):
    client, csrf = auth_client
    resp = await client.put(f"{BASE}/token", json={"token": "fdb_wrong-token"}, headers=_h(csrf))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "filamentdb_token_invalid"


@pytest.mark.asyncio
async def test_undecryptable_token_asks_for_reentry(auth_client, fake_db, monkeypatch):
    client, csrf = auth_client
    await _save_token(client, csrf)
    monkeypatch.setenv("FILAMAN_ENC_KEY", "anderer-schluessel")
    resp = await client.post(f"{BASE}/token/test", headers=_h(csrf))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "filamentdb_token_undecryptable"


@pytest.mark.asyncio
async def test_token_endpoints_need_contribute_permission(viewer_auth_client, fake_db):  # noqa: F811
    client, csrf = viewer_auth_client
    assert (await client.get(f"{BASE}/token")).status_code == 403
    assert (await client.put(f"{BASE}/token", json={"token": TOKEN}, headers=_h(csrf))).status_code == 403
    assert (await client.delete(f"{BASE}/token", headers=_h(csrf))).status_code == 403


# ─── Rechte ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_viewer_cannot_contribute_rate_report_or_import(viewer_auth_client, fake_db, entities):  # noqa: F811
    client, csrf = viewer_auth_client
    ref = {"type": "manufacturer", "local_id": entities["mfr"].id}
    calls = [
        client.post(f"{BASE}/contributions/preview", json=ref, headers=_h(csrf)),
        client.post(f"{BASE}/contributions/submit", json=ref, headers=_h(csrf)),
        client.post(f"{BASE}/contributions/refresh", headers=_h(csrf)),
        client.put(f"{BASE}/print-profiles/1/rating", json={"stars": 5}, headers=_h(csrf)),
        client.post(f"{BASE}/print-profiles/1/report", json={"reason": "x"}, headers=_h(csrf)),
        client.post(
            f"{BASE}/print-profiles/1/import",
            json={"filament_id": entities["fil"].id, "printer_id": entities["printer"].id},
            headers=_h(csrf),
        ),
    ]
    for call in calls:
        assert (await call).status_code == 403
    # Lesen bleibt offen
    assert (await client.get(f"{BASE}/contributions")).status_code == 200
    assert (await client.get(f"{BASE}/contributions/status")).status_code == 200
    assert fake_db.requests == []


def test_user_role_holds_contribute_permission():
    from app.core.seeds import ADMIN_PERMISSIONS, USER_PERMISSIONS, VIEWER_PERMISSIONS

    assert "filamentdb:contribute" in USER_PERMISSIONS
    assert "filamentdb:contribute" in ADMIN_PERMISSIONS
    assert "filamentdb:contribute" not in VIEWER_PERMISSIONS


@pytest.mark.asyncio
async def test_user_role_can_manage_own_token(normal_user, client, fake_db, db_session):
    cl, csrf = await _create_session(client, db_session, normal_user.id)
    assert (await cl.get(f"{BASE}/token")).status_code == 200
    assert (await cl.put(f"{BASE}/token", json={"token": TOKEN}, headers=_h(csrf))).status_code == 200


# ─── Vorschau ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_preview_contains_no_spool_or_private_data(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    status = SpoolStatus(key="new-contrib", label="New")
    db_session.add(status)
    await db_session.flush()
    db_session.add(
        Spool(
            filament_id=entities["fil"].id,
            status_id=status.id,
            lot_number="LOT-PRIVAT",
            purchase_price=19.5,
            initial_total_weight_g=1234,
        )
    )
    await db_session.commit()

    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    await db_session.commit()
    fake_db.matches["filament"] = [{"type": "filament", "id": 9, "label": "Acme PLA Rot", "score": 0.9}]
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "filament", "local_id": entities["fil"].id},
        headers=_h(csrf),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "create" and body["blockers"] == [] and body["dependencies"] == []
    assert body["matches"][0]["id"] == 9
    payload = body["payload"]
    assert payload["manufacturer_id"] == 7 and payload["material_id"] == 5
    assert body["display"]["manufacturer_id"] == entities["mfr"].name
    assert body["display"]["material_id"] == entities["fil"].material_type
    assert payload["temp_nozzle_min"] == 190 and payload["temp_bed"] == 60
    assert payload["hex_color"] == "#ff0000" and payload["colors"][0]["color_name"] == "Rot"
    flat = json.dumps(payload).lower()
    for forbidden in ("price", "shop", "24.9", "19.5", "spool", "location", "lot", "privat", "1234"):
        assert forbidden not in flat
    assert "id" not in payload and "filament_id" not in payload
    # der Vorab-Check bekam genau diesen Payload
    assert fake_db.sent("POST", "/contribute/check")[0]["data"] == payload


@pytest.mark.asyncio
async def test_preview_blocks_filament_values_outside_db_limits(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    entities["fil"].bed_temp_range_c = {"min": 250, "max": 250}
    await db_session.commit()
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "filament", "local_id": entities["fil"].id},
        headers=_h(csrf),
    )
    assert resp.status_code == 200, resp.text
    blockers = [b for b in resp.json()["blockers"] if b["code"] == "implausible_value"]
    assert blockers == [
        {"code": "implausible_value", "message": "temp_bed must be between 0 and 200", "field": "temp_bed", "min": 0, "max": 200}
    ]


def test_db_validation_error_carries_field_and_limit():
    import httpx

    from app.services.filamentdb_contrib_client import _error_from_response

    resp = httpx.Response(
        422,
        json={"detail": [{"type": "less_than_equal", "loc": ["body", "data", "temp_bed"], "msg": "Input should be less than or equal to 200", "ctx": {"le": 200}}]},
    )
    err = _error_from_response(resp)
    assert err.code == "validation_error"
    assert err.extra == {"field": "temp_bed", "max": 200}


@pytest.mark.asyncio
async def test_preview_reports_dependencies_and_blockers(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["profile"].printer_model = None
    entities["profile"].nozzle_temp_c = 900
    await db_session.commit()
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "print_profile", "local_id": entities["profile"].id},
        headers=_h(csrf),
    )
    body = resp.json()
    codes = {b["code"] for b in body["blockers"]}
    assert {"printer_model_missing", "implausible_value"} <= codes
    assert [d["type"] for d in body["dependencies"]] == ["filament"]
    assert body["matches"] == []


@pytest.mark.asyncio
async def test_unknown_material_blocks_filament(auth_client, fake_db, entities):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.materials = []
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "filament", "local_id": entities["fil"].id},
        headers=_h(csrf),
    )
    assert resp.json()["blockers"][0]["code"] == "material_unknown"
    blocked = await _submit(client, csrf, "filament", entities["fil"].id)
    assert blocked.status_code == 409
    assert fake_db.sent("POST", "/contribute") == []


# ─── Einreichen, Verknüpfen, Abhängigkeiten ───────────────────────────────


@pytest.mark.asyncio
async def test_submit_manufacturer_then_refresh_links_it(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    shown = [{"type": "manufacturer", "id": 3, "score": 0.7}]
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id, shown_matches=shown)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending"
    sent = fake_db.sent("POST", "/contribute")[0]
    assert sent["type"] == "manufacturer" and sent["data"] == {"name": "Acme"}
    assert sent["shown_matches"] == shown and sent["entity_id"] is None

    sub_id = resp.json()["remote_submission_id"]
    fake_db.approve(sub_id, 42)
    listed = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    assert listed[0]["status"] == "approved" and listed[0]["remote_entity_id"] == 42
    await db_session.refresh(entities["mfr"])
    assert entities["mfr"].custom_fields["filamentdb_id"] == 42


@pytest.mark.asyncio
async def test_link_sends_nothing_and_sets_local_ids(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches = {
        "manufacturer": [{"id": 11, "score": 0.8}],
        "filament": [{"id": 12, "score": 0.8}],
        "printer_model": [{"id": 13, "score": 0.8}],
    }
    for type_, local, match in (
        ("manufacturer", entities["mfr"].id, 11),
        ("filament", entities["fil"].id, 12),
        ("printer_model", entities["printer"].id, 13),
    ):
        resp = await _submit(client, csrf, type_, local, action="link", match_id=match)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "linked" and resp.json()["remote_entity_id"] == match
    assert fake_db.sent("POST", "/contribute") == []
    for obj in entities.values():
        await db_session.refresh(obj)
    assert entities["mfr"].custom_fields["filamentdb_id"] == 11
    assert entities["fil"].custom_fields["filamentdb_id"] == 12
    assert entities["printer"].filamentdb_printer_model_id == 13

    missing = await _submit(client, csrf, "filament", entities["fil"].id, action="link")
    assert missing.status_code == 422


@pytest.mark.asyncio
async def test_link_rejects_match_id_not_proposed_by_db(auth_client, fake_db, entities):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches = {"manufacturer": [{"id": 11, "score": 0.8}]}
    bad = await _submit(client, csrf, "manufacturer", entities["mfr"].id, action="link", match_id=999)
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "filamentdb_match_invalid"


@pytest.mark.asyncio
async def test_link_needs_update_permission_of_target(normal_user, client, fake_db, entities, db_session):
    cl, csrf = await _create_session(client, db_session, normal_user.id)
    await cl.put(f"{BASE}/token", json={"token": TOKEN}, headers=_h(csrf))
    fake_db.matches = {"manufacturer": [{"id": 11, "score": 0.8}]}
    for type_, local in (
        ("manufacturer", entities["mfr"].id),
        ("filament", entities["fil"].id),
        ("print_profile", entities["profile"].id),
        ("printer_model", entities["printer"].id),
    ):
        resp = await _submit(cl, csrf, type_, local, action="link", match_id=11)
        assert resp.status_code == 403, (type_, resp.text)
    await db_session.refresh(entities["mfr"])
    assert "filamentdb_id" not in (entities["mfr"].custom_fields or {})


@pytest.mark.asyncio
async def test_filament_waits_for_manufacturer_and_is_sent_after_approval(
    auth_client, fake_db, entities, db_session
):
    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await _submit(client, csrf, "filament", entities["fil"].id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "waiting"
    assert body["depends_on"]["entity_type"] == "manufacturer"
    assert [b["type"] for b in fake_db.sent("POST", "/contribute")] == ["manufacturer"]

    mfr_sub = fake_db.sent("POST", "/contribute")  # nur der Hersteller ging raus
    assert len(mfr_sub) == 1
    fake_db.approve(max(fake_db.submissions), 77)
    items = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    by_type = {i["entity_type"]: i for i in items}
    assert by_type["manufacturer"]["status"] == "approved"
    assert by_type["filament"]["status"] == "pending"
    filament_post = fake_db.sent("POST", "/contribute")[1]
    assert filament_post["type"] == "filament" and filament_post["data"]["manufacturer_id"] == 77


@pytest.mark.asyncio
async def test_existing_manufacturer_in_db_is_linked_not_resubmitted(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches["manufacturer"] = [{"type": "manufacturer", "id": 8, "label": "Acme", "score": 1.0}]
    resp = await _submit(client, csrf, "filament", entities["fil"].id)
    assert resp.json()["status"] == "pending"  # Hersteller verknüpft, Filament direkt raus
    types = [b["type"] for b in fake_db.sent("POST", "/contribute")]
    assert types == ["filament"]
    await db_session.refresh(entities["mfr"])
    assert entities["mfr"].custom_fields["filamentdb_id"] == 8


@pytest.mark.asyncio
async def test_profile_waits_for_filament_and_printer_model_then_publishes(
    auth_client, fake_db, entities, db_session
):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    await db_session.commit()

    resp = await _submit(client, csrf, "print_profile", entities["profile"].id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "waiting"
    assert resp.json()["depends_on"]["entity_type"] == "filament"
    assert sorted(b["type"] for b in fake_db.sent("POST", "/contribute")) == ["filament", "printer_model"]

    for sub_id, entity in zip(sorted(fake_db.submissions), (50, 60)):
        fake_db.approve(sub_id, entity)
    items = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    by_type = {i["entity_type"]: i for i in items}
    assert by_type["print_profile"]["status"] == "published"
    assert by_type["print_profile"]["remote_entity_id"] is not None
    posted = fake_db.sent("POST", "/contribute")[-1]
    assert posted["type"] == "print_profile"
    data = posted["data"]
    assert data["filament_id"] == 50 and data["printer_model_id"] == 60
    assert data["build_plate"] == "Textured PEI" and data["nozzle_diameter_mm"] == 0.4
    assert "profile_name" not in data and "printer_id" not in data and "is_default_for_printer" not in data


@pytest.mark.asyncio
async def test_published_profile_is_updated_with_put_not_duplicated(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    entities["fil"].custom_fields = {"filamentdb_id": 9}
    entities["profile"].filamentdb_printer_model_id = 3
    await db_session.commit()

    first = await _submit(client, csrf, "print_profile", entities["profile"].id)
    assert first.json()["status"] == "published"
    remote_id = first.json()["remote_entity_id"]

    entities["profile"].nozzle_temp_c = 220
    await db_session.commit()
    second = await _submit(client, csrf, "print_profile", entities["profile"].id)
    assert second.json()["status"] == "published"
    assert len(fake_db.sent("POST", "/contribute")) == 1
    assert fake_db.sent("PUT", f"/print-profiles/{remote_id}")[0]["nozzle_temp_c"] == 220
    rows = (await db_session.scalars(select(FilamentDBContribution))).all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_linked_filament_sends_base_values_as_edit(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["fil"].custom_fields = {"filamentdb_id": 9}
    await db_session.commit()
    resp = await _submit(client, csrf, "filament", entities["fil"].id)
    assert resp.json()["status"] == "pending"
    sent = fake_db.sent("POST", "/contribute")[0]
    assert sent["entity_id"] == 9 and sent["type"] == "filament"
    assert set(sent["data"]) <= {
        "density_g_cm3", "temp_nozzle_min", "temp_nozzle_max", "temp_bed", "fan_speed_min",
        "fan_speed_max", "chamber_temp", "max_volumetric_speed", "flow_ratio", "k_value",
        "softening_temp", "dry_temp", "dry_time_hours",
    }
    assert sent["data"]["dry_temp"] == 45
    assert fake_db.sent("POST", "/contribute/check") == []


@pytest.mark.asyncio
async def test_rejected_dependency_turns_waiting_profile_into_error(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["profile"].filamentdb_printer_model_id = 3
    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    await db_session.commit()
    await _submit(client, csrf, "print_profile", entities["profile"].id)
    sub = next(iter(fake_db.submissions))
    fake_db.submissions[sub]["status"] = "rejected"
    items = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    by_type = {i["entity_type"]: i for i in items}
    assert by_type["filament"]["status"] == "rejected"
    assert by_type["print_profile"]["status"] == "error"


# ─── Fehlercodes ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_error_codes_reach_the_ui(auth_client, fake_db, entities):
    client, csrf = auth_client
    await _save_token(client, csrf)
    ref = entities["mfr"].id

    fake_db.fail["POST /contribute"] = (429, {"code": "daily_limit_reached", "message": "limit"})
    resp = await _submit(client, csrf, "manufacturer", ref)
    assert resp.status_code == 429 and resp.json()["detail"]["code"] == "daily_limit_reached"

    fake_db.fail["POST /contribute"] = (
        422,
        {"code": "implausible_value", "message": "bad", "field": "nozzle_temp_c", "min": 150, "max": 500},
    )
    resp = await _submit(client, csrf, "manufacturer", ref)
    detail = resp.json()["detail"]
    assert resp.status_code == 422 and detail["field"] == "nozzle_temp_c" and detail["max"] == 500

    fake_db.fail["POST /contribute"] = (401, {"code": "invalid_token", "message": "x"})
    resp = await _submit(client, csrf, "manufacturer", ref)
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "filamentdb_token_invalid"

    def unreachable(request):
        raise httpx.ConnectError("down")

    client_mod._TRANSPORT = httpx.MockTransport(unreachable)
    resp = await _submit(client, csrf, "manufacturer", ref)
    assert resp.status_code == 502 and resp.json()["detail"]["code"] == "filamentdb_unreachable"


@pytest.mark.asyncio
async def test_local_validation_stops_before_sending(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["profile"].retraction_mm = 99
    entities["fil"].custom_fields = {"filamentdb_id": 9}
    entities["profile"].filamentdb_printer_model_id = 3
    await db_session.commit()
    resp = await _submit(client, csrf, "print_profile", entities["profile"].id)
    assert resp.status_code == 422
    assert resp.json()["detail"]["field"] == "retraction_mm"
    assert fake_db.sent("POST", "/contribute") == []


@pytest.mark.asyncio
async def test_submit_without_token(auth_client, fake_db, entities):
    client, csrf = auth_client
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "filamentdb_token_missing"


# ─── Community-Profile ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_profiles_proxy_adds_is_own_only_with_token(auth_client, fake_db):
    client, csrf = auth_client
    url = f"{BASE}/print-profiles?filament_id=9&printer_model_id=3&nozzle_diameter_mm=0.4"
    assert (await client.get(url)).json()["items"][0]["is_own"] is False
    await _save_token(client, csrf)
    assert (await client.get(url)).json()["items"][0]["is_own"] is True
    sent = [r for r in fake_db.requests if r[1] == "/print-profiles"]
    assert sent  # Parameter wurden durchgereicht


@pytest.mark.asyncio
async def test_rate_and_report_use_token(auth_client, fake_db):
    client, csrf = auth_client
    await _save_token(client, csrf)
    rated = await client.put(f"{BASE}/print-profiles/4/rating", json={"stars": 5}, headers=_h(csrf))
    assert rated.json()["my_rating"] == 5
    bad = await client.put(f"{BASE}/print-profiles/4/rating", json={"stars": 6}, headers=_h(csrf))
    assert bad.status_code == 422
    fake_db.fail["PUT /print-profiles/4/rating"] = (403, {"code": "own_profile", "message": "own"})
    own = await client.put(f"{BASE}/print-profiles/4/rating", json={"stars": 5}, headers=_h(csrf))
    assert own.status_code == 403 and own.json()["detail"]["code"] == "own_profile"
    reported = await client.post(f"{BASE}/print-profiles/4/report", json={"reason": "Unsinn"}, headers=_h(csrf))
    assert reported.status_code == 201
    assert fake_db.sent("POST", "/print-profiles/4/report")[0] == {"reason": "Unsinn"}


@pytest.mark.asyncio
async def test_import_community_profile_creates_local_profile(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    fake_db.profiles[5] = {
        "id": 5,
        "author_display_name": "Maker",
        "nozzle_diameter_mm": 0.4,
        "nozzle_temp_c": 215.0,
        "bed_temp_c": 60,
        "pressure_advance_k": 0.04,
        "build_plate": "Smooth",
        "material_notes": "Danke",
        "rating_avg": 4.5,
    }
    resp = await client.post(
        f"{BASE}/print-profiles/5/import",
        json={"filament_id": entities["fil"].id, "printer_id": entities["printer"].id},
        headers=_h(csrf),
    )
    assert resp.status_code == 201, resp.text
    created = await db_session.get(FilamentPrinterProfile, resp.json()["id"])
    assert created.nozzle_temp_c == 215 and created.build_plate == "Smooth"
    assert created.profile_name == "Maker (FilaMan-DB)"
    row = await db_session.scalar(
        select(FilamentDBContribution).where(FilamentDBContribution.local_id == created.id)
    )
    assert row.status == "linked" and row.remote_entity_id == 5

    # Ein übernommenes Fremdprofil wird nicht per PUT überschrieben, sondern neu eingereicht.
    assert (created.printer_manufacturer, created.printer_model) == ("Bambu Lab", "X1C")
    entities["fil"].custom_fields = {"filamentdb_id": 9}
    created.filamentdb_printer_model_id = 3
    await db_session.commit()
    await _save_token(client, csrf)
    sent = await _submit(client, csrf, "print_profile", created.id)
    assert sent.json()["status"] == "published"
    assert fake_db.sent("PUT", "/print-profiles/5") == []
    assert len(fake_db.sent("POST", "/contribute")) == 1


@pytest.mark.asyncio
async def test_import_rejects_implausible_remote_values(auth_client, fake_db, entities):
    client, csrf = auth_client
    fake_db.profiles[6] = {"nozzle_temp_c": 900}
    resp = await client.post(
        f"{BASE}/print-profiles/6/import",
        json={"filament_id": entities["fil"].id, "printer_id": entities["printer"].id},
        headers=_h(csrf),
    )
    assert resp.status_code == 422 and resp.json()["detail"]["field"] == "nozzle_temp_c"


@pytest.mark.asyncio
async def test_status_endpoint(auth_client, fake_db):
    client, csrf = auth_client
    before = (await client.get(f"{BASE}/contributions/status")).json()
    assert before["token_saved"] is False
    await _save_token(client, csrf)
    after = (await client.get(f"{BASE}/contributions/status")).json()
    assert after["token_saved"] is True and after["display_name"] == "Maker"


@pytest.mark.asyncio
async def test_build_plate_in_profile_api(auth_client, entities):
    client, csrf = auth_client
    created = await client.post(
        f"/api/v1/filaments/{entities['fil'].id}/printer-profiles",
        json={"printer_id": entities["printer"].id, "profile_name": "BP", "build_plate": "Cool Plate"},
        headers=_h(csrf),
    )
    assert created.status_code == 201 and created.json()["build_plate"] == "Cool Plate"


# ─── changed / payload_hash ───────────────────────────────────────────────


async def _listed(client, type_, local_id):
    resp = await client.get(f"{BASE}/contributions", params={"entity_type": type_, "local_id": local_id})
    assert resp.status_code == 200, resp.text
    return resp.json()["items"][0]


@pytest.mark.asyncio
async def test_changed_flag_follows_local_values(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["changed"] is False
    assert (await _listed(client, "manufacturer", entities["mfr"].id))["changed"] is False

    entities["mfr"].name = "Acme Renamed"
    await db_session.commit()
    assert (await _listed(client, "manufacturer", entities["mfr"].id))["changed"] is True


@pytest.mark.asyncio
async def test_link_sets_payload_hash(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches = {"manufacturer": [{"id": 11, "score": 0.8}]}
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id, action="link", match_id=11)
    assert resp.status_code == 200, resp.text
    row = await db_session.scalar(
        select(FilamentDBContribution).where(FilamentDBContribution.local_id == entities["mfr"].id)
    )
    assert row.payload_hash and len(row.payload_hash) == 64
    assert resp.json()["changed"] is False


@pytest.mark.asyncio
async def test_no_changes_reply_marks_row_in_sync(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["fil"].custom_fields = {"filamentdb_id": 9}
    await db_session.commit()
    fake_db.fail["POST /contribute"] = (422, {"code": "no_changes", "message": "same"})
    resp = await _submit(client, csrf, "filament", entities["fil"].id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["changed"] is False and body["no_changes"] is True
    assert body["status"] != "error" and body["last_error"] is None
    assert (await _listed(client, "filament", entities["fil"].id))["changed"] is False


@pytest.mark.asyncio
async def test_approval_without_local_change_stays_in_sync(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    fake_db.approve(resp.json()["remote_submission_id"], 42)
    listed = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    assert listed[0]["status"] == "approved" and listed[0]["changed"] is False


@pytest.mark.asyncio
async def test_approval_keeps_local_change_made_during_review(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await _submit(client, csrf, "manufacturer", entities["mfr"].id)
    entities["mfr"].name = "Acme Renamed"
    await db_session.commit()
    fake_db.approve(resp.json()["remote_submission_id"], 42)
    listed = (await client.post(f"{BASE}/contributions/refresh", headers=_h(csrf))).json()["items"]
    assert listed[0]["status"] == "approved" and listed[0]["changed"] is True


@pytest.mark.asyncio
async def test_resolve_material_id_pages_with_max_page_size(monkeypatch):
    from app.services import filamentdb_contribution_service as svc

    calls = []
    size = svc.FDB_MAX_PAGE_SIZE

    async def fake_request(method, path, params=None, **kwargs):
        calls.append(dict(params))
        if params["page"] == 1:
            return {"items": [{"id": i, "name": f"X{i}", "key": f"x{i}"} for i in range(size)], "total": size + 1}
        return {"items": [{"id": 999, "name": "PETG", "key": "petg"}], "total": size + 1}

    monkeypatch.setattr(svc, "fdb_request", fake_request)
    assert await svc._resolve_material_id("PETG") == 999
    assert [c["page"] for c in calls] == [1, 2]
    assert all(c["page_size"] <= 200 for c in calls)


@pytest.mark.asyncio
async def test_preview_blocker_carries_ids_for_links(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["profile"].printer_manufacturer = None
    entities["profile"].printer_model = None
    await db_session.commit()
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "print_profile", "local_id": entities["profile"].id},
        headers=_h(csrf),
    )
    blocker = next(b for b in resp.json()["blockers"] if b["code"] == "printer_model_missing")
    assert blocker["profile_id"] == entities["profile"].id
    assert blocker["filament_id"] == entities["fil"].id
    assert blocker["printer_id"] == entities["printer"].id


@pytest.mark.asyncio
async def test_profile_model_link_applies_to_profiles_not_printers(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches = {"printer_model": [{"id": 13, "score": 0.8}]}
    resp = await _submit(
        client, csrf, "printer_model", -entities["profile"].id, action="link", match_id=13
    )
    assert resp.status_code == 200, resp.text
    for obj in entities.values():
        await db_session.refresh(obj)
    assert entities["profile"].filamentdb_printer_model_id == 13
    # Profil-Link läuft unter filaments:update und darf keine Drucker ändern
    assert entities["printer"].filamentdb_printer_model_id is None


@pytest.mark.parametrize("name", ["eeff00", "#EEFF00", "ffe100", "abc", "#ABC", "11223344", " eeff00 "])
def test_hex_only_names_are_detected(name):
    from app.services.filamentdb_contribution_service import is_hex_only_name

    assert is_hex_only_name(name)


@pytest.mark.parametrize("name", ["Rot", "Yellow Fluorescent", "beef", "eeff0", "eeff000", "ggg", "", None, "Fade"])
def test_real_names_are_not_hex_only(name):
    from app.services.filamentdb_contribution_service import is_hex_only_name

    assert not is_hex_only_name(name)


@pytest.mark.asyncio
async def test_hex_only_color_names_are_not_sent(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["mfr"].custom_fields = {"filamentdb_id": 7}
    entities["fil"].manufacturer_color_name = "eeff00"
    color = Color(name="eeff00", hex_code="#EEFF00")
    db_session.add(color)
    await db_session.flush()
    db_session.add(FilamentColor(filament_id=entities["fil"].id, color_id=color.id, position=2))
    await db_session.commit()
    resp = await client.post(
        f"{BASE}/contributions/preview",
        json={"type": "filament", "local_id": entities["fil"].id},
        headers=_h(csrf),
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()["payload"]
    assert "color_name" not in payload
    assert payload["colors"][0]["color_name"] == "Rot"
    assert payload["colors"][1] == {"hex_code": "#eeff00", "position": 2}


@pytest.mark.asyncio
async def test_import_same_community_profile_twice_is_409(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    fake_db.profiles[7] = {"id": 7, "nozzle_temp_c": 210}
    body = {"filament_id": entities["fil"].id, "printer_id": entities["printer"].id}
    first = await client.post(f"{BASE}/print-profiles/7/import", json=body, headers=_h(csrf))
    assert first.status_code == 201, first.text
    second = await client.post(f"{BASE}/print-profiles/7/import", json=body, headers=_h(csrf))
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "already_imported"

    # Wurde das lokale Profil gelöscht, ist die Übernahme wieder möglich.
    created = await db_session.get(FilamentPrinterProfile, first.json()["id"])
    await db_session.delete(created)
    await db_session.commit()
    third = await client.post(f"{BASE}/print-profiles/7/import", json=body, headers=_h(csrf))
    assert third.status_code == 201, third.text


@pytest.mark.asyncio
async def test_suggest_build_plate_submits_when_no_duplicate(auth_client, fake_db):
    client, csrf = auth_client
    await _save_token(client, csrf)
    resp = await client.post(f"{BASE}/build-plates/suggest", json={"name": " Textured PEI "}, headers=_h(csrf))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "submitted"}
    assert fake_db.sent("POST", "/contribute/check")[-1] == {
        "type": "build_plate",
        "data": {"name": "Textured PEI"},
    }
    sent = fake_db.sent("POST", "/contribute")
    assert len(sent) == 1 and sent[0]["type"] == "build_plate" and sent[0]["data"] == {"name": "Textured PEI"}


@pytest.mark.asyncio
async def test_suggest_build_plate_reports_strong_duplicate(auth_client, fake_db):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches["build_plate"] = [{"type": "build_plate", "id": 4, "label": "Textured PEI", "score": 0.97}]
    resp = await client.post(f"{BASE}/build-plates/suggest", json={"name": "textured pei"}, headers=_h(csrf))
    assert resp.status_code == 200
    assert resp.json() == {"status": "duplicate", "match": {"id": 4, "name": "Textured PEI", "score": 0.97}}
    assert fake_db.sent("POST", "/contribute") == []

    fake_db.matches["build_plate"] = [{"type": "build_plate", "id": 5, "label": "Other", "score": 0.4}]
    weak = await client.post(f"{BASE}/build-plates/suggest", json={"name": "Glass"}, headers=_h(csrf))
    assert weak.json() == {"status": "submitted"}


@pytest.mark.asyncio
async def test_suggest_build_plate_validation_and_permission(auth_client, fake_db):
    client, csrf = auth_client
    await _save_token(client, csrf)
    for bad in ("", "x" * 101):
        resp = await client.post(f"{BASE}/build-plates/suggest", json={"name": bad}, headers=_h(csrf))
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_suggest_build_plate_needs_contribute_permission(viewer_auth_client, fake_db):  # noqa: F811
    viewer, viewer_csrf = viewer_auth_client
    denied = await viewer.post(f"{BASE}/build-plates/suggest", json={"name": "A"}, headers=_h(viewer_csrf))
    assert denied.status_code == 403


# ─── Massenabgleich ───────────────────────────────────────────────────────


async def _bulk(client, csrf, type_="manufacturer", **extra):
    return await client.post(
        f"{BASE}/contributions/bulk-check",
        json={"type": type_, **extra},
        headers=_h(csrf),
    )


@pytest.mark.asyncio
async def test_bulk_check_categories_and_sorting(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    linked_already = Manufacturer(name="Schon da", custom_fields={"filamentdb_id": 9})
    broken = Manufacturer(name="Kaputt")
    db_session.add_all([linked_already, broken])
    await db_session.commit()
    fake_db.matches["manufacturer"] = [
        {"id": 1, "label": "Acme Low", "score": 0.7, "type": "manufacturer"},
        {"id": 2, "label": "Acme", "score": 0.8, "type": "manufacturer"},
    ]
    resp = await _bulk(client, csrf, auto_link_exact=False)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    ids = {i["local_id"] for i in body["items"]}
    assert linked_already.id not in ids
    acme = next(i for i in body["items"] if i["local_id"] == entities["mfr"].id)
    assert acme["category"] == "suggested"
    assert [m["id"] for m in acme["matches"]] == [2, 1]
    assert acme["matches"][0]["label"] == "Acme"
    assert body["counts"]["suggested"] == 2
    assert body["truncated"] is False

    fake_db.matches["manufacturer"] = []
    body = (await _bulk(client, csrf, auto_link_exact=False)).json()
    assert body["counts"]["none"] == 2


@pytest.mark.asyncio
async def test_bulk_check_auto_link_on_and_off(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.matches["manufacturer"] = [
        {"id": 7, "label": "Acme", "score": 1.0, "type": "manufacturer"},
        {"id": 8, "label": "Acme X", "score": 0.7, "type": "manufacturer"},
    ]
    off = (await _bulk(client, csrf, auto_link_exact=False)).json()
    assert off["items"][0]["category"] == "suggested"
    await db_session.refresh(entities["mfr"])
    assert not (entities["mfr"].custom_fields or {}).get("filamentdb_id")

    on = (await _bulk(client, csrf, auto_link_exact=True)).json()
    item = on["items"][0]
    assert item["category"] == "linked" and item["linked_remote_id"] == 7
    await db_session.refresh(entities["mfr"])
    assert entities["mfr"].custom_fields["filamentdb_id"] == 7
    row = (await db_session.scalars(select(FilamentDBContribution))).one()
    assert row.status == "linked"

    # zweiter Lauf: schon verknüpft, wird übersprungen
    again = (await _bulk(client, csrf, auto_link_exact=True)).json()
    assert again["total"] == 0


@pytest.mark.asyncio
async def test_bulk_check_skips_active_submissions_and_marks_blocked(
    auth_client, fake_db, entities, db_session
):
    client, csrf = auth_client
    await _save_token(client, csrf)
    other = Manufacturer(name="Zweiter")
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        FilamentDBContribution(
            entity_type="manufacturer", local_id=other.id, status="pending", created_by=1
        )
    )
    await db_session.commit()
    fake_db.materials = []
    body = (await _bulk(client, csrf, "filament", auto_link_exact=False)).json()
    assert body["counts"]["blocked"] == 1
    item = body["items"][0]
    assert item["category"] == "blocked"
    assert item["blockers"][0]["code"] == "material_unknown"

    mfr_body = (await _bulk(client, csrf, auto_link_exact=False)).json()
    assert [i["local_id"] for i in mfr_body["items"]] == [entities["mfr"].id]


@pytest.mark.asyncio
async def test_bulk_check_filament_with_linked_manufacturer(auth_client, fake_db, entities, db_session):
    client, csrf = auth_client
    await _save_token(client, csrf)
    entities["mfr"].custom_fields = {"filamentdb_id": 3}
    await db_session.commit()
    fake_db.matches["filament"] = [
        {"id": 11, "label": "Acme PLA Rot", "score": 0.995, "type": "filament"}
    ]
    body = (await _bulk(client, csrf, "filament", auto_link_exact=True)).json()
    assert body["items"][0]["category"] == "linked"
    await db_session.refresh(entities["fil"])
    assert entities["fil"].custom_fields["filamentdb_id"] == 11


@pytest.mark.asyncio
async def test_bulk_check_limit_truncates_and_single_error_does_not_abort(
    auth_client, fake_db, entities, db_session
):
    client, csrf = auth_client
    await _save_token(client, csrf)
    db_session.add(Manufacturer(name="Noch einer"))
    await db_session.commit()
    body = (await _bulk(client, csrf, auto_link_exact=False, limit=1)).json()
    assert body["total"] == 1 and body["truncated"] is True

    fake_db.fail["POST /contribute/check"] = (500, {"code": "boom", "message": "kaputt"})
    body = (await _bulk(client, csrf, auto_link_exact=False)).json()
    assert body["counts"]["blocked"] == 2
    assert body["items"][0]["blockers"][0]["code"]


@pytest.mark.asyncio
async def test_bulk_check_invalid_token_aborts(auth_client, fake_db, entities):
    client, csrf = auth_client
    await _save_token(client, csrf)
    fake_db.fail["POST /contribute/check"] = (
        401,
        {"code": "invalid_token", "message": "no"},
    )
    resp = await _bulk(client, csrf, auto_link_exact=False)
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "filamentdb_token_invalid"


@pytest.mark.asyncio
async def test_bulk_check_needs_contribute_permission(viewer_auth_client, fake_db, entities):  # noqa: F811
    client, csrf = viewer_auth_client
    resp = await _bulk(client, csrf, auto_link_exact=True)
    assert resp.status_code == 403
    assert fake_db.requests == []
