"""Display API: merge of FilaMan slot assignments and optional driver live state."""

from app.api.v1 import display as display_api
from app.models import Filament, FilamentPrinterParam, PrinterSlotAssignment, SpoolPrinterParam
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
    filament.manufacturer_color_name = "Oak"
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
            {"id": 255, "tray": [{"id": 0}]},
        ]
    },
    "hms": [{"code": "0x0500", "msg": "Nozzle clog"}],
}


# ---------------------------------------------------------------------------
# pure functions
# ---------------------------------------------------------------------------


def test_spool_swatch_uses_manufacturer_color_name():
    """The board must show Filament.manufacturer_color_name, not Color.name."""
    from types import SimpleNamespace

    from app.services.display_service import _spool_swatch

    filament = SimpleNamespace(
        designation="PETG",
        material_type="PETG",
        manufacturer_color_name="Galaxy Blue",
        manufacturer=SimpleNamespace(name="SUNLU"),
        filament_colors=[SimpleNamespace(position=0, color=SimpleNamespace(hex_code="#456DF1", name="#456DF1"))],
        printer_params=[],
        raw_material_weight_g=1000,
    )
    spool = SimpleNamespace(
        id=91,
        filament=filament,
        remaining_weight_g=70,
        initial_total_weight_g=1250,
        empty_spool_weight_g=250,
        rfid_uid="AA",
        rfid_uid_2=None,
        last_used_at=None,
        printer_params=[],
    )
    out = _spool_swatch(spool, printer_id=1)
    assert out["color_name"] == "Galaxy Blue"
    assert out["color"] == "#456DF1"

    filament.manufacturer_color_name = "  "
    assert _spool_swatch(spool, printer_id=1)["color_name"] == ""


def test_normalize_hex_color():
    assert normalize_hex_color("f8a813ff") == "#F8A813"
    assert normalize_hex_color("#F8A813") == "#F8A813"
    assert normalize_hex_color("") == "#202020"
    assert normalize_hex_color("nope") == "#202020"


def test_canonicalize_external_vt_ids():
    from app.services.display_service import canonicalize_slot_key

    assert canonicalize_slot_key(255, 0) == (255, 0)
    assert canonicalize_slot_key(255, 1) == (255, 1)
    assert canonicalize_slot_key(255, 254) == (255, 0)
    assert canonicalize_slot_key(255, 255) == (255, 1)
    assert canonicalize_slot_key(254, 0) == (255, 0)
    assert canonicalize_slot_key(0, 2) == (0, 2)


def test_x1c_string_temp_and_humidity_are_parsed():
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": {
                "ams": [
                    {
                        "id": "0",
                        "humidity": "4",
                        "temp": "26.5",
                        "tray": [{"id": "0", "tray_type": "PLA"}],
                    }
                ]
            },
        }
    )
    unit = live["ams"][0]
    assert unit["temperature"] == 26.5
    assert unit["humidity"] == 4


def test_x1c_prefers_humidity_raw_percent():
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [
                {"id": 0, "humidity": 4, "humidity_raw": 23, "temp": 25.0, "tray": []},
            ],
        }
    )
    unit = live["ams"][0]
    assert unit["humidity"] == 23
    assert unit["temperature"] == 25.0


def test_x1c_wrapper_climate_fills_tray_only_units():
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": {
                "ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PLA"}]}],
                "humidity": "16",
                "temp": "24.2",
                "tray_now": "255",
            },
        }
    )
    unit = live["ams"][0]
    assert unit["temperature"] == 24.2
    assert unit["humidity"] == 16


def test_driver_ams_units_climate_matches_printers_page():
    """Printers page reads health.ams_units; AMS View must show those numbers."""
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PLA"}]}],
            "ams_units": [{"ams_id": 0, "humidity": 26, "temp": 23.8}],
        }
    )
    assert live["ams"][0]["humidity"] == 26
    assert live["ams"][0]["temperature"] == 23.8


def test_zero_ams_temp_is_not_a_reading():
    live = normalize_driver_state(
        {"connected": True, "ams": [{"id": 0, "temp": "0.0", "humidity": "16", "tray": []}]}
    )
    assert live["ams"][0]["temperature"] is None
    assert live["ams"][0]["humidity"] == 16


