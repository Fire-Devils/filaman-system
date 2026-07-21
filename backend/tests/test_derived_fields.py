"""Comprehensive tests for app.services.derived_fields.

Covers every custom JSON Logic operator, build_formula_context for both
spool and filament target types, evaluate_formula error handling, and
compute_derived end-to-end.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from app.services.derived_fields import (
    _abs,
    _coalesce,
    _date_only,
    _day,
    _days_between,
    _floor,
    _hour,
    _hours_between,
    _hue_from_hex,
    _left,
    _length,
    _lower,
    _minute,
    _month,
    _parse_dt,
    _right,
    _round,
    _second,
    _time_only,
    _timestamp,
    _today,
    _trim,
    _upper,
    _year,
    build_formula_context,
    compute_derived,
    evaluate_formula,
    formula_var_paths,
    validate_formula,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_field(key: str, formula: dict) -> SimpleNamespace:
    """Minimal SystemExtraField-like object for compute_derived."""
    return SimpleNamespace(key=key, formula=formula)


def _make_filament(**overrides: Any) -> SimpleNamespace:
    defaults: dict[str, Any] = dict(
        id=1,
        designation="PLA Basic",
        material_type="PLA",
        material_subgroup=None,
        diameter_mm=1.75,
        manufacturer_color_name="Fire Engine Red",
        finish_type="matte",
        raw_material_weight_g=750.0,
        default_spool_weight_g=1000.0,
        spool_outer_diameter_mm=200.0,
        spool_width_mm=56.0,
        spool_material="cardboard",
        price=24.99,
        density_g_cm3=1.24,
        color_mode="solid",
        shop_url=None,
        multi_color_style=None,
        custom_fields={},
        filament_colors=[],
        manufacturer=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_spool(**overrides: Any) -> SimpleNamespace:
    defaults: dict[str, Any] = dict(
        id=1,
        filament_id=1,
        status_id=1,
        location_id=None,
        lot_number="A2024001",
        rfid_uid=None,
        external_id=None,
        purchase_price=24.99,
        purchase_date=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
        stocked_in_at=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc),
        last_used_at=datetime(2024, 6, 1, 8, 30, 0, tzinfo=timezone.utc),
        initial_total_weight_g=1000.0,
        empty_spool_weight_g=250.0,
        remaining_weight_g=225.0,
        spool_outer_diameter_mm=200.0,
        spool_width_mm=56.0,
        spool_material="cardboard",
        low_weight_threshold_g=100,
        custom_fields={},
        filament=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ============================================================================
# hue_from_hex
# ============================================================================

class TestHueFromHex:
    def test_pure_red(self):
        assert _hue_from_hex("#FF0000") == 0

    def test_pure_yellow(self):
        assert _hue_from_hex("#FFFF00") == 60

    def test_pure_green(self):
        assert _hue_from_hex("#00FF00") == 120

    def test_pure_cyan(self):
        assert _hue_from_hex("#00FFFF") == 180

    def test_pure_blue(self):
        assert _hue_from_hex("#0000FF") == 240

    def test_pure_magenta(self):
        assert _hue_from_hex("#FF00FF") == 300

    def test_lowercase_hex(self):
        assert _hue_from_hex("#ff0000") == 0

    def test_no_hash_prefix(self):
        assert _hue_from_hex("FF0000") == 0

    def test_achromatic_white(self):
        assert _hue_from_hex("#FFFFFF") == 0

    def test_achromatic_black(self):
        assert _hue_from_hex("#000000") == 0

    def test_achromatic_gray(self):
        assert _hue_from_hex("#808080") == 0

    def test_none_input(self):
        assert _hue_from_hex(None) is None

    def test_integer_input(self):
        assert _hue_from_hex(12345) is None

    def test_too_short(self):
        assert _hue_from_hex("#FFF") is None

    def test_empty_string(self):
        assert _hue_from_hex("") is None

    def test_invalid_hex_chars(self):
        assert _hue_from_hex("#GGGGGG") is None

    def test_result_in_valid_range(self):
        for hex_str in ("#FF6B35", "#4ECDC4", "#1A535C", "#F7FFF7", "#FFE66D"):
            result = _hue_from_hex(hex_str)
            assert result is not None
            assert 0 <= result <= 359


# ============================================================================
# Math operators
# ============================================================================

class TestFloor:
    def test_positive_float(self):
        assert _floor(3.9) == 3

    def test_negative_float(self):
        assert _floor(-1.1) == -2

    def test_already_integer_value(self):
        assert _floor(5.0) == 5

    def test_integer_input(self):
        assert _floor(7) == 7

    def test_non_numeric_returns_none(self):
        assert _floor("3.9") is None

    def test_none_returns_none(self):
        assert _floor(None) is None


class TestAbs:
    def test_negative_int(self):
        assert _abs(-5) == 5

    def test_negative_float(self):
        assert _abs(-3.14) == 3.14

    def test_positive_unchanged(self):
        assert _abs(5) == 5

    def test_zero(self):
        assert _abs(0) == 0

    def test_non_numeric_returns_none(self):
        assert _abs("x") is None

    def test_none_returns_none(self):
        assert _abs(None) is None


class TestRound:
    def test_no_decimals(self):
        assert _round(3.7) == 4

    def test_with_decimals(self):
        assert _round(3.14159, 2) == 3.14

    def test_negative(self):
        assert _round(-2.5) == -2  # Python banker's rounding

    def test_zero_decimals_explicit(self):
        assert _round(2.9, 0) == 3

    def test_non_numeric_returns_none(self):
        assert _round("x") is None

    def test_none_returns_none(self):
        assert _round(None) is None


class TestCoalesce:
    def test_first_non_none(self):
        assert _coalesce(None, None, 42) == 42

    def test_first_value_returned(self):
        assert _coalesce(1, 2, 3) == 1

    def test_all_none(self):
        assert _coalesce(None, None, None) is None

    def test_false_is_not_none(self):
        assert _coalesce(None, False, 1) is False

    def test_zero_is_not_none(self):
        assert _coalesce(None, 0, 1) == 0

    def test_empty_string_is_not_none(self):
        assert _coalesce(None, "", "x") == ""

    def test_single_non_none(self):
        assert _coalesce("hello") == "hello"


# ============================================================================
# Text operators
# ============================================================================

class TestUpper:
    def test_basic(self):
        assert _upper("hello") == "HELLO"

    def test_already_upper(self):
        assert _upper("HELLO") == "HELLO"

    def test_mixed_case(self):
        assert _upper("Hello World") == "HELLO WORLD"

    def test_non_string_passthrough(self):
        assert _upper(42) == 42

    def test_none_passthrough(self):
        assert _upper(None) is None


class TestLower:
    def test_basic(self):
        assert _lower("HELLO") == "hello"

    def test_already_lower(self):
        assert _lower("hello") == "hello"

    def test_mixed_case(self):
        assert _lower("Hello World") == "hello world"

    def test_non_string_passthrough(self):
        assert _lower(42) == 42


class TestTrim:
    def test_leading_trailing_spaces(self):
        assert _trim("  hi  ") == "hi"

    def test_tabs_and_newlines(self):
        assert _trim("\t hello \n") == "hello"

    def test_no_whitespace(self):
        assert _trim("hello") == "hello"

    def test_empty_string(self):
        assert _trim("") == ""

    def test_non_string_passthrough(self):
        assert _trim(42) == 42


class TestLength:
    def test_string(self):
        assert _length("hello") == 5

    def test_empty_string(self):
        assert _length("") == 0

    def test_list(self):
        assert _length([1, 2, 3]) == 3

    def test_empty_list(self):
        assert _length([]) == 0

    def test_none_returns_none(self):
        assert _length(None) is None

    def test_integer_returns_none(self):
        assert _length(42) is None


class TestLeft:
    def test_basic(self):
        assert _left("hello", 3) == "hel"

    def test_zero(self):
        assert _left("hello", 0) == ""

    def test_longer_than_string(self):
        assert _left("hi", 10) == "hi"

    def test_non_string_returns_none(self):
        assert _left(42, 3) is None


class TestRight:
    def test_basic(self):
        assert _right("hello", 3) == "llo"

    def test_zero(self):
        assert _right("hello", 0) == ""

    def test_longer_than_string(self):
        assert _right("hi", 10) == "hi"

    def test_non_string_returns_none(self):
        assert _right(42, 3) is None


# ============================================================================
# Date parsing helper
# ============================================================================

class TestParseDt:
    def test_iso_string_naive(self):
        result = _parse_dt("2024-06-15T14:30:45")
        assert result == datetime(2024, 6, 15, 14, 30, 45)

    def test_iso_string_with_tz(self):
        result = _parse_dt("2024-06-15T14:30:45+00:00")
        assert result is not None
        assert result.year == 2024 and result.hour == 14

    def test_datetime_object_passthrough(self):
        dt = datetime(2024, 6, 15, 10, 0, 0, tzinfo=timezone.utc)
        assert _parse_dt(dt) is dt

    def test_invalid_string(self):
        assert _parse_dt("not-a-date") is None

    def test_none(self):
        assert _parse_dt(None) is None

    def test_integer(self):
        assert _parse_dt(1234567890) is None


# ============================================================================
# Date/Time component operators
# ============================================================================

ISO_DT = "2024-06-15T14:30:45"
ISO_DT_TZ = "2024-06-15T14:30:45+00:00"


class TestDateComponents:
    def test_year(self):
        assert _year(ISO_DT) == 2024

    def test_month(self):
        assert _month(ISO_DT) == 6

    def test_day(self):
        assert _day(ISO_DT) == 15

    def test_hour(self):
        assert _hour(ISO_DT) == 14

    def test_minute(self):
        assert _minute(ISO_DT) == 30

    def test_second(self):
        assert _second(ISO_DT) == 45

    def test_year_with_tz(self):
        assert _year(ISO_DT_TZ) == 2024

    def test_none_returns_none(self):
        for fn in [_year, _month, _day, _hour, _minute, _second]:
            assert fn(None) is None, f"{fn.__name__} should return None for None"

    def test_invalid_string_returns_none(self):
        for fn in [_year, _month, _day, _hour, _minute, _second]:
            assert fn("not-a-date") is None


class TestDateFormatters:
    def test_date_only(self):
        assert _date_only(ISO_DT) == "2024-06-15"

    def test_time_only(self):
        assert _time_only(ISO_DT) == "14:30:45"

    def test_timestamp_returns_float(self):
        result = _timestamp(ISO_DT_TZ)
        assert isinstance(result, float)
        assert result > 0

    def test_date_only_none(self):
        assert _date_only(None) is None

    def test_time_only_none(self):
        assert _time_only(None) is None

    def test_timestamp_none(self):
        assert _timestamp(None) is None


class TestToday:
    def test_returns_string(self):
        result = _today()
        assert isinstance(result, str)

    def test_format_yyyy_mm_dd(self):
        result = _today()
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", result)

    def test_reasonable_year(self):
        year = int(_today()[:4])
        assert 2024 <= year <= 2100


# ============================================================================
# Date diff operators
# ============================================================================

class TestDaysBetween:
    def test_basic(self):
        assert _days_between("2024-01-01T00:00:00+00:00", "2024-06-01T00:00:00+00:00") == 152

    def test_negative_when_reversed(self):
        assert _days_between("2024-06-01T00:00:00+00:00", "2024-01-01T00:00:00+00:00") == -152

    def test_same_day(self):
        assert _days_between("2024-01-01T00:00:00", "2024-01-01T23:59:59") == 0

    def test_exact_one_day(self):
        assert _days_between("2024-01-01T00:00:00", "2024-01-02T00:00:00") == 1

    def test_naive_and_aware_mixing(self):
        # Should not raise; should return a number
        result = _days_between("2024-01-01T00:00:00+00:00", "2024-06-01T00:00:00")
        assert result == 152

    def test_none_start(self):
        assert _days_between(None, "2024-06-01T00:00:00") is None

    def test_none_end(self):
        assert _days_between("2024-01-01T00:00:00", None) is None

    def test_invalid_strings(self):
        assert _days_between("bad", "2024-01-01") is None


class TestHoursBetween:
    def test_two_hours(self):
        assert _hours_between("2024-01-01T00:00:00", "2024-01-01T02:00:00") == 2.0

    def test_ninety_minutes(self):
        assert _hours_between("2024-01-01T00:00:00", "2024-01-01T01:30:00") == 1.5

    def test_negative_when_reversed(self):
        assert _hours_between("2024-01-01T02:00:00", "2024-01-01T00:00:00") == -2.0

    def test_none_returns_none(self):
        assert _hours_between(None, "2024-01-01T00:00:00") is None

    def test_returns_float(self):
        result = _hours_between("2024-01-01T00:00:00", "2024-01-01T02:15:30")
        assert isinstance(result, float)


# ============================================================================
# evaluate_formula — integration via JSON Logic
# ============================================================================

class TestEvaluateFormula:
    # -- passthrough of built-in json-logic ops --

    def test_var_lookup(self):
        assert evaluate_formula({"var": "x"}, {"x": 42}) == 42

    def test_var_missing(self):
        assert evaluate_formula({"var": "missing_key"}, {}) is None

    def test_arithmetic_add(self):
        assert evaluate_formula({"+": [{"var": "a"}, {"var": "b"}]}, {"a": 3, "b": 4}) == 7

    def test_arithmetic_divide(self):
        result = evaluate_formula({"/": [{"var": "a"}, {"var": "b"}]}, {"a": 10.0, "b": 4})
        assert result == 2.5

    def test_comparison_gt(self):
        assert evaluate_formula({">": [{"var": "x"}, 0]}, {"x": 5}) is True
        assert evaluate_formula({">": [{"var": "x"}, 0]}, {"x": -1}) is False

    def test_if_conditional(self):
        formula = {"if": [{"var": "flag"}, "yes", "no"]}
        assert evaluate_formula(formula, {"flag": True}) == "yes"
        assert evaluate_formula(formula, {"flag": False}) == "no"

    def test_cat_string_concat(self):
        formula = {"cat": [{"var": "a"}, " ", {"var": "b"}]}
        assert evaluate_formula(formula, {"a": "hello", "b": "world"}) == "hello world"

    # -- custom math ops --

    def test_floor_via_jsonlogic(self):
        assert evaluate_formula({"floor": [{"var": "v"}]}, {"v": 3.9}) == 3

    def test_abs_via_jsonlogic(self):
        assert evaluate_formula({"abs": [{"var": "v"}]}, {"v": -5}) == 5

    def test_round_via_jsonlogic(self):
        assert evaluate_formula({"round": [{"var": "v"}, 2]}, {"v": 3.14159}) == 3.14

    def test_coalesce_via_jsonlogic(self):
        formula = {"coalesce": [{"var": "x"}, {"var": "y"}]}
        assert evaluate_formula(formula, {"x": None, "y": 99}) == 99

    # -- custom text ops --

    def test_upper_via_jsonlogic(self):
        assert evaluate_formula({"upper": [{"var": "t"}]}, {"t": "hello"}) == "HELLO"

    def test_lower_via_jsonlogic(self):
        assert evaluate_formula({"lower": [{"var": "t"}]}, {"t": "HELLO"}) == "hello"

    def test_trim_via_jsonlogic(self):
        assert evaluate_formula({"trim": [{"var": "t"}]}, {"t": "  hi  "}) == "hi"

    def test_length_via_jsonlogic(self):
        assert evaluate_formula({"length": [{"var": "t"}]}, {"t": "hello"}) == 5

    def test_left_via_jsonlogic(self):
        assert evaluate_formula({"left": [{"var": "t"}, 3]}, {"t": "hello"}) == "hel"

    def test_right_via_jsonlogic(self):
        assert evaluate_formula({"right": [{"var": "t"}, 3]}, {"t": "hello"}) == "llo"

    # -- custom date/time ops --

    def test_year_via_jsonlogic(self):
        assert evaluate_formula({"year": [{"var": "d"}]}, {"d": "2024-06-15T10:00:00"}) == 2024

    def test_month_via_jsonlogic(self):
        assert evaluate_formula({"month": [{"var": "d"}]}, {"d": "2024-06-15T10:00:00"}) == 6

    def test_day_via_jsonlogic(self):
        assert evaluate_formula({"day": [{"var": "d"}]}, {"d": "2024-06-15T10:00:00"}) == 15

    def test_hour_via_jsonlogic(self):
        assert evaluate_formula({"hour": [{"var": "d"}]}, {"d": "2024-06-15T14:30:00"}) == 14

    def test_minute_via_jsonlogic(self):
        assert evaluate_formula({"minute": [{"var": "d"}]}, {"d": "2024-06-15T14:30:00"}) == 30

    def test_second_via_jsonlogic(self):
        assert evaluate_formula({"second": [{"var": "d"}]}, {"d": "2024-06-15T14:30:45"}) == 45

    def test_date_only_via_jsonlogic(self):
        assert evaluate_formula({"date_only": [{"var": "d"}]}, {"d": "2024-06-15T14:30:45"}) == "2024-06-15"

    def test_time_only_via_jsonlogic(self):
        assert evaluate_formula({"time_only": [{"var": "d"}]}, {"d": "2024-06-15T14:30:45"}) == "14:30:45"

    def test_today_via_jsonlogic(self):
        result = evaluate_formula({"today": []}, {})
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", result)

    def test_days_between_via_jsonlogic(self):
        formula = {"days_between": [{"var": "start"}, {"var": "end"}]}
        ctx = {"start": "2024-01-01T00:00:00+00:00", "end": "2024-06-01T00:00:00+00:00"}
        assert evaluate_formula(formula, ctx) == 152

    def test_hours_between_via_jsonlogic(self):
        formula = {"hours_between": [{"var": "start"}, {"var": "end"}]}
        ctx = {"start": "2024-01-01T00:00:00", "end": "2024-01-01T02:00:00"}
        assert evaluate_formula(formula, ctx) == 2.0

    def test_hue_from_hex_via_jsonlogic(self):
        assert evaluate_formula({"hue_from_hex": [{"var": "c"}]}, {"c": "#FF0000"}) == 0
        assert evaluate_formula({"hue_from_hex": [{"var": "c"}]}, {"c": "#0000FF"}) == 240

    # -- nested / compound formulas --

    def test_nested_math(self):
        # round(remaining / initial * 100, 1) → percentage remaining
        formula = {"round": [{"/": [{"*": [{"var": "remaining"}, 100]}, {"var": "initial"}]}, 1]}
        result = evaluate_formula(formula, {"remaining": 225.0, "initial": 1000.0})
        assert result == 22.5

    def test_days_since_purchase(self):
        # age in days: days_between(purchase_date, today)  — approximate; just check it's a non-negative int
        formula = {"days_between": [{"var": "purchase_date"}, {"today": []}]}
        ctx = {"purchase_date": "2024-01-01T00:00:00+00:00"}
        result = evaluate_formula(formula, ctx)
        assert isinstance(result, int)
        assert result > 0

    def test_coalesce_chain(self):
        formula = {"coalesce": [{"var": "a"}, {"var": "b"}, "default"]}
        assert evaluate_formula(formula, {"a": None, "b": None}) == "default"
        assert evaluate_formula(formula, {"a": None, "b": "found"}) == "found"
        assert evaluate_formula(formula, {"a": "first"}) == "first"

    def test_hue_color_category(self):
        # Classify a color: hue<30 or hue>330 → "red", 30–90 → "yellow", etc.
        formula = {
            "if": [
                {"or": [{"<": [{"hue_from_hex": [{"var": "c"}]}, 30]}, {">": [{"hue_from_hex": [{"var": "c"}]}, 330]}]},
                "red",
                {"if": [
                    {"and": [{">=": [{"hue_from_hex": [{"var": "c"}]}, 30]}, {"<": [{"hue_from_hex": [{"var": "c"}]}, 90]}]},
                    "yellow",
                    "other"
                ]}
            ]
        }
        assert evaluate_formula(formula, {"c": "#FF0000"}) == "red"
        assert evaluate_formula(formula, {"c": "#FFFF00"}) == "yellow"
        assert evaluate_formula(formula, {"c": "#0000FF"}) == "other"

    # -- error handling --

    def test_unknown_operator_returns_none(self):
        assert evaluate_formula({"nonexistent_op": [1, 2]}, {}) is None

    def test_invalid_formula_type_returns_literal(self):
        # json-logic-py treats non-dict/non-list as a literal and returns it as-is
        assert evaluate_formula("not a dict", {}) == "not a dict"  # type: ignore[arg-type]
        assert evaluate_formula(42, {}) == 42  # type: ignore[arg-type]

    def test_division_by_zero_returns_none(self):
        assert evaluate_formula({"/": [1, 0]}, {}) is None

    def test_validation_rejects_unknown_operator(self):
        with pytest.raises(ValueError, match="Unsupported JSON Logic operator"):
            validate_formula({"nonexistent_op": [1, 2]})

    def test_validation_rejects_literal_runtime_failure(self):
        with pytest.raises(ZeroDivisionError):
            validate_formula({"/": [1, 0]})

    def test_validation_allows_variable_backed_expression(self):
        validate_formula({"/": [{"var": "remaining_weight_g"}, 2]})

    def test_validation_rejects_excessive_depth(self):
        formula: dict[str, Any] = {"var": "id"}
        for _ in range(33):
            formula = {"!!": [formula]}
        with pytest.raises(ValueError, match="depth limit"):
            validate_formula(formula)

    def test_validation_rejects_excessive_node_count(self):
        formula = {"merge": list(range(513))}
        with pytest.raises(ValueError, match="node limit"):
            validate_formula(formula)

    def test_var_paths_only_returns_var_operands(self):
        formula = {"cat": [{"var": "custom_fields.note"}, "custom_fields.decoy"]}
        assert formula_var_paths(formula) == {"custom_fields.note"}


# ============================================================================
# build_formula_context — spool
# ============================================================================

class TestBuildFormulaContextSpool:
    def test_scalar_fields_present(self):
        spool = _make_spool()
        ctx = build_formula_context(spool, "spool")
        for key in [
            "id", "filament_id", "status_id", "location_id",
            "lot_number", "rfid_uid", "external_id", "purchase_price",
            "initial_total_weight_g", "empty_spool_weight_g", "remaining_weight_g",
            "spool_outer_diameter_mm", "spool_width_mm", "spool_material",
            "low_weight_threshold_g",
        ]:
            assert key in ctx, f"missing key: {key}"

    def test_purchase_date_as_iso_string(self):
        spool = _make_spool(purchase_date=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc))
        ctx = build_formula_context(spool, "spool")
        assert isinstance(ctx["purchase_date"], str)
        assert ctx["purchase_date"].startswith("2024-01-15")

    def test_stocked_in_at_as_iso_string(self):
        spool = _make_spool(stocked_in_at=datetime(2024, 1, 15, 10, 0, 0, tzinfo=timezone.utc))
        ctx = build_formula_context(spool, "spool")
        assert isinstance(ctx["stocked_in_at"], str)

    def test_last_used_at_as_iso_string(self):
        spool = _make_spool(last_used_at=datetime(2024, 6, 1, 8, 30, 0, tzinfo=timezone.utc))
        ctx = build_formula_context(spool, "spool")
        assert isinstance(ctx["last_used_at"], str)

    def test_null_dates_are_none(self):
        spool = _make_spool(purchase_date=None, stocked_in_at=None, last_used_at=None)
        ctx = build_formula_context(spool, "spool")
        assert ctx["purchase_date"] is None
        assert ctx["stocked_in_at"] is None
        assert ctx["last_used_at"] is None

    def test_location_id_nullable(self):
        ctx = build_formula_context(_make_spool(location_id=None), "spool")
        assert ctx["location_id"] is None
        ctx2 = build_formula_context(_make_spool(location_id=7), "spool")
        assert ctx2["location_id"] == 7

    def test_custom_fields_nested_for_json_logic_paths(self):
        spool = _make_spool(custom_fields={"notes": "test note", "batch": "B001"})
        ctx = build_formula_context(spool, "spool")
        assert ctx["custom_fields"] == {"notes": "test note", "batch": "B001"}
        assert evaluate_formula({"var": "custom_fields.notes"}, ctx) == "test note"

    def test_custom_fields_none_safe(self):
        spool = _make_spool(custom_fields=None)
        ctx = build_formula_context(spool, "spool")
        assert ctx["custom_fields"] == {}

    def test_no_filament_attribute(self):
        spool = _make_spool(filament=None)
        ctx = build_formula_context(spool, "spool")
        assert "filament" not in ctx

    def test_nested_filament_context(self):
        fil = _make_filament(material_type="PETG", price=29.99)
        spool = _make_spool(filament=fil)
        ctx = build_formula_context(spool, "spool")
        assert "filament" in ctx
        assert ctx["filament"]["material_type"] == "PETG"
        assert ctx["filament"]["price"] == 29.99

    def test_nested_filament_manufacturer(self):
        mfr = SimpleNamespace(id=5, name="Bambu Lab", url="https://bambulab.com")
        fil = _make_filament(manufacturer=mfr)
        spool = _make_spool(filament=fil)
        ctx = build_formula_context(spool, "spool")
        assert ctx["filament"]["manufacturer"]["name"] == "Bambu Lab"
        assert ctx["filament"]["manufacturer"]["id"] == 5

    def test_date_fields_parseable_by_operators(self):
        spool = _make_spool()
        ctx = build_formula_context(spool, "spool")
        formula = {"year": [{"var": "purchase_date"}]}
        result = evaluate_formula(formula, ctx)
        assert result == 2024

    def test_days_between_using_spool_dates(self):
        spool = _make_spool(
            purchase_date=datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
            last_used_at=datetime(2024, 6, 1, 0, 0, 0, tzinfo=timezone.utc),
        )
        ctx = build_formula_context(spool, "spool")
        formula = {"days_between": [{"var": "purchase_date"}, {"var": "last_used_at"}]}
        result = evaluate_formula(formula, ctx)
        assert result == 152


# ============================================================================
# build_formula_context — filament
# ============================================================================

class TestBuildFormulaContextFilament:
    def test_scalar_fields_present(self):
        fil = _make_filament()
        ctx = build_formula_context(fil, "filament")
        for key in [
            "id", "designation", "material_type", "material_subgroup",
            "diameter_mm", "manufacturer_color_name", "finish_type",
            "raw_material_weight_g", "default_spool_weight_g",
            "spool_outer_diameter_mm", "spool_width_mm", "spool_material",
            "price", "density_g_cm3", "color_mode", "shop_url", "multi_color_style",
            "color_hex", "colors",
        ]:
            assert key in ctx, f"missing key: {key}"

    def test_color_hex_none_when_no_colors(self):
        fil = _make_filament(filament_colors=[])
        ctx = build_formula_context(fil, "filament")
        assert ctx["color_hex"] is None
        assert ctx["colors"] == []

    def test_color_hex_from_first_color(self):
        color = SimpleNamespace(hex_code="#FF3B30", name="Red")
        fc = SimpleNamespace(position=0, color=color)
        fil = _make_filament(filament_colors=[fc])
        ctx = build_formula_context(fil, "filament")
        assert ctx["color_hex"] == "#FF3B30"

    def test_colors_list_sorted_by_position(self):
        c1 = SimpleNamespace(position=1, color=SimpleNamespace(hex_code="#00FF00", name="Green"))
        c0 = SimpleNamespace(position=0, color=SimpleNamespace(hex_code="#FF0000", name="Red"))
        fil = _make_filament(filament_colors=[c1, c0])  # intentionally unordered
        ctx = build_formula_context(fil, "filament")
        assert ctx["color_hex"] == "#FF0000"  # position 0 is first
        assert ctx["colors"][0]["hex"] == "#FF0000"
        assert ctx["colors"][1]["hex"] == "#00FF00"

    def test_colors_list_structure(self):
        color = SimpleNamespace(hex_code="#0000FF", name="Blue")
        fc = SimpleNamespace(position=0, color=color)
        fil = _make_filament(filament_colors=[fc])
        ctx = build_formula_context(fil, "filament")
        entry = ctx["colors"][0]
        assert "position" in entry and "hex" in entry and "name" in entry

    def test_hue_from_hex_on_color_hex(self):
        color = SimpleNamespace(hex_code="#FF0000", name="Red")
        fc = SimpleNamespace(position=0, color=color)
        fil = _make_filament(filament_colors=[fc])
        ctx = build_formula_context(fil, "filament")
        formula = {"hue_from_hex": [{"var": "color_hex"}]}
        assert evaluate_formula(formula, ctx) == 0

    def test_manufacturer_nested(self):
        mfr = SimpleNamespace(id=3, name="Prusament", url="https://prusament.com")
        fil = _make_filament(manufacturer=mfr)
        ctx = build_formula_context(fil, "filament")
        assert ctx["manufacturer"]["name"] == "Prusament"
        assert ctx["manufacturer"]["url"] == "https://prusament.com"

    def test_no_manufacturer(self):
        fil = _make_filament(manufacturer=None)
        ctx = build_formula_context(fil, "filament")
        assert "manufacturer" not in ctx

    def test_custom_fields_nested_for_json_logic_paths(self):
        fil = _make_filament(custom_fields={"temp_min": 200, "temp_max": 230})
        ctx = build_formula_context(fil, "filament")
        assert ctx["custom_fields"] == {"temp_min": 200, "temp_max": 230}
        assert evaluate_formula({"var": "custom_fields.temp_min"}, ctx) == 200

    def test_spool_formula_reads_nested_filament_custom_field(self):
        fil = _make_filament(custom_fields={"temp_min": 205})
        ctx = build_formula_context(_make_spool(filament=fil), "spool")
        assert evaluate_formula({"var": "filament.custom_fields.temp_min"}, ctx) == 205

    def test_shop_url_exposed(self):
        fil = _make_filament(shop_url="https://example.com/filament")
        ctx = build_formula_context(fil, "filament")
        assert ctx["shop_url"] == "https://example.com/filament"

    def test_multi_color_style_exposed(self):
        fil = _make_filament(multi_color_style="gradient")
        ctx = build_formula_context(fil, "filament")
        assert ctx["multi_color_style"] == "gradient"


# ============================================================================
# build_formula_context — unknown type
# ============================================================================

class TestBuildFormulaContextUnknown:
    def test_unknown_type_returns_empty(self):
        assert build_formula_context(SimpleNamespace(), "device") == {}

    def test_empty_string_type_returns_empty(self):
        assert build_formula_context(SimpleNamespace(), "") == {}


# ============================================================================
# compute_derived
# ============================================================================

class TestComputeDerived:
    def test_empty_formula_fields(self):
        spool = _make_spool()
        result = compute_derived(spool, "spool", [])
        assert result == {}

    def test_single_formula_field(self):
        fil = _make_filament(raw_material_weight_g=750.0, density_g_cm3=1.24)
        field = _make_field("volume_cm3", {"/": [{"var": "raw_material_weight_g"}, {"var": "density_g_cm3"}]})
        result = compute_derived(fil, "filament", [field])
        assert "volume_cm3" in result
        assert abs(result["volume_cm3"] - (750.0 / 1.24)) < 0.001

    def test_null_result_excluded(self):
        fil = _make_filament()
        # hue_from_hex on None color_hex → None → excluded
        field = _make_field("hue", {"hue_from_hex": [{"var": "color_hex"}]})
        result = compute_derived(fil, "filament", [field])
        assert "hue" not in result

    def test_non_null_result_included(self):
        color = SimpleNamespace(hex_code="#FF0000", name="Red")
        fc = SimpleNamespace(position=0, color=color)
        fil = _make_filament(filament_colors=[fc])
        field = _make_field("hue", {"hue_from_hex": [{"var": "color_hex"}]})
        result = compute_derived(fil, "filament", [field])
        assert result["hue"] == 0

    def test_multiple_fields(self):
        fil = _make_filament(raw_material_weight_g=750.0, density_g_cm3=1.24, price=24.99)
        fields = [
            _make_field("volume_cm3", {"/": [{"var": "raw_material_weight_g"}, {"var": "density_g_cm3"}]}),
            _make_field("mat_upper", {"upper": [{"var": "material_type"}]}),
        ]
        result = compute_derived(fil, "filament", fields)
        assert "volume_cm3" in result
        assert result["mat_upper"] == "PLA"

    def test_bad_formula_excluded(self):
        spool = _make_spool()
        field = _make_field("bad", {"nonexistent_op": [1, 2]})
        result = compute_derived(spool, "spool", [field])
        assert "bad" not in result

    def test_spool_remaining_percentage(self):
        spool = _make_spool(remaining_weight_g=225.0, initial_total_weight_g=1000.0, empty_spool_weight_g=250.0)
        formula = {"round": [{"*": [{"/": [{"var": "remaining_weight_g"}, {"-": [{"var": "initial_total_weight_g"}, {"var": "empty_spool_weight_g"}]}]}, 100]}, 1]}
        field = _make_field("pct_remaining", formula)
        result = compute_derived(spool, "spool", [field])
        assert result["pct_remaining"] == pytest.approx(30.0, rel=1e-3)

    def test_field_with_none_formula_skipped(self):
        spool = _make_spool()
        field = _make_field("noop", None)
        result = compute_derived(spool, "spool", [field])
        assert "noop" not in result
