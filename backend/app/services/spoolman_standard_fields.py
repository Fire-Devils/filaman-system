"""Promote unambiguous Spoolman filament extras to native filament properties."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any
from urllib.parse import urlparse

from app.services.spoolman_extra_field_mapping import (
    SpoolmanFieldError,
    convert_spoolman_value,
    map_spoolman_definition,
)

_LABELS = {
    "manufacturer_sku": {"manufacturersku", "sku"},
    "datasheet_url": {"datasheet", "datasheeturl"},
    "image_url": {"imageurl", "filamentimageurl"},
    "is_discontinued": {"discontinued", "isdiscontinued"},
    "drying_temp_c": {"dryingtemperature", "dryingtemp"},
    "drying_time_hours": {"dryingtime", "dryingtimehours", "drytime"},
    "softening_temp_c": {"softeningtemperature", "softeningtemp"},
    "cooling_fan_range_percent": {"coolingfanspeed", "coolingfanrange", "fanspeed"},
    "chamber_temp_c": {"chambertemperature", "chambertemp"},
    "max_volumetric_speed_mm3_s": {"maxvolumetricspeed"},
    "flow_ratio": {"flowratio"},
    "pressure_advance_k": {"pressureadvance", "pressureadvancek", "kvalue"},
    "ams_compatibility": {"amscompatibility", "amscompatible"},
    "build_plate_compatibility": {"buildplatecompatibility", "buildplates"},
    "price_currency": {"currency", "pricecurrency"},
}
_NUMBERS = {
    "drying_temp_c",
    "drying_time_hours",
    "softening_temp_c",
    "chamber_temp_c",
    "max_volumetric_speed_mm3_s",
    "flow_ratio",
    "pressure_advance_k",
}
_TEXT = {"manufacturer_sku", "datasheet_url", "image_url", "price_currency"}
_LISTS = {"ams_compatibility", "build_plate_compatibility"}
_UNITS = {
    "drying_temp_c": {"°c", "c", "celsius"},
    "softening_temp_c": {"°c", "c", "celsius"},
    "chamber_temp_c": {"°c", "c", "celsius"},
    "drying_time_hours": {"h", "hr", "hrs", "hour", "hours"},
    "cooling_fan_range_percent": {"%", "percent"},
    "max_volumetric_speed_mm3_s": {"mm³/s", "mm3/s", "mm^3/s"},
    "flow_ratio": {"ratio"},
    "pressure_advance_k": {"k"},
}


def _name(value: Any) -> str:
    return "".join(char for char in str(value).lower() if char.isalnum())


def compatible_unit(target: str, unit: Any) -> bool:
    """Absent units are unknown; explicit units must match native semantics."""
    if unit is None or unit == "":
        return True
    if not isinstance(unit, str):
        return False
    return unit.strip().lower() in _UNITS.get(target, set())


def standard_source_definitions(
    definitions: list[dict[str, Any]],
) -> dict[str, tuple[str, dict[str, Any]]]:
    """Return only sources with one compatible definition per native target."""
    by_target: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    for definition in definitions:
        key = definition.get("key")
        source_type = definition.get("field_type")
        if not isinstance(key, str):
            continue
        try:
            map_spoolman_definition(definition, "filament")
        except SpoolmanFieldError:
            continue
        names = {_name(key), _name(definition.get("name", ""))}
        matches = [
            target
            for target, labels in _LABELS.items()
            if names & labels
            and (
                (target in _NUMBERS and source_type in {"integer", "float"})
                or (
                    target == "cooling_fan_range_percent"
                    and source_type in {"integer_range", "float_range"}
                )
                or (target == "is_discontinued" and source_type == "boolean")
                or (target in _TEXT and source_type in {"text", "choice"})
                or (target in _LISTS and source_type in {"text", "choice"})
            )
        ]
        if len(matches) == 1 and compatible_unit(matches[0], definition.get("unit")):
            by_target[matches[0]].append((key, definition))
    return {
        sources[0][0]: (target, sources[0][1])
        for target, sources in by_target.items()
        if len(sources) == 1
    }


def standard_value(raw: Any, target: str, definition: dict[str, Any]) -> Any:
    """Convert a typed Spoolman value; reject values unsafe for its native column."""
    source_type = definition["field_type"]
    try:
        value = convert_spoolman_value(
            raw,
            source_type,
            definition.get("choices"),
            definition.get("multi_choice") if source_type == "choice" else None,
        )
    except OverflowError as exc:
        raise SpoolmanFieldError("number is too large") from exc
    if target in _NUMBERS:
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            raise SpoolmanFieldError("expected a finite number")
        return value
    if target == "cooling_fan_range_percent":
        if any(
            endpoint is not None and not 0 <= endpoint <= 100
            for endpoint in value.values()
        ):
            raise SpoolmanFieldError("fan percentage must be between 0 and 100")
        return value
    if target == "is_discontinued":
        return value
    if target in _LISTS:
        values = value if isinstance(value, list) else value.split(",")
        items = [
            item.strip()
            for item in values
            if isinstance(item, str) and item.strip()
        ]
        if not items:
            raise SpoolmanFieldError("expected at least one compatibility value")
        return items
    if not isinstance(value, str) or not value.strip():
        raise SpoolmanFieldError("expected non-empty text")
    text = value.strip()
    if target in {"datasheet_url", "image_url"}:
        try:
            parsed = urlparse(text)
        except ValueError as exc:
            raise SpoolmanFieldError("expected a valid URL") from exc
        if (
            len(text) > 500
            or parsed.scheme not in {"http", "https"}
            or not parsed.netloc
        ):
            raise SpoolmanFieldError("expected a URL of at most 500 characters")
    elif target == "price_currency":
        text = text.upper()
        if len(text) != 3 or not text.isascii() or not text.isalpha():
            raise SpoolmanFieldError("expected an ISO-style currency code")
    elif len(text) > 255:
        raise SpoolmanFieldError("text exceeds 255 characters")
    return text


def standard_fan_pair(
    extra: dict[str, Any],
) -> tuple[dict[str, int | float | None], set[str]] | None:
    """Read the common two-field fan range without guessing other extra keys."""
    keys = {key for key in ("fan_speed_min", "fan_speed_max") if key in extra}
    if not keys:
        return None
    value: dict[str, int | float | None] = {"min": None, "max": None}
    for key, endpoint in (("fan_speed_min", "min"), ("fan_speed_max", "max")):
        if key in keys:
            number = convert_spoolman_value(extra[key], "float")
            try:
                valid = math.isfinite(number) and 0 <= number <= 100
            except OverflowError:
                valid = False
            if not valid:
                raise SpoolmanFieldError("fan percentage must be between 0 and 100")
            value[endpoint] = number
    if (
        value["min"] is not None
        and value["max"] is not None
        and value["min"] > value["max"]
    ):
        raise SpoolmanFieldError("fan minimum exceeds maximum")
    return value, keys
