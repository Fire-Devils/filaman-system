"""Display API: merge of FilaMan slot assignments and optional driver live state."""

from app.api.v1 import display as display_api
from app.models import PrinterSlotAssignment
from app.services.display_service import (
    SCHEMA_VERSION,
    build_printer_display,
    compute_etag,
    normalize_driver_state,
    normalize_hex_color,
    slots_only,
)
from tests.test_devices import (
    _create_device,
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _device_headers,
    _get_status,
    _register_device,
)
from tests.test_printers import _create_printer, _create_slot


async def _printer_with_spool(db_session, *, slot_index="0-1", present=True):
    printer = await _create_printer(db_session, name="P2S", driver_key="bambuddy")
    slot = await _create_slot(
        db_session, printer.id, slot_no=1, name="AMS 1 - Slot 2", custom_fields={"slot_index": slot_index}
    )
    manufacturer = await _create_manufacturer(db_session, name="SUNLU")
    filament = await _create_filament(db_session, manufacturer.id)
    status = await _get_status(db_session, "opened")
    spool = await _create_spool(
        db_session,
        filament.id,
        status.id,
        initial_total_weight_g=1250.0,
        empty_spool_weight_g=250.0,
        remaining_weight_g=500.0,
        rfid_uid="04:EF:14:10:C8:2A:81",
    )
    db_session.add(PrinterSlotAssignment(slot_id=slot.id, spool_id=spool.id, present=present))
    await db_session.commit()
    return printer, spool


BAMBUDDY_STATUS = {
    "connected": True,
    "gcode_state": "RUNNING",
    "subtask_name": "benchy.3mf",
    "mc_percent": 42,
    "layer_num": 57,
    "total_layer_num": 130,
    "mc_remaining_time": 62,
    "nozzle_temper": 219.6,
    "bed_temper": 60,
    "tray_now": 1,
    "ams": {
        "ams": [
            {
                "id": 0,
                "temp": 25.4,
                "humidity": 3,
                "tray": [
                    {"id": 0, "tray_type": "PETG", "tray_color": "0000FFFF", "remain": 80, "tag_uid": "AAAA"},
                    {"id": 1, "tray_type": "PLA", "tray_color": "F8A813FF", "remain": 20},
                    {"id": 2},
                    {"id": 3},
                ],
            },
            {"id": 128, "temp": 40.0, "humidity": 1, "tray": [{"id": 0, "tray_type": "PA", "tray_color": "111111FF"}]},
        ]
    },
    "hms": [{"code": "0x0500", "msg": "Nozzle clog"}],
}


# ---------------------------------------------------------------------------
# pure functions
# ---------------------------------------------------------------------------


def test_normalize_hex_color():
    assert normalize_hex_color("f8a813ff") == "#F8A813"
    assert normalize_hex_color("#F8A813") == "#F8A813"
    assert normalize_hex_color("") == "#202020"
    assert normalize_hex_color("nope") == "#202020"


def test_normalize_bambuddy_status():
    live = normalize_driver_state(BAMBUDDY_STATUS)
    assert live["connected"] is True
    assert live["state"] == "RUNNING"
    assert live["job"] == {"name": "benchy.3mf", "progress": 42, "layer": 57, "total_layers": 130, "remaining_seconds": 3720}
    assert live["temperatures"]["nozzle"] == 220 and live["temperatures"]["bed"] == 60
    assert live["active_tray"] == 1
    assert live["hms"] == [{"code": "0x0500", "message": "Nozzle clog"}]
    assert [u["ams_id"] for u in live["ams"]] == [0, 128]
    assert live["ams"][1]["kind"] == "ams_ht"
    tray0 = live["ams"][0]["slots"][0]
    assert tray0["color"] == "#0000FF" and tray0["rfid"] is True and tray0["remaining_percent"] == 80


