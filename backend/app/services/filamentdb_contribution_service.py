"""Beiträge an die FilaMan-DB: Payload bauen, prüfen, senden, Freigabe abgleichen.

Gesendet werden ausschließlich Stammdaten (Hersteller, Filament, Druckermodell,
Druckprofil). Spulen, Lagerorte, Bestände, Preise und lokale IDs verlassen die
Instanz nie; nur die FilaMan-DB-IDs gehen mit.

Ablauf je lokalem Objekt (Tabelle ``filamentdb_contributions``, eine Zeile je
Typ + lokale ID):

* ``build``  : Payload + fehlende Voraussetzungen (Abhängigkeiten) + Blocker.
* ``submit`` : sendet oder wartet (``waiting``), bis Abhängigkeiten freigegeben sind.
* ``refresh``: holt den Stand der Einreichungen, verknüpft freigegebene Objekte
  lokal und sendet wartende Beiträge nach.
"""

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_secret import AppSecretError, decrypt_app_secret
from app.models import (
    Color,
    Filament,
    FilamentColor,
    FilamentDBContribution,
    FilamentPrinterProfile,
    Manufacturer,
    Printer,
    User,
)
from app.services.filamentdb_contrib_client import FilamentDBError, fdb_request
from app.services.print_profile_validation import (
    FILAMENT_PAYLOAD_RANGES,
    find_implausible_values,
)

logger = logging.getLogger(__name__)

ENTITY_TYPES = ("manufacturer", "filament", "printer_model", "print_profile")
ACTIVE_STATUSES = ("waiting", "pending", "approved", "published", "linked", "changes_requested")
# Ab diesem Score gilt ein Hersteller-Treffer als derselbe Hersteller (Abhängigkeit).
AUTO_LINK_SCORE = 0.99

PROFILE_FIELDS = (
    "nozzle_diameter_mm",
    "extruder_type",
    "nozzle_temp_c",
    "bed_temp_c",
    "chamber_temp_c",
    "print_speed_mm_s",
    "travel_speed_mm_s",
    "first_layer_speed_mm_s",
    "max_volumetric_flow_mm3_s",
    "flowrate_percent",
    "extrusion_multiplier",
    "pressure_advance_k",
    "linear_advance_k",
    "retraction_mm",
    "retraction_speed_mm_s",
    "deretraction_speed_mm_s",
    "retraction_extra_prime_mm3",
    "fan_percent_min",
    "fan_percent_max",
    "fan_first_layer_percent",
    "z_hop_mm",
    "z_hop_only_when_retracting",
    "bridge_flow_percent",
    "bridge_fan_percent",
    "build_plate",
    "material_notes",
)

# Werte, die bei einem verknüpften Filament als Edit an die DB gehen.
FILAMENT_EDIT_KEYS = (
    "density_g_cm3",
    "temp_nozzle_min",
    "temp_nozzle_max",
    "temp_bed",
    "fan_speed_min",
    "fan_speed_max",
    "chamber_temp",
    "max_volumetric_speed",
    "flow_ratio",
    "k_value",
    "softening_temp",
    "dry_temp",
    "dry_time_hours",
)


@dataclass
class Build:
    entity_type: str
    local_id: int
    mode: str = "create"  # create | edit (Filament-Basiswerte) | update (Profil per PUT)
    payload: dict[str, Any] = field(default_factory=dict)
    entity_id: int | None = None
    # Voraussetzungen, die zuerst an die DB müssen: (Typ, lokale ID, Bezeichnung)
    dependencies: list[tuple[str, int, str]] = field(default_factory=list)
    blockers: list[dict[str, Any]] = field(default_factory=list)
    can_check: bool = False
    # Lesbare Namen zu IDs im Payload, nur für die Anzeige
    display: dict[str, str] = field(default_factory=dict)


def _err(status: int, code: str, message: str, **extra: Any) -> FilamentDBError:
    return FilamentDBError(status, code, message, extra)


# ── Token ────────────────────────────────────────────────────────────────


async def get_user(db: AsyncSession, user_id: int | None) -> User | None:
    if user_id is None:
        return None
    return await db.get(User, user_id)


def _decrypt_user_token(user: User) -> str | None:
    if not user.filamentdb_token_enc:
        return None
    try:
        return decrypt_app_secret(user.filamentdb_token_enc)
    except AppSecretError as exc:
        raise _err(
            400,
            "filamentdb_token_undecryptable",
            "The stored token cannot be decrypted, please enter it again",
        ) from exc


async def get_token(db: AsyncSession, user_id: int | None) -> str | None:
    """Klartext-Token des Users oder ``None``. Nicht entschlüsselbar → eigene Fehlermeldung."""
    user = await get_user(db, user_id)
    if user is None:
        return None
    return _decrypt_user_token(user)


