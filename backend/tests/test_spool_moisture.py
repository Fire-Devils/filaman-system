from datetime import datetime, timedelta, timezone

import pytest

from app.services.spool_moisture import (
    THRESHOLD_DAYS,
    compute_moisture,
    material_sensitivity,
)

NOW = datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc)


def moisture(days, material="PLA", status="opened", subgroup=None, dried_days=None):
    return compute_moisture(
        status,
        material,
        subgroup,
        NOW - timedelta(days=days) if days is not None else None,
        NOW - timedelta(days=dried_days) if dried_days is not None else None,
        now=NOW,
    )


@pytest.mark.parametrize(
    "material,expected",
    [
        ("PA", "high"),
        ("PA6-CF", "high"),
        ("nylon", "high"),
        ("PVA", "high"),
        ("BVOH", "high"),
        ("PC", "high"),
        ("TPU", "high"),
        ("PEBA", "high"),
        ("PPS-CF", "high"),
        ("PA-GF", "high"),
        ("PETG", "medium"),
        ("petg-cf", "medium"),
        ("PCTG", "medium"),
        ("PET", "medium"),
        ("PPA-CF", "high"),
        ("ASA", "medium"),
        ("ABS", "medium"),
        ("PET-CF", "medium"),
        ("HIPS", "medium"),
        ("PP", "medium"),
        ("PLA", "low"),
        ("pla+", "low"),
        ("Wood", "low"),
        ("", "low"),
        (None, "low"),
    ],
)
def test_material_sensitivity(material, expected):
    assert material_sensitivity(material) == expected


def test_subgroup_can_raise_sensitivity():
    assert material_sensitivity("PLA", "PA-CF") == "high"
    assert material_sensitivity("PETG", None) == "medium"
    assert material_sensitivity("Unknown", "ABS") == "medium"


def test_longest_prefix_wins_over_shorter_prefix():
    assert material_sensitivity("PCTG") == "medium"  # not "PC" (high)
    assert material_sensitivity("PPS") == "high"  # not "PP" (medium)


@pytest.mark.parametrize(
    "sensitivity,material", [("high", "PA"), ("medium", "PETG"), ("low", "PLA")]
)
def test_level_boundaries(sensitivity, material):
    dry, fair, damp = THRESHOLD_DAYS[sensitivity]
    for days, level in [
        (0, "dry"),
        (dry, "dry"),
        (dry + 1, "fair"),
        (fair, "fair"),
        (fair + 1, "damp"),
        (damp, "damp"),
        (damp + 1, "wet"),
    ]:
        result = moisture(days, material)
        assert result["level"] == level, (material, days)
        assert result["days_exposed"] == days
        assert result["sensitivity"] == sensitivity


def test_thresholds_match_spec():
    assert THRESHOLD_DAYS == {
        "high": (3, 7, 14),
        "medium": (7, 21, 45),
        "low": (30, 90, 180),
    }


def test_reference_is_the_later_of_opened_and_dried():
    result = moisture(40, "PA", dried_days=2)
    assert result["days_exposed"] == 2
    assert result["level"] == "dry"
    assert result["reference_at"] == NOW - timedelta(days=2)

    result = moisture(2, "PA", dried_days=40)
    assert result["days_exposed"] == 2


def test_only_dried_at_is_enough():
    assert moisture(None, "PA", dried_days=10)["level"] == "damp"


@pytest.mark.parametrize("status", ["new", "empty", "archived", None])
def test_no_status_for_excluded_status(status):
    assert moisture(100, "PA", status=status) is None


@pytest.mark.parametrize("status", ["opened", "active", "drying"])
def test_status_for_open_spools(status):
    assert moisture(100, "PA", status=status)["level"] == "wet"


def test_no_status_without_reference():
    assert moisture(None, "PA") is None


def test_future_reference_never_gives_negative_days():
    assert moisture(-5, "PA")["days_exposed"] == 0


def test_naive_datetimes_are_treated_as_utc():
    result = compute_moisture(
        "opened",
        "PA",
        None,
        (NOW - timedelta(days=5)).replace(tzinfo=None),
        None,
        now=NOW,
    )
    assert result["days_exposed"] == 5
