import pytest
from pydantic import TypeAdapter, ValidationError

from app.api.v1.schemas_entity_extra_field import (
    EntityExtraFieldDefinition,
    EntityExtraFieldDefinitions,
)


@pytest.mark.parametrize(
    "field_type",
    [
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
    ],
)
def test_entity_extra_field_accepts_supported_type(field_type):
    definition = EntityExtraFieldDefinition(
        field_type=field_type,
        options=["A"] if field_type in {"dropdown", "multiselect"} else None,
    )

    assert definition.field_type == field_type


@pytest.mark.parametrize("field_type", ["formula", "float", "garbage"])
def test_entity_extra_field_rejects_unsupported_type(field_type):
    with pytest.raises(ValidationError):
        EntityExtraFieldDefinition(field_type=field_type)


@pytest.mark.parametrize(
    "key",
    [
        "__proto__",
        "__proto__.polluted",
        "constructor.prototype.polluted",
        "safe..field",
        "spoolman_extra",
        "spoolman_id",
        "spoolman_external_id",
        "filamentdb_id",
    ],
)
def test_entity_extra_field_rejects_unsafe_definition_key(key):
    with pytest.raises(ValidationError):
        TypeAdapter(EntityExtraFieldDefinitions).validate_python(
            {key: {"field_type": "text"}}
        )


def test_entity_extra_field_accepts_safe_nested_definition_key():
    definitions = TypeAdapter(EntityExtraFieldDefinitions).validate_python(
        {"drying.temperature": {"field_type": "number"}}
    )

    assert definitions["drying.temperature"].field_type == "number"


def test_entity_extra_field_rejects_overlapping_definition_paths():
    with pytest.raises(ValidationError, match="cannot overlap"):
        TypeAdapter(EntityExtraFieldDefinitions).validate_python(
            {
                "drying": {"field_type": "text"},
                "drying.temperature": {"field_type": "number"},
            }
        )
