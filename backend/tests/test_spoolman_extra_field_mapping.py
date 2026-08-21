import math
from types import SimpleNamespace

import pytest

from app.services.spoolman_contracts import (
    RepairFieldType,
    SpoolmanFieldCandidate,
    SpoolmanSourceFieldType,
    SpoolmanTarget,
)
from app.services.spoolman_extra_field_mapping import (
    SpoolmanFieldError,
    convert_spoolman_value,
    decode_spoolman_value,
    fingerprint,
    infer_definition,
    map_spoolman_definition,
)
from app.services.system_extra_field_compatibility import definition_can_receive


def test_map_definition_returns_a_validated_candidate():
    mapped = map_spoolman_definition(
        {
            "key": "nozzle_range",
            "name": "Nozzle range",
            "field_type": "integer_range",
            "unit": "°C",
        },
        "filament",
    )

    assert isinstance(mapped, SpoolmanFieldCandidate)
    assert mapped.target_type is SpoolmanTarget.FILAMENT
    assert mapped.field_type is RepairFieldType.RANGE
    assert mapped.source_field_type is SpoolmanSourceFieldType.INTEGER_RANGE
    assert mapped.config == {"decimal_places": 0, "unit": "°C"}


def test_infer_definition_returns_proposal_metadata_and_candidate():
    inferred = infer_definition(
        "filament",
        "temperature",
        ["[190,230]", "[200,240]", "[205,245]"],
    )

    assert inferred.definition is not None
    assert inferred.definition.field_type is RepairFieldType.RANGE
    assert (
        inferred.definition.source_field_type
        is SpoolmanSourceFieldType.INTEGER_RANGE
    )
    assert inferred.confidence == "high"
    assert inferred.confidence_reason == "structured_values"
    assert inferred.occurrences == 3


@pytest.mark.parametrize(
    ("receiver", "incoming", "expected"),
    [
        (
            {"field_type": "dropdown", "options": ["PLA", "PETG", "TPU"]},
            {"field_type": "dropdown", "options": ["PLA", "PETG"]},
            True,
        ),
        (
            {"field_type": "dropdown", "options": ["PLA"]},
            {"field_type": "dropdown", "options": ["PLA", "PETG"]},
            False,
        ),
        (
            {"field_type": "number", "config": {"unit": "°C"}},
            {"field_type": "number", "config": {"unit": "mm"}},
            False,
        ),
        (
            {"field_type": "number", "config": {}},
            {"field_type": "number", "config": {"decimal_places": 0}},
            True,
        ),
        (
            {"field_type": "number", "config": {"decimal_places": 0}},
            {"field_type": "number", "config": {}},
            False,
        ),
        (
            {"field_type": "integer", "config": {}},
            {"field_type": "number", "config": {"decimal_places": 0}},
            True,
        ),
        (
            {
                "field_type": "number",
                "config": {"min_bound": 0, "max_bound": 300},
            },
            {
                "field_type": "number",
                "config": {"min_bound": 10, "max_bound": 250},
            },
            True,
        ),
        (
            {
                "field_type": "number",
                "config": {"min_bound": 10, "max_bound": 250},
            },
            {
                "field_type": "number",
                "config": {"min_bound": 0, "max_bound": 300},
            },
            False,
        ),
        (
            {"field_type": "textarea", "config": {"max_length": 500}},
            {"field_type": "textarea", "config": {"max_length": 200}},
            True,
        ),
        (
            {"field_type": "textarea", "config": {"max_length": 200}},
            {"field_type": "textarea", "config": {}},
            False,
        ),
    ],
)
def test_definition_can_receive_all_values(receiver, incoming, expected):
    assert definition_can_receive(receiver, incoming) is expected


@pytest.mark.parametrize(
    ("field_type", "raw", "expected"),
    [
        ("text", '"PLA profile"', "PLA profile"),
        ("text", "legacy text", "legacy text"),
        ("integer", "42", 42),
        ("float", "3.14", 3.14),
        ("integer_range", "[190,230]", {"min": 190, "max": 230}),
        ("float_range", "[0.2,null]", {"min": 0.2, "max": None}),
        ("boolean", "true", True),
        ("choice", '"PLA"', "PLA"),
        ("choice", '["PLA","PETG"]', ["PLA", "PETG"]),
        ("datetime", '"2026-07-20T10:30:00Z"', "2026-07-20T10:30:00Z"),
    ],
)
def test_convert_spoolman_values(field_type, raw, expected):
    assert convert_spoolman_value(raw, field_type, ["PLA", "PETG"]) == expected


