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

SCHEMA_VERSION = 3
DEFAULT_EMPTY_COLOR = "#202020"
AMS_HT_ID_BASE = 128  # Bambu numbers AMS-HT units from 128
SLOTS_PER_AMS = 4


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


def ams_kind(ams_id: int, unit: dict[str, Any] | None = None) -> str:
    if unit and unit.get("is_ams_ht"):
        return "ams_ht"
    return "ams_ht" if ams_id >= AMS_HT_ID_BASE else "ams"


def ams_label(ams_id: int, kind: str) -> str:
    if kind == "ams_ht":
        n = ams_id - AMS_HT_ID_BASE + 1 if ams_id >= AMS_HT_ID_BASE else ams_id + 1
        return f"HT{n}"
    return f"AMS {ams_letter(ams_id)}"


def slot_label(ams_id: int, slot: int, kind: str) -> str:
    if kind == "ams_ht":
        return ams_label(ams_id, kind)
    return f"{ams_letter(ams_id)}{slot + 1}"


def parse_slot_index(slot: PrinterSlot) -> tuple[int, int]:
    """(ams_id, tray) for a FilaMan printer slot.

    Drivers store ``custom_fields.slot_index = "<ams>-<tray>"``; without it
    the slot number is interpreted as consecutive 4-slot AMS units.
    """
    raw = (slot.custom_fields or {}).get("slot_index")
    if isinstance(raw, str) and "-" in raw:
        a, _, t = raw.partition("-")
        try:
            return int(a), int(t)
        except ValueError:
            pass
    return slot.slot_no // SLOTS_PER_AMS, slot.slot_no % SLOTS_PER_AMS


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
        if isinstance(candidate, list):
            return [u for u in candidate if isinstance(u, dict)]
    return []


def extract_trays(unit: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("slots", "trays", "tray"):
        trays = unit.get(key)
        if isinstance(trays, list):
            return [t for t in trays if isinstance(t, dict)]
    return []


def _tray_has_filament(tray: dict[str, Any]) -> bool:
    return bool(str(_first(tray, ("material", "tray_type", "filament_type"), "") or "").strip())


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
        active_tray          active_tray | tray_now (ams*4+slot, 254/255 = none)
        hms                  [{code, msg}] | []
        ams[]                ams_id|id, is_ams_ht, temperature|temp, humidity,
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
    if active_tray is not None and (active_tray < 0 or active_tray >= 254):
        active_tray = None

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
    for unit in extract_ams_units(raw):
        ams_id = _as_int(_first(unit, ("ams_id", "id"), 0)) or 0
        kind = ams_kind(ams_id, unit)
        drying = None
        if _first(unit, ("dry_status", "dry_target_temp", "dry_time")) is not None:
            drying = {
                "status": _first(unit, ("dry_status",)),
                "target_temp": _as_float(_first(unit, ("dry_target_temp",))),
                "time": _as_int(_first(unit, ("dry_time",))),
            }
        slots: list[dict[str, Any]] = []
        for tray in extract_trays(unit):
            slot_no = _as_int(_first(tray, ("slot", "id", "tray_id"), 0)) or 0
            slots.append(
                {
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
            )
        units.append(
            {
                "ams_id": ams_id,
                "kind": kind,
                "temperature": _as_float(_first(unit, ("temperature", "temp"))),
                "humidity": _as_float(_first(unit, ("humidity", "humidity_raw"))),
                "drying": drying,
                "slots": slots,
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


def _spool_swatch(spool: Spool) -> dict[str, Any]:
    filament = spool.filament
    manufacturer = filament.manufacturer.name if filament and filament.manufacturer else ""
    color_hex = ""
    color_name = ""
    if filament and filament.filament_colors:
        colors = sorted(filament.filament_colors, key=lambda fc: getattr(fc, "position", 0) or 0)
        if colors and colors[0].color:
            color_hex = colors[0].color.hex_code or ""
            color_name = colors[0].color.name or ""
    if not color_name and filament:
        color_name = filament.manufacturer_color_name or ""

    remaining = spool.remaining_weight_g
    initial = spool.initial_total_weight_g
    empty = spool.empty_spool_weight_g
    net_initial = None
    if initial is not None and empty is not None:
        net_initial = max(initial - empty, 0)
    remaining_percent = None
    if remaining is not None and net_initial:
        remaining_percent = max(0, min(100, int(round(remaining / net_initial * 100))))

    return {
        "spool_id": spool.id,
        "filament": filament.designation if filament else "",
        "material": (filament.material_type if filament else "") or "",
        "manufacturer": manufacturer,
        "color": normalize_hex_color(color_hex, ""),
        "color_name": color_name,
        "remaining_grams": int(round(remaining)) if remaining is not None else None,
        "remaining_percent": remaining_percent,
        "nozzle_min": _as_int(getattr(filament, "nozzle_temp_min", None)) if filament else None,
        "nozzle_max": _as_int(getattr(filament, "nozzle_temp_max", None)) if filament else None,
        "rfid": bool(spool.rfid_uid or getattr(spool, "rfid_uid_2", None)),
        "last_used": spool.last_used_at.isoformat() if spool.last_used_at else None,
    }


async def load_slot_spools(db: AsyncSession, printer_id: int) -> dict[tuple[int, int], dict[str, Any]]:
    """{(ams_id, tray): swatch} from FilaMan's slot assignments for one printer."""
    result = await db.execute(
        select(PrinterSlot)
        .where(PrinterSlot.printer_id == printer_id, PrinterSlot.is_active.is_(True))
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
        )
        .order_by(PrinterSlot.slot_no)
    )
    out: dict[tuple[int, int], dict[str, Any]] = {}
    for slot in result.scalars().all():
        key = parse_slot_index(slot)
        assignment = slot.assignment
        entry: dict[str, Any] = {"present": bool(assignment and assignment.present)}
        if assignment and assignment.spool:
            entry.update(_spool_swatch(assignment.spool))
        out[key] = entry
    return out


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


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
    empty = not has_spool and not has_live

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
    if active_tray is not None:
        ams_id, slot_no = divmod(active_tray, SLOTS_PER_AMS)
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

    # Collect AMS units from both sources; live wins for climate, FilaMan fills spools.
    units_by_id: dict[int, dict[str, Any]] = {}
    live_slots: dict[tuple[int, int], dict[str, Any]] = {}
    if live:
        for unit in live["ams"]:
            units_by_id[unit["ams_id"]] = {
                "ams_id": unit["ams_id"],
                "kind": unit["kind"],
                "temperature": unit["temperature"],
                "humidity": unit["humidity"],
                "drying": unit["drying"],
                "_slot_nos": {s["slot"] for s in unit["slots"]},
            }
            for s in unit["slots"]:
                live_slots[(unit["ams_id"], s["slot"])] = s
    for (ams_id, slot_no) in fm_slots:
        unit = units_by_id.setdefault(
            ams_id,
            {"ams_id": ams_id, "kind": ams_kind(ams_id), "temperature": None, "humidity": None, "drying": None, "_slot_nos": set()},
        )
        unit["_slot_nos"].add(slot_no)

    units: list[dict[str, Any]] = []
    for ams_id in sorted(units_by_id):
        unit = units_by_id[ams_id]
        kind = unit["kind"]
        slot_nos = unit.pop("_slot_nos")
        if kind != "ams_ht":
            slot_nos |= set(range(SLOTS_PER_AMS))
        elif not slot_nos:
            slot_nos = {0}
        unit["label"] = ams_label(ams_id, kind)
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
