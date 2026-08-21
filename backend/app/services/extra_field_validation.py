"""Reusable validation for System and record-local extra-field definitions."""

import math
from typing import Any

from app.services.custom_field_identity import validate_custom_field_path

__all__ = [
    "CONFIG_KEYS_BY_TYPE",
    "VALID_FIELD_TYPES",
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
        isinstance(max_length, bool) or not isinstance(max_length, int) or max_length < 1
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