def test_h2c_humidity_percent_is_kept():
    live = normalize_driver_state(
        {"connected": True, "ams": [{"id": 0, "temp": 19.5, "humidity": 16, "tray": []}]}
    )
    assert live["ams"][0]["temperature"] == 19.5
    assert live["ams"][0]["humidity"] == 16


def test_extract_trays_accepts_dict_and_single_object():
    from app.services.display_service import extract_trays

    assert extract_trays({"tray": {"0": {"tray_type": "PLA", "tray_color": "FF0000FF"}}})[0]["tray_type"] == "PLA"
    assert extract_trays({"tray": {"id": 0, "tray_type": "PETG"}})[0]["tray_type"] == "PETG"


def test_exists_without_tray_type_is_loaded():
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [{"id": 128, "is_ams_ht": True, "tray": [{"id": 0, "state": 9, "exists": True}]}],
        }
    )
    ht = live["ams"][0]["slots"][0]
    assert ht["has_filament"] is True


def test_legacy_external_keys_collapse_to_two_bays():
    """H2C once stored both 255-0/1 and mistaken 255-254/255 — board must show Ext1/Ext2 only."""
    fm = {
        (255, 0): {"present": True, "spool_id": 10, "material": "PLA", "color": "#FF0000",
                   "color_name": "Red", "manufacturer": "X", "filament": "PLA", "remaining_percent": 40,
                   "remaining_grams": 400, "nozzle_min": None, "nozzle_max": None, "rfid": False, "last_used": None},
        (255, 1): {"present": False},
        (255, 254): {"present": False},
        (255, 255): {"present": False},
    }
    out = build_printer_display(_P(name="H2C"), fm, None)
    ext = [u for u in out["ams"] if u["kind"] == "external"]
    assert len(ext) == 1
    assert [s["label"] for s in ext[0]["slots"]] == ["Ext1", "Ext2"]
    assert ext[0]["slots"][0]["spool_id"] == 10
    assert ext[0]["slots"][1]["empty"] is True


def test_normalize_preserves_trayless_units():
    """A thin status update must not make an already-known AMS disappear."""
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [
                {"id": 0, "temp": 25.0, "humidity": 3, "tray": []},
                {"id": 128, "is_ams_ht": True, "tray": []},
            ],
        }
    )

    assert [(u["ams_id"], u["kind"]) for u in live["ams"]] == [
        (0, "ams"),
        (128, "ams_ht"),
    ]
    assert live["ams"][0]["temperature"] == 25.0
    assert live["ams"][0]["slots"] == []
    assert live["ams"][1]["slots"] == []


def test_top_level_external_data_replaces_embedded_placeholder():
    """H2 status can contain an empty AMS entry and richer vt_tray for the same bay."""
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [{"id": 255, "tray": [{"id": 0}]}],
            "vt_tray": [
                {
                    "id": 254,
                    "tray_type": "PETG",
                    "tray_color": "FF0000FF",
                    "remain": 65,
                }
            ],
        }
    )

    [external] = [u for u in live["ams"] if u["kind"] == "external"]
    assert [s["slot"] for s in external["slots"]] == [0]
    assert external["slots"][0]["has_filament"] is True
    assert external["slots"][0]["material"] == "PETG"
    assert external["slots"][0]["color"] == "#FF0000"
    assert external["slots"][0]["remaining_percent"] == 65


def test_empty_duplicate_does_not_replace_loaded_external_data():
    """Duplicate-source ordering must not let a placeholder erase a loaded bay."""
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [
                {
                    "id": 255,
                    "tray": [
                        {
                            "id": 0,
                            "tray_type": "PLA",
                            "tray_color": "0000FFFF",
                            "remain": 80,
                        }
                    ],
                }
            ],
            "vt_tray": [{"id": 254}],
        }
    )

    [external] = [u for u in live["ams"] if u["kind"] == "external"]
    assert external["slots"][0]["has_filament"] is True
    assert external["slots"][0]["material"] == "PLA"
    assert external["slots"][0]["remaining_percent"] == 80


def test_normalize_bambuddy_status():
    live = normalize_driver_state(BAMBUDDY_STATUS)
    assert live["connected"] is True
    assert live["state"] == "RUNNING"
    assert live["job"] == {"name": "benchy.3mf", "progress": 42, "layer": 57, "total_layers": 130, "remaining_seconds": 3720}
    assert live["temperatures"]["nozzle"] == 220 and live["temperatures"]["bed"] == 60
    assert live["active_tray"] == 1
    assert live["hms"] == [{"code": "0x0500", "message": "Nozzle clog"}]
    assert [u["ams_id"] for u in live["ams"]] == [0, 128, 255]
    assert [u["kind"] for u in live["ams"]] == ["ams", "ams_ht", "external"]
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


