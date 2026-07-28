"""Compatibility checks for promoting retained custom values to typed fields."""

from __future__ import annotations

import math
import re
from datetime import date, datetime
from typing import Any, Literal

CustomFieldPathState = Literal["missing", "value", "collision"]


def resolve_custom_field_value(
    custom_fields: dict[str, Any] | None,
    path: str,
) -> tuple[CustomFieldPathState, Any]:
    """Resolve a dotted path while distinguishing absence from shape collision."""
    if not isinstance(custom_fields, dict):
        return "missing", None

    current: Any = custom_fields
    for segment in path.split("."):
        if not isinstance(current, dict):
            return "collision", current
        if segment not in current:
            return "missing", None
        current = current[segment]
    return "value", current


def get_custom_field_value(
    custom_fields: dict[str, Any] | None,
    path: str,
) -> tuple[bool, Any]:
    """Resolve the same dotted custom-field paths used by the frontend."""
    state, value = resolve_custom_field_value(custom_fields, path)
    return state == "value", value


def is_existing_value_compatible(
    value: Any,
    field_type: str,
    options: list[str] | None = None,
    config: dict[str, Any] | None = None,
) -> bool:
    """Return whether a retained JSON value already has a usable native shape.

    This deliberately validates, rather than converts, values. Import and repair
    workflows own their explicit conversion step and do not call this helper.
    """
    if value is None or value == "":
        return True

    if field_type in {"text", "textarea"}:
        if not isinstance(value, str | int | float | bool):
            return False
        return field_type != "textarea" or _within_text_length(value, config)

    if field_type == "url":
        return isinstance(value, str)

    if field_type in {"number", "float", "integer"}:
        return _number_within_bounds(value, config)

    if field_type == "checkbox":
        return isinstance(value, bool) or (
            isinstance(value, str) and value in {"true", "false"}
        )

    if field_type == "range":
        if not isinstance(value, dict) or set(value) - {"min", "max"}:
            return False
        return all(
            endpoint is None
            or endpoint == ""
            or _number_within_bounds(endpoint, config)
            for endpoint in value.values()
        )

    if field_type == "dropdown":
        if isinstance(value, list | dict):
            return False
        return not options or str(value) in options

    if field_type == "multiselect":
        if not isinstance(value, list):
            return False
        return all(
            not isinstance(item, list | dict) and (not options or str(item) in options)
            for item in value
        )

    if field_type == "date":
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return False
        try:
            date.fromisoformat(value)
        except ValueError:
            return False
        return True

    if field_type == "datetime":
        if not isinstance(value, str) or not re.match(
            r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}",
            value,
        ):
            return False
        try:
            datetime.fromisoformat(value)
        except ValueError:
            return False
        return True

    # Preserve the existing API contract for legacy and plugin-defined types.
    return field_type != "formula"


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int | float):
        return math.isfinite(value)
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return math.isfinite(float(value))
    except ValueError:
        return False


def _number_within_bounds(
    value: Any,
    config: dict[str, Any] | None,
) -> bool:
    if not _is_finite_number(value):
        return False
    number = float(value)
    minimum = (config or {}).get("min_bound")
    maximum = (config or {}).get("max_bound")
    return not (
        minimum is not None
        and number < minimum
        or maximum is not None
        and number > maximum
    )


def _within_text_length(
    value: Any,
    config: dict[str, Any] | None,
) -> bool:
    maximum = (config or {}).get("max_length")
    return maximum is None or len(str(value)) <= maximum
