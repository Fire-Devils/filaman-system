"""Compatibility between native filament properties and the Spoolman v1 API."""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Mapping
from copy import deepcopy
from functools import wraps
from typing import Any

from fastapi import Depends, HTTPException
from fastapi.routing import APIRoute
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload

from app.api.deps import DBSession
from app.models.filament import Filament, Manufacturer
from app.models.spool import Spool
from app.models.system_extra_field import SystemExtraField
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
_JSON_EXTRA_VERSIONS = ("1.2.3", "1.2.4", "1.2.5")
_NUMERIC_WIRE_FIELDS = {
    "dry_temp": "Drying Temperature",
    "dry_time_hours": "Drying Time",
    "softening_temp": "Softening Temperature",
    "chamber_temp": "Chamber Temperature",
    "max_volumetric_speed": "Max Volumetric Speed",
    "flow_ratio": "Flow Ratio",
    "k_value": "Pressure Advance",
}


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


def effective_source_definition(path: str, local: Mapping, system: Mapping) -> Any:
    """System metadata takes precedence, including historical unqualified keys."""
    key = path.removeprefix("spoolman_extra.")
    return system.get(path, system.get(key, local.get(path, local.get(key))))


def _same_source_value(left: Any, right: Any) -> bool:
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same_source_value(value, right[key]) for key, value in left.items())
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_same_source_value(a, b) for a, b in zip(left, right))
    return isinstance(left, bool) == isinstance(right, bool) and left == right


def _definition_semantics(definition: Any) -> dict:
    if not isinstance(definition, Mapping):
        return {}
    # Registry identity/order and absent optional metadata do not change ownership.
    return {
        key: definition[key]
        for key in ("label", "field_type", "options", "config", "default_value")
        if definition.get(key) is not None
    }


def owns_retained_source(alias: Any, current: Any, definition: Any = None) -> bool:
    """Only an unchanged deliberately retained source remains owned by promotion."""
    wire = _wire(alias)
    captured = wire.get("definition")
    if captured is None and isinstance(alias, dict):
        captured = alias.get("definition")
    return (
        wire.get("retained") is True
        and _same_source_value(current, wire.get("value"))
        and (definition is None or (captured is not None and _same_source_value(
            _definition_semantics(definition), _definition_semantics(captured),
        )))
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


def project_extra(
    entity: Any, extra: dict, *, filament: Any | None = None,
    system_definitions: Mapping | None = None,
) -> dict:
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
            alias, container[key], effective_source_definition(path, definitions, system_definitions or {})
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

    def __init__(self, filament: Any, system_definitions: Mapping | None = None):
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
        self.custom_fields.update(project_extra(filament, extra, system_definitions=system_definitions))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._filament, name)


async def _load_system_definition_context(db: DBSession) -> None:
    # Serializers are synchronous; load both maps once before their request runs.
    definitions = {"filament": {}, "spool": {}}
    for field in await db.scalars(select(SystemExtraField).where(SystemExtraField.target_type.in_(definitions))):
        definitions[field.target_type][field.key] = {
            name: getattr(field, name)
            for name in ("label", "field_type", "options", "config", "default_value")
        }
    db.info["spoolman_definitions"] = definitions


async def get_or_create_unknown_manufacturer(db: DBSession) -> Manufacturer:
    query = select(Manufacturer).where(Manufacturer.name == "Unknown")
    manufacturer = await db.scalar(query)
    if manufacturer is not None:
        return manufacturer
    try:
        async with db.begin_nested():
            manufacturer = Manufacturer(name="Unknown")
            db.add(manufacturer)
            await db.flush()
            return manufacturer
    except IntegrityError:
        manufacturer = await db.scalar(query.with_for_update())
        if manufacturer is None:
            raise
        return manufacturer


async def _write_filament(service, write, data, filament_id=None):
    payload = data.model_dump(exclude_unset=True)
    vendor = None
    if filament_id is None or "vendor_id" in payload:
        if filament_id is not None and await service.db.get(Filament, filament_id) is None:
            return None
        if data.vendor_id is None:
            vendor = await get_or_create_unknown_manufacturer(service.db)
            data = data.model_copy(update={"vendor_id": vendor.id})
        else:
            vendor = await service.db.get(Manufacturer, data.vendor_id)
            if vendor is None:
                raise HTTPException(status_code=404, detail="Vendor not found")

    temperatures = {key: payload[key] for key in _TEMPERATURES if key in payload}
    args = (data,) if filament_id is None else (filament_id, data)
    if not temperatures and vendor is None:
        return await write(service, *args)

    def apply_native_fields(session, _context, _instances):
        candidates = session.new if filament_id is None else session.dirty
        for filament in candidates:
            if not isinstance(filament, Filament) or (
                filament_id is not None and filament.id != filament_id
            ):
                continue
            if vendor is not None:
                filament.manufacturer = vendor
            if not temperatures:
                continue
            custom = dict(filament.custom_fields or {})
            for key, value in temperatures.items():
                native = _TEMPERATURES[key]
                current = _range_scalar(getattr(filament, native))
                # Echoing the displayed scalar must preserve the native range.
                if value is None or current is None or round(current) != value:
                    setattr(filament, native, None if value is None else {"min": value, "max": value})
                custom.pop(key, None)
            filament.custom_fields = custom or None

    # The ZIP owns its transaction and emits the response after committing.
    session = service.db.sync_session
    event.listen(session, "before_flush", apply_native_fields)
    try:
        return await write(service, *args)
    finally:
        event.remove(session, "before_flush", apply_native_fields)


