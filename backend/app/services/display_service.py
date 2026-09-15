"""Display API: one read-only feed for dashboards and digital swatch boards.

Anyone building a wall display, an e-paper swatch panel or a tablet kiosk
polls ``GET /api/v1/display`` and gets, per printer, every AMS unit and slot
with the loaded filament's colour, material, manufacturer and remaining
amount, plus a small printer/job summary.  Nothing here knows about a
particular piece of hardware; formatting (locale, clocks, thresholds) is the
client's job, so the feed carries raw numbers only.

Two data sources are merged:

* **FilaMan itself** — ``printer_slots`` + ``printer_slot_assignments`` say
  which spool sits in which slot.  This alone yields a swatch board, even for
  a printer whose driver reports nothing live.
* **The printer driver (optional)** — a driver may implement
  ``get_display_state()`` returning live tray/job/temperature data (see
  :func:`normalize_driver_state` for the accepted shape).  The Bambuddy
  driver hands back the raw Bambuddy printer status; the extractor is
  tolerant of that shape and of the documented normalised one.

Schema version 3.  Bump when a field changes meaning; adding fields is free.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Filament, FilamentColor, Printer, PrinterSlot, PrinterSlotAssignment, Spool

_NOZZLE_MIN_KEY = "bambu_nozzle_temp_min"
_NOZZLE_MAX_KEY = "bambu_nozzle_temp_max"

SCHEMA_VERSION = 3
DEFAULT_EMPTY_COLOR = "#202020"
AMS_HT_ID_BASE = 128  # Bambu numbers AMS-HT units from 128
EXTERNAL_IDS = {254, 255}  # Bambu: external spool holder / virtual tray
SLOTS_PER_AMS = 4
# BambuStudio DryStatus (bits 4–7 of ams info / dry_status on AMS 2 Pro / HT).
# 0 = off; 1–4 are an in-progress cycle. Idle units still send dry_status=0.
_DRY_STATUS_ACTIVE = {1, 2, 3, 4}  # checking, drying, cooling, stopping


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _first(payload: dict[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return default


def _deep_get(payload: Any, path: tuple[str, ...]) -> Any:
    current = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _as_float(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    f = _as_float(value)
    return int(round(f)) if f is not None else None


def _decode_active_tray(value: int | None) -> tuple[int, int] | None:
    """Map Bambu ``tray_now`` / ``active_tray`` to ``(ams_id, slot)``.

    Regular AMS uses ``ams*4+slot``. AMS-HT units are numbered 128–135, and
    dual-nozzle printers (H2D/H2C) report that id directly when HT is
    feeding — ``divmod(128, 4)`` would look for a phantom AMS 32.
    254/255 mean no tray at this layer (external is encoded elsewhere).
    """
    if value is None or value < 0 or value >= 254:
        return None
    if value >= AMS_HT_ID_BASE:
        return canonicalize_slot_key(value, 0)
    return divmod(value, SLOTS_PER_AMS)


def _encode_active_tray(location: tuple[int, int] | None) -> int | None:
    if location is None:
        return None
    ams_id, slot_no = location
    if ams_id in EXTERNAL_IDS:
        return None
    if ams_id >= AMS_HT_ID_BASE:
        return ams_id
    return ams_id * SLOTS_PER_AMS + slot_no


def _pair_from_extruder_slots(raw: dict[str, Any]) -> tuple[int, int] | None:
    """Bambuddy dual-nozzle status: ``extruder_slots[active_extruder]``."""
    slots = raw.get("extruder_slots")
    if not isinstance(slots, dict):
        return None
    active = _as_int(raw.get("active_extruder"))
    if active is None:
        return None
    entry = slots.get(str(active))
    if entry is None:
        entry = slots.get(active)
    if not isinstance(entry, dict) or entry.get("has_filament") is False:
        return None
    ams_id = _as_int(_first(entry, ("ams_id", "ams")))
    slot_no = _as_int(_first(entry, ("slot_id", "slot", "tray_id", "tray")))
    if ams_id is None or slot_no is None:
        return None
    return canonicalize_slot_key(ams_id, slot_no)


def normalize_hex_color(value: Any, default: str = DEFAULT_EMPTY_COLOR) -> str:
    """``RRGGBB`` / ``#RRGGBB`` / ``RRGGBBAA`` -> ``#RRGGBB`` (upper-case)."""
    if not value:
        return default
    text = str(value).strip().lstrip("#")
    if len(text) >= 6 and all(c in "0123456789abcdefABCDEF" for c in text[:6]):
        return f"#{text[:6].upper()}"
    return default


def ams_letter(ams_id: int) -> str:
    return chr(ord("A") + ams_id) if 0 <= ams_id < 26 else str(ams_id)


