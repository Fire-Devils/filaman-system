import copy
import json
from pathlib import Path

import pytest

from app.services.label_preset_v1 import convert_label_preset_data

CASES = json.loads((Path(__file__).parent / "fixtures/label_preset_v1_v2.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_frozen_browser_conversion_contract(case):
    original = copy.deepcopy(case["input"])
    actual = convert_label_preset_data(original, case["kind"])
    assert actual == case["expected"]
    assert original == case["input"]
    assert convert_label_preset_data(actual, case["kind"]) is actual


@pytest.mark.parametrize("data", [None, [], {}, {"unrelated": 1}, {"version": 3},
    {"version": 2, "design": {"elements": []}}, {"settings": None},
    {"settings": {"logo": []}}, {"settings": {"unknown": "preserve me"}},
    {"settings": {"title": {"template": "x" * 131072}}}])
def test_preserves_unrecognized_or_oversized_data(data):
    assert convert_label_preset_data(data, "spool") is data


def test_sheet_and_oversized_converted_payload_stay_unchanged():
    data = {"settings": {"title": {"template": "x" * 8000}, "recovery": "x" * 122000}}
    assert convert_label_preset_data(data, "sheet") is data
    assert convert_label_preset_data(data, "spool") is data


def test_legacy_markup_is_preserved_without_reinterpreting_saved_text():
    data = {"settings": {"title": {"template": "***{filament.name}***"}}}
    converted = convert_label_preset_data(data, "spool")
    assert converted["design"]["elements"][1]["template"] == "***{filament.name}***"
