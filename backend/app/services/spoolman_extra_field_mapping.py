"""Pure conversion helpers for Spoolman extra fields."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlparse

from app.services.custom_field_identity import validate_custom_field_path
from app.services.spoolman_contracts import (
    RepairFieldType,
    SpoolmanFieldCandidate,
    SpoolmanSourceFieldType,
    SpoolmanTarget,
)


class SpoolmanFieldError(ValueError):
    """A Spoolman field definition or value cannot be mapped safely."""


_TYPE_MAP = {
    "text": "text",
    "integer": "number",
    "float": "number",
    "integer_range": "range",
    "float_range": "range",
    "datetime": "datetime",
    "boolean": "checkbox",
}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RepairConfidence = Literal[
    "authoritative",
    "high",
    "medium",
    "low",
    "unresolved",
]


@dataclass(frozen=True, slots=True)
class RepairFieldProposal:
    target_type: str
    key: str
    label: str
    definition: SpoolmanFieldCandidate | None
    confidence: RepairConfidence
    confidence_reason: str
    samples: tuple[Any, ...]
    occurrences: int

    @property
    def identity(self) -> tuple[str, str]:
        return (self.target_type, self.key)


def decode_spoolman_value(raw: Any, field_type: str | None = None) -> Any:
    """Decode Spoolman's JSON-in-a-string value, including legacy cleaned text."""
    if not isinstance(raw, str):
        return raw
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    # Older FilaMan imports stripped the JSON quotes from text values. A value
    # such as "true" is then indistinguishable from a JSON boolean unless the
    # authoritative field definition tells us it is text.
    if field_type in {"text", "datetime"} and not isinstance(value, str):
        return raw
    return value


def convert_spoolman_value(
    raw: Any,
    field_type: str,
    choices: list[str] | None = None,
    multi_choice: bool | None = None,
) -> Any:
    """Convert one Spoolman wire value to FilaMan's native JSON shape."""
    value = decode_spoolman_value(raw, field_type)

    if field_type in {"text", "datetime"}:
        if not isinstance(value, str):
            raise SpoolmanFieldError("expected a string")
        if field_type == "datetime":
            try:
                datetime.fromisoformat(value)
            except ValueError as exc:
                raise SpoolmanFieldError("expected an ISO-8601 datetime") from exc
        return value

    if field_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise SpoolmanFieldError("expected an integer")
        return value

    if field_type == "float":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise SpoolmanFieldError("expected a number")
        return value

    if field_type in {"integer_range", "float_range"}:
        endpoints = _parse_range_endpoints(value)
        if endpoints is None:
            raise SpoolmanFieldError("expected a two-item range")
        for item in endpoints:
            if (
                field_type == "integer_range"
                and item is not None
                and not isinstance(item, int)
            ):
                raise SpoolmanFieldError("range endpoints must be integers or null")
        return {"min": endpoints[0], "max": endpoints[1]}

    if field_type == "boolean":
        if not isinstance(value, bool):
            raise SpoolmanFieldError("expected a boolean")
        return value

    if field_type == "choice":
        multi = isinstance(value, list)
        if multi_choice is True and not multi:
            raise SpoolmanFieldError("expected multiple choices")
        if multi_choice is False and multi:
            raise SpoolmanFieldError("expected one choice")
        selected = value if multi else [value]
        if not all(isinstance(item, str) for item in selected):
            raise SpoolmanFieldError("expected a string choice")
        if choices is not None and any(item not in choices for item in selected):
            raise SpoolmanFieldError("value is not in the configured choices")
        return value

    raise SpoolmanFieldError(f"unsupported Spoolman field type: {field_type}")


