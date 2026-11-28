from app.services.custom_field_values import merge_custom_fields, validate_custom_field_values

DEFS = [
    {"target_type": "spool", "key": "dd", "field_type": "dropdown", "options": ["a", "b"]},
    {"target_type": "spool", "key": "ms", "field_type": "multiselect", "options": ["a", "b"]},
    {"target_type": "spool", "key": "n", "field_type": "number", "config": {"min_bound": 0, "max_bound": 10}},
    {"target_type": "spool", "key": "cb", "field_type": "checkbox"},
    {"target_type": "spool", "key": "fx", "field_type": "formula"},
    {"target_type": "filament", "key": "other", "field_type": "dropdown", "options": ["z"]},
]


def test_valid_values_and_unknown_keys_pass():
    values = {"dd": "a", "ms": ["a", "b"], "n": 5, "cb": True, "local": object(), "other": "nope", "dd2": None}
    assert validate_custom_field_values(values, DEFS) == []


def test_none_is_always_allowed():
    assert validate_custom_field_values({"dd": None, "fx": None, "n": None}, DEFS) == []


def test_invalid_values_reported():
    errors = validate_custom_field_values(
        {"dd": "x", "ms": ["a", "q"], "n": 11, "cb": "yes", "fx": 1}, DEFS
    )
    assert len(errors) == 5
    assert validate_custom_field_values({"n": True}, DEFS) == ["'n' must be a number"]
    assert validate_custom_field_values({"n": -1}, DEFS) == ["'n' must be >= 0"]
    assert validate_custom_field_values({"ms": "a"}, DEFS)


def test_merge_custom_fields():
    assert merge_custom_fields({"a": 1, "b": 2}, {"b": None, "c": 3}) == {"a": 1, "c": 3}
    assert merge_custom_fields(None, {"a": None}) is None
    assert merge_custom_fields({"a": 1}, {"a": None}) is None


def test_normalize_checkbox_bool_to_string():
    from app.services.custom_field_values import normalize_custom_field_values

    defs = [
        {"target_type": "spool", "key": "flag", "field_type": "checkbox"},
        {"target_type": "filament", "key": "other", "field_type": "checkbox"},
    ]
    assert normalize_custom_field_values({"flag": True, "other": True, "x": False}, defs) == {
        "flag": "true", "other": True, "x": False,
    }
    assert normalize_custom_field_values({"flag": False, "none": None}, defs) == {"flag": "false", "none": None}