def test_idle_dry_status_is_not_drying():
    """AMS 2 Pro / HT always send dry_status=0; that is idle, not a cycle."""
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [
                {
                    "id": 0,
                    "dry_status": 0,
                    "dry_time": 0,
                    "dry_target_temp": None,
                    "tray": [{"id": 0, "tray_type": "PLA"}],
                },
                {
                    "id": 128,
                    "is_ams_ht": True,
                    "dry_status": 0,
                    "dry_time": 0,
                    "tray": [{"id": 0, "tray_type": "PLA"}],
                },
            ],
        }
    )
    assert all(u["drying"] is None for u in live["ams"])


def test_active_dry_status_is_drying():
    live = normalize_driver_state(
        {
            "connected": True,
            "ams": [
                {
                    "id": 0,
                    "dry_status": 2,
                    "dry_time": 90,
                    "dry_target_temp": 55,
                    "tray": [{"id": 0, "tray_type": "PLA"}],
                }
            ],
        }
    )
    assert live["ams"][0]["drying"] == {"status": 2, "target_temp": 55.0, "time": 90}


def test_normalize_ht_tray_now_is_unit_id():
    """H2D reports AMS-HT as tray_now=128, not ams*4+slot."""
    live = normalize_driver_state({"connected": True, "tray_now": 128, "ams": []})
    assert live["active_tray"] == 128


class _P:
    def __init__(self, id=11, name="P2S", driver_key="bambuddy"):
        self.id, self.name, self.driver_key = id, name, driver_key


def test_ams_units_climate_fills_filaman_only_board():
    fm = {(0, 0): {"present": True, "material": "PLA", "color": "#111111"}}
    out = build_printer_display(
        _P(name="X1C"),
        fm,
        {"connected": True, "ams": [], "ams_units": [{"ams_id": 0, "humidity": 16, "temp": 26.8}]},
    )
    assert out["ams"][0]["humidity"] == 16
    assert out["ams"][0]["temperature"] == 26.8


def test_unlinked_ht_meta_fills_empty_live_unit():
    """H2C HT often has driver tray_type in assignment.meta but no FilaMan spool.

    A thin status still lists the HT unit (climate / empty tray[]), which used
    to paint an empty HT1/HT2 while the printer page showed PLA.
    """
    fm = {
        (128, 0): {"present": True, "material": "PLA", "color": "#00FF00"},
        (129, 1): {"present": True, "material": "PETG", "color": "#0000FF"},
    }
    status = {
        "connected": True,
        "ams": [
            {"id": 128, "is_ams_ht": True, "temp": 45.0, "humidity": 2, "tray": []},
            {"id": 129, "is_ams_ht": True, "temp": 40.0, "humidity": 1, "tray": []},
        ],
    }
    out = build_printer_display(_P(name="H2C"), fm, status)
    hts = [u for u in out["ams"] if u["kind"] == "ams_ht"]
    assert [(u["label"], u["slots"][0]["material"], u["slots"][0]["empty"]) for u in hts] == [
        ("HT1", "PLA", False),
        ("HT2", "PETG", False),
    ]
    assert all(len(u["slots"]) == 1 and u["slots"][0]["slot"] == 0 for u in hts)


def test_ht_tray_now_marks_ht_bay():
    status = {
        "connected": True,
        "gcode_state": "RUNNING",
        "tray_now": 128,
        "ams": {
            "ams": [
                {"id": 0, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "FF0000FF"}]},
                {"id": 128, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "FFFFFFFF"}]},
            ]
        },
    }
    out = build_printer_display(_P(), {}, status)
    assert out["active"] == {"ams_id": 128, "slot": 0}
    ht = next(u for u in out["ams"] if u["ams_id"] == 128)
    assert ht["slots"][0]["active"] is True
    assert out["ams"][0]["slots"][0]["active"] is False


