import math

import pytest

from app.services.spoolman_extra_field_mapping import SpoolmanFieldError
from app.services.spoolman_standard_fields import (
    standard_fan_pair,
    standard_source_definitions,
    standard_value,
)


def test_reserved_extra_key_cannot_replace_import_identity():
    assert standard_source_definitions(
        [{"key": "spoolman_id", "name": "Drying Temperature", "field_type": "integer"}]
    ) == {}


def test_nonfinite_standard_number_is_rejected():
    with pytest.raises(SpoolmanFieldError):
        standard_value(math.nan, "flow_ratio", {"field_type": "float"})


def test_oversized_fan_number_is_preserved_by_rejecting_conversion():
    with pytest.raises(SpoolmanFieldError):
        standard_fan_pair({"fan_speed_min": str(10**1000)})


def test_oversized_fan_range_is_preserved_by_rejecting_conversion():
    with pytest.raises(SpoolmanFieldError):
        standard_value(
            [10**1000, 100],
            "cooling_fan_range_percent",
            {"field_type": "integer_range"},
        )


@pytest.mark.parametrize(
    ("name", "source_type", "unit"),
    [
        ("Drying Time", "float", "min"),
        ("Drying Temperature", "float", "°F"),
        ("Max Volumetric Speed", "float", "mm/s"),
        ("Cooling Fan Speed", "float_range", "rpm"),
    ],
)
def test_explicit_incompatible_unit_does_not_promote(name, source_type, unit):
    assert standard_source_definitions(
        [{"key": "candidate", "name": name, "field_type": source_type, "unit": unit}]
    ) == {}


def test_malformed_url_is_rejected_without_aborting_import():
    with pytest.raises(SpoolmanFieldError):
        standard_value('"http://[bad"', "datasheet_url", {"field_type": "text"})


def test_currency_must_be_three_ascii_letters():
    with pytest.raises(SpoolmanFieldError):
        standard_value('"ÉUR"', "price_currency", {"field_type": "text"})
