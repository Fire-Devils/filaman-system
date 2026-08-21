from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, Field, model_validator

from app.api.v1.schemas_system_extra_field import validate_field_type_config
from app.services.custom_field_identity import validate_custom_field_path


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


def validate_definition_keys(
    definitions: dict[str, EntityExtraFieldDefinition],
) -> dict[str, EntityExtraFieldDefinition]:
    for key in definitions:
        validate_custom_field_path(key)
    keys = list(definitions)
    for index, key in enumerate(keys):
        for other in keys[index + 1 :]:
            if (
                key == other
                or key.startswith(f"{other}.")
                or other.startswith(f"{key}.")
            ):
                raise ValueError(
                    "custom-field definition keys cannot overlap nested paths: "
                    f"{key!r}, {other!r}"
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