def canonicalize_slot_key(ams_id: int, tray: int) -> tuple[int, int]:
    """Map Bambu VT ids onto the FilaMan/Bambuddy external form ``255-{0|1}``.

    Physical virtual trays are numbered 254 / 255. Bambuddy (and FilaMan slot
    indexes) store both under ``ams_id=255`` with tray ``0`` / ``1``. Older
    builds mistakenly persisted ``255-254`` / ``255-255``, which made dual-
    extruder printers show four External bays. Always collapse to the
    canonical pair before merging the board.
    """
    if ams_id == 254:
        if tray in (1, 255):
            return 255, 1
        return 255, 0
    if ams_id == 255:
        if tray == 254:
            return 255, 0
        if tray == 255:
            return 255, 1
        return 255, tray
    return ams_id, tray


def ams_kind(ams_id: int, unit: dict[str, Any] | None = None) -> str:
    """``ams`` (4 slots) | ``ams_ht`` (1 slot) | ``external`` (spool holder)."""
    if ams_id in EXTERNAL_IDS or (unit and unit.get("is_external")):
        return "external"
    if unit and unit.get("is_ams_ht"):
        return "ams_ht"
    return "ams_ht" if ams_id >= AMS_HT_ID_BASE else "ams"


def ams_label(ams_id: int, kind: str) -> str:
    if kind == "external":
        return "External"
    if kind == "ams_ht":
        n = ams_id - AMS_HT_ID_BASE + 1 if ams_id >= AMS_HT_ID_BASE else ams_id + 1
        return f"HT{n}"
    return f"AMS {ams_letter(ams_id)}"


def slot_label(ams_id: int, slot: int, kind: str) -> str:
    if kind == "ams_ht":
        return ams_label(ams_id, kind)
    if kind == "external":
        return f"Ext{slot + 1}"  # dual-extruder printers report several external trays
    return f"{ams_letter(ams_id)}{slot + 1}"


def parse_slot_index(slot: PrinterSlot) -> tuple[int, int]:
    """(ams_id, tray) for a FilaMan printer slot.

    Drivers store ``custom_fields.slot_index = "<ams>-<tray>"``; without it
    the slot number is interpreted as consecutive 4-slot AMS units. External
    VT ids are canonicalised so legacy ``255-254`` / ``255-255`` collapse.
    """
    raw = (slot.custom_fields or {}).get("slot_index")
    if isinstance(raw, str) and "-" in raw:
        a, _, t = raw.partition("-")
        try:
            return canonicalize_slot_key(int(a), int(t))
        except ValueError:
            pass
    return slot.slot_no // SLOTS_PER_AMS, slot.slot_no % SLOTS_PER_AMS


