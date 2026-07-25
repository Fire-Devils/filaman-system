from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator

from app.api.v1.schemas_system_extra_field import validate_field_type_config


class EntityExtraFieldDefinition(BaseModel):
    """Optional input/display metadata for one record-local custom field."""

    label: str | None = Field(None, exclude_if=lambda value: value is None)
    field_type: Literal[
        "text",
        "number",
        "range",
        "dropdown",
        "multiselect",
        "checkbox",
        "date",
        "datetime",
        "url",
        "textarea",
    ] = "text"
    options: list[str] | None = Field(None, exclude_if=lambda value: value is None)
    config: dict[str, Any] | None = Field(None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def validate_type_and_config(self) -> "EntityExtraFieldDefinition":
        validate_field_type_config(self.field_type, self.options, self.config)
        return self


_RESERVED_PATH_SEGMENTS = frozenset({"__proto__", "constructor", "prototype"})


def validate_definition_keys(
    definitions: dict[str, EntityExtraFieldDefinition],
) -> dict[str, EntityExtraFieldDefinition]:
    for key in definitions:
        segments = key.split(".")
        if any(not segment for segment in segments):
            raise ValueError("custom-field definition keys cannot contain empty path segments")
        reserved = _RESERVED_PATH_SEGMENTS.intersection(segments)
        if reserved:
            raise ValueError(
                "custom-field definition keys cannot contain reserved path segments: "
                f"{sorted(reserved)}"
            )
    return definitions


EntityExtraFieldDefinitions = Annotated[
    dict[str, EntityExtraFieldDefinition],
    AfterValidator(validate_definition_keys),
]


def optional_entity_definitions_field(*, omit_none: bool = False):
    return Field(
        None,
        exclude_if=(lambda value: value is None) if omit_none else None,
        description=(
            "Record-local custom-field definitions keyed by custom_fields key. "
            "Values remain stored unchanged in custom_fields."
        ),
    )