def test_normalize_documented_shape():
    live = normalize_driver_state(
        {
            "connected": False,
            "state": "IDLE",
            "job": {"name": "x", "progress": 5, "remaining_seconds": 90},
            "temperatures": {"nozzle": 30, "bed": 25},
            "active_tray": 254,
            "ams": [{"ams_id": 1, "slots": [{"slot": 2, "material": "TPU", "color": "#ABCDEF"}]}],
        }
    )
    assert live["connected"] is False
    assert live["job"]["remaining_seconds"] == 90
    assert live["active_tray"] is None
    assert live["ams"][0]["slots"][0]["color"] == "#ABCDEF"


class _P:
    def __init__(self, id=11, name="P2S", driver_key="bambuddy"):
        self.id, self.name, self.driver_key = id, name, driver_key


def test_build_without_driver_state_uses_assignments_only():
    fm = {(0, 1): {"present": True, "spool_id": 5, "material": "PLA", "color": "#F8A813", "color_name": "Orange",
                   "manufacturer": "SUNLU", "filament": "PLA Plus", "remaining_percent": 50, "remaining_grams": 500,
                   "nozzle_min": 190, "nozzle_max": 230, "rfid": True, "last_used": None}}
    out = build_printer_display(_P(), fm, None)
    assert out["connected"] is None and out["job"] is None and out["state"] == "unknown"
    assert [u["label"] for u in out["ams"]] == ["AMS A"]
    slots = out["ams"][0]["slots"]
    assert [s["label"] for s in slots] == ["A1", "A2", "A3", "A4"]
    assert slots[1]["empty"] is False and slots[1]["spool_id"] == 5 and slots[1]["remaining_source"] == "filaman"
    assert slots[0]["empty"] is True and slots[0]["color"] == "#202020"
    assert out["active"] is None


def test_build_merges_live_and_filaman_and_marks_backup():
    fm = {
        (0, 1): {"present": True, "spool_id": 5, "material": "PLA", "color": "#F8A813", "color_name": "Orange",
                 "manufacturer": "SUNLU", "filament": "PLA Plus", "remaining_percent": 50, "remaining_grams": 500,
                 "nozzle_min": None, "nozzle_max": None, "rfid": False, "last_used": None},
        (0, 3): {"present": True, "spool_id": 6, "material": "PLA", "color": "#F8A813", "color_name": "Orange",
                 "manufacturer": "SUNLU", "filament": "PLA Plus", "remaining_percent": 90, "remaining_grams": 900,
                 "nozzle_min": None, "nozzle_max": None, "rfid": False, "last_used": None},
    }
    out = build_printer_display(_P(), fm, BAMBUDDY_STATUS)
    assert out["connected"] is True and out["job"]["progress"] == 42
    assert [u["label"] for u in out["ams"]] == ["AMS A", "HT1"]
    a = out["ams"][0]["slots"]
    # slot 0: printer sees PETG, FilaMan has no spool -> non-empty, printer remaining
    assert a[0]["empty"] is False and a[0]["spool_id"] is None
    assert a[0]["material"] == "PETG" and a[0]["remaining_source"] == "printer" and a[0]["remaining_percent"] == 80
    # slot 1: FilaMan spool wins over tray data, active via tray_now
    assert a[1]["spool_id"] == 5 and a[1]["remaining_percent"] == 50 and a[1]["active"] is True
    assert out["active"] == {"ams_id": 0, "slot": 1}
    # backups: A2 and A4 share PLA orange
    assert a[1]["backup_of"] == "A4" and a[3]["backup_of"] == "A2"
    # HT unit: single slot, label HT1
    ht = out["ams"][1]
    assert ht["kind"] == "ams_ht" and [s["label"] for s in ht["slots"]] == ["HT1"]
    assert any(al["id"] == "hms-0x0500" for al in out["alerts"])


