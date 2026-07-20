from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

VALID_FIELD_TYPES = frozenset({
    "text", "number", "range",
    "dropdown", "checkbox", "formula",
    "date", "url", "multiselect", "textarea",
})

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
            f"Unsupported config keys for field_type={field_type!r}: {sorted(unknown_keys)}"
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
            raise ValueError(f"config.{key} must be a number")
        bounds[key] = value

    if (
        field_type in {"number", "range"}
        and "min_bound" in bounds
        and "max_bound" in bounds
        and bounds["min_bound"] >= bounds["max_bound"]
    ):
        raise ValueError("config.min_bound must be less than config.max_bound")


class SystemExtraFieldBase(BaseModel):
    target_type: str = Field(..., description="'filament' or 'spool'")
    key: str = Field(..., description="Key for the JSON custom_fields")
    label: str = Field(..., description="Display label")
    default_value: str | None = Field(None, description="Default value if any")
    field_type: str = Field(
        "text",
        description=(
            "Field type: text, number, range, dropdown, checkbox, "
            "formula, date, url, multiselect, textarea"
        ),
    )
    options: list[str] | None = Field(None, description="Options for dropdown/multiselect fields")
    config: dict[str, Any] | None = Field(
        None,
        exclude_if=lambda value: value is None,
        description=(
            "Type-specific config. Supported keys: unit (str), decimal_places (int|null), "
            "min_bound (number|null), max_bound (number|null), max_length (int|null)."
        ),
    )

class SystemExtraFieldCreate(SystemExtraFieldBase):
    source: str | None = Field(
        None,
        description="Plugin source, e.g. 'bambulab'. Protected from manual deletion.",
    )

    @model_validator(mode="after")
    def validate_type_and_config(self) -> "SystemExtraFieldCreate":
        validate_field_type_config(self.field_type, self.options, self.config)
        return self


class SystemExtraFieldUpdate(BaseModel):
    """Update schema for user-created fields. target_type and key are not editable."""

    label: str | None = Field(None, description="Display label")
    default_value: str | None = Field(None, description="Default value if any")
    field_type: str | None = Field(
        None,
        description=(
            "Field type: text, number, range, dropdown, checkbox, "
            "formula, date, url, multiselect, textarea. Cannot be changed after creation."
        ),
    )
    options: list[str] | None = Field(None, description="Options for dropdown/multiselect fields")
    config: dict[str, Any] | None = Field(None, description="Type-specific config")


class SystemExtraFieldResponse(SystemExtraFieldBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str | None = None