def test_authoritative_text_preserves_legacy_json_looking_value():
    assert decode_spoolman_value("true", "text") == "true"


def test_choice_cardinality_is_enforced():
    with pytest.raises(SpoolmanFieldError, match="one choice"):
        convert_spoolman_value('["PLA"]', "choice", ["PLA"], multi_choice=False)


@pytest.mark.parametrize(
    ("field_type", "raw", "expected"),
    [
        ("integer_range", '{"min":190,"max":230}', {"min": 190, "max": 230}),
        ("float_range", '{"min":0.2,"max":null}', {"min": 0.2, "max": None}),
    ],
)
def test_convert_spoolman_range_accepts_exact_min_max_object(
    field_type, raw, expected
):
    """Fails if object-shaped legacy ranges are not normalized at conversion."""
    assert convert_spoolman_value(raw, field_type) == expected


@pytest.mark.parametrize(
    "raw",
    [
        {"min": True, "max": 230},
        {"min": 190, "max": False},
        {"min": 190},
        {"max": 230},
        {"min": 190, "max": 230, "unit": "C"},
        {"min": math.nan, "max": 230},
        {"min": 190, "max": math.inf},
    ],
)
def test_convert_spoolman_range_rejects_malformed_min_max_objects(raw):
    """Fails if malformed or unsafe object-shaped ranges can cross the boundary."""
    with pytest.raises(SpoolmanFieldError):
        convert_spoolman_value(raw, "float_range")


@pytest.mark.parametrize(
    ("raw", "field_type"),
    [("true", "integer"), ("[1,2,3]", "integer_range"), ('"ABS"', "choice")],
)
def test_invalid_values_are_rejected(raw, field_type):
    with pytest.raises(SpoolmanFieldError):
        convert_spoolman_value(raw, field_type, ["PLA", "PETG"])


@pytest.mark.parametrize(
    ("source_type", "multi", "native_type"),
    [
        ("text", None, "text"),
        ("integer", None, "number"),
        ("float", None, "number"),
        ("integer_range", None, "range"),
        ("float_range", None, "range"),
        ("boolean", None, "checkbox"),
        ("datetime", None, "datetime"),
        ("choice", False, "dropdown"),
        ("choice", True, "multiselect"),
    ],
)
def test_map_definition(source_type, multi, native_type):
    definition = {
        "key": "profile",
        "name": "Profile",
        "field_type": source_type,
        "unit": "mm"
        if source_type in {"integer", "float", "integer_range", "float_range"}
        else None,
    }
    if source_type == "choice":
        definition.update(choices=["PLA", "PETG"], multi_choice=multi)
    mapped = map_spoolman_definition(definition, "filament")
    assert mapped.field_type == native_type
    assert mapped.source_field_type == source_type


def test_vendor_definition_is_not_silently_mapped():
    with pytest.raises(SpoolmanFieldError, match="unsupported target"):
        map_spoolman_definition(
            {"key": "account", "name": "Account", "field_type": "text"},
            "vendor",
        )


@pytest.mark.parametrize(
    "key",
    [
        "__proto__",
        "constructor",
        "prototype",
        "spoolman_extra",
        "spoolman_id",
        "spoolman_external_id",
        "filamentdb_id",
    ],
)
def test_authoritative_definition_rejects_reserved_destination_identity(key):
    with pytest.raises(SpoolmanFieldError, match="reserved"):
        map_spoolman_definition(
            {"key": key, "name": "Reserved", "field_type": "text"},
            "filament",
        )


@pytest.mark.parametrize(
    "key",
    [
        "__proto__",
        "constructor",
        "prototype",
        "spoolman_extra",
        "spoolman_id",
        "spoolman_external_id",
        "filamentdb_id",
    ],
)
def test_inferred_definition_marks_reserved_destination_identity_unresolved(key):
    inferred = infer_definition("filament", key, ["42"])

    assert inferred.definition is None
    assert inferred.confidence == "unresolved"
    assert inferred.confidence_reason == "invalid_key"


