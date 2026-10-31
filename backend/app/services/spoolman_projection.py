"""Read-only projection of promoted properties into the Spoolman v1 wire shape."""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Mapping
from copy import deepcopy
from functools import wraps
from typing import Any

from app.services.filamentdb_field_mapping import DIRECT_FIELDS

_EXTRA_FIELDS = {
    **DIRECT_FIELDS,
    "image_url": "image_url",
    "discontinued": "is_discontinued",
    "ams_compatible": "ams_compatibility",
    "build_plates": "build_plate_compatibility",
    "fan_speed_min": "cooling_fan_range_percent.min",
    "fan_speed_max": "cooling_fan_range_percent.max",
}
_TEMPERATURES = {
    "settings_extruder_temp": "extruder_temp_range_c",
    "settings_bed_temp": "bed_temp_range_c",
}
_NATIVE_FIELDS = {target.split(".")[0] for target in _EXTRA_FIELDS.values()} | set(
    _TEMPERATURES.values()
)
_FILAMENT_TOP_LEVEL = {"article_number", "comment", "external_id", *_TEMPERATURES}


def promotion_alias(target: str, raw: Any, native: Any) -> dict[str, Any]:
    """Retain representation evidence, never a second editable source of truth."""
    return {
        "target": target,
        "wire": {"target": target, "value": deepcopy(raw), "native": deepcopy(native)},
    }


def catalog_promotion_aliases(
    data: dict, native: dict, custom: dict | None = None, existing: dict | None = None
) -> dict:
    """Remember catalog fields whose original custom-field paths were promoted."""
    aliases = {}
    sources = {
        **_EXTRA_FIELDS,
        "temp_nozzle_min": "extruder_temp_range_c.min",
        "temp_nozzle_max": "extruder_temp_range_c.max",
        "temp_bed": "bed_temp_range_c",
    }
    for source, target in sources.items():
        field, _, endpoint = target.partition(".")
        if source in data and data[source] is not None and field in native:
            old = (existing or {}).get(source)
            old_target = old.get("target") if isinstance(old, dict) else old
            matching = isinstance(old_target, str) and old_target.split(".")[0] == field
            if (old is not None and not matching) or (
                source in (custom or {}) and not matching
            ):
                continue
            value = native[field].get(endpoint) if endpoint else native[field]
            alias = promotion_alias(target, data[source], value)
            if matching:
                alias = {
                    **(old if isinstance(old, dict) else {"target": old}),
                    "wire": alias["wire"],
                }
            aliases[source] = alias
    return aliases


def _native_value(entity: Any, target: str) -> Any:
    field, _, endpoint = target.partition(".")
    value = (
        entity.get(field)
        if isinstance(entity, Mapping)
        else getattr(entity, field, None)
    )
    return value.get(endpoint) if endpoint and isinstance(value, dict) else value


def _range_scalar(value: dict | None) -> Any:
    if not value:
        return None
    return value.get("min") if value.get("min") is not None else value.get("max")


def _encode(value: Any, original: Any, snapshot: Any) -> Any:
    if value is None:
        return None
    if isinstance(original, str):
        if isinstance(snapshot, str) and original.strip() == snapshot:
            return deepcopy(value)
        # CSV cannot represent commas inside items; JSON retains every item.
        if isinstance(value, list) and any("," in item for item in value):
            return json.dumps(value, ensure_ascii=False)
        try:
            decoded = json.loads(original)
        except ValueError:
            decoded = None
        # Text that happens to parse as a number/bool is still plain text.
        if decoded is None or (
            isinstance(snapshot, (str, list))
            and not isinstance(decoded, (str, list, dict))
        ):
            if isinstance(value, list):
                return ",".join(value)
            if isinstance(value, dict):
                value = _range_scalar(value)
            return str(value) if value is not None else None
        return json.dumps(_encode(value, decoded, snapshot), ensure_ascii=False)
    if isinstance(value, dict) and set(value) <= {"min", "max"}:
        previous = snapshot if isinstance(snapshot, dict) else {}
        if isinstance(original, list):
            return [
                _encode(
                    value.get(key),
                    original[index] if index < len(original) else None,
                    previous.get(key),
                )
                for index, key in enumerate(("min", "max"))
            ]
        if not isinstance(original, dict):
            # Former scalars use the lower available endpoint; native APIs retain the range.
            return _range_scalar(value)
        return {
            key: _encode(endpoint, original.get(key), previous.get(key))
            for key, endpoint in value.items()
            if key in original or endpoint is not None
        }
    return deepcopy(value)


def _wire(alias: Any) -> dict:
    wire = alias.get("wire") if isinstance(alias, dict) else None
    return wire if isinstance(wire, dict) else {}


def alias_target(alias: Any) -> Any:
    return _wire(alias).get(
        "target", alias.get("target") if isinstance(alias, dict) else alias
    )


def alias_source(path: str, alias: Any, aliases: Mapping) -> tuple[str, ...] | None:
    """Prefer captured literal keys; old aliases retain their original path policy."""
    source = _wire(alias).get("source")
    if (
        isinstance(source, list)
        and all(isinstance(part, str) for part in source)
        and (len(source) == 1 or (len(source) == 2 and source[0] == "spoolman_extra"))
    ):
        return tuple(source)
    # Generated range children are label tokens, not independent wire sources.
    if path.rpartition(".")[0] in aliases:
        return None
    return (
        ("spoolman_extra", path.removeprefix("spoolman_extra."))
        if path.startswith("spoolman_extra.")
        else (path,)
    )