def _flatten_wire_extras(wire: dict[str, str], nested: Any) -> None:
    if not isinstance(nested, dict):
        return
    wire.pop("spoolman_extra", None)
    collisions = {}
    for key, value in nested.items():
        if key == "spoolman_extra" or key in wire:
            collisions[key] = value
            continue
        # Imported Spoolman extras may already be encoded as JSON strings.
        if isinstance(value, str):
            try:
                json.loads(value)
            except ValueError:
                pass
            else:
                wire[key] = value
                continue
        wire[key] = json.dumps(value)
    if collisions:
        wire["spoolman_extra"] = json.dumps(collisions)


async def _project_download(db, rows, model):
    if not rows:
        return rows
    definitions = db.info.get("spoolman_definitions", {})
    by_id = {row["id"]: row for row in rows}
    query = select(model)
    if model is Spool:
        query = query.options(joinedload(Spool.filament))
    entities = await db.stream_scalars(query.execution_options(yield_per=500))
    try:
        async for entity in entities:
            row = by_id.get(entity.id)
            if row is None:
                continue
            if model is Filament:
                extra = FilamentCompatibilityView(entity, definitions.get("filament")).custom_fields
            elif entity.filament is not None:
                extra = project_extra(
                    entity, row["custom_fields"] or {}, filament=entity.filament,
                    system_definitions=definitions.get("spool"),
                )
            else:
                continue
            if extra:
                row["custom_fields"] = extra
    finally:
        await entities.close()
    return rows


def adapt_installed_spoolman(module: Any, plugin_key: str, manifest: dict) -> bool:
    """Adapt only the known v1 serializer interface; leave routes and queries owned by the plugin."""
    if plugin_key != "spoolmanapi":
        return False
    service = getattr(module, "SpoolmanService", None)
    version = manifest.get("version")
    uses_json_extras = version in _JSON_EXTRA_VERSIONS
    methods = {
        "_filament_to_schema": ["self", "filament"],
        "_spool_to_schema": ["self", "spool"],
    }
    if uses_json_extras:
        methods.update(
            create_filament=["self", "data"],
            update_filament=["self", "filament_id", "data"],
            export_filaments=["self"],
            export_spools=["self"],
            get_extra_fields=["self", "entity_type"],
        )
    supported = (
        (version == "1.0.0" or uses_json_extras)
        and isinstance(service, type)
        and service.__module__ == "spoolmanapi.service"
        and all(
            callable(getattr(service, method, None))
            and list(inspect.signature(getattr(service, method)).parameters) == parameters
            for method, parameters in methods.items()
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
        definitions = self.db.info.get("spoolman_definitions", {}).get("filament", {})
        view = FilamentCompatibilityView(filament, definitions)
        wire = original_filament(self, view)
        if uses_json_extras:
            _flatten_wire_extras(wire.extra, view.custom_fields.get("spoolman_extra"))
            for key in _NUMERIC_WIRE_FIELDS:
                value = _native_value(filament, _EXTRA_FIELDS[key])
                if value is not None:
                    wire.extra.setdefault(key, json.dumps(value))
        return wire

    @wraps(original_spool)
    def spool_to_schema(self, spool):
        wire = original_spool(self, spool)
        definitions = self.db.info.get("spoolman_definitions", {}).get("spool", {})
        # Ownership checks use stored values, while newer serializers require JSON strings.
        extra = (
            {key: json.loads(value) for key, value in wire.extra.items()}
            if uses_json_extras else wire.extra
        )
        projected = project_extra(
            spool, extra, filament=spool.filament, system_definitions=definitions
        )
        wire.extra = (
            {key: json.dumps(value) for key, value in projected.items()}
            if uses_json_extras else projected
        )
        if uses_json_extras:
            _flatten_wire_extras(wire.extra, projected.get("spoolman_extra"))
        return wire

    for route in module.router.routes:
        if isinstance(route, APIRoute):
            route.dependencies.append(Depends(_load_system_definition_context))
    service._filament_to_schema = filament_to_schema
    service._spool_to_schema = spool_to_schema
    if uses_json_extras:
        original_create = service.create_filament
        original_update = service.update_filament
        original_export_filaments = service.export_filaments
        original_export_spools = service.export_spools
        original_get_extra_fields = service.get_extra_fields

        @wraps(original_create)
        async def create_filament(self, data):
            return await _write_filament(self, original_create, data)

        @wraps(original_update)
        async def update_filament(self, filament_id, data):
            return await _write_filament(self, original_update, data, filament_id)

        @wraps(original_export_filaments)
        async def export_filaments(self):
            return await _project_download(self.db, await original_export_filaments(self), Filament)

        @wraps(original_export_spools)
        async def export_spools(self):
            return await _project_download(self.db, await original_export_spools(self), Spool)

        @wraps(original_get_extra_fields)
        async def get_extra_fields(self, entity_type):
            fields = await original_get_extra_fields(self, entity_type)
            if entity_type == "filament":
                # Stable names let the importer identify a native field across old aliases.
                fields = [*fields, *(
                    {"key": key, "name": name, "entity_type": "filament", "field_type": "float"}
                    for key, name in _NUMERIC_WIRE_FIELDS.items()
                )]
            return fields

        service.create_filament = create_filament
        service.update_filament = update_filament
        service.export_filaments = export_filaments
        service.export_spools = export_spools
        service.get_extra_fields = get_extra_fields
    service._filaman_projection = True
    return True
