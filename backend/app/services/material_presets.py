"""Material presets: default print/drying values per filament material.

The matching and apply functions are pure (no database access). The small
snapshot cache lets sync code (e.g. ``Spool.moisture``) read the drying
intervals without a session; it is refreshed by ``ensure_preset_cache``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, fields
from typing import Any

# (material_type, ext_min, ext_max, bed_min, bed_max, flow, dry_temp, dry_hours,
#  interval_days, density)
_DEFAULT_ROWS: tuple[tuple[Any, ...], ...] = (
    ("PLA", 190, 230, 50, 65, 0.98, 55, 8, 90, 1.24),
    ("PLA-CF", 210, 240, 45, 65, 0.96, 55, 8, 60, 1.29),
    ("PETG", 220, 260, 70, 85, 0.95, 65, 8, 30, 1.27),
    ("PETG-CF", 240, 270, 70, 85, 0.95, 65, 8, 30, 1.29),
    ("PCTG", 240, 270, 70, 90, 0.95, 65, 6, 30, 1.23),
    ("PET-CF", 260, 290, 70, 90, 0.96, 80, 10, 21, 1.29),
    ("ABS", 240, 270, 90, 110, 0.95, 80, 8, 30, 1.04),
    ("ASA", 240, 270, 90, 110, 0.95, 80, 8, 30, 1.07),
    ("HIPS", 230, 250, 90, 110, 0.98, 70, 6, 30, 1.04),
    ("PC", 260, 300, 100, 120, 0.95, 80, 8, 14, 1.20),
    ("TPU", 210, 240, 30, 60, 1.00, 55, 8, 14, 1.21),
    ("PA", 260, 290, 80, 100, 0.98, 80, 12, 7, 1.14),
    ("PA-CF", 260, 300, 80, 100, 0.96, 80, 12, 7, 1.17),
    ("PP", 220, 250, 80, 100, 0.98, 70, 6, 60, 0.90),
    ("PPS", 300, 340, 100, 120, 0.98, 90, 8, 14, 1.35),
    ("PVA", 190, 220, 45, 60, 1.00, 55, 8, 3, 1.23),
    ("BVOH", 190, 220, 50, 70, 1.00, 55, 8, 3, 1.14),
)

PRESET_VALUE_FIELDS: tuple[str, ...] = (
    "extruder_temp_min_c",
    "extruder_temp_max_c",
    "bed_temp_min_c",
    "bed_temp_max_c",
    "flow_ratio",
    "drying_temp_c",
    "drying_time_hours",
    "drying_interval_days",
    "density_g_cm3",
)

DEFAULT_MATERIAL_PRESETS: tuple[dict[str, Any], ...] = tuple(
    {"material_type": row[0], **dict(zip(PRESET_VALUE_FIELDS, row[1:]))}
    for row in _DEFAULT_ROWS
)

DEFAULT_EMPTY_SPOOL_WEIGHT_G = 250.0


@dataclass(frozen=True)
class PresetSnapshot:
    """Detached copy of a ``MaterialPreset`` row."""

    material_type: str
    extruder_temp_min_c: float | None = None
    extruder_temp_max_c: float | None = None
    bed_temp_min_c: float | None = None
    bed_temp_max_c: float | None = None
    flow_ratio: float | None = None
    drying_temp_c: float | None = None
    drying_time_hours: float | None = None
    drying_interval_days: int | None = None
    density_g_cm3: float | None = None


def snapshot(preset: Any) -> PresetSnapshot:
    return PresetSnapshot(
        **{f.name: getattr(preset, f.name) for f in fields(PresetSnapshot)}
    )


def _prefix_len(value: str | None, material_type: str) -> int:
    if not value:
        return 0
    prefix = (material_type or "").strip().casefold()
    if prefix and value.strip().casefold().startswith(prefix):
        return len(prefix)
    return 0


def match_preset(
    presets: Any,
    material_type: str | None,
    material_subgroup: str | None = None,
) -> Any | None:
    """Preset with the longest prefix match; type first, subgroup as fallback."""
    for candidate in (material_type, material_subgroup):
        best = None
        best_len = 0
        for preset in presets:
            length = _prefix_len(candidate, preset.material_type)
            if length > best_len:
                best, best_len = preset, length
        if best is not None:
            return best
    return None


def _range_empty(value: Any) -> bool:
    if not value:
        return True
    return value.get("min") is None and value.get("max") is None


def apply_material_defaults(
    filament: Any,
    preset: Any | None,
    app_settings: Any | None = None,
    manufacturer: Any | None = None,
) -> int:
    """Fill empty (None) filament fields from preset and spool-weight defaults.

    Values already set always win. Temperature ranges are only filled when the
    whole range is empty. The empty spool weight comes from the manufacturer,
    otherwise from the global app setting. Returns the number of fields set.
    """
    changed = 0

    def put(name: str, value: Any) -> None:
        nonlocal changed
        if value is not None and getattr(filament, name) is None:
            setattr(filament, name, value)
            changed += 1

    if preset is not None:
        for name in ("flow_ratio", "drying_temp_c", "drying_time_hours",
                     "drying_interval_days", "density_g_cm3"):
            put(name, getattr(preset, name))
        for attr, lo, hi in (
            ("extruder_temp_range_c", "extruder_temp_min_c", "extruder_temp_max_c"),
            ("bed_temp_range_c", "bed_temp_min_c", "bed_temp_max_c"),
        ):
            low, high = getattr(preset, lo), getattr(preset, hi)
            if _range_empty(getattr(filament, attr)) and (
                low is not None or high is not None
            ):
                setattr(filament, attr, {"min": low, "max": high})
                changed += 1

    if filament.default_spool_weight_g is None:
        weight = getattr(manufacturer, "empty_spool_weight_g", None)
        if weight is None:
            # No settings row yet means the shipped default still applies.
            weight = (
                DEFAULT_EMPTY_SPOOL_WEIGHT_G
                if app_settings is None
                else app_settings.default_empty_spool_weight_g
            )
        put("default_spool_weight_g", weight)
    return changed


# --- snapshot cache for sync readers -------------------------------------

_CACHE_TTL_SECONDS = 60.0
_cache: tuple[float, tuple[PresetSnapshot, ...]] | None = None


def set_preset_cache(presets: Any) -> None:
    global _cache
    _cache = (time.monotonic(), tuple(snapshot(p) for p in presets))


def invalidate_preset_cache() -> None:
    global _cache
    _cache = None


def cached_presets() -> tuple[PresetSnapshot, ...]:
    return _cache[1] if _cache is not None else ()


def cache_is_fresh() -> bool:
    return _cache is not None and time.monotonic() - _cache[0] < _CACHE_TTL_SECONDS


def cached_interval_days(
    material_type: str | None, material_subgroup: str | None = None
) -> int | None:
    preset = match_preset(cached_presets(), material_type, material_subgroup)
    return preset.drying_interval_days if preset is not None else None


async def load_presets(db: Any) -> list[Any]:
    from sqlalchemy import select

    from app.models.material_preset import MaterialPreset

    result = await db.execute(select(MaterialPreset).order_by(MaterialPreset.material_type))
    return list(result.scalars().all())


async def ensure_preset_cache(db: Any) -> None:
    """Refresh the snapshot cache when stale; never raises."""
    if cache_is_fresh():
        return
    try:
        set_preset_cache(await load_presets(db))
    except Exception:  # noqa: BLE001 - table missing / DB hiccup must not break requests
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass


async def apply_defaults_to_new_filament(
    db: Any, filament: Any, manufacturer: Any | None = None
) -> int:
    """Load presets/settings and fill empty fields of a freshly created filament."""
    from sqlalchemy import select

    from app.models.app_settings import AppSettings

    presets = await load_presets(db)
    settings_row = (
        await db.execute(select(AppSettings).where(AppSettings.id == 1))
    ).scalar_one_or_none()
    preset = match_preset(presets, filament.material_type, filament.material_subgroup)
    return apply_material_defaults(filament, preset, settings_row, manufacturer)