def owns_retained_source(alias: Any, current: Any, definition: Any = None) -> bool:
    """Only an unchanged deliberately retained source remains owned by promotion."""
    wire = _wire(alias)
    return (
        wire.get("retained") is True
        and current == wire.get("value")
        and (definition is None or definition == alias.get("definition"))
    )


def project_alias_value(
    native: Any, source: str, alias: Any, *, filament: bool = False
) -> Any:
    """Shared runtime/rollback projection of one alias into its original wire shape."""
    if filament and source in _TEMPERATURES:
        value = _range_scalar(_native_value(native, _TEMPERATURES[source]))
        return round(value) if value is not None else None
    target = alias_target(alias)
    if not isinstance(target, str) or target.split(".")[0] not in _NATIVE_FIELDS:
        return None
    value = _native_value(native, target)
    wire = _wire(alias)
    if value is None:
        return None
    if wire and value == wire.get("native"):
        return deepcopy(wire.get("value"))
    if wire:
        return _encode(value, wire.get("value"), wire.get("native"))
    # Older aliases lack source bytes; Spoolman nested extras use JSON strings.
    return (
        json.dumps(value, ensure_ascii=False)
        if source.startswith("spoolman_extra.")
        else deepcopy(value)
    )


def project_extra(entity: Any, extra: dict, *, filament: Any | None = None) -> dict:
    """Rebuild source paths without changing stored JSON or unrelated extras."""
    result = deepcopy(extra)
    aliases = getattr(entity, "label_field_aliases", None) or {}
    native = filament if filament is not None else entity
    covered = set()
    definitions = getattr(entity, "custom_field_definitions", None) or {}
    for path, alias in aliases.items():
        target = alias_target(alias)
        if not isinstance(target, str) or target.split(".")[0] not in _NATIVE_FIELDS:
            continue
        covered.add(target.split(".")[0])
        parts = alias_source(path, alias, aliases)
        if parts is None:
            continue
        if path in (_FILAMENT_TOP_LEVEL if filament is None else {"comment"}):
            continue
        key = parts[-1]
        container = result.setdefault(parts[0], {}) if len(parts) == 2 else result
        if not isinstance(container, dict):
            continue
        if key in container and not owns_retained_source(
            alias, container[key], definitions.get(path)
        ):
            continue
        container[key] = project_alias_value(native, path, alias)
    if filament is None:
        for key, target in _EXTRA_FIELDS.items():
            value = _native_value(entity, target)
            if (
                target.split(".")[0] not in covered
                and value is not None
                and not (target == "is_discontinued" and value is False)
            ):
                result.setdefault(key, deepcopy(value))
    return result


class FilamentCompatibilityView:
    """Delegate reads to the ORM object while giving old serializers projected JSON."""

    def __init__(self, filament: Any):
        self._filament = filament
        self.custom_fields = deepcopy(filament.custom_fields or {})
        aliases = getattr(filament, "label_field_aliases", None) or {}
        alias_targets = (
            alias.get("target") if isinstance(alias, dict) else alias
            for alias in aliases.values()
        )
        targets = {
            target.split(".")[0] for target in alias_targets if isinstance(target, str)
        }
        for key, field in _TEMPERATURES.items():
            native = getattr(filament, field, None)
            if native is not None or field in targets:
                self.custom_fields[key] = project_alias_value(
                    filament, key, None, filament=True
                )
        extra = {
            key: value
            for key, value in self.custom_fields.items()
            if key not in _FILAMENT_TOP_LEVEL
        }
        self.custom_fields.update(project_extra(filament, extra))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._filament, name)


def adapt_installed_spoolman(module: Any, plugin_key: str, manifest: dict) -> bool:
    """Adapt only the known v1 serializer interface; leave routes and queries owned by the plugin."""
    if plugin_key != "spoolmanapi":
        return False
    service = getattr(module, "SpoolmanService", None)
    supported = (
        manifest.get("version") == "1.0.0"
        and isinstance(service, type)
        and service.__module__ == "spoolmanapi.service"
        and all(
            callable(getattr(service, method, None))
            and list(inspect.signature(getattr(service, method)).parameters)
            == ["self", parameter]
            for method, parameter in (
                ("_filament_to_schema", "filament"),
                ("_spool_to_schema", "spool"),
            )
        )
    )
    if not supported:
        logging.getLogger(__name__).warning(
            "Unsupported Spoolman serializer interface/version; leaving plugin unchanged"
        )
        return False
    if getattr(service, "_filaman_projection", False):
        return True
    original_filament = service._filament_to_schema
    original_spool = service._spool_to_schema

    @wraps(original_filament)
    def filament_to_schema(self, filament):
        return original_filament(self, FilamentCompatibilityView(filament))

    @wraps(original_spool)
    def spool_to_schema(self, spool):
        wire = original_spool(self, spool)
        wire.extra = project_extra(spool, wire.extra, filament=spool.filament)
        return wire

    service._filament_to_schema = filament_to_schema
    service._spool_to_schema = spool_to_schema
    service._filaman_projection = True
    return True
