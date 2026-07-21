"""Derived field evaluation via JSON Logic.

Computes formula-based extra fields at read time so the values never
need to be stored — they are derived from the entity's own data.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from json_logic import add_operation, jsonLogic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from app.models.system_extra_field import SystemExtraField

logger = logging.getLogger(__name__)

DerivedSurface = Literal["api", "detail", "template"]

# Explicitly omit operators such as ``method`` and ``log``. Formula fields are
# persisted configuration, so the evaluator should expose a small data-only
# language rather than every capability offered by the Python package.
ALLOWED_OPERATORS = frozenset(
    {
        "==", "===", "!=", "!==", ">", ">=", "<", "<=", "!!", "!",
        "in", "cat", "substr", "+", "-", "*", "/", "%", "min", "max",
        "merge", "if", "?:", "and", "or", "filter", "map", "reduce",
        "all", "none", "some", "var", "missing", "missing_some",
        "hue_from_hex", "floor", "abs", "round", "coalesce", "upper",
        "lower", "trim", "length", "left", "right", "year", "month",
        "day", "hour", "minute", "second", "timestamp", "date_only",
        "time_only", "today", "days_between", "hours_between",
    }
)
MAX_FORMULA_DEPTH = 32
MAX_FORMULA_NODES = 512


# ---------------------------------------------------------------------------
# Custom JSON Logic operators
# ---------------------------------------------------------------------------

def _hue_from_hex(hex_str: Any) -> int | None:
    """Return HSL hue (0–359) for a CSS hex color string, or None on bad input."""
    if not isinstance(hex_str, str):
        return None
    h = hex_str.lstrip("#")
    if len(h) < 6:
        return None
    try:
        r = int(h[0:2], 16) / 255
        g = int(h[2:4], 16) / 255
        b = int(h[4:6], 16) / 255
    except ValueError:
        return None
    cmax, cmin = max(r, g, b), min(r, g, b)
    delta = cmax - cmin
    if delta == 0:
        return 0
    if cmax == r:
        hue = 60.0 * (((g - b) / delta) % 6)
    elif cmax == g:
        hue = 60.0 * ((b - r) / delta + 2)
    else:
        hue = 60.0 * ((r - g) / delta + 4)
    return round(hue)


add_operation("hue_from_hex", _hue_from_hex)


# -- Math ------------------------------------------------------------------

def _floor(val: Any) -> Any:
    return math.floor(val) if isinstance(val, (int, float)) else None


def _abs(val: Any) -> Any:
    return abs(val) if isinstance(val, (int, float)) else None


def _round(val: Any, ndigits: Any = 0) -> Any:
    if not isinstance(val, (int, float)):
        return None
    return round(val, int(ndigits))


def _coalesce(*args: Any) -> Any:
    for a in args:
        if a is not None:
            return a
    return None


add_operation("floor", _floor)
add_operation("abs", _abs)
add_operation("round", _round)
add_operation("coalesce", _coalesce)


# -- Text ------------------------------------------------------------------

def _upper(s: Any) -> Any:
    return s.upper() if isinstance(s, str) else s


def _lower(s: Any) -> Any:
    return s.lower() if isinstance(s, str) else s


def _trim(s: Any) -> Any:
    return s.strip() if isinstance(s, str) else s


def _length(s: Any) -> Any:
    return len(s) if isinstance(s, (str, list)) else None


def _left(s: Any, n: Any) -> Any:
    return s[: int(n)] if isinstance(s, str) else None


def _right(s: Any, n: Any) -> Any:
    if not isinstance(s, str):
        return None
    n = int(n)
    return s[-n:] if n > 0 else ""


add_operation("upper", _upper)
add_operation("lower", _lower)
add_operation("trim", _trim)
add_operation("length", _length)
add_operation("left", _left)
add_operation("right", _right)


# -- Date / Time -----------------------------------------------------------

def _parse_dt(val: Any) -> datetime | None:
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        try:
            return datetime.fromisoformat(val)
        except ValueError:
            return None
    return None


def _year(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.year if dt else None


def _month(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.month if dt else None


def _day(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.day if dt else None


def _hour(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.hour if dt else None


def _minute(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.minute if dt else None


def _second(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.second if dt else None


def _timestamp(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.timestamp() if dt else None


def _date_only(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.strftime("%Y-%m-%d") if dt else None


def _time_only(val: Any) -> Any:
    dt = _parse_dt(val)
    return dt.strftime("%H:%M:%S") if dt else None


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _days_between(start: Any, end: Any) -> Any:
    ds, de = _parse_dt(start), _parse_dt(end)
    if ds is None or de is None:
        return None
    if ds.tzinfo is not None and de.tzinfo is None:
        de = de.replace(tzinfo=timezone.utc)
    elif ds.tzinfo is None and de.tzinfo is not None:
        ds = ds.replace(tzinfo=timezone.utc)
    return (de - ds).days


def _hours_between(start: Any, end: Any) -> Any:
    ds, de = _parse_dt(start), _parse_dt(end)
    if ds is None or de is None:
        return None
    if ds.tzinfo is not None and de.tzinfo is None:
        de = de.replace(tzinfo=timezone.utc)
    elif ds.tzinfo is None and de.tzinfo is not None:
        ds = ds.replace(tzinfo=timezone.utc)
    return round((de - ds).total_seconds() / 3600, 2)


add_operation("year", _year)
add_operation("month", _month)
add_operation("day", _day)
add_operation("hour", _hour)
add_operation("minute", _minute)
add_operation("second", _second)
add_operation("timestamp", _timestamp)
add_operation("date_only", _date_only)
add_operation("time_only", _time_only)
add_operation("today", _today)
add_operation("days_between", _days_between)
add_operation("hours_between", _hours_between)


def _scalar(value: Any) -> Any:
    """Convert ORM objects/lists to plain Python values for JSON Logic."""
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)


def build_formula_context(entity: Any, target_type: str) -> dict[str, Any]:
    """Construct the evaluation context dict from an ORM entity.

    For a *spool*  the context includes all spool scalar fields, its
    ``custom_fields`` entries, and a nested ``filament.*`` sub-context
    (including ``filament.manufacturer.*`` and ``filament.custom_fields.*``).

    For a *filament* the context includes all filament scalar fields,
    its ``custom_fields`` entries, and a nested ``manufacturer.*``
    sub-context.
    """
    if target_type == "spool":
        ctx: dict[str, Any] = {
            "id": entity.id,
            "filament_id": entity.filament_id,
            "status_id": entity.status_id,
            "location_id": entity.location_id,
            "lot_number": entity.lot_number,
            "rfid_uid": entity.rfid_uid,
            "external_id": entity.external_id,
            "purchase_price": entity.purchase_price,
            "purchase_date": entity.purchase_date.isoformat() if entity.purchase_date else None,
            "stocked_in_at": entity.stocked_in_at.isoformat() if entity.stocked_in_at else None,
            "last_used_at": entity.last_used_at.isoformat() if entity.last_used_at else None,
            "initial_total_weight_g": entity.initial_total_weight_g,
            "empty_spool_weight_g": entity.empty_spool_weight_g,
            "remaining_weight_g": entity.remaining_weight_g,
            "spool_outer_diameter_mm": entity.spool_outer_diameter_mm,
            "spool_width_mm": entity.spool_width_mm,
            "spool_material": entity.spool_material,
            "low_weight_threshold_g": entity.low_weight_threshold_g,
        }
        ctx["custom_fields"] = dict(entity.custom_fields or {})

        # Nested filament sub-context
        fil = getattr(entity, "filament", None)
        if fil is not None:
            ctx["filament"] = _filament_context(fil)
        return ctx

    if target_type == "filament":
        ctx = _filament_context(entity)
        return ctx

    return {}


def _filament_context(fil: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "id": fil.id,
        "designation": fil.designation,
        "material_type": fil.material_type,
        "material_subgroup": fil.material_subgroup,
        "diameter_mm": fil.diameter_mm,
        "manufacturer_color_name": fil.manufacturer_color_name,
        "finish_type": fil.finish_type,
        "raw_material_weight_g": fil.raw_material_weight_g,
        "default_spool_weight_g": fil.default_spool_weight_g,
        "spool_outer_diameter_mm": fil.spool_outer_diameter_mm,
        "spool_width_mm": fil.spool_width_mm,
        "spool_material": fil.spool_material,
        "price": fil.price,
        "density_g_cm3": fil.density_g_cm3,
        "color_mode": fil.color_mode,
        "shop_url": fil.shop_url,
        "multi_color_style": fil.multi_color_style,
    }
    # Expose color hex codes from the filament_colors relationship.
    # color_hex = first color's hex (useful for single-color filaments).
    # colors = list of {position, hex, name} for multi-color access.
    fil_colors = sorted(getattr(fil, "filament_colors", None) or [], key=lambda fc: fc.position)
    if fil_colors:
        ctx["color_hex"] = fil_colors[0].color.hex_code
        ctx["colors"] = [
            {"position": fc.position, "hex": fc.color.hex_code, "name": fc.color.name}
            for fc in fil_colors
        ]
    else:
        ctx["color_hex"] = None
        ctx["colors"] = []

    ctx["custom_fields"] = dict(fil.custom_fields or {})

    mfr = getattr(fil, "manufacturer", None)
    if mfr is not None:
        ctx["manufacturer"] = {
            "id": mfr.id,
            "name": mfr.name,
            "url": mfr.url,
        }
    return ctx


def validate_formula(formula: dict[str, Any]) -> None:
    """Validate shape, operators, size, and literal evaluation failures."""
    if not formula:
        raise ValueError("Formula must be a non-empty JSON Logic object")

    nodes = 0

    def walk(value: Any, depth: int = 0) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_FORMULA_NODES:
            raise ValueError(f"Formula exceeds the {MAX_FORMULA_NODES}-node limit")
        if depth > MAX_FORMULA_DEPTH:
            raise ValueError(f"Formula exceeds the {MAX_FORMULA_DEPTH}-level depth limit")
        if isinstance(value, list):
            for item in value:
                walk(item, depth + 1)
            return
        if not isinstance(value, dict):
            return
        if len(value) != 1:
            raise ValueError("Each JSON Logic expression must contain exactly one operator")
        operator, operands = next(iter(value.items()))
        if operator not in ALLOWED_OPERATORS:
            raise ValueError(f"Unsupported JSON Logic operator: {operator}")
        walk(operands, depth + 1)

    walk(formula)
    # Literal-only expressions can be evaluated safely. Variable-backed rules
    # are checked structurally here and evaluated against real/sample data later.
    if not formula_var_paths(formula):
        evaluate_formula_strict(formula, {})


def evaluate_formula_strict(formula: dict[str, Any], context: dict[str, Any]) -> Any:
    """Evaluate a validated expression and propagate evaluation errors."""
    return jsonLogic(formula, context)


def evaluate_formula(formula: dict[str, Any], context: dict[str, Any]) -> Any:
    """Evaluate a JSON Logic expression against *context*.

    Returns ``None`` on any evaluation error rather than raising, so a
    bad formula silently produces no output rather than breaking the
    entire response.
    """
    try:
        return evaluate_formula_strict(formula, context)
    except Exception:
        logger.debug("Formula evaluation failed: formula=%r context_keys=%s", formula, list(context))
        return None


def compute_derived(
    entity: Any,
    target_type: str,
    formula_fields: list[SystemExtraField],
) -> dict[str, Any]:
    """Run all formula fields and return ``{key: value}`` for non-null results."""
    if not formula_fields:
        return {}

    context = build_formula_context(entity, target_type)
    result: dict[str, Any] = {}
    for field in formula_fields:
        if field.formula:
            value = evaluate_formula(field.formula, context)
            if value is not None:
                result[field.key] = value
    return result


async def load_formula_fields(
    db: AsyncSession,
    target_type: str,
    surface: DerivedSurface = "api",
) -> list[SystemExtraField]:
    """Load formula definitions exposed on one native FilaMan surface."""
    from app.models.system_extra_field import SystemExtraField

    exposure_column = {
        "api": SystemExtraField.include_in_api,
        "detail": SystemExtraField.show_in_detail,
        "template": SystemExtraField.show_in_template,
    }[surface]
    result = await db.execute(
        select(SystemExtraField).where(
            SystemExtraField.target_type == target_type,
            SystemExtraField.field_type == "formula",
            SystemExtraField.formula.is_not(None),
            exposure_column.is_(True),
        )
    )
    return list(result.scalars().all())


def formula_var_paths(formula: object) -> set[str]:
    """Return only actual JSON Logic ``var`` references from an expression."""
    if isinstance(formula, list):
        paths: set[str] = set()
        for item in formula:
            paths.update(formula_var_paths(item))
        return paths
    if not isinstance(formula, dict):
        return set()
    paths = set()
    for operator, operands in formula.items():
        if operator == "var":
            candidate = operands[0] if isinstance(operands, list) and operands else operands
            if isinstance(candidate, str):
                paths.add(candidate)
        else:
            paths.update(formula_var_paths(operands))
    return paths
