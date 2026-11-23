"""Moisture exposure of a spool, derived from when it was opened or last dried.

Pure functions only (no database access) so the rules stay easy to test.
"""

from datetime import datetime, timezone
from typing import Any

LEVELS = ("dry", "fair", "damp", "wet")

# Status keys for which no moisture status is reported.
EXCLUDED_STATUS_KEYS = frozenset({"new", "empty", "archived"})

# Material prefixes per sensitivity (compared case-insensitively). The longest
# matching prefix wins, so "PCTG" (medium) is not swallowed by "PC" (high) and
# "PPS" (high) not by "PP" (medium). Everything unlisted counts as "low".
SENSITIVITY_PREFIXES: dict[str, tuple[str, ...]] = {
    "high": (
        "pa", "nylon", "pva", "bvoh", "pc", "tpu", "peba", "pps", "ppa", "pa-cf", "pa-gf",
    ),
    "medium": ("pet", "petg", "pctg", "asa", "abs", "pet-cf", "hips", "pp"),
    "low": ("pla",),
}

_SENSITIVITY_RANK = {"low": 0, "medium": 1, "high": 2}

# Upper bounds in days for dry / fair / damp; anything above is "wet".
THRESHOLD_DAYS: dict[str, tuple[int, int, int]] = {
    "high": (3, 7, 14),
    "medium": (7, 21, 45),
    "low": (30, 90, 180),
}

_PREFIX_TABLE: tuple[tuple[str, str], ...] = tuple(
    (prefix, sensitivity)
    for sensitivity, prefixes in SENSITIVITY_PREFIXES.items()
    for prefix in prefixes
)


def _classify_one(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip().casefold()
    best: tuple[int, str] | None = None
    for prefix, sensitivity in _PREFIX_TABLE:
        if text.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), sensitivity)
    return best[1] if best else None


def material_sensitivity(
    material_type: str | None, material_subgroup: str | None = None
) -> str:
    """Moisture sensitivity ("high" | "medium" | "low") of a material.

    Type and subgroup are both checked; the more sensitive match wins.
    """
    found = [
        s
        for s in (_classify_one(material_type), _classify_one(material_subgroup))
        if s is not None
    ]
    if not found:
        return "low"
    return max(found, key=_SENSITIVITY_RANK.__getitem__)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def interval_thresholds(interval_days: int) -> tuple[int, int, int]:
    """Dry / fair / damp upper bounds derived from a drying interval in days."""
    dry = max(1, round(interval_days * 0.2))
    fair = max(dry + 1, round(interval_days * 0.5))
    return dry, fair, interval_days


def moisture_level(
    sensitivity: str, days_exposed: int, interval_days: int | None = None
) -> str:
    if interval_days is not None and interval_days > 0:
        dry, fair, damp = interval_thresholds(interval_days)
    else:
        dry, fair, damp = THRESHOLD_DAYS[sensitivity]
    if days_exposed <= dry:
        return "dry"
    if days_exposed <= fair:
        return "fair"
    if days_exposed <= damp:
        return "damp"
    return "wet"


def compute_moisture(
    status_key: str | None,
    material_type: str | None,
    material_subgroup: str | None,
    opened_at: datetime | None,
    last_dried_at: datetime | None,
    now: datetime | None = None,
    interval_days: int | None = None,
) -> dict[str, Any] | None:
    """Moisture status or None when it does not apply.

    Reference point is the later of opened_at and last_dried_at. None when no
    reference exists or the spool is new, empty or archived. days_exposed is
    the number of full days since the reference (never negative). When
    interval_days is set it replaces the sensitivity-based thresholds.
    """
    if status_key is None or status_key in EXCLUDED_STATUS_KEYS:
        return None
    points = [_aware(p) for p in (opened_at, last_dried_at) if p is not None]
    if not points:
        return None
    reference = max(points)
    current = _aware(now) if now else datetime.now(timezone.utc)
    days = max(0, int((current - reference).total_seconds() // 86400))
    sensitivity = material_sensitivity(material_type, material_subgroup)
    return {
        "level": moisture_level(sensitivity, days, interval_days),
        "days_exposed": days,
        "reference_at": reference,
        "sensitivity": sensitivity,
    }
