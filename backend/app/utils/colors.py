from __future__ import annotations

from string import hexdigits
from typing import Any

_KNOWN_SPOOLMANDB_ARGB_VALUES = {
    "00FFFFFF": "FFFFFF00",
    "3C8AD77F": "8AD77F3C",
    "3CD8100C": "D8100C3C",
    "3CF8A813": "F8A8133C",
}


def normalize_hex_color(value: Any) -> str:
    """Normalize a color value to CSS-compatible `#RRGGBB` or `#RRGGBBAA`.

    Accepts optional `#` prefixes and 3/4-digit shorthand values.
    Stored values are normalized to uppercase with a leading `#`.
    """
    if value is None:
        raise ValueError("hex_code is required")

    raw = str(value).strip().lstrip("#")
    if not raw:
        raise ValueError("hex_code is required")

    if len(raw) in (3, 4):
        raw = "".join(ch * 2 for ch in raw)

    if len(raw) not in (6, 8) or any(ch not in hexdigits for ch in raw):
        raise ValueError("hex_code must use #RRGGBB or #RRGGBBAA format")

    return f"#{raw.upper()}"


def normalize_spoolmandb_hex_color(value: Any) -> str:
    """Normalize SpoolmanDB color data to `#RRGGBB` or `#RRGGBBAA`.

    SpoolmanDB documents 8-digit colors as a 6-digit RGB value plus alpha,
    but some existing entries look like legacy `AARRGGBB` values. Convert
    those known shapes so stored values remain CSS-compatible.
    """
    normalized = normalize_hex_color(value)
    raw = normalized[1:]

    if raw in _KNOWN_SPOOLMANDB_ARGB_VALUES:
        return f"#{_KNOWN_SPOOLMANDB_ARGB_VALUES[raw]}"

    return normalized


def visible_rgb_hex(value: Any) -> str:
    """Return the visible RGB portion for display/printing.

    For device payloads that expect opaque RGB, drop the trailing alpha bytes.
    """
    normalized = normalize_hex_color(value)
    raw = normalized[1:]
    if len(raw) == 8:
        raw = raw[:6]
    return f"#{raw}"


def visible_rgb_hex_or_legacy(value: Any) -> str:
    """Return visible RGB while retaining the shipped legacy fallback."""
    try:
        return visible_rgb_hex(value)
    except ValueError:
        return f"#{str(value).replace('#', '')[:6].upper()}"


def normalize_hex_color_if_valid(value: Any) -> str:
    """Normalize valid colors while preserving shipped legacy string inputs."""
    try:
        return normalize_hex_color(value)
    except ValueError:
        return str(value)
