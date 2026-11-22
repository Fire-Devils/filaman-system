"""Abrasive-filament detection and nozzle warnings (pure functions)."""

import re
from typing import Any

_ABRASIVE_TOKENS = frozenset(
    {
        "cf",
        "gf",
        "carbon",
        "glass",
        "glow",
        "gitd",
        "leuchtend",
        "wood",
        "holz",
        "metal",
        "marble",
        "marmor",
        "steel",
        "copper",
        "bronze",
    }
)
_MIN_04 = frozenset({"cf", "gf", "wood", "holz"})
_MIN_06 = frozenset({"metal", "steel", "copper", "bronze"})

# A word counts as a token when it is delimited by anything that is not a
# letter or digit (space, hyphen, plus, slash, ...). "PLA-CF" and "PLA+GF"
# match; embedded letters ("Cfoo") do not.
_SPLIT_RE = re.compile(r"[^0-9a-zA-ZäöüÄÖÜß]+")


def _tokens(filament: Any) -> set[str]:
    found: set[str] = set()
    for attr in ("material_type", "material_subgroup", "designation"):
        value = getattr(filament, attr, None)
        if not value:
            continue
        for part in _SPLIT_RE.split(str(value).lower()):
            if part:
                found.add(part)
    return found


def effective_abrasive(filament: Any) -> bool:
    """Explicit override wins; otherwise detect by name tokens."""
    override = getattr(filament, "is_abrasive", None)
    if override is not None:
        return bool(override)
    return bool(_tokens(filament) & _ABRASIVE_TOKENS)


def min_nozzle_mm(filament: Any) -> float | None:
    tokens = _tokens(filament)
    if tokens & _MIN_06:
        return 0.6
    if tokens & _MIN_04:
        return 0.4
    return None


def slot_warnings(filament: Any, printer: Any) -> list[dict[str, Any]]:
    """Warnings for a filament loaded in a slot of the given printer."""
    if filament is None:
        return []
    warnings: list[dict[str, Any]] = []
    if effective_abrasive(filament):
        hardened = getattr(printer, "nozzle_hardened", None)
        if hardened is not True:
            warnings.append(
                {
                    "code": "abrasive_soft_nozzle",
                    "level": "warning" if hardened is False else "unknown",
                }
            )
    needed = min_nozzle_mm(filament)
    diameter = getattr(printer, "nozzle_diameter_mm", None)
    if needed is not None and diameter is not None and diameter < needed:
        warnings.append(
            {
                "code": "nozzle_too_small",
                "level": "warning",
                "nozzle_diameter_mm": diameter,
                "min_nozzle_mm": needed,
            }
        )
    return warnings