def test_slots_projection_and_etag_ignore_timestamp():
    out = build_printer_display(_P(), {}, BAMBUDDY_STATUS)
    small = slots_only(out)
    assert set(small) == {"id", "name", "connected", "state", "active", "ams"}
    assert set(small["ams"][0]["slots"][0]) == {"slot", "label", "empty", "active", "color", "material", "remaining_percent", "spool_id"}
    a = {"schema_version": SCHEMA_VERSION, "generated_at": "t1", "printers": [out]}
    b = {"schema_version": SCHEMA_VERSION, "generated_at": "t2", "printers": [out]}
    assert compute_etag(a) == compute_etag(b)


# ---------------------------------------------------------------------------
# endpoint
# ---------------------------------------------------------------------------


class TestDisplayEndpoint:
    async def test_requires_auth(self, client):
        response = await client.get("/api/v1/display")
        assert response.status_code == 401

    async def test_user_gets_board_from_assignments(self, auth_client, db_session):
        client, _ = auth_client
        printer, spool = await _printer_with_spool(db_session)

        response = await client.get("/api/v1/display")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["schema_version"] == SCHEMA_VERSION
        [p] = body["printers"]
        assert p["id"] == printer.id and p["name"] == "P2S" and p["connected"] is None
        slot = p["ams"][0]["slots"][1]
        assert slot["spool_id"] == spool.id
        assert slot["manufacturer"] == "SUNLU" and slot["remaining_grams"] == 500
        assert slot["remaining_percent"] == 50 and slot["rfid"] is True
        assert slot["label"] == "A2"

    async def test_etag_304_and_slots_projection(self, auth_client, db_session):
        client, _ = auth_client
        await _printer_with_spool(db_session)

        first = await client.get("/api/v1/display", params={"fields": "slots"})
        assert first.status_code == 200
        etag = first.headers["etag"]
        assert set(first.json()["printers"][0]) == {"id", "name", "connected", "state", "active", "ams"}

        again = await client.get("/api/v1/display", params={"fields": "slots"}, headers={"If-None-Match": etag})
        assert again.status_code == 304
        assert again.headers["etag"] == etag

    async def test_driver_live_state_is_merged(self, auth_client, db_session, monkeypatch):
        client, _ = auth_client
        printer, _ = await _printer_with_spool(db_session)

        async def fake_state(p):
            return BAMBUDDY_STATUS if p.id == printer.id else None

        monkeypatch.setattr(display_api, "_driver_state", fake_state)
        response = await client.get(f"/api/v1/display/printers/{printer.id}")
        assert response.status_code == 200, response.text
        [p] = response.json()["printers"]
        assert p["connected"] is True and p["job"]["name"] == "benchy.3mf"
        assert p["active"] == {"ams_id": 0, "slot": 1}
        assert p["ams"][0]["slots"][1]["active"] is True

    async def test_unknown_printer_404(self, auth_client):
        client, _ = auth_client
        response = await client.get("/api/v1/display/printers/9999")
        assert response.status_code == 404

    async def test_device_token_with_scope(self, auth_client, db_session):
        client, csrf = auth_client
        await _printer_with_spool(db_session)
        await _create_device(db_session, device_code="DISP01", scopes=["display:read"])
        token, _ = await _register_device(client, "DISP01", csrf)
        client.cookies.clear()  # drop the admin session: authenticate as the device only

        response = await client.get("/api/v1/display", headers=_device_headers(token))
        assert response.status_code == 200, response.text
        assert response.json()["printers"][0]["ams"][0]["slots"][1]["spool_id"] is not None

    async def test_device_token_without_scope_is_forbidden(self, auth_client, db_session):
        client, csrf = auth_client
        await _create_device(db_session, device_code="DISP02", scopes=["spools:read"])
        token, _ = await _register_device(client, "DISP02", csrf)
        client.cookies.clear()  # drop the admin session: authenticate as the device only

        response = await client.get("/api/v1/display", headers=_device_headers(token))
        assert response.status_code == 403, response.text