def map_spoolman_definition(
    definition: dict[str, Any], target_type: str
) -> SpoolmanFieldCandidate:
    """Map a Spoolman field definition to a native SystemExtraField candidate."""
    if target_type not in {"filament", "spool"}:
        raise SpoolmanFieldError(f"unsupported target: {target_type}")

    key = definition.get("key")
    label = definition.get("name")
    source_type = definition.get("field_type")
    if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9_]{1,64}", key):
        raise SpoolmanFieldError("invalid field key")
    try:
        validate_custom_field_path(key)
    except ValueError as exc:
        raise SpoolmanFieldError(str(exc)) from exc
    if not isinstance(label, str) or not label.strip():
        raise SpoolmanFieldError("invalid field name")

    options: list[str] | None = None
    if source_type == "choice":
        choices = definition.get("choices")
        if (
            not isinstance(choices, list)
            or not choices
            or not all(isinstance(item, str) for item in choices)
        ):
            raise SpoolmanFieldError("choice field has invalid choices")
        options = list(choices)
        native_type = (
            "multiselect" if definition.get("multi_choice") is True else "dropdown"
        )
    else:
        native_type = _TYPE_MAP.get(source_type)
        if native_type is None:
            raise SpoolmanFieldError(f"unsupported Spoolman field type: {source_type}")

    config: dict[str, Any] = {}
    if source_type in {"integer", "integer_range"}:
        config["decimal_places"] = 0
    unit = definition.get("unit")
    if (
        source_type in {"integer", "float", "integer_range", "float_range"}
        and isinstance(unit, str)
        and unit
    ):
        config["unit"] = unit

    default_value = None
    if definition.get("default_value") is not None:
        converted = convert_spoolman_value(
            definition["default_value"],
            source_type,
            options,
            definition.get("multi_choice"),
        )
        default_value = _serialize_default(converted)
        if len(default_value) > 500:
            raise SpoolmanFieldError(
                "default value exceeds FilaMan's 500-character limit"
            )

    return SpoolmanFieldCandidate(
        target_type=SpoolmanTarget(target_type),
        key=key,
        label=label.strip(),
        field_type=RepairFieldType(native_type),
        options=options,
        config=config or None,
        default_value=default_value,
        source_field_type=SpoolmanSourceFieldType(source_type),
        order=(
            definition.get("order", 0)
            if isinstance(definition.get("order", 0), int)
            else 0
        ),
    )


def infer_definition(
    target_type: str, key: str, raw_values: Iterable[Any]
) -> RepairFieldProposal:
    """Suggest a conservative native definition from legacy stored values."""
    stored_values = list(raw_values)
    values = [decode_spoolman_value(value) for value in stored_values]
    if not values:
        raise SpoolmanFieldError("no values to infer")
    try:
        valid_identity = bool(re.fullmatch(r"[A-Za-z0-9_]{1,100}", key))
        validate_custom_field_path(key)
    except ValueError:
        valid_identity = False
    if not valid_identity:
        return _inferred_proposal(
            target_type,
            key,
            "text",
            "unresolved",
            "invalid_key",
            None,
            values,
        )

    source_type: str | None = None
    confidence = "low"
    confidence_reason = "legacy_scalar"
    options: list[str] | None = None

    if all(isinstance(value, bool) for value in values):
        source_type, confidence = "boolean", "low"
    elif all(
        isinstance(value, int) and not isinstance(value, bool) for value in values
    ):
        source_type, confidence = "integer", "low"
    elif all(
        isinstance(value, int | float) and not isinstance(value, bool)
        for value in values
    ):
        source_type, confidence = "float", "low"
    elif all(_is_numeric_range(value) for value in values):
        endpoints = [
            item
            for value in values
            for item in _parse_range_endpoints(value) or ()
            if item is not None
        ]
        source_type = (
            "integer_range"
            if all(isinstance(item, int) for item in endpoints)
            else "float_range"
        )
        confidence = "high" if len(values) >= 3 else "medium"
        confidence_reason = "structured_values"
    elif all(
        isinstance(value, list) and all(isinstance(item, str) for item in value)
        for value in values
    ):
        source_type = "choice"
        confidence = "high" if len(values) >= 3 else "medium"
        confidence_reason = "structured_values"
        options = sorted({item for value in values for item in value})
    elif all(isinstance(value, str) for value in values):
        if all(_ISO_DATE.fullmatch(value) for value in values):
            source_type, confidence = "date", "medium"
            confidence_reason = "date_pattern"
        elif all(_is_datetime(value) for value in values):
            source_type, confidence = "datetime", "medium"
            confidence_reason = "date_pattern"
        elif all(_is_url(value) for value in values):
            source_type = "url"
            confidence = "high" if len(values) >= 2 else "medium"
            confidence_reason = "url_pattern"
        else:
            majority = _majority_inference(values)
            if majority is not None:
                source_type, options = majority
                confidence = (
                    "low"
                    if source_type in {"boolean", "integer", "float"}
                    else "medium"
                )
                confidence_reason = "majority_match"
            else:
                source_type, confidence = "text", "low"
                confidence_reason = "fallback_text"

    if source_type is None:
        majority = _majority_inference(values)
        if majority is not None:
            source_type, options = majority
            confidence = (
                "low" if source_type in {"boolean", "integer", "float"} else "medium"
            )
            confidence_reason = "majority_match"
        elif all(isinstance(value, str) for value in stored_values):
            source_type, confidence = "text", "low"
            confidence_reason = "mixed_text"

    if source_type is None:
        return _inferred_proposal(
            target_type,
            key,
            "text",
            "unresolved",
            "mixed_values",
            None,
            values,
        )

    return _inferred_proposal(
        target_type,
        key,
        source_type,
        confidence,
        confidence_reason,
        options,
        values,
    )