def test_oversized_default_is_preserved_as_unsupported_definition():
    with pytest.raises(SpoolmanFieldError, match="500-character"):
        map_spoolman_definition(
            {
                "key": "profile",
                "name": "Profile",
                "field_type": "text",
                "default_value": '"' + ("x" * 501) + '"',
            },
            "filament",
        )


def test_float_definition_does_not_reuse_integer_only_native_field():
    candidate = map_spoolman_definition(
        {"key": "flow", "name": "Flow", "field_type": "float"},
        "filament",
    )
    existing = SimpleNamespace(
        field_type="number", options=None, config={"decimal_places": 0}
    )

    assert definition_can_receive(existing, candidate) is False


def test_unbounded_definition_does_not_reuse_bounded_native_field():
    candidate = map_spoolman_definition(
        {"key": "flow", "name": "Flow", "field_type": "float"},
        "filament",
    )
    existing = SimpleNamespace(
        field_type="number", options=None, config={"min_bound": 0}
    )

    assert definition_can_receive(existing, candidate) is False


@pytest.mark.parametrize(
    ("values", "expected_type", "confidence"),
    [
        (["true", "false"], "checkbox", "low"),
        (["1", "2"], "number", "low"),
        (["[190,230]", "[200,240]"], "range", "medium"),
        (['["PLA"]', '["PETG"]'], "multiselect", "medium"),
        (["plain text", "other"], "text", "low"),
        (["2026-07-20", "2026-07-21"], "date", "medium"),
        (["2026-07-20T10:30:00Z"], "datetime", "medium"),
        (
            ["https://example.com/one", "https://example.com/two"],
            "url",
            "high",
        ),
    ],
)
def test_infer_definition(values, expected_type, confidence):
    inferred = infer_definition("filament", "profile", values)
    assert inferred.definition is not None
    assert inferred.definition.field_type == expected_type
    assert inferred.confidence == confidence


def test_infer_definition_uses_high_confidence_for_repeated_structured_values():
    inferred = infer_definition(
        "filament",
        "temperature",
        ["[190,230]", "[200,240]", "[205,245]"],
    )

    assert inferred.definition is not None
    assert inferred.definition.field_type is RepairFieldType.RANGE
    assert inferred.confidence == "high"
    assert inferred.confidence_reason == "structured_values"


def test_infer_definition_recognizes_exact_min_max_objects():
    """Fails if exact object-shaped ranges are not inferred as a numeric range."""
    inferred = infer_definition(
        "filament",
        "temperature",
        [
            {"min": 190, "max": 230},
            {"min": 200, "max": 240},
        ],
    )

    assert inferred.definition is not None
    assert inferred.definition.field_type is RepairFieldType.RANGE
    assert (
        inferred.definition.source_field_type
        is SpoolmanSourceFieldType.INTEGER_RANGE
    )
    assert inferred.definition.config == {"decimal_places": 0}
    assert inferred.confidence == "medium"


def test_infer_definition_uses_object_shaped_ranges_for_majority_inference():
    """Fails if object-shaped ranges are skipped by majority inference."""
    inferred = infer_definition(
        "filament",
        "temperature",
        [
            {"min": 190, "max": 230},
            {"min": 200, "max": 240},
            {"min": 205, "max": 245},
            {"min": 210, "max": 250},
            "unknown",
        ],
    )

    assert inferred.definition is not None
    assert inferred.definition.field_type is RepairFieldType.RANGE
    assert (
        inferred.definition.source_field_type
        is SpoolmanSourceFieldType.INTEGER_RANGE
    )
    assert inferred.confidence == "medium"
    assert inferred.confidence_reason == "majority_match"


def test_infer_definition_uses_dominant_pattern_and_preserves_outliers():
    inferred = infer_definition(
        "spool",
        "inspection_date",
        [
            "2026-07-20",
            "2026-07-21",
            "2026-07-22",
            "2026-07-23",
            "unknown",
        ],
    )

    assert inferred.definition is not None
    assert inferred.definition.field_type is RepairFieldType.DATE
    assert inferred.confidence == "medium"
    assert inferred.confidence_reason == "majority_match"


def test_fingerprint_is_stable_for_dictionary_order():
    assert fingerprint({"a": 1, "b": 2}) == fingerprint({"b": 2, "a": 1})
