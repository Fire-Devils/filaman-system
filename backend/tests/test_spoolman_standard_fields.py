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