async def require_token(db: AsyncSession, user_id: int | None) -> str:
    token = await get_token(db, user_id)
    if not token:
        raise _err(400, "filamentdb_token_missing", "No FilaMan-DB token saved")
    return token


# ── Lokale Objekte ───────────────────────────────────────────────────────


def _cf_id(custom_fields: dict[str, Any] | None) -> int | None:
    raw = (custom_fields or {}).get("filamentdb_id")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _clean(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if v is not None and v != ""}


def _int(value: Any) -> int | None:
    return None if value is None else int(round(value))


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


async def _get_manufacturer(db: AsyncSession, local_id: int) -> Manufacturer:
    obj = await db.get(Manufacturer, local_id)
    if obj is None:
        raise _err(404, "not_found", "Manufacturer not found")
    return obj


async def _get_filament(db: AsyncSession, local_id: int) -> Filament:
    obj = await db.get(Filament, local_id)
    if obj is None:
        raise _err(404, "not_found", "Filament not found")
    return obj


async def _get_printer(db: AsyncSession, local_id: int) -> Printer:
    obj = await db.get(Printer, local_id)
    if obj is None or obj.deleted_at is not None:
        raise _err(404, "not_found", "Printer not found")
    return obj


async def _get_model_source(db: AsyncSession, local_id: int) -> Printer | FilamentPrinterProfile:
    """Quelle eines printer_model-Beitrags.

    local_id > 0: Drucker (wie bisher). local_id < 0: Druckprofil mit der ID -local_id,
    denn ein Profil trägt sein Modell selbst und braucht keinen Drucker.
    """
    if local_id < 0:
        return await _get_profile(db, -local_id)
    return await _get_printer(db, local_id)


async def _get_profile(db: AsyncSession, local_id: int) -> FilamentPrinterProfile:
    obj = await db.get(FilamentPrinterProfile, local_id)
    if obj is None:
        raise _err(404, "not_found", "Print profile not found")
    return obj


async def get_row(db: AsyncSession, entity_type: str, local_id: int) -> FilamentDBContribution | None:
    return await db.scalar(
        select(FilamentDBContribution).where(
            FilamentDBContribution.entity_type == entity_type,
            FilamentDBContribution.local_id == local_id,
        )
    )


FDB_MAX_PAGE_SIZE = 200  # die FilaMan-DB lehnt page_size > 200 ab
_FDB_MAX_PAGES = 50


async def _fetch_all_items(path: str) -> list[dict[str, Any]]:
    """Alle Seiten einer paginierten FilaMan-DB-Liste einsammeln."""
    collected: list[dict[str, Any]] = []
    for page in range(1, _FDB_MAX_PAGES + 1):
        data = await fdb_request(
            "GET", path, params={"page": page, "page_size": FDB_MAX_PAGE_SIZE}
        )
        if not isinstance(data, dict):
            break
        items = [i for i in (data.get("items") or []) if isinstance(i, dict)]
        collected.extend(items)
        total = data.get("total")
        if len(items) < FDB_MAX_PAGE_SIZE or (
            isinstance(total, int) and len(collected) >= total
        ):
            break
    return collected


async def _resolve_material_id(material_type: str) -> int | None:
    items = await _fetch_all_items("/materials")
    wanted = _norm(material_type)
    for item in items:
        if wanted and wanted in (_norm(item.get("name")), _norm(item.get("key"))):
            return item.get("id")
    return None


# ── Payload ──────────────────────────────────────────────────────────────

