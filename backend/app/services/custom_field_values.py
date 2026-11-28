"""Validation and merging of spool ``custom_fields`` values for MCP and bulk updates.

Only keys backed by a system extra field definition are checked; record-local
keys without a definition pass through unchanged. A ``None`` value always means
"remove this key".
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def _definition_value(definition: Any, name: str) -> Any:
    if isinstance(definition, dict):
        return definition.get(name)
    return getattr(definition, name, None)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_number(label: str, value: Any, config: dict[str, Any]) -> list[str]:
    if not _is_number(value):
        return [f"'{label}' must be a number"]
    errors = []
    low, high = config.get("min_bound"), config.get("max_bound")
    if low is not None and value < low:
        errors.append(f"'{label}' must be >= {low}")
    if high is not None and value > high:
        errors.append(f"'{label}' must be <= {high}")
    return errors


def validate_custom_field_values(values: dict[str, Any], definitions: Iterable[Any]) -> list[str]:
    """Return error messages for values that violate their spool system definition."""
    by_key = {
        _definition_value(d, "key"): d
        for d in definitions
        if _definition_value(d, "target_type") == "spool"
    }
    errors: list[str] = []
    for key, value in values.items():
        definition = by_key.get(key)
        if definition is None or value is None:
            continue
        field_type = _definition_value(definition, "field_type") or "text"
        options = _definition_value(definition, "options") or []
        config = _definition_value(definition, "config") or {}
        if field_type == "formula":
            errors.append(f"'{key}' is a formula field and cannot be set")
        elif field_type == "dropdown":
            if value not in options:
                errors.append(f"'{key}' must be one of {options}")
        elif field_type == "multiselect":
            if not isinstance(value, list) or any(v not in options for v in value):
                errors.append(f"'{key}' must be a list of values from {options}")
        elif field_type == "number":
            errors.extend(_check_number(key, value, config))
        elif field_type == "range":
            if isinstance(value, dict):
                for end in ("min", "max"):
                    if value.get(end) is not None:
                        errors.extend(_check_number(f"{key}.{end}", value[end], config))
            else:
                errors.extend(_check_number(key, value, config))
        elif field_type == "checkbox":
            # The web UI stores checkbox values as the strings 'true'/'false'.
            if not (isinstance(value, bool) or value in ("true", "false")):
                errors.append(f"'{key}' must be true or false")
    return errors


def normalize_custom_field_values(values: dict[str, Any], definitions: Iterable[Any]) -> dict[str, Any]:
    """Store checkbox values the way the web UI does (the strings 'true'/'false')."""
    checkbox_keys = {
        _definition_value(d, "key")
        for d in definitions
        if _definition_value(d, "target_type") == "spool" and _definition_value(d, "field_type") == "checkbox"
    }
    return {
        key: ("true" if value else "false") if key in checkbox_keys and isinstance(value, bool) else value
        for key, value in values.items()
    }


def merge_custom_fields(existing: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any] | None:
    """Merge ``incoming`` into ``existing``; ``None`` values delete keys. Empty result is ``None``."""
    merged = dict(existing or {})
    for key, value in incoming.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged or None