def fingerprint(value: Any) -> str:
    """Create a stable fingerprint for preview/execute drift detection."""
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), default=str
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def canonicalize_definition_lists(
    definitions: dict[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    """Sort endpoint definition lists without reordering semantic inner arrays."""

    def sort_key(definition: dict[str, Any]) -> tuple[int, str, str]:
        raw_order = definition.get("order", 0)
        order = (
            raw_order
            if isinstance(raw_order, int) and not isinstance(raw_order, bool)
            else 0
        )
        raw_key = definition.get("key", "")
        key = raw_key if isinstance(raw_key, str) else ""
        content = json.dumps(
            definition,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return order, key, content

    return {
        target: sorted(items, key=sort_key)
        for target, items in sorted(definitions.items())
    }


def _serialize_default(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    return json.dumps(value, separators=(",", ":"))


def _is_numeric_range(value: Any) -> bool:
    return _parse_range_endpoints(value) is not None


def _parse_range_endpoints(
    value: Any,
) -> tuple[int | float | None, int | float | None] | None:
    """Return validated range endpoints from legacy arrays or exact min/max objects."""
    object_shape = isinstance(value, dict)
    if isinstance(value, list) and len(value) == 2:
        endpoints = (value[0], value[1])
    elif object_shape and set(value) == {"min", "max"}:
        endpoints = (value["min"], value["max"])
    else:
        return None

    for item in endpoints:
        valid_number = isinstance(item, int | float) and not isinstance(item, bool)
        if item is not None and (
            not valid_number or (object_shape and not math.isfinite(item))
        ):
            return None
    return endpoints


def _is_datetime(value: str) -> bool:
    if _ISO_DATE.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _majority_inference(
    values: list[Any],
) -> tuple[str, list[str] | None] | None:
    """Infer a useful type when at least 80% of three or more values agree."""
    if len(values) < 3:
        return None
    required = max(2, math.ceil(len(values) * 0.8))
    candidates: list[tuple[str, Any]] = [
        ("boolean", lambda value: isinstance(value, bool)),
        (
            "integer",
            lambda value: isinstance(value, int) and not isinstance(value, bool),
        ),
        (
            "float",
            lambda value: (
                isinstance(value, int | float) and not isinstance(value, bool)
            ),
        ),
        ("integer_range", _is_numeric_range),
        (
            "choice",
            lambda value: (
                isinstance(value, list) and all(isinstance(item, str) for item in value)
            ),
        ),
        (
            "date",
            lambda value: isinstance(value, str) and bool(_ISO_DATE.fullmatch(value)),
        ),
        (
            "datetime",
            lambda value: isinstance(value, str) and _is_datetime(value),
        ),
        ("url", lambda value: isinstance(value, str) and _is_url(value)),
    ]
    for source_type, matches in candidates:
        matching = [value for value in values if matches(value)]
        if len(matching) < required:
            continue
        if source_type == "integer_range":
            endpoints = [
                item
                for value in matching
                for item in _parse_range_endpoints(value) or ()
                if item is not None
            ]
            if any(not isinstance(item, int) for item in endpoints):
                source_type = "float_range"
        options = (
            sorted({item for value in matching for item in value})
            if source_type == "choice"
            else None
        )
        return source_type, options
    return None


def _inferred_proposal(
    target_type: str,
    key: str,
    source_type: str,
    confidence: RepairConfidence,
    confidence_reason: str,
    options: list[str] | None,
    values: list[Any],
) -> RepairFieldProposal:
    if source_type == "choice":
        native_type = "multiselect"
    elif source_type in {"date", "url"}:
        native_type = source_type
    else:
        native_type = _TYPE_MAP[source_type]
    config = (
        {"decimal_places": 0} if source_type in {"integer", "integer_range"} else None
    )
    label = key.replace("_", " ").strip().title() or key
    definition: SpoolmanFieldCandidate | None = None
    if confidence != "unresolved":
        try:
            definition = SpoolmanFieldCandidate(
                target_type=SpoolmanTarget(target_type),
                key=key,
                label=label,
                field_type=RepairFieldType(native_type),
                options=options,
                config=config,
                default_value=None,
                source_field_type=SpoolmanSourceFieldType(source_type),
            )
        except ValueError:
            confidence = "unresolved"
            confidence_reason = "invalid_key"
    return RepairFieldProposal(
        target_type=target_type,
        key=key,
        label=label,
        definition=definition,
        confidence=confidence,
        confidence_reason=confidence_reason,
        samples=tuple(values[:5]),
        occurrences=len(values),
    )
