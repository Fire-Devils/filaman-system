import pytest
from app.utils.colors import (
    normalize_hex_color,
    normalize_spoolmandb_hex_color,
    visible_rgb_hex,
    visible_rgb_hex_or_legacy,
)


def test_normalize_hex_color_uses_css_rgba_order():
    assert normalize_hex_color("abc") == "#AABBCC"
    assert normalize_hex_color("abcd") == "#AABBCCDD"
    assert normalize_hex_color("00ffffff") == "#00FFFFFF"


def test_visible_rgb_hex_drops_trailing_alpha():
    assert visible_rgb_hex("#BE000022") == "#BE0000"
    assert visible_rgb_hex("#FFFFFF00") == "#FFFFFF"
    assert visible_rgb_hex_or_legacy("legacy") == "#LEGACY"


def test_spoolmandb_import_normalizes_known_legacy_argb_values():
    assert normalize_spoolmandb_hex_color("00FFFFFF") == "#FFFFFF00"
    assert normalize_spoolmandb_hex_color("3CD8100C") == "#D8100C3C"
    assert normalize_spoolmandb_hex_color("3C8AD77F") == "#8AD77F3C"
    assert normalize_spoolmandb_hex_color("3CF8A813") == "#F8A8133C"


def test_spoolmandb_import_preserves_css_rgba_values():
    assert normalize_spoolmandb_hex_color("be000022") == "#BE000022"
    assert normalize_spoolmandb_hex_color("00d4d488") == "#00D4D488"
    assert normalize_spoolmandb_hex_color("3c112233") == "#3C112233"


def test_normalize_hex_color_rejects_invalid_values():
    with pytest.raises(ValueError):
        normalize_hex_color("#12345")
