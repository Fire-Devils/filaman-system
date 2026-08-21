import pytest
from pydantic import ValidationError

from app.api.v1.schemas_spoolman import (
    SpoolmanRepairExecuteRequest,
    SpoolmanRepairPreviewRequest,
    SpoolmanUrlRequest,
)
from app.services.spoolman_contracts import (
    ApprovedRepairMapping,
    SpoolmanFieldAction,
)


def test_url_only_request_does_not_mark_new_options_as_explicit():
    request = SpoolmanUrlRequest.model_validate({"url": "http://spoolman"})
    assert request.model_fields_set == {"url"}


@pytest.mark.parametrize("mode", ["legacy", "system", "local", "preserve"])
def test_import_modes_are_accepted(mode):
    action = SpoolmanFieldAction.model_validate(
        {"target_type": "filament", "key": "drying_temp", "action": mode}
    )
    assert action.action.value == mode


def test_invalid_import_action_is_rejected():
    with pytest.raises(ValidationError):
        SpoolmanFieldAction.model_validate(
            {"target_type": "filament", "key": "drying_temp", "action": "guess"}
        )


def test_reserved_field_identity_is_rejected():
    with pytest.raises(ValidationError):
        SpoolmanFieldAction.model_validate(
            {"target_type": "filament", "key": "constructor", "action": "system"}
        )


def test_blank_label_is_rejected_after_whitespace_is_stripped():
    with pytest.raises(ValidationError):
        ApprovedRepairMapping.model_validate(
            {
                "target_type": "spool",
                "key": "material",
                "label": "   ",
                "field_type": "text",
                "action": "system",
            }
        )


def test_choice_mapping_normalizes_nonblank_unique_options():
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "spool",
            "key": "material",
            "label": " Material ",
            "field_type": "dropdown",
            "options": [" PLA ", "PETG", "PLA", ""],
            "action": "system",
        }
    )
    assert mapping.label == "Material"
    assert mapping.options == ["PLA", "PETG"]


def test_choice_mapping_requires_options():
    with pytest.raises(ValidationError):
        ApprovedRepairMapping.model_validate(
            {
                "target_type": "spool",
                "key": "material",
                "label": "Material",
                "field_type": "multiselect",
                "options": [],
                "action": "local",
            }
        )


def test_repair_mode_is_validated_at_the_http_boundary():
    with pytest.raises(ValidationError):
        SpoolmanRepairPreviewRequest.model_validate({"mode": "automatic"})


def test_repair_execute_parses_typed_mappings():
    request = SpoolmanRepairExecuteRequest.model_validate(
        {
            "mode": "offline",
            "preview_fingerprint": "a" * 64,
            "approved_mappings": [
                {
                    "target_type": "spool",
                    "key": "dry",
                    "label": "Dry",
                    "field_type": "date",
                    "source_field_type": "datetime",
                    "action": "system",
                }
            ],
        }
    )
    assert request.approved_mappings[0].field_type.value == "date"
