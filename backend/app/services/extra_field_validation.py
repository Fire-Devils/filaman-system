"""Reusable validation for System and record-local extra-field definitions."""

import math
from typing import Any

from app.services.custom_field_identity import validate_custom_field_path

__all__ = [
    "CONFIG_KEYS_BY_TYPE",
    "VALID_FIELD_TYPES",
    "normalize_numeric_range",
    "validate_custom_field_path",
    "validate_field_type_config",
]

VALID_FIELD_TYPES = frozenset(
    {
        "text",
        "number",
        "range",
        "dropdown",
        "checkbox",
        "formula",
        "date",
        "datetime",
        "url",
        "multiselect",
        "textarea",
    }
)

CONFIG_KEYS_BY_TYPE = {
    "number": {"unit", "decimal_places", "min_bound", "max_bound"},
    "range": {"unit", "decimal_places", "min_bound", "max_bound"},
    "textarea": {"max_length"},
}


def normalize_numeric_range(value: Any) -> dict[str, int | float | None]:
    """Return the canonical JSON range shape, accepting a scalar shorthand."""
    if isinstance(value, bool):
        raise ValueError("range values must be numbers")  # noqa: TRY004
    if isinstance(value, int | float):
        endpoints = (value, value)
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        endpoints = (value[0], value[1])
    elif isinstance(value, dict) and set(value) <= {"min", "max"}:
        endpoints = (value.get("min"), value.get("max"))
    else:
        raise ValueError("expected a number or range with min and max")

    for endpoint in endpoints:
        if endpoint is not None and (
            isinstance(endpoint, bool)
            or not isinstance(endpoint, int | float)
            or not math.isfinite(endpoint)
        ):
            raise ValueError("range endpoints must be finite numbers or null")
    if endpoints == (None, None):
        raise ValueError("range must contain at least one endpoint")
    if (
        endpoints[0] is not None
        and endpoints[1] is not None
        and endpoints[0] > endpoints[1]
    ):
        raise ValueError("range min must be less than or equal to max")
    return {"min": endpoints[0], "max": endpoints[1]}


def validate_field_type_config(
    field_type: str,
    options: list[str] | None,
    config: dict[str, Any] | None,
) -> None:
    # multiselect is new, so requiring choices does not reject legacy payloads.
    # Existing field types and option combinations remain accepted as before.
    if field_type == "multiselect" and not options:
        raise ValueError(f"options must be provided for field_type={field_type!r}")

    if not config:
        return

    allowed_keys = CONFIG_KEYS_BY_TYPE.get(field_type, set())
    unknown_keys = set(config) - allowed_keys
    if unknown_keys:
        raise ValueError(
            f"Unsupported config keys for field_type={field_type!r}: "
            f"{sorted(unknown_keys)}"
        )

    unit = config.get("unit")
    if unit is not None and not isinstance(unit, str):
        raise ValueError("config.unit must be a string")

    decimal_places = config.get("decimal_places")
    if decimal_places is not None and (
        isinstance(decimal_places, bool)
        or not isinstance(decimal_places, int)
        or decimal_places < 0
        or decimal_places > 10
    ):
        raise ValueError("config.decimal_places must be an integer from 0 to 10")

    max_length = config.get("max_length")
    if max_length is not None and (
        isinstance(max_length, bool)
        or not isinstance(max_length, int)
        or max_length < 1
    ):
        raise ValueError("config.max_length must be a positive integer")

    bounds: dict[str, int | float] = {}
    for key in ("min_bound", "max_bound"):
        value = config.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError(f"config.{key} must be a number")  # noqa: TRY004
        if not math.isfinite(value):
            raise ValueError(f"config.{key} must be finite")
        bounds[key] = value

    if (
        field_type in {"number", "range"}
        and "min_bound" in bounds
        and "max_bound" in bounds
        and bounds["min_bound"] >= bounds["max_bound"]
    ):
        raise ValueError("config.min_bound must be less than config.max_bound")