def _prefer_fm_entry(existing: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    """When two PrinterSlots collapse to the same key, keep the richer one."""
    if existing is None:
        return incoming
    if incoming.get("spool_id") is not None and existing.get("spool_id") is None:
        return incoming
    if existing.get("spool_id") is not None and incoming.get("spool_id") is None:
        return existing
    if incoming.get("present") and not existing.get("present"):
        return incoming
    return existing


# ---------------------------------------------------------------------------
# driver state normalisation
# ---------------------------------------------------------------------------


def extract_ams_units(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Find the AMS list in a driver state (normalised or Bambuddy-shaped)."""
    for candidate in (
        state.get("ams"),
        _deep_get(state, ("print", "ams", "ams")),
        _deep_get(state, ("ams", "ams")),
        _deep_get(state, ("print", "ams")),
    ):
        if isinstance(candidate, dict) and isinstance(candidate.get("ams"), list):
            candidate = candidate["ams"]
        elif isinstance(candidate, dict) and isinstance(candidate.get("ams"), dict):
            candidate = [u for u in candidate["ams"].values() if isinstance(u, dict)]
        elif isinstance(candidate, dict) and (
            isinstance(candidate.get("tray"), (list, dict))
            or isinstance(candidate.get("trays"), (list, dict))
            or isinstance(candidate.get("slots"), (list, dict))
        ):
            # Single AMS flattened onto the wrapper (common X1C / one-unit payload).
            return [candidate]
        if isinstance(candidate, list):
            return [u for u in candidate if isinstance(u, dict)]
    return []


def _ams_wrapper(state: dict[str, Any]) -> dict[str, Any] | None:
    """Parent ``ams`` object — X1C often puts humidity/temp here, not on each unit."""
    for candidate in (state.get("ams"), _deep_get(state, ("print", "ams"))):
        if not isinstance(candidate, dict):
            continue
        if isinstance(candidate.get("ams"), (list, dict)) or "tray_now" in candidate or "ams_exist_bits" in candidate:
            return candidate
    return None


def _unit_temperature(*payloads: dict[str, Any] | None) -> float | None:
    """First positive °C. Original AMS / X1C often send ``0`` / ``0.0`` when empty."""
    for payload in payloads:
        if not payload:
            continue
        for key in ("temperature", "temp", "ams_temp"):
            value = _as_float(payload.get(key))
            if value is not None and value > 0:
                return value
    return None


def _unit_humidity(
    *payloads: dict[str, Any] | None,
) -> tuple[float | None, int | None]:
    """``(percent, optional 1–5 level)``.

    Prefer ``humidity_raw`` (sensor %). Otherwise use ``humidity`` the same way
    the Printers page does — Bambuddy already resolves raw→percent into that
    field on ``ams_units``. A leftover 1–5 MQTT index is still a number we can
    show; AMS View must not hide climate the Printers page already displays.
    """
    raw: float | None = None
    humidity: float | None = None
    for payload in payloads:
        if not payload:
            continue
        if raw is None:
            raw = _as_float(_first(payload, ("humidity_raw",)))
        if humidity is None and payload.get("humidity") not in (None, ""):
            humidity = _as_float(payload.get("humidity"))
    if raw is not None and 0 <= raw <= 100:
        level = int(humidity) if humidity is not None and 1 <= humidity <= 5 else None
        return raw, level
    level = int(humidity) if humidity is not None and 1 <= humidity <= 5 else None
    return humidity, level


def _apply_ams_units_climate(
    units_by_id: dict[int, dict[str, Any]],
    raw: dict[str, Any] | None,
) -> None:
    """Stamp Printers-page climate (driver ``ams_units``) onto AMS View units."""
    health = raw.get("ams_units") if isinstance(raw, dict) else None
    if not isinstance(health, list):
        return
    for item in health:
        if not isinstance(item, dict):
            continue
        ams_id = canonicalize_slot_key(_as_int(_first(item, ("ams_id", "id"), 0)) or 0, 0)[0]
        bucket = units_by_id.get(ams_id)
        if bucket is None:
            continue
        temp = _unit_temperature(item)
        humidity, humidity_level = _unit_humidity(item)
        if temp is not None:
            bucket["temperature"] = temp
        if humidity is not None:
            bucket["humidity"] = humidity
        if humidity_level is not None:
            bucket["humidity_level"] = humidity_level


def _unit_drying(unit: dict[str, Any]) -> dict[str, Any] | None:
    """Return drying telemetry only when a cycle is actually running.

    AMS 2 Pro / HT always include ``dry_status`` / ``dry_time`` (0 when idle).
    Treating field presence as “drying” made every unit show the badge.
    """
    status = _as_int(_first(unit, ("dry_status",)))
    time_left = _as_int(_first(unit, ("dry_time", "drying_time", "remaining_drying_time")))
    if status not in _DRY_STATUS_ACTIVE and not (time_left and time_left > 0):
        return None
    return {
        "status": status,
        "target_temp": _as_float(_first(unit, ("dry_target_temp", "drying_temp"))),
        "time": time_left,
    }


def _looks_like_tray(payload: dict[str, Any]) -> bool:
    """True for a single tray object (not a ``{index: tray}`` map)."""
    return any(
        key in payload
        for key in (
            "tray_type",
            "tray_color",
            "material",
            "filament_type",
            "tag_uid",
            "tray_uuid",
            "remain",
            "exists",
            "state",
            "slot",
            "tray_id",
        )
    )


def extract_trays(unit: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("slots", "trays", "tray"):
        trays = unit.get(key)
        if isinstance(trays, list):
            return [t for t in trays if isinstance(t, dict)]
        if isinstance(trays, dict):
            if _looks_like_tray(trays):
                return [trays]
            out: list[dict[str, Any]] = []
            for idx, tray in trays.items():
                if not isinstance(tray, dict):
                    continue
                if "id" not in tray and "slot" not in tray and "tray_id" not in tray:
                    slot_no = _as_int(idx)
                    if slot_no is not None:
                        tray = {**tray, "id": slot_no}
                out.append(tray)
            if out:
                return out
    return []


def _tray_has_filament(tray: dict[str, Any]) -> bool:
    if bool(str(_first(tray, ("material", "tray_type", "filament_type"), "") or "").strip()):
        return True
    state = _as_int(tray.get("state"))
    if state in (11, 12):
        return True
    # H2C/H2D 01.04+ can report a loaded "?" spool with no tray_type. Bambuddy
    # sets ``exists`` from tray_exist_bits; treat that as a filled bay.
    return tray.get("exists") is True and state not in (0, 8)


def _normalize_live_slot(tray: dict[str, Any], slot_no: int) -> dict[str, Any]:
    """Normalize one driver tray without deciding which source should win."""
    return {
        "slot": slot_no,
        "material": str(_first(tray, ("material", "tray_type", "filament_type"), "") or ""),
        "color": normalize_hex_color(_first(tray, ("color", "tray_color", "filament_color")), ""),
        "color_name": str(_first(tray, ("color_name", "tray_id_name", "tray_sub_brands"), "") or ""),
        "remaining_percent": _as_int(_first(tray, ("remaining_percent", "remain"))),
        "nozzle_min": _as_int(_first(tray, ("nozzle_min", "nozzle_temp_min"))),
        "nozzle_max": _as_int(_first(tray, ("nozzle_max", "nozzle_temp_max"))),
        "rfid": any(
            tray.get(k) not in (None, "", 0, "0", "0000000000000000")
            for k in ("tag_uid", "tray_uuid", "rfid_uid")
        ),
        "active": bool(_first(tray, ("active", "is_active"), False)) or tray.get("state") == 27,
        "has_filament": _tray_has_filament(tray),
    }


def _live_slot_quality(slot: dict[str, Any]) -> tuple[int, int, int]:
    """Rank duplicate live representations without depending on source order."""
    details = sum(
        value is not None and value != "" and value is not False
        for value in (
            slot.get("material"),
            slot.get("color"),
            slot.get("color_name"),
            slot.get("remaining_percent"),
            slot.get("nozzle_min"),
            slot.get("nozzle_max"),
            slot.get("rfid"),
        )
    )
    return (
        int(bool(slot.get("has_filament"))),
        details,
        int(bool(slot.get("active"))),
    )


def _prefer_live_slot(
    existing: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> dict[str, Any]:
    """Keep the richer duplicate tray; loaded data always beats a placeholder."""
    if existing is None or _live_slot_quality(incoming) > _live_slot_quality(existing):
        return incoming
    return existing


def normalize_driver_state(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Reduce whatever a driver returned to the documented live-state shape.

    Accepted input keys (first match wins), so a driver can return either the
    normalised shape or Bambu/Bambuddy status verbatim::

        connected            bool
        state                gcode_state | status
        job.name             subtask_name | gcode_file | current_print.filename
        job.progress         progress | mc_percent (0-100)
        job.layer / total    layer_num | current_layer, total_layers | total_layer_num
        job.remaining_sec    remaining_seconds | remaining_time (minutes) | mc_remaining_time
        temperatures.*       temperatures.{nozzle,bed,chamber,*_target} | nozzle_temper ...
        speed_level          speed_level | spd_lvl
        active_tray          extruder_slots[active_extruder] | active_tray | tray_now
                             (ams*4+slot; AMS-HT 128–135 = that unit, slot 0; 254/255 = none)
        hms                  [{code, msg}] | []
        ams[]                ams_id|id, is_ams_ht, temperature|temp, humidity
                             (percent, or 1–5 level on X1C), humidity_raw (%),
                             dry_status, dry_target_temp, dry_time,
                             slots|trays|tray[]: slot|id|tray_id, material|tray_type,
                             color|tray_color, remaining_percent|remain, tag_uid,
                             tray_uuid, nozzle_min|nozzle_temp_min, nozzle_max|
                             nozzle_temp_max, color_name|tray_id_name|tray_sub_brands,
                             active | state==27
    """
    raw = raw or {}
    job_src = raw.get("job") if isinstance(raw.get("job"), dict) else {}
    cur = raw.get("current_print") if isinstance(raw.get("current_print"), dict) else {}
    temps = raw.get("temperatures") if isinstance(raw.get("temperatures"), dict) else {}

    remaining_seconds = _as_int(_first(job_src, ("remaining_seconds",)))
    if remaining_seconds is None:
        minutes = _as_float(
            _first(
                raw,
                ("remaining_seconds",),
                None,
            )
        )
        if minutes is not None:
            remaining_seconds = int(minutes)
        else:
            minutes = _as_float(
                _first(
                    job_src,
                    ("remaining_minutes", "remaining_time"),
                    _first(raw, ("remaining_time", "mc_remaining_time"), _first(cur, ("remaining_time",))),
                )
            )
            remaining_seconds = int(minutes * 60) if minutes is not None else None

    job_name = _first(
        job_src,
        ("name",),
        _first(raw, ("subtask_name", "gcode_file", "task_name"), _first(cur, ("filename", "name", "subtask_name"), "")),
    )
    if isinstance(job_name, dict):
        job_name = _first(job_name, ("filename", "name"), "")

    progress = _as_int(
        _first(job_src, ("progress",), _first(raw, ("progress", "mc_percent"), _first(cur, ("progress",))))
    )
    if progress is not None:
        progress = max(0, min(100, progress))

    active_tray = _as_int(_first(raw, ("active_tray", "tray_now")))
    if active_tray is None:
        active_tray = _as_int(_deep_get(raw, ("ams", "tray_now")))
    active_tray = _encode_active_tray(
        _pair_from_extruder_slots(raw) or _decode_active_tray(active_tray)
    )

    hms_raw = raw.get("hms") or raw.get("hms_errors") or []
    hms: list[dict[str, Any]] = []
    if isinstance(hms_raw, list):
        for item in hms_raw[:10]:
            if isinstance(item, dict):
                hms.append(
                    {
                        "code": str(_first(item, ("code", "full_code", "attr"), "") or ""),
                        "message": str(_first(item, ("msg", "message", "description", "desc"), "") or ""),
                    }
                )
            elif item:
                hms.append({"code": "", "message": str(item)})

    units: list[dict[str, Any]] = []
    units_by_id: dict[int, dict[str, Any]] = {}
    ams_parent = _ams_wrapper(raw)
    for unit in extract_ams_units(raw):
        raw_ams_id = _as_int(_first(unit, ("ams_id", "id"), 0)) or 0
        ams_id = canonicalize_slot_key(raw_ams_id, 0)[0]
        kind = ams_kind(ams_id, unit)
        drying = _unit_drying(unit)
        temperature = _unit_temperature(unit, ams_parent)
        humidity, humidity_level = _unit_humidity(unit, ams_parent)
        bucket = units_by_id.get(ams_id)
        if bucket is None:
            bucket = {
                "ams_id": ams_id,
                "kind": kind,
                "temperature": temperature,
                "humidity": humidity,
                "humidity_level": humidity_level,
                "drying": drying,
                "slots": {},
            }
            units_by_id[ams_id] = bucket
        else:
            if bucket["temperature"] is None:
                bucket["temperature"] = temperature
            if bucket["humidity"] is None:
                bucket["humidity"] = humidity
            if bucket.get("humidity_level") is None:
                bucket["humidity_level"] = humidity_level
            if bucket["drying"] is None:
                bucket["drying"] = drying

        # Remap each tray through canonicalize_slot_key so a unit reported as
        # ams_id=254 (or trays 254/255 under 255) folds into the External card.
        for tray in extract_trays(unit):
            raw_slot = _as_int(_first(tray, ("slot", "id", "tray_id"), 0)) or 0
            _, slot_no = canonicalize_slot_key(raw_ams_id, raw_slot)
            normalized = _normalize_live_slot(tray, slot_no)
            bucket["slots"][slot_no] = _prefer_live_slot(
                bucket["slots"].get(slot_no),
                normalized,
            )

    # Also fold top-level vt_tray[] (H2C dual external). Some status payloads
    # include a placeholder for the same bay under ams[], so select by content
    # quality rather than whichever representation happened to arrive first.
    for vt in raw.get("vt_tray") or []:
        if not isinstance(vt, dict):
            continue
        vt_id = _as_int(_first(vt, ("id", "tray_id"), 254)) or 254
        ams_id, slot_no = canonicalize_slot_key(255, vt_id)
        bucket = units_by_id.get(ams_id)
        if bucket is None:
            bucket = {
                "ams_id": ams_id,
                "kind": "external",
                "temperature": None,
                "humidity": None,
                "humidity_level": None,
                "drying": None,
                "slots": {},
            }
            units_by_id[ams_id] = bucket
        normalized = _normalize_live_slot(vt, slot_no)
        bucket["slots"][slot_no] = _prefer_live_slot(
            bucket["slots"].get(slot_no),
            normalized,
        )

    _apply_ams_units_climate(units_by_id, raw)

    for ams_id in sorted(units_by_id):
        bucket = units_by_id[ams_id]
        units.append(
            {
                "ams_id": ams_id,
                "kind": bucket["kind"],
                "temperature": bucket["temperature"],
                "humidity": bucket["humidity"],
                "humidity_level": bucket.get("humidity_level"),
                "drying": bucket["drying"],
                "slots": [bucket["slots"][n] for n in sorted(bucket["slots"])],
            }
        )

    return {
        "connected": bool(raw.get("connected", True)) if raw else False,
        "state": str(_first(raw, ("state", "gcode_state", "status"), "unknown")),
        "job": {
            "name": str(job_name or ""),
            "progress": progress,
            "layer": _as_int(_first(job_src, ("layer",), _first(raw, ("layer_num", "current_layer"), _first(cur, ("current_layer", "layer_num"))))),
            "total_layers": _as_int(_first(job_src, ("total_layers",), _first(raw, ("total_layers", "total_layer_num"), _first(cur, ("total_layers",))))),
            "remaining_seconds": remaining_seconds,
        },
        "temperatures": {
            "nozzle": _as_int(_first(temps, ("nozzle",), _first(raw, ("nozzle_temper",)))),
            "nozzle_target": _as_int(_first(temps, ("nozzle_target",), _first(raw, ("nozzle_target_temper",)))),
            "bed": _as_int(_first(temps, ("bed",), _first(raw, ("bed_temper",)))),
            "bed_target": _as_int(_first(temps, ("bed_target",), _first(raw, ("bed_target_temper",)))),
            "chamber": _as_int(_first(temps, ("chamber",), _first(raw, ("chamber_temper",)))),
            "chamber_target": _as_int(_first(temps, ("chamber_target",))),
        },
        "speed_level": _as_int(_first(raw, ("speed_level", "spd_lvl"))),
        "active_tray": active_tray,
        "hms": hms,
        "ams": units,
    }


# ---------------------------------------------------------------------------
# FilaMan side: spools per slot
# ---------------------------------------------------------------------------


def _params_for_printer(params: list[Any] | None, printer_id: int) -> dict[str, str]:
    out: dict[str, str] = {}
    for param in params or []:
        if (
            getattr(param, "printer_id", None) == printer_id
            and param.param_key
            and param.param_value not in (None, "")
        ):
            out[param.param_key] = param.param_value
    return out


def _nozzle_range(spool: Spool, printer_id: int) -> tuple[int | None, int | None]:
    """Bambu nozzle range lives on per-printer params, not on Filament.

    ``FilamentPrinterProfile.nozzle_temp_c`` is a single setpoint, so it cannot
    fill ``nozzle_min`` / ``nozzle_max``. Spool-level params override filament.
    """
    filament = spool.filament
    merged = {
        **_params_for_printer(getattr(filament, "printer_params", None) if filament else None, printer_id),
        **_params_for_printer(getattr(spool, "printer_params", None), printer_id),
    }
    return _as_int(merged.get(_NOZZLE_MIN_KEY)), _as_int(merged.get(_NOZZLE_MAX_KEY))


def _spool_swatch(spool: Spool, printer_id: int) -> dict[str, Any]:
    filament = spool.filament
    manufacturer = filament.manufacturer.name if filament and filament.manufacturer else ""
    color_hex = ""
    if filament and filament.filament_colors:
        colors = sorted(filament.filament_colors, key=lambda fc: getattr(fc, "position", 0) or 0)
        if colors and colors[0].color:
            color_hex = colors[0].color.hex_code or ""
    # AMS View shows the filament's Manufacturer Color Name, not Color.name
    # (that field is often a hex code or a generic swatch label).
    color_name = (filament.manufacturer_color_name or "").strip() if filament else ""

    remaining = spool.remaining_weight_g
    initial = spool.initial_total_weight_g
    empty = spool.empty_spool_weight_g
    net_initial = None
    if initial is not None and empty is not None:
        net_initial = max(initial - empty, 0)
    if not net_initial and filament is not None:
        # No gross weight recorded on the spool: fall back to the filament's
        # net weight (e.g. 1000 g) so the board can still show a percentage.
        net_initial = getattr(filament, "raw_material_weight_g", None) or None
    remaining_percent = None
    if remaining is not None and net_initial:
        remaining_percent = max(0, min(100, int(round(remaining / net_initial * 100))))

    nozzle_min, nozzle_max = _nozzle_range(spool, printer_id)
    return {
        "spool_id": spool.id,
        "filament": filament.designation if filament else "",
        "material": (filament.material_type if filament else "") or "",
        "manufacturer": manufacturer,
        "color": normalize_hex_color(color_hex, ""),
        "color_name": color_name,
        "remaining_grams": int(round(remaining)) if remaining is not None else None,
        "remaining_percent": remaining_percent,
        "nozzle_min": nozzle_min,
        "nozzle_max": nozzle_max,
        "rfid": bool(spool.rfid_uid or getattr(spool, "rfid_uid_2", None)),
        "last_used": spool.last_used_at.isoformat() if spool.last_used_at else None,
    }


def _assignment_meta_swatch(assignment: PrinterSlotAssignment) -> dict[str, Any]:
    """Filament the driver last reported on a slot that has no FilaMan spool.

    The printer page already shows ``meta.tray_type`` / ``tray_color`` for
    unlinked occupied bays. AMS View used to ignore that and look empty.
    """
    meta = assignment.meta or {}
    tray_type = str(meta.get("tray_type") or meta.get("material") or "").strip()
    out: dict[str, Any] = {}
    if tray_type:
        out["material"] = tray_type
    color = meta.get("tray_color") or meta.get("color")
    if color:
        out["color"] = normalize_hex_color(color, "")
    nozzle_min = _as_int(meta.get("nozzle_temp_min") or meta.get("nozzle_min"))
    nozzle_max = _as_int(meta.get("nozzle_temp_max") or meta.get("nozzle_max"))
    if nozzle_min is not None:
        out["nozzle_min"] = nozzle_min
    if nozzle_max is not None:
        out["nozzle_max"] = nozzle_max
    return out


async def load_slot_spools(db: AsyncSession, printer_id: int) -> dict[tuple[int, int], dict[str, Any]]:
    """{(ams_id, tray): swatch} from FilaMan's slot assignments for one printer."""
    result = await db.execute(
        select(PrinterSlot)
        .where(PrinterSlot.printer_id == printer_id, PrinterSlot.is_active.is_(True))
        .execution_options(populate_existing=True)
        .options(
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .selectinload(Filament.manufacturer),
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .selectinload(Filament.printer_params),
            selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.printer_params),
        )
        .order_by(PrinterSlot.slot_no)
    )
    out: dict[tuple[int, int], dict[str, Any]] = {}
    for slot in result.scalars().all():
        key = parse_slot_index(slot)
        assignment = slot.assignment
        entry: dict[str, Any] = {"present": bool(assignment and assignment.present)}
        if assignment and assignment.spool:
            entry.update(_spool_swatch(assignment.spool, printer_id))
        elif assignment and assignment.present:
            entry.update(_assignment_meta_swatch(assignment))
        out[key] = _prefer_fm_entry(out.get(key), entry)
    return out


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


def _pick_ht_sources(
    ams_id: int,
    slot_nos: set[int],
    live_slots: dict[tuple[int, int], dict[str, Any]],
    fm_slots: dict[tuple[int, int], dict[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """AMS-HT is one bay. Some firmware/drivers store the tray as id 1."""
    best_live: dict[str, Any] | None = None
    best_fm: dict[str, Any] | None = None
    best = (-1, -1, -1)
    for n in sorted(slot_nos | {0, 1}):
        live = live_slots.get((ams_id, n))
        fm = fm_slots.get((ams_id, n))
        score = (
            int(bool(fm and fm.get("spool_id") is not None)),
            int(bool(fm and str(fm.get("material") or "").strip())),
            int(bool(live and live.get("has_filament"))),
        )
        if score > best:
            best = score
            best_live, best_fm = live, fm
    return best_live, best_fm


def _merge_slot(
    ams_id: int,
    slot_no: int,
    kind: str,
    live: dict[str, Any] | None,
    fm: dict[str, Any] | None,
) -> dict[str, Any]:
    live = live or {}
    fm = fm or {}
    has_spool = fm.get("spool_id") is not None
    has_live = bool(live.get("has_filament"))
    has_fm_filament = bool(str(fm.get("material") or "").strip())
    empty = not has_spool and not has_live and not has_fm_filament

    remaining_percent = fm.get("remaining_percent")
    remaining_source: str | None = "filaman" if remaining_percent is not None else None
    if remaining_percent is None and live.get("remaining_percent") is not None:
        rp = live["remaining_percent"]
        if 0 <= rp <= 100:
            remaining_percent = rp
            remaining_source = "printer"

    return {
        "ams_id": ams_id,
        "slot": slot_no,
        "label": slot_label(ams_id, slot_no, kind),
        "empty": empty,
        "active": bool(live.get("active", False)),
        "color": fm.get("color") or live.get("color") or DEFAULT_EMPTY_COLOR,
        "color_name": fm.get("color_name") or live.get("color_name") or "",
        "material": fm.get("material") or live.get("material") or "",
        "manufacturer": fm.get("manufacturer") or "",
        "filament": fm.get("filament") or "",
        "spool_id": fm.get("spool_id"),
        "remaining_percent": remaining_percent,
        "remaining_grams": fm.get("remaining_grams"),
        "remaining_source": remaining_source,
        "nozzle_min": fm.get("nozzle_min") if fm.get("nozzle_min") is not None else live.get("nozzle_min"),
        "nozzle_max": fm.get("nozzle_max") if fm.get("nozzle_max") is not None else live.get("nozzle_max"),
        "rfid": bool(fm.get("rfid") or live.get("rfid")),
        "last_used": fm.get("last_used"),
        "backup_of": None,
    }


def _apply_backups(slots: list[dict[str, Any]]) -> None:
    """Mark slots holding the same material+colour as another slot."""
    for slot in slots:
        if slot["empty"] or not slot["material"]:
            continue
        for other in slots:
            if other is slot or other["empty"]:
                continue
            if (
                other["material"].lower() == slot["material"].lower()
                and other["color"] == slot["color"]
            ):
                slot["backup_of"] = other["label"]
                break


def _apply_active(units: list[dict[str, Any]], active_tray: int | None) -> dict[str, Any] | None:
    """Return {ams_id, slot} of the active slot; honour tray_now over per-tray flags."""
    location = _decode_active_tray(active_tray)
    if location is not None:
        ams_id, slot_no = location
        for unit in units:
            for slot in unit["slots"]:
                slot["active"] = unit["ams_id"] == ams_id and slot["slot"] == slot_no and not slot["empty"]
    for unit in units:
        for slot in unit["slots"]:
            if slot["active"]:
                return {"ams_id": unit["ams_id"], "slot": slot["slot"]}
    return None


def _build_alerts(printer_name: str, live: dict[str, Any], units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    state = str(live.get("state") or "").upper()
    if live and not live.get("connected", True):
        alerts.append({"id": "printer-offline", "severity": "danger", "title": "Printer offline", "detail": printer_name, "source": "printer"})
    if state in {"PAUSE", "PAUSED"}:
        alerts.append({"id": "print-paused", "severity": "warn", "title": "Print paused", "detail": live.get("job", {}).get("name", ""), "source": "printer"})
    if state in {"FAILED", "FAIL", "ERROR"}:
        alerts.append({"id": "print-failed", "severity": "danger", "title": "Print failed", "detail": live.get("job", {}).get("name", ""), "source": "printer"})
    for i, item in enumerate(live.get("hms") or []):
        code = item.get("code") or f"hms-{i}"
        alerts.append({"id": f"hms-{code}", "severity": "danger", "title": f"HMS {code}".strip(), "detail": item.get("message", ""), "source": "hms"})
    return alerts


def build_printer_display(
    printer: Printer,
    fm_slots: dict[tuple[int, int], dict[str, Any]],
    driver_state: dict[str, Any] | None,
) -> dict[str, Any]:
    live = normalize_driver_state(driver_state) if driver_state is not None else None

    # Collapse legacy external VT keys before merging so a dirty FilaMan slot
    # table (255-0 plus 255-254) cannot paint four External bays.
    if fm_slots:
        collapsed: dict[tuple[int, int], dict[str, Any]] = {}
        for key, entry in fm_slots.items():
            canon = canonicalize_slot_key(*key)
            collapsed[canon] = _prefer_fm_entry(collapsed.get(canon), entry)
        fm_slots = collapsed

    # Collect AMS units from both sources; live wins for climate, FilaMan fills spools.
    units_by_id: dict[int, dict[str, Any]] = {}
    live_slots: dict[tuple[int, int], dict[str, Any]] = {}
    if live:
        for unit in live["ams"]:
            ams_id = canonicalize_slot_key(unit["ams_id"], 0)[0]
            existing = units_by_id.get(ams_id)
            if existing is None:
                units_by_id[ams_id] = {
                    "ams_id": ams_id,
                    "kind": unit["kind"] if ams_id not in EXTERNAL_IDS else "external",
                    "temperature": unit["temperature"],
                    "humidity": unit["humidity"],
                    "humidity_level": unit.get("humidity_level"),
                    "drying": unit["drying"],
                    "_slot_nos": set(),
                }
                existing = units_by_id[ams_id]
            else:
                if existing["temperature"] is None:
                    existing["temperature"] = unit["temperature"]
                if existing["humidity"] is None:
                    existing["humidity"] = unit["humidity"]
                if existing.get("humidity_level") is None:
                    existing["humidity_level"] = unit.get("humidity_level")
                if existing["drying"] is None:
                    existing["drying"] = unit["drying"]
            for s in unit["slots"]:
                slot_no = canonicalize_slot_key(unit["ams_id"], s["slot"])[1]
                existing["_slot_nos"].add(slot_no)
                live_slots[(ams_id, slot_no)] = {**s, "slot": slot_no}
    for (ams_id, slot_no) in fm_slots:
        unit = units_by_id.setdefault(
            ams_id,
            {"ams_id": ams_id, "kind": ams_kind(ams_id), "temperature": None, "humidity": None, "humidity_level": None, "drying": None, "_slot_nos": set()},
        )
        unit["_slot_nos"].add(slot_no)

    _apply_ams_units_climate(units_by_id, driver_state)

    units: list[dict[str, Any]] = []
    for ams_id in sorted(units_by_id):
        unit = units_by_id[ams_id]
        kind = unit["kind"]
        slot_nos = unit.pop("_slot_nos")
        if kind == "ams":
            slot_nos |= set(range(SLOTS_PER_AMS))
        elif not slot_nos:
            slot_nos = {0}
        unit["label"] = ams_label(ams_id, kind)
        if kind == "ams_ht":
            ht_live, ht_fm = _pick_ht_sources(ams_id, slot_nos, live_slots, fm_slots)
            unit["slots"] = [_merge_slot(ams_id, 0, kind, ht_live, ht_fm)]
        else:
            unit["slots"] = [
                _merge_slot(ams_id, n, kind, live_slots.get((ams_id, n)), fm_slots.get((ams_id, n)))
                for n in sorted(slot_nos)
            ]
        units.append(unit)

    all_slots = [s for u in units for s in u["slots"]]
    _apply_backups(all_slots)
    active = _apply_active(units, live["active_tray"] if live else None)

    out: dict[str, Any] = {
        "id": printer.id,
        "name": printer.name,
        "driver": printer.driver_key,
        "connected": bool(live["connected"]) if live else None,
        "state": live["state"] if live else "unknown",
        "job": live["job"] if live else None,
        "temperatures": live["temperatures"] if live else None,
        "speed_level": live["speed_level"] if live else None,
        "active": active,
        "alerts": _build_alerts(printer.name, live or {}, units),
        "ams": units,
    }
    return out


def slots_only(printer_payload: dict[str, Any]) -> dict[str, Any]:
    """The ``fields=slots`` projection: enough for a swatch board, small enough for an MCU."""
    return {
        "id": printer_payload["id"],
        "name": printer_payload["name"],
        "connected": printer_payload["connected"],
        "state": printer_payload["state"],
        "active": printer_payload["active"],
        "ams": [
            {
                "ams_id": u["ams_id"],
                "kind": u["kind"],
                "label": u["label"],
                "slots": [
                    {k: s[k] for k in ("slot", "label", "empty", "active", "color", "material", "remaining_percent", "spool_id")}
                    for s in u["slots"]
                ],
            }
            for u in printer_payload["ams"]
        ],
    }


DriverStateGetter = Callable[[Printer], Awaitable[dict[str, Any] | None]]


async def build_display(
    db: AsyncSession,
    printers: list[Printer],
    get_driver_state: DriverStateGetter,
    *,
    fields: str = "full",
) -> dict[str, Any]:
    payload_printers = []
    for printer in printers:
        fm_slots = await load_slot_spools(db, printer.id)
        try:
            driver_state = await get_driver_state(printer)
        except Exception:  # a misbehaving driver must not blank the board
            driver_state = None
        item = build_printer_display(printer, fm_slots, driver_state)
        payload_printers.append(slots_only(item) if fields == "slots" else item)
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "printers": payload_printers,
    }


def compute_etag(payload: dict[str, Any]) -> str:
    """Weak ETag over everything except the timestamp, so unchanged polls get 304."""
    body = {k: v for k, v in payload.items() if k != "generated_at"}
    digest = hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:20]
    return f'W/"{digest}"'