def test_extruder_slots_select_active_nozzle_over_slot_only_tray_now():
    """Dual-nozzle H2D tray_now is often just 0–3; Bambuddy already decoded the bay."""
    status = {
        "connected": True,
        "gcode_state": "RUNNING",
        "tray_now": 3,
        "active_extruder": 1,
        "extruder_slots": {
            "0": {"ams_id": 0, "slot_id": 3, "has_filament": True},
            "1": {"ams_id": 128, "slot_id": 0, "has_filament": True},
        },
        "ams": {
            "ams": [
                {"id": 0, "tray": [{"id": 3, "tray_type": "PLA", "tray_color": "111111FF"}]},
                {"id": 128, "tray": [{"id": 0, "tray_type": "PLA", "tray_color": "FFFFFFFF"}]},
            ]
        },
    }
    out = build_printer_display(_P(), {}, status)
    assert out["active"] == {"ams_id": 128, "slot": 0}
    assert next(u for u in out["ams"] if u["ams_id"] == 128)["slots"][0]["active"] is True
    assert out["ams"][0]["slots"][3]["active"] is False


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
    assert [u["label"] for u in out["ams"]] == ["AMS A", "HT1", "External"]
    ext = out["ams"][2]
    assert ext["kind"] == "external" and [s["label"] for s in ext["slots"]] == ["Ext1"] and ext["slots"][0]["empty"]
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

    async def test_unlinked_ht_assignment_meta_populates_board(self, auth_client, db_session):
        client, _ = auth_client
        printer = await _create_printer(db_session, name="H2C", driver_key="bambuddy")
        slot = await _create_slot(
            db_session,
            printer.id,
            slot_no=512,
            name="AMS HT 1 Slot 1",
            custom_fields={"slot_index": "128-0"},
        )
        slot.assignment = PrinterSlotAssignment(
            present=True,
            meta={"tray_type": "PLA", "tray_color": "00FF00FF", "nozzle_temp_min": 190, "nozzle_temp_max": 220},
        )
        db_session.add(slot.assignment)
        await db_session.commit()

        response = await client.get("/api/v1/display")
        assert response.status_code == 200, response.text
        [p] = response.json()["printers"]
        ht = next(u for u in p["ams"] if u["kind"] == "ams_ht")
        bay = ht["slots"][0]
        assert bay["empty"] is False
        assert bay["material"] == "PLA"
        assert bay["color"] == "#00FF00"
        assert bay["spool_id"] is None
        assert bay["nozzle_min"] == 190 and bay["nozzle_max"] == 220

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
        assert slot["manufacturer"] == "SUNLU" and slot["color_name"] == "Oak"
        assert slot["remaining_grams"] == 500
        assert slot["remaining_percent"] == 50 and slot["rfid"] is True
        assert slot["label"] == "A2"
        assert slot["nozzle_min"] is None and slot["nozzle_max"] is None

    async def test_nozzle_temps_come_from_printer_params(self, auth_client, db_session):
        client, _ = auth_client
        printer, spool = await _printer_with_spool(db_session)
        db_session.add_all(
            [
                FilamentPrinterParam(
                    filament_id=spool.filament_id,
                    printer_id=printer.id,
                    param_key="bambu_nozzle_temp_min",
                    param_value="190",
                ),
                FilamentPrinterParam(
                    filament_id=spool.filament_id,
                    printer_id=printer.id,
                    param_key="bambu_nozzle_temp_max",
                    param_value="230",
                ),
                SpoolPrinterParam(
                    spool_id=spool.id,
                    printer_id=printer.id,
                    param_key="bambu_nozzle_temp_max",
                    param_value="240",
                ),
            ]
        )
        await db_session.commit()

        response = await client.get(f"/api/v1/display/printers/{printer.id}")
        assert response.status_code == 200, response.text
        slot = response.json()["printers"][0]["ams"][0]["slots"][1]
        assert slot["nozzle_min"] == 190
        assert slot["nozzle_max"] == 240

    async def test_remaining_percent_falls_back_to_filament_net_weight(self, auth_client, db_session):
        client, _ = auth_client
        printer, spool = await _printer_with_spool(db_session)
        spool.initial_total_weight_g = None
        spool.remaining_weight_g = 250.0
        filament = await db_session.get(Filament, spool.filament_id)
        filament.raw_material_weight_g = 1000.0
        await db_session.commit()

        response = await client.get(f"/api/v1/display/printers/{printer.id}")
        assert response.status_code == 200, response.text
        slot = response.json()["printers"][0]["ams"][0]["slots"][1]
        assert slot["remaining_percent"] == 25 and slot["remaining_grams"] == 250

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