_HEX_NAME_RE = re.compile(r"^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def is_hex_only_name(name: str | None) -> bool:
    """True, wenn ein Farbname nur ein Hex-Code ist (3, 6 oder 8 Stellen, optional mit #)."""
    return bool(name) and bool(_HEX_NAME_RE.match(name.strip()))


def _real_color_name(name: str | None) -> str | None:
    return None if is_hex_only_name(name) else name


async def _filament_payload(db: AsyncSession, fil: Filament) -> dict[str, Any]:
    color_rows = (
        await db.execute(
            select(FilamentColor, Color)
            .join(Color, Color.id == FilamentColor.color_id)
            .where(FilamentColor.filament_id == fil.id)
            .order_by(FilamentColor.position)
        )
    ).all()
    # Die DB erwartet "#rrggbb" und Positionen 1..20 (FilamentColorItem).
    valid_colors = [
        (fc, color, "#" + color.hex_code.lstrip("#")[:6].lower())
        for fc, color in color_rows
        if color.hex_code and len(color.hex_code.lstrip("#")) >= 6
    ][:20]
    colors = [
        _clean(
            {
                "hex_code": hex_code,
                "color_name": _real_color_name(fc.display_name_override or color.name),
                "position": position,
            }
        )
        for position, (fc, color, hex_code) in enumerate(valid_colors, start=1)
    ]
    nozzle = fil.extruder_temp_range_c or {}
    bed = fil.bed_temp_range_c or {}
    fan = fil.cooling_fan_range_percent or {}
    data = {
        "designation": fil.designation,
        "material_subtype": fil.material_subgroup,
        "color_name": _real_color_name(fil.manufacturer_color_name),
        "color_mode": fil.color_mode,
        "multi_color_style": fil.multi_color_style,
        "hex_color": colors[0]["hex_code"] if colors else None,
        "colors": colors or None,
        "diameter_mm": fil.diameter_mm,
        "density_g_cm3": fil.density_g_cm3,
        "temp_nozzle_min": _int(nozzle.get("min")),
        "temp_nozzle_max": _int(nozzle.get("max")),
        "temp_bed": _int(bed.get("min") if bed.get("min") is not None else bed.get("max")),
        "fan_speed_min": _int(fan.get("min")),
        "fan_speed_max": _int(fan.get("max")),
        "chamber_temp": _int(fil.chamber_temp_c),
        "max_volumetric_speed": fil.max_volumetric_speed_mm3_s,
        "flow_ratio": fil.flow_ratio,
        "k_value": fil.pressure_advance_k,
        "softening_temp": _int(fil.softening_temp_c),
        "dry_temp": _int(fil.drying_temp_c),
        "dry_time_hours": _int(fil.drying_time_hours),
        "nominal_weight_g": _int(fil.raw_material_weight_g),
        "sku": fil.manufacturer_sku,
        "datasheet_url": fil.datasheet_url,
        "discontinued": bool(fil.is_discontinued),
        "ams_compatible": ", ".join(fil.ams_compatibility) if fil.ams_compatibility else None,
        "build_plates": (
            ", ".join(fil.build_plate_compatibility) if fil.build_plate_compatibility else None
        ),
    }
    return _clean(data)


async def local_fingerprint(db: AsyncSession, entity_type: str, local_id: int) -> str:
    """SHA-256 der lokalen Werte, die gesendet würden (ohne Netzwerkzugriff)."""
    if entity_type == "manufacturer":
        mfr = await _get_manufacturer(db, local_id)
        data: dict[str, Any] = {"name": mfr.name, "url": mfr.url}
    elif entity_type == "printer_model":
        printer = await _get_model_source(db, local_id)
        data = {
            "printer_manufacturer": printer.printer_manufacturer,
            "printer_model": printer.printer_model,
            "nozzle_diameter_mm": printer.nozzle_diameter_mm,
        }
    elif entity_type == "filament":
        fil = await _get_filament(db, local_id)
        data = {
            "payload": await _filament_payload(db, fil),
            "material_type": fil.material_type,
            "manufacturer_id": fil.manufacturer_id,
        }
    else:
        profile = await _get_profile(db, local_id)
        data = {name: getattr(profile, name) for name in PROFILE_FIELDS}
        data["filament_id"] = profile.filament_id
        data["printer_model_id"] = profile.filamentdb_printer_model_id
        data["printer_manufacturer"] = profile.printer_manufacturer
        data["printer_model"] = profile.printer_model
    raw = json.dumps(data, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _model_blocker_info(source: Printer | FilamentPrinterProfile) -> dict[str, Any]:
    """Strukturierte Angaben, damit das Frontend zur richtigen Stelle verlinken kann."""
    if isinstance(source, FilamentPrinterProfile):
        info: dict[str, Any] = {
            "profile_id": source.id,
            "filament_id": source.filament_id,
            "printer_id": source.printer_id,
        }
        return {k: v for k, v in info.items() if v is not None}
    return {"printer_id": source.id}


async def _stamp(db: AsyncSession, row: FilamentDBContribution) -> None:
    row.payload_hash = await local_fingerprint(db, row.entity_type, row.local_id)


async def build(db: AsyncSession, entity_type: str, local_id: int) -> Build:
    """Baut genau den Payload, der gesendet würde, samt Voraussetzungen und Blockern."""
    if entity_type not in ENTITY_TYPES:
        raise _err(422, "invalid_type", f"Unknown type {entity_type}")
    result = Build(entity_type, local_id)
    row = await get_row(db, entity_type, local_id)

    if entity_type == "manufacturer":
        mfr = await _get_manufacturer(db, local_id)
        if _cf_id(mfr.custom_fields):
            result.blockers.append(
                {"code": "already_linked", "message": "Manufacturer is already linked"}
            )
        result.payload = _clean({"name": mfr.name, "website": mfr.url})
        result.can_check = True

    elif entity_type == "printer_model":
        printer = await _get_model_source(db, local_id)
        if printer.filamentdb_printer_model_id:
            result.blockers.append(
                {"code": "already_linked", "message": "Printer model is already linked"}
            )
        if not (printer.printer_manufacturer and printer.printer_model):
            result.blockers.append(
                {
                    "code": "printer_model_missing",
                    "message": "Printer needs a manufacturer and a model name",
                    **_model_blocker_info(printer),
                }
            )
        result.payload = _clean(
            {
                "manufacturer": printer.printer_manufacturer,
                "model": printer.printer_model,
                "default_nozzle_mm": printer.nozzle_diameter_mm,
            }
        )
        result.can_check = True

    elif entity_type == "filament":
        fil = await _get_filament(db, local_id)
        payload = await _filament_payload(db, fil)
        remote_id = _cf_id(fil.custom_fields)
        if remote_id:
            result.mode = "edit"
            result.entity_id = remote_id
            result.payload = {k: v for k, v in payload.items() if k in FILAMENT_EDIT_KEYS}
            if not result.payload:
                result.blockers.append(
                    {"code": "nothing_to_send", "message": "No base values to send"}
                )
        else:
            mfr = await _get_manufacturer(db, fil.manufacturer_id)
            mfr_remote = _cf_id(mfr.custom_fields)
            if mfr_remote:
                payload["manufacturer_id"] = mfr_remote
                result.display["manufacturer_id"] = mfr.name
            else:
                result.dependencies.append(("manufacturer", mfr.id, mfr.name))
            material_id = await _resolve_material_id(fil.material_type)
            if material_id is None:
                result.blockers.append(
                    {
                        "code": "material_unknown",
                        "message": f"Material {fil.material_type} does not exist in the FilaMan-DB",
                        "material": fil.material_type,
                    }
                )
            else:
                payload["material_id"] = material_id
                result.display["material_id"] = fil.material_type
            result.payload = payload
            result.can_check = bool(mfr_remote)
        for problem in find_implausible_values(result.payload or {}, FILAMENT_PAYLOAD_RANGES):
            result.blockers.append(
                {
                    "code": "implausible_value",
                    "message": f"{problem['field']} must be between {problem['min']} and {problem['max']}",
                    **problem,
                }
            )

    else:  # print_profile
        profile = await _get_profile(db, local_id)
        fil = await _get_filament(db, profile.filament_id)
        payload = _clean({name: getattr(profile, name) for name in PROFILE_FIELDS})
        fil_remote = _cf_id(fil.custom_fields)
        if fil_remote:
            payload["filament_id"] = fil_remote
            result.display["filament_id"] = fil.designation
        else:
            result.dependencies.append(("filament", fil.id, fil.designation))
        if profile.filamentdb_printer_model_id:
            payload["printer_model_id"] = profile.filamentdb_printer_model_id
            result.display["printer_model_id"] = " ".join(
                x for x in (profile.printer_manufacturer, profile.printer_model) if x
            ) or str(profile.filamentdb_printer_model_id)
        elif profile.printer_manufacturer and profile.printer_model:
            # Freitext-Modell: erst als printer_model einreichen (local_id = -Profil-ID).
            result.dependencies.append(
                (
                    "printer_model",
                    -profile.id,
                    f"{profile.printer_manufacturer} {profile.printer_model}",
                )
            )
        else:
            result.blockers.append(
                {
                    "code": "printer_model_missing",
                    "message": "Print profile needs a printer model (manufacturer and model)",
                    **_model_blocker_info(profile),
                }
            )
        if payload.get("nozzle_diameter_mm") is None:
            result.blockers.append(
                {
                    "code": "nozzle_required",
                    "message": "Nozzle diameter is required",
                    "field": "nozzle_diameter_mm",
                }
            )
        for problem in find_implausible_values(payload):
            result.blockers.append(
                {
                    "code": "implausible_value",
                    "message": f"{problem['field']} must be between {problem['min']} and {problem['max']}",
                    **problem,
                }
            )
        result.payload = payload
        if row is not None and row.status == "published" and row.remote_entity_id:
            result.mode = "update"
            result.entity_id = row.remote_entity_id
        result.can_check = (
            result.mode == "create" and "filament_id" in payload and "printer_model_id" in payload
        )

    return result


# ── Vorschau ─────────────────────────────────────────────────────────────


async def check_matches(db: AsyncSession, b: Build, token: str) -> list[dict[str, Any]]:
    if not b.can_check or b.mode != "create":
        return []
    data = await fdb_request(
        "POST", "/contribute/check", token=token, json={"type": b.entity_type, "data": b.payload}
    )
    matches = data.get("matches", []) if isinstance(data, dict) else []
    # Nur Treffer mit echter, positiver Integer-ID übernehmen (Daten aus der DB
    # landen später in HTML-Attributen und in lokalen Verknüpfungen).
    return [
        m
        for m in matches
        if isinstance(m, dict)
        and isinstance(m.get("id"), int)
        and not isinstance(m.get("id"), bool)
        and m["id"] > 0
    ]


async def preview(
    db: AsyncSession, user_id: int | None, entity_type: str, local_id: int
) -> dict[str, Any]:
    token = await require_token(db, user_id)
    b = await build(db, entity_type, local_id)
    matches = await check_matches(db, b, token) if not b.blockers else []
    return {
        "type": entity_type,
        "local_id": local_id,
        "mode": b.mode,
        "payload": b.payload,
        "display": b.display,
        "matches": matches,
        "blockers": b.blockers,
        "dependencies": [
            {"type": t, "local_id": lid, "label": label} for t, lid, label in b.dependencies
        ],
    }


# ── Lokale Verknüpfung ───────────────────────────────────────────────────


def _with_cf(custom_fields: dict[str, Any] | None, remote_id: int) -> dict[str, Any]:
    merged = dict(custom_fields or {})
    merged["filamentdb_id"] = remote_id
    return merged


async def _apply_link(
    db: AsyncSession, entity_type: str, local_id: int, remote_id: int
) -> None:
    if entity_type == "manufacturer":
        mfr = await _get_manufacturer(db, local_id)
        mfr.custom_fields = _with_cf(mfr.custom_fields, remote_id)
    elif entity_type == "filament":
        fil = await _get_filament(db, local_id)
        fil.custom_fields = _with_cf(fil.custom_fields, remote_id)
    elif entity_type == "printer_model":
        printer = await _get_model_source(db, local_id)
        printer.filamentdb_printer_model_id = remote_id
        if printer.printer_manufacturer and printer.printer_model:
            # Profil-Quelle (local_id < 0) läuft unter filaments:update, darf also keine Drucker ändern.
            tables = (FilamentPrinterProfile,) if local_id < 0 else (Printer, FilamentPrinterProfile)
            for table in tables:
                same = await db.scalars(
                    select(table).where(
                        func.lower(table.printer_manufacturer) == printer.printer_manufacturer.lower(),
                        func.lower(table.printer_model) == printer.printer_model.lower(),
                        table.filamentdb_printer_model_id.is_(None),
                        *((table.deleted_at.is_(None),) if table is Printer else ()),
                    )
                )
                for other in same:
                    other.filamentdb_printer_model_id = remote_id
        from app.api.v1.filamentdb_proxy import clear_printer_models_cache

        clear_printer_models_cache()
    # print_profile: keine lokale Spalte, der Stand steht in der Beitragszeile.


async def _upsert_row(
    db: AsyncSession, entity_type: str, local_id: int, user_id: int | None
) -> FilamentDBContribution:
    row = await get_row(db, entity_type, local_id)
    if row is None:
        row = FilamentDBContribution(
            entity_type=entity_type, local_id=local_id, status="draft", created_by=user_id
        )
        db.add(row)
        await db.flush()
    return row


def _take_over(row: FilamentDBContribution, user_id: int | None) -> None:
    """Sendet ein anderer User erneut, ist das eine neue Einreichung unter seinem Konto.

    Verknüpfte und freigegebene Zeilen bleiben unverändert (die DB-Daten stehen
    schon). Bei allen anderen werden die alten Remote-IDs verworfen, damit der
    Abgleich nicht mit dem Token des neuen Users nach fremden Einreichungen fragt.
    """
    if user_id is None or row.created_by == user_id:
        return
    if row.status in ("linked", "approved"):
        return
    row.created_by = user_id
    if row.remote_submission_id is not None:
        row.remote_submission_id = None
        row.remote_entity_id = None
        row.last_checked_at = None


async def link(
    db: AsyncSession, user_id: int | None, entity_type: str, local_id: int, match_id: int
) -> FilamentDBContribution:
    await build(db, entity_type, local_id)  # prüft, dass das lokale Objekt existiert
    await _apply_link(db, entity_type, local_id, match_id)
    row = await _upsert_row(db, entity_type, local_id, user_id)
    row.status = "linked"
    row.remote_entity_id = match_id
    row.remote_submission_id = None
    row.depends_on_id = None
    row.payload = None
    row.last_error = None
    await _stamp(db, row)
    await db.commit()
    await db.refresh(row)
    return row


# ── Senden ───────────────────────────────────────────────────────────────


def _raise_blockers(b: Build) -> None:
    first = b.blockers[0]
    extra = {k: v for k, v in first.items() if k not in ("code", "message")}
    extra["blockers"] = b.blockers
    status = 422 if first["code"] == "implausible_value" else 409
    raise _err(status, first["code"], first["message"], **extra)


async def _ensure_dependency(
    db: AsyncSession, token: str, user_id: int | None, entity_type: str, local_id: int
) -> FilamentDBContribution:
    row = await get_row(db, entity_type, local_id)
    if row is not None and row.status in ACTIVE_STATUSES + ("rejected",):
        return row
    return await _submit_row(db, token, user_id, entity_type, local_id, as_dependency=True)


async def _submit_row(
    db: AsyncSession,
    token: str,
    user_id: int | None,
    entity_type: str,
    local_id: int,
    *,
    shown_matches: list[dict[str, Any]] | None = None,
    as_dependency: bool = False,
) -> FilamentDBContribution:
    b = await build(db, entity_type, local_id)
    if b.blockers:
        _raise_blockers(b)
    row = await _upsert_row(db, entity_type, local_id, user_id)
    _take_over(row, user_id)

    if as_dependency and entity_type == "manufacturer":
        # Derselbe Hersteller existiert schon in der DB: verknüpfen statt einreichen.
        matches = await check_matches(db, b, token)
        if matches and float(matches[0].get("score") or 0) >= AUTO_LINK_SCORE:
            await _apply_link(db, entity_type, local_id, int(matches[0]["id"]))
            row.status = "linked"
            row.remote_entity_id = int(matches[0]["id"])
            row.last_error = None
            await _stamp(db, row)
            await db.flush()
            return row
        shown_matches = [
            {"type": m.get("type"), "id": m.get("id"), "score": m.get("score")} for m in matches
        ]

    await _send_or_wait(db, token, user_id, row, b, shown_matches)
    return row


async def _send_or_wait(
    db: AsyncSession,
    token: str,
    user_id: int | None,
    row: FilamentDBContribution,
    b: Build,
    shown_matches: list[dict[str, Any]] | None = None,
) -> None:
    if b.dependencies:
        dep_rows = [
            await _ensure_dependency(db, token, user_id, t, lid) for t, lid, _label in b.dependencies
        ]
        await db.flush()
        # Hersteller war schon in der DB und wurde verknüpft: dann geht es gleich weiter.
        rebuilt = await build(db, b.entity_type, b.local_id)
        if rebuilt.dependencies or rebuilt.blockers:
            row.status = "waiting"
            row.depends_on_id = dep_rows[0].id
            row.payload = b.payload
            row.last_error = None
            await _stamp(db, row)
            await db.flush()
            return
        b = rebuilt

    row.payload = b.payload
    row.last_error = None
    row.depends_on_id = None
    client_ref = f"filaman-{b.entity_type}-{b.local_id}"
    if b.mode == "update":
        await fdb_request(
            "PUT", f"/print-profiles/{b.entity_id}", token=token, json=b.payload
        )
        row.status = "published"
    else:
        body: dict[str, Any] = {
            "type": b.entity_type,
            "entity_id": b.entity_id,
            "data": b.payload,
            "client_ref": client_ref,
            "shown_matches": shown_matches or [],
        }
        resp = await fdb_request("POST", "/contribute", token=token, json=body)
        resp = resp if isinstance(resp, dict) else {}
        if b.entity_type == "print_profile":
            row.status = "published"
            row.remote_entity_id = resp.get("print_profile_id")
            row.remote_submission_id = None
        else:
            row.status = "pending"
            row.remote_submission_id = resp.get("submission_id")
    await _stamp(db, row)
    await db.flush()


async def submit(
    db: AsyncSession,
    user_id: int | None,
    entity_type: str,
    local_id: int,
    *,
    action: str,
    match_id: int | None = None,
    shown_matches: list[dict[str, Any]] | None = None,
) -> FilamentDBContribution:
    if action == "link":
        if not match_id:
            raise _err(422, "match_required", "match_id is required to link")
        # match_id kommt vom Client: nur übernehmen, was die DB für genau dieses Objekt vorschlägt.
        token = await require_token(db, user_id)
        b = await build(db, entity_type, local_id)
        matches = await check_matches(db, b, token)
        if match_id not in {m["id"] for m in matches}:
            raise _err(400, "filamentdb_match_invalid", "match_id is not a match for this object")
        return await link(db, user_id, entity_type, local_id, match_id)
    token = await require_token(db, user_id)
    row = await _submit_row(
        db, token, user_id, entity_type, local_id, shown_matches=shown_matches
    )
    await db.commit()
    await db.refresh(row)
    return row


# ── Abgleich ─────────────────────────────────────────────────────────────

_REMOTE_STATUS = {
    "pending": "pending",
    "in_review": "pending",
    "changes_requested": "changes_requested",
    "approved": "approved",
    "rejected": "rejected",
}


async def advance_waiting(db: AsyncSession, token: str, user_id: int) -> None:
    """Sendet wartende Beiträge dieses Users, deren Voraussetzungen erfüllt sind."""
    for _ in range(4):
        waiting = (
            await db.scalars(
                select(FilamentDBContribution).where(
                    FilamentDBContribution.status == "waiting",
                    FilamentDBContribution.created_by == user_id,
                )
            )
        ).all()
        progressed = False
        for row in waiting:
            dep = await db.get(FilamentDBContribution, row.depends_on_id) if row.depends_on_id else None
            if dep is not None and dep.status in ("rejected", "error"):
                row.status = "error"
                row.last_error = f"Dependency was {dep.status}: {dep.entity_type} #{dep.local_id}"
                progressed = True
                continue
            try:
                b = await build(db, row.entity_type, row.local_id)
                if b.blockers:
                    row.status = "error"
                    row.last_error = b.blockers[0]["message"]
                    progressed = True
                    continue
                await _send_or_wait(db, token, row.created_by, row, b)
            except FilamentDBError as exc:
                row.status = "error"
                row.last_error = exc.message
                progressed = True
                continue
            except Exception:
                # Lokales Objekt gelöscht o. Ä.: Beitrag verwerfen statt ewig warten.
                logger.exception("Waiting contribution %s failed", row.id)
                row.status = "error"
                row.last_error = "Local object no longer available"
                progressed = True
                continue
            if row.status != "waiting":
                progressed = True
        await db.flush()
        if not progressed:
            break


async def _refresh_user(db: AsyncSession, user_id: int, token: str) -> list[FilamentDBContribution]:
    open_rows = (
        await db.scalars(
            select(FilamentDBContribution).where(
                FilamentDBContribution.created_by == user_id,
                FilamentDBContribution.status.in_(("pending", "changes_requested")),
                FilamentDBContribution.remote_submission_id.is_not(None),
            )
        )
    ).all()
    now = datetime.now(UTC)
    if open_rows:
        ids = ",".join(str(r.remote_submission_id) for r in open_rows)
        data = await fdb_request("GET", "/me/submissions", token=token, params={"ids": ids})
        by_id = {
            item.get("submission_id"): item
            for item in (data if isinstance(data, list) else [])
            if isinstance(item, dict)
        }
        for row in open_rows:
            row.last_checked_at = now
            item = by_id.get(row.remote_submission_id)
            if item is None:
                continue
            status = _REMOTE_STATUS.get(item.get("status"), row.status)
            row.status = status
            row.last_error = item.get("reviewer_comment") if status in ("rejected", "changes_requested") else None
            if status == "approved" and item.get("entity_id"):
                row.remote_entity_id = int(item["entity_id"])
                try:
                    await _apply_link(db, row.entity_type, row.local_id, row.remote_entity_id)
                    if row.payload_hash is None:
                        await _stamp(db, row)
                except FilamentDBError as exc:
                    row.last_error = exc.message
    await advance_waiting(db, token, user_id)
    return list(open_rows)


async def refresh(db: AsyncSession, user_id: int | None) -> list[FilamentDBContribution]:
    """Stand der offenen Einreichungen eines Users abfragen, wartende nachsenden.

    Ohne ``user_id`` (Hintergrund-Job) wird jeder User mit eigenen Beiträgen mit
    seinem eigenen Token abgeglichen; wer keinen (lesbaren) Token hat, wird
    übersprungen.
    """
    if user_id is not None:
        token = await get_token(db, user_id)
        if not token:
            return []
        rows = await _refresh_user(db, user_id, token)
        await db.commit()
        return rows

    owners = (
        await db.scalars(
            select(FilamentDBContribution.created_by)
            .where(
                FilamentDBContribution.created_by.is_not(None),
                FilamentDBContribution.status.in_(("pending", "changes_requested", "waiting")),
            )
            .distinct()
        )
    ).all()
    result: list[FilamentDBContribution] = []
    for owner_id in owners:
        try:
            token = await get_token(db, owner_id)
        except FilamentDBError as exc:
            logger.info("FilaMan-DB refresh skipped for user %s: %s", owner_id, exc.message)
            continue
        if not token:
            logger.info("FilaMan-DB refresh skipped for user %s: no token saved", owner_id)
            continue
        try:
            result.extend(await _refresh_user(db, owner_id, token))
            await db.commit()
        except FilamentDBError as exc:
            await db.rollback()
            logger.info("FilaMan-DB refresh for user %s failed: %s", owner_id, exc.message)
    return result


async def run_refresh_once() -> None:
    """Hintergrund-Job (alle 30 min): eigene Session, jeder User mit seinem Token."""
    from app.core.database import async_session_maker

    async with async_session_maker() as db:
        try:
            await refresh(db, None)
        except FilamentDBError as exc:
            await db.rollback()
            logger.info("FilaMan-DB refresh skipped: %s", exc.message)


# ── Liste ────────────────────────────────────────────────────────────────


async def _label(db: AsyncSession, entity_type: str, local_id: int) -> str | None:
    if entity_type == "manufacturer":
        obj = await db.get(Manufacturer, local_id)
        return obj.name if obj else None
    if entity_type == "filament":
        fil = await db.get(Filament, local_id)
        if fil is None:
            return None
        mfr = await db.get(Manufacturer, fil.manufacturer_id)
        return f"{mfr.name} {fil.designation}" if mfr else fil.designation
    if entity_type == "printer_model":
        if local_id < 0:
            source = await db.get(FilamentPrinterProfile, -local_id)
        else:
            source = await db.get(Printer, local_id)
        if source is None:
            return None
        return (
            " ".join(filter(None, [source.printer_manufacturer, source.printer_model]))
            or getattr(source, "name", None)
            or source.profile_name
        )
    profile = await db.get(FilamentPrinterProfile, local_id)
    if profile is None:
        return None
    fil = await db.get(Filament, profile.filament_id)
    return f"{profile.profile_name} ({fil.designation})" if fil else profile.profile_name


async def _user_label(db: AsyncSession, user_id: int | None) -> str | None:
    user = await get_user(db, user_id)
    if user is None:
        return None
    return user.display_name or user.email


async def serialize(db: AsyncSession, row: FilamentDBContribution) -> dict[str, Any]:
    dep = await db.get(FilamentDBContribution, row.depends_on_id) if row.depends_on_id else None
    try:
        current = await local_fingerprint(db, row.entity_type, row.local_id)
        changed = row.payload_hash is None or row.payload_hash != current
    except FilamentDBError:
        changed = False  # lokales Objekt gelöscht
    return {
        "id": row.id,
        "entity_type": row.entity_type,
        "local_id": row.local_id,
        "label": await _label(db, row.entity_type, row.local_id),
        "status": row.status,
        "changed": changed,
        "remote_submission_id": row.remote_submission_id,
        "remote_entity_id": row.remote_entity_id,
        "depends_on": (
            {
                "id": dep.id,
                "entity_type": dep.entity_type,
                "local_id": dep.local_id,
                "label": await _label(db, dep.entity_type, dep.local_id),
                "status": dep.status,
            }
            if dep
            else None
        ),
        "created_by": row.created_by,
        "created_by_name": await _user_label(db, row.created_by),
        "last_error": row.last_error,
        "last_checked_at": row.last_checked_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


# ── Community-Profile übernehmen ─────────────────────────────────────────


def _integer_profile_columns() -> set[str]:
    from sqlalchemy import Integer

    return {
        c.name
        for c in FilamentPrinterProfile.__table__.columns
        if isinstance(c.type, Integer) and c.name in PROFILE_FIELDS
    }


async def import_community_profile(
    db: AsyncSession,
    user_id: int | None,
    remote_profile_id: int,
    filament_id: int,
    printer_id: int | None = None,
) -> FilamentPrinterProfile:
    remote = await fdb_request("GET", f"/print-profiles/{remote_profile_id}")
    if not isinstance(remote, dict):
        raise _err(502, "filamentdb_error", "Unexpected answer from FilaMan-DB")
    await _get_filament(db, filament_id)
    printer = await _get_printer(db, printer_id) if printer_id else None
    model_id = _int(remote.get("printer_model_id"))
    if not model_id and printer is not None:
        model_id = printer.filamentdb_printer_model_id
    manufacturer = remote.get("printer_manufacturer") or (printer.printer_manufacturer if printer else None)
    model_name = remote.get("printer_model") or (printer.printer_model if printer else None)
    if not (model_id or (manufacturer and model_name)):
        raise _err(
            422, "printer_model_required", "The profile has no printer model; choose a printer with a model"
        )

    integers = _integer_profile_columns()
    values: dict[str, Any] = {}
    for name in PROFILE_FIELDS:
        value = remote.get(name)
        if value is None:
            continue
        values[name] = _int(value) if name in integers else value
    problems = find_implausible_values(values)
    if problems:
        first = problems[0]
        raise _err(
            422,
            "implausible_value",
            f"{first['field']} must be between {first['min']} and {first['max']}",
            **first,
        )
    author = remote.get("author_display_name") or "FilaMan-DB"
    profile = FilamentPrinterProfile(
        filament_id=filament_id,
        printer_id=printer_id,
        filamentdb_printer_model_id=model_id,
        printer_manufacturer=manufacturer,
        printer_model=model_name,
        profile_name=f"{author} (FilaMan-DB)"[:255],
        **values,
    )
    db.add(profile)
    await db.flush()
    row = await _upsert_row(db, "print_profile", profile.id, user_id)
    row.status = "linked"
    row.remote_entity_id = remote_profile_id
    await _stamp(db, row)
    await db.commit()
    await db.refresh(profile)
    return profile
