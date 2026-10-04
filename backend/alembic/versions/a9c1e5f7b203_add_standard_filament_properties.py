"""Add standard filament properties and migrate legacy values.

Revision ID: a9c1e5f7b203
Revises: f3c7a1e9d204
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlparse

import sqlalchemy as sa

from alembic import op

revision: str = "a9c1e5f7b203"
down_revision: str | Sequence[str] | None = "f3c7a1e9d204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ALIASES = {
    "extruder": (
        "extruder",
        "settings_extruder_temp",
        "nozzle_temperature",
        "extruder_temp",
        "nozzle_temp",
        "print_temp",
    ),
    "bed": ("bed", "settings_bed_temp", "bed_temp", "heatbed_temp", "temp_bed"),
}
_PAIRS = {
    "extruder": (("temp_nozzle_min", "temp_nozzle_max"), ("min_temp", "max_temp")),
    "bed": (),
}
_PLUGIN_MIGRATION_KEYS = {
    "nozzle_temperature",
    "settings_bed_temp",
    "settings_extruder_temp",
}
_FILAMENTDB_NUMBER_FIELDS = {
    "dry_temp": "drying_temp_c",
    "dry_time_hours": "drying_time_hours",
    "softening_temp": "softening_temp_c",
    "chamber_temp": "chamber_temp_c",
    "max_volumetric_speed": "max_volumetric_speed_mm3_s",
    "flow_ratio": "flow_ratio",
    "k_value": "pressure_advance_k",
}
_STANDARD_NUMBER_LABELS = {
    "drying_temp_c": {"dryingtemperature", "drytemp"},
    "drying_time_hours": {"dryingtime", "dryingtimehours", "drytime"},
    "softening_temp_c": {"softeningtemperature", "softeningtemp"},
    "chamber_temp_c": {"chambertemperature", "chambertemp"},
    "max_volumetric_speed_mm3_s": {"maxvolumetricspeed"},
    "flow_ratio": {"flowratio"},
    "pressure_advance_k": {"pressureadvance", "pressureadvancek", "kvalue"},
}
_STANDARD_RANGE_LABELS = {
    "cooling_fan_range_percent": {"coolingfanspeed", "coolingfanrange", "fanspeed"}
}
_STANDARD_FIELD_LABELS = {
    "manufacturer_sku": {"manufacturersku", "sku"},
    "datasheet_url": {"datasheet", "datasheeturl"},
    "image_url": {"imageurl", "filamentimageurl"},
    "is_discontinued": {"discontinued", "isdiscontinued"},
    "ams_compatibility": {"amscompatibility", "amscompatible"},
    "build_plate_compatibility": {
        "buildplatecompatibility",
        "buildplates",
    },
    "price_currency": {"currency", "pricecurrency"},
}
_STANDARD_FIELD_TYPES = {
    "manufacturer_sku": {"text", "dropdown"},
    "datasheet_url": {"url", "text"},
    "image_url": {"url", "text"},
    "is_discontinued": {"checkbox"},
    "ams_compatibility": {"multiselect", "text", "dropdown"},
    "build_plate_compatibility": {"multiselect", "text", "dropdown"},
    "price_currency": {"text", "dropdown"},
}
_STANDARD_UNITS = {
    "extruder": {"°c", "c", "celsius"},
    "bed": {"°c", "c", "celsius"},
    "drying_temp_c": {"°c", "c", "celsius"},
    "softening_temp_c": {"°c", "c", "celsius"},
    "chamber_temp_c": {"°c", "c", "celsius"},
    "drying_time_hours": {"h", "hr", "hrs", "hour", "hours"},
    "cooling_fan_range_percent": {"%", "percent"},
    "max_volumetric_speed_mm3_s": {"mm³/s", "mm3/s", "mm^3/s"},
    "flow_ratio": {"ratio"},
    "pressure_advance_k": {"k"},
}
_DIRECT_NUMERIC_TYPES = {"number", "float", "integer"}
_DOWNGRADE_FIELDS = {
    "extruder_temp_range_c": ("Extruder temperature", "range", "°C"),
    "bed_temp_range_c": ("Bed temperature", "range", "°C"),
    "manufacturer_sku": ("Manufacturer SKU", "text", None),
    "datasheet_url": ("Datasheet URL", "url", None),
    "image_url": ("Image URL", "url", None),
    "is_discontinued": ("Discontinued", "checkbox", None),
    "drying_temp_c": ("Drying temperature", "number", "°C"),
    "drying_time_hours": ("Drying time", "number", "h"),
    "softening_temp_c": ("Softening temperature", "number", "°C"),
    "cooling_fan_range_percent": ("Cooling fan", "range", "%"),
    "chamber_temp_c": ("Chamber temperature", "number", "°C"),
    "max_volumetric_speed_mm3_s": ("Max volumetric speed", "number", "mm³/s"),
    "flow_ratio": ("Flow ratio", "number", None),
    "pressure_advance_k": ("Pressure advance (K)", "number", None),
    "ams_compatibility": ("AMS compatibility", "multiselect", None),
    "build_plate_compatibility": ("Build plate compatibility", "multiselect", None),
    "price_currency": ("Price currency", "text", None),
}
_LABELS = {
    "extruder": {
        "extruder",
        "extrudertemperature",
        "extrudertemp",
        "nozzle",
        "nozzletemperature",
        "nozzletemp",
        "printingtemperature",
        "printtemperature",
        "printtemp",
        "hotendtemperature",
        "hotendtemp",
    },
    "bed": {
        "bed",
        "bedtemperature",
        "bedtemp",
        "heatbedtemperature",
        "heatbedtemp",
        "heatedbedtemperature",
        "heatedbedtemp",
        "buildplatetemperature",
        "buildplatetemp",
    },
}


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        try:
            return value if math.isfinite(value) else None
        except OverflowError:
            return None
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        if not math.isfinite(parsed):
            return None
        return int(parsed) if parsed.is_integer() else parsed
    return None


def _range(value: Any) -> dict[str, int | float | None] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            pass
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float | str):
        scalar = _number(value)
        endpoints = (scalar, scalar)
    elif isinstance(value, list) and len(value) == 2:
        endpoints = (_number(value[0]), _number(value[1]))
        if value[0] is not None and endpoints[0] is None:
            return None
        if value[1] is not None and endpoints[1] is None:
            return None
    elif isinstance(value, dict) and set(value) <= {"min", "max"}:
        endpoints = (_number(value.get("min")), _number(value.get("max")))
        if value.get("min") is not None and endpoints[0] is None:
            return None
        if value.get("max") is not None and endpoints[1] is None:
            return None
    else:
        return None
    if endpoints == (None, None):
        return None
    if (
        endpoints[0] is not None
        and endpoints[1] is not None
        and endpoints[0] > endpoints[1]
    ):
        return None
    return {"min": endpoints[0], "max": endpoints[1]}


def _percentage_range(value: Any) -> dict[str, int | float | None] | None:
    normalized = _range(value)
    if normalized is None or any(
        endpoint is not None and not 0 <= endpoint <= 100
        for endpoint in normalized.values()
    ):
        return None
    return normalized


def _text(value: Any, max_length: int | None = None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    return normalized if max_length is None or len(normalized) <= max_length else None


def _url(value: Any) -> str | None:
    normalized = _text(value, 500)
    if normalized is None:
        return None
    try:
        parsed = urlparse(normalized)
    except ValueError:
        return None
    return normalized if parsed.scheme in {"http", "https"} and parsed.netloc else None


def _boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        return value.strip().lower() == "true"
    return None


def _string_list(value: Any) -> list[str] | None:
    if isinstance(value, str):
        items = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        items = [item.strip() for item in value if item.strip()]
    else:
        return None
    return items or None


def _currency(value: Any) -> str | None:
    normalized = _text(value)
    if normalized is None:
        return None
    normalized = normalized.upper()
    return (
        normalized
        if len(normalized) == 3 and normalized.isascii() and normalized.isalpha()
        else None
    )


def _standard_value(target: str, value: Any) -> Any:
    if target == "cooling_fan_range_percent":
        return _percentage_range(value)
    if target in _STANDARD_NUMBER_LABELS:
        return _number(value)
    if target in {"datasheet_url", "image_url"}:
        return _url(value)
    if target == "is_discontinued":
        return _boolean(value)
    if target in {"ams_compatibility", "build_plate_compatibility"}:
        return _string_list(value)
    if target == "price_currency":
        return _currency(value)
    return _text(value, 255)


def _compatible_unit(target: str, config: Any) -> bool:
    unit = config.get("unit") if isinstance(config, dict) else None
    if unit is None or unit == "":
        return True
    return isinstance(unit, str) and unit.strip().lower() in _STANDARD_UNITS.get(
        target, set()
    )


def _decoded_spoolman_value(value: Any, target: str) -> Any:
    if not isinstance(value, str):
        return value
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return value
    if target in {"manufacturer_sku", "datasheet_url", "image_url", "price_currency"}:
        return decoded if isinstance(decoded, str) else value
    return decoded


def _find_value(
    custom: dict[str, Any], kind: str, aliases: dict[str, list[str]]
) -> tuple[
    dict[str, int | float | None] | None,
    tuple[tuple[str, ...], ...] | None,
    bool,
]:
    candidates: list[tuple[dict[str, int | float | None] | None, tuple[str, ...]]] = []

    def collect(container: dict[str, Any], prefix: tuple[str, ...] = ()) -> None:
        for minimum, maximum in _PAIRS[kind]:
            present = tuple(key for key in (minimum, maximum) if key in container)
            if present:
                candidates.append(
                    (
                        _range(
                            {
                                "min": container.get(minimum),
                                "max": container.get(maximum),
                            }
                        ),
                        (*prefix, *present),
                    )
                )
        for key in aliases[kind]:
            if key in container:
                candidates.append((_range(container[key]), (*prefix, key)))

    collect(custom)
    nested = custom.get("spoolman_extra")
    if isinstance(nested, dict):
        collect(nested, ("spoolman_extra",))

    if not candidates:
        return None, None, False
    if any(value is None for value, _ in candidates):
        return None, None, True
    distinct = {json.dumps(value, sort_keys=True) for value, _ in candidates}
    if len(distinct) != 1:
        return None, None, True
    return candidates[0][0], tuple(source for _, source in candidates), True


def _remove_source(
    custom: dict[str, Any],
    definitions: dict[str, Any],
    source: tuple[str, ...],
) -> None:
    if source[-1] in _PLUGIN_MIGRATION_KEYS:
        definitions.pop(source[-1], None)
        return
    if source[0] == "spoolman_extra":
        nested = dict(custom.get("spoolman_extra") or {})
        for key in source[1:]:
            nested.pop(key, None)
        if nested:
            custom["spoolman_extra"] = nested
        else:
            custom.pop("spoolman_extra", None)
        return
    for key in source:
        custom.pop(key, None)
        definitions.pop(key, None)


def _promote_filamentdb_fields(
    custom: dict[str, Any],
    definitions: dict[str, Any],
    system_aliases: dict[str, str],
    blocked_sources: set[str],
) -> dict[str, Any]:
    values: dict[str, Any] = {}
    candidates: dict[str, list[tuple[Any, tuple[str, ...]]]] = defaultdict(list)
    nested = custom.get("spoolman_extra")

    def direct_allowed(source: str, target: str) -> bool:
        definition = definitions.get(source)
        config = definition.get("config") if isinstance(definition, dict) else None
        field_type = definition.get("field_type") if isinstance(definition, dict) else None
        allowed_types = (
            _DIRECT_NUMERIC_TYPES
            if target in _STANDARD_NUMBER_LABELS
            or target == "cooling_fan_range_percent"
            else _STANDARD_FIELD_TYPES.get(target)
        )
        return (
            source not in blocked_sources
            and system_aliases.get(source, target) == target
            and _compatible_unit(target, config)
            and (field_type is None or field_type in (allowed_types or set()))
        )

    if "sku" in custom and direct_allowed("sku", "manufacturer_sku"):
        candidates["manufacturer_sku"].append(
            (_text(custom["sku"], 255), ("sku",))
        )
    if isinstance(nested, dict) and "sku" in nested and direct_allowed(
        "sku", "manufacturer_sku"
    ):
        candidates["manufacturer_sku"].append(
            (
                _text(_decoded_spoolman_value(nested["sku"], "manufacturer_sku"), 255),
                ("spoolman_extra", "sku"),
            )
        )

    for source, target in _FILAMENTDB_NUMBER_FIELDS.items():
        if source in custom and direct_allowed(source, target):
            candidates[target].append((_number(custom[source]), (source,)))
        if isinstance(nested, dict) and source in nested and direct_allowed(source, target):
            candidates[target].append(
                (_number(nested[source]), ("spoolman_extra", source))
            )

    fan_keys = tuple(key for key in ("fan_speed_min", "fan_speed_max") if key in custom)
    if fan_keys and all(
        direct_allowed(key, "cooling_fan_range_percent") for key in fan_keys
    ):
        candidates["cooling_fan_range_percent"].append(
            (
                _percentage_range(
                    {
                        "min": custom.get("fan_speed_min"),
                        "max": custom.get("fan_speed_max"),
                    }
                ),
                fan_keys,
            )
        )
    if isinstance(nested, dict):
        nested_fan_keys = tuple(
            key for key in ("fan_speed_min", "fan_speed_max") if key in nested
        )
        if nested_fan_keys and all(
            direct_allowed(key, "cooling_fan_range_percent")
            for key in nested_fan_keys
        ):
            candidates["cooling_fan_range_percent"].append(
                (
                    _percentage_range(
                        {
                            "min": nested.get("fan_speed_min"),
                            "max": nested.get("fan_speed_max"),
                        }
                    ),
                    ("spoolman_extra", *nested_fan_keys),
                )
            )

    for source, target in system_aliases.items():
        if source in custom:
            candidates[target].append(
                (_standard_value(target, custom[source]), (source,))
            )
        if isinstance(nested, dict) and source in nested:
            candidates[target].append(
                (
                    _standard_value(target, _decoded_spoolman_value(nested[source], target)),
                    ("spoolman_extra", source),
                )
            )

    for target, target_candidates in candidates.items():
        if any(value is None for value, _ in target_candidates):
            continue
        distinct = {
            json.dumps(value, sort_keys=True) for value, _ in target_candidates
        }
        if len(distinct) != 1:
            continue
        values[target] = target_candidates[0][0]
        for _, source in target_candidates:
            _remove_source(custom, definitions, source)
    return values


def _clean_system_definitions(
    connection: sa.Connection,
    system_fields: sa.Table,
    filaments: sa.Table,
    spools: sa.Table,
    aliases: dict[str, list[str]],
    promoted_sources: set[tuple[str, int, str]],
    extra_keys: set[str],
) -> None:
    temperature_keys = (
        set().union(*aliases.values())
        | {key for pairs in _PAIRS.values() for pair in pairs for key in pair}
    )
    filament_keys = (
        extra_keys
        | set(_FILAMENTDB_NUMBER_FIELDS)
        | {"sku", "fan_speed_min", "fan_speed_max"}
    )
    for field in connection.execute(sa.select(system_fields)).mappings():
        if field["target_type"] not in {
            "filament",
            "spool",
        }:
            continue
        recognized = temperature_keys | (
            filament_keys if field["target_type"] == "filament" else set()
        )
        if field["key"] not in recognized:
            continue
        table = filaments if field["target_type"] == "filament" else spools
        still_used = any(
            isinstance(row.custom_fields, dict)
            and (
                field["key"] in row.custom_fields
                or (
                    isinstance(row.custom_fields.get("spoolman_extra"), dict)
                    and field["key"] in row.custom_fields["spoolman_extra"]
                )
            )
            and (field["target_type"], row.id, field["key"]) not in promoted_sources
            for row in connection.execute(sa.select(table.c.id, table.c.custom_fields))
        )
        if not still_used:
            connection.execute(
                system_fields.delete().where(system_fields.c.id == field["id"])
            )


def upgrade() -> None:
    op.add_column(
        "filaments", sa.Column("extruder_temp_range_c", sa.JSON(), nullable=True)
    )
    op.add_column("filaments", sa.Column("bed_temp_range_c", sa.JSON(), nullable=True))
    op.add_column(
        "filaments", sa.Column("manufacturer_sku", sa.String(255), nullable=True)
    )
    op.add_column(
        "filaments", sa.Column("datasheet_url", sa.String(500), nullable=True)
    )
    op.add_column("filaments", sa.Column("image_url", sa.String(500), nullable=True))
    op.add_column(
        "filaments",
        sa.Column(
            "is_discontinued",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column("filaments", sa.Column("drying_temp_c", sa.Float(), nullable=True))
    op.add_column(
        "filaments", sa.Column("drying_time_hours", sa.Float(), nullable=True)
    )
    op.add_column("filaments", sa.Column("softening_temp_c", sa.Float(), nullable=True))
    op.add_column(
        "filaments",
        sa.Column("cooling_fan_range_percent", sa.JSON(), nullable=True),
    )
    op.add_column("filaments", sa.Column("chamber_temp_c", sa.Float(), nullable=True))
    op.add_column(
        "filaments",
        sa.Column("max_volumetric_speed_mm3_s", sa.Float(), nullable=True),
    )
    op.add_column("filaments", sa.Column("flow_ratio", sa.Float(), nullable=True))
    op.add_column(
        "filaments", sa.Column("pressure_advance_k", sa.Float(), nullable=True)
    )
    op.add_column("filaments", sa.Column("ams_compatibility", sa.JSON(), nullable=True))
    op.add_column(
        "filaments",
        sa.Column("build_plate_compatibility", sa.JSON(), nullable=True),
    )
    op.add_column("filaments", sa.Column("price_currency", sa.String(3), nullable=True))

    connection = op.get_bind()
    filaments = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
    spools = sa.Table("spools", sa.MetaData(), autoload_with=connection)
    system_fields = sa.Table(
        "system_extra_fields", sa.MetaData(), autoload_with=connection
    )
    system_rows = list(connection.execute(sa.select(system_fields)).mappings())
    aliases_by_target = {
        target: {kind: list(values) for kind, values in _ALIASES.items()}
        for target in ("filament", "spool")
    }
    standard_system_aliases: dict[str, str] = {}
    blocked_system_aliases = {target: set() for target in aliases_by_target}
    for field in system_rows:
        if field["target_type"] not in aliases_by_target:
            continue
        direct_target = _FILAMENTDB_NUMBER_FIELDS.get(field["key"])
        if field["key"] == "sku":
            direct_target = "manufacturer_sku"
        elif field["key"] in {"fan_speed_min", "fan_speed_max"}:
            direct_target = "cooling_fan_range_percent"
        if field["target_type"] == "filament" and direct_target is not None:
            direct_types = (
                _DIRECT_NUMERIC_TYPES
                if direct_target in _STANDARD_NUMBER_LABELS
                or direct_target == "cooling_fan_range_percent"
                else _STANDARD_FIELD_TYPES.get(direct_target, set())
            )
            if field["field_type"] not in direct_types or not _compatible_unit(
                direct_target, field.get("config")
            ):
                blocked_system_aliases["filament"].add(field["key"])
                continue
        numeric_type = field["field_type"] in {
            "range",
            "number",
            "float",
            "integer",
            "float_range",
            "integer_range",
        }
        names = {
            "".join(char for char in str(field[value]).lower() if char.isalnum())
            for value in ("key", "label")
        }
        potential: set[tuple[str, str]] = set()
        if numeric_type:
            potential.update(
                ("temperature", kind)
                for kind, labels in _LABELS.items()
                if names & labels
            )
        if field["target_type"] == "filament":
            for target, labels in {
                **_STANDARD_NUMBER_LABELS,
                **_STANDARD_RANGE_LABELS,
                **_STANDARD_FIELD_LABELS,
            }.items():
                allowed_types = _STANDARD_FIELD_TYPES.get(target)
                if names & labels and (
                    (allowed_types is None and numeric_type)
                    or (
                        allowed_types is not None
                        and field["field_type"] in allowed_types
                    )
                ):
                    potential.add(("standard", target))
        matches = {
            (match_type, target)
            for match_type, target in potential
            if _compatible_unit(target, field.get("config"))
        }
        if len(matches) != 1:
            if potential:
                blocked_system_aliases[field["target_type"]].add(field["key"])
            continue
        match_type, target = matches.pop()
        if match_type == "temperature":
            aliases_by_target[field["target_type"]][target].append(field["key"])
        else:
            standard_system_aliases[field["key"]] = target

    for target, blocked in blocked_system_aliases.items():
        for kind, aliases in aliases_by_target[target].items():
            aliases_by_target[target][kind] = [
                alias for alias in aliases if alias not in blocked
            ]
    blocked_fallback: dict[int, set[str]] = defaultdict(set)
    promoted_sources: set[tuple[str, int, str]] = set()

    for row in connection.execute(sa.select(filaments)).mappings():
        custom = dict(row["custom_fields"] or {})
        definitions = dict(row["custom_field_definitions"] or {})
        values = _promote_filamentdb_fields(
            custom,
            definitions,
            standard_system_aliases,
            blocked_system_aliases["filament"],
        )
        for kind, column in (
            ("extruder", "extruder_temp_range_c"),
            ("bed", "bed_temp_range_c"),
        ):
            normalized, sources, saw_value = _find_value(
                custom, kind, aliases_by_target["filament"]
            )
            if saw_value:
                blocked_fallback[row["id"]].add(kind)
            if normalized is not None and sources is not None:
                values[column] = normalized
                for source in sources:
                    if source[-1] in _PLUGIN_MIGRATION_KEYS:
                        promoted_sources.add(("filament", row["id"], source[-1]))
                    _remove_source(custom, definitions, source)
        if values:
            values["custom_fields"] = custom or None
            values["custom_field_definitions"] = definitions or None
            connection.execute(
                filaments.update().where(filaments.c.id == row["id"]).values(**values)
            )

    spool_candidates: dict[
        tuple[int, str],
        list[
            tuple[
                int,
                dict[str, int | float | None],
                tuple[tuple[str, ...], ...],
            ]
        ],
    ] = defaultdict(list)
    spool_blocked: set[tuple[int, str]] = set()
    spool_rows: dict[int, dict[str, Any]] = {}
    for row in connection.execute(sa.select(spools)).mappings():
        spool_rows[row["id"]] = dict(row)
        custom = dict(row["custom_fields"] or {})
        for kind in ("extruder", "bed"):
            normalized, sources, saw_value = _find_value(
                custom, kind, aliases_by_target["spool"]
            )
            if saw_value and normalized is None:
                spool_blocked.add((row["filament_id"], kind))
            if normalized is not None and sources is not None:
                spool_candidates[(row["filament_id"], kind)].append(
                    (row["id"], normalized, sources)
                )

    for (filament_id, kind), candidates in spool_candidates.items():
        if (
            kind in blocked_fallback[filament_id]
            or (filament_id, kind) in spool_blocked
        ):
            continue
        distinct = {json.dumps(value, sort_keys=True) for _, value, _ in candidates}
        if len(distinct) != 1:
            continue
        value = candidates[0][1]
        column = (
            filaments.c.extruder_temp_range_c
            if kind == "extruder"
            else filaments.c.bed_temp_range_c
        )
        connection.execute(
            filaments.update()
            .where(filaments.c.id == filament_id)
            .values({column.key: value})
        )
        for spool_id, _, sources in candidates:
            row = spool_rows[spool_id]
            custom = dict(row["custom_fields"] or {})
            definitions = dict(row["custom_field_definitions"] or {})
            for source in sources:
                if source[-1] in _PLUGIN_MIGRATION_KEYS:
                    promoted_sources.add(("spool", spool_id, source[-1]))
                _remove_source(custom, definitions, source)
            connection.execute(
                spools.update()
                .where(spools.c.id == spool_id)
                .values(
                    custom_fields=custom or None,
                    custom_field_definitions=definitions or None,
                )
            )
            row["custom_fields"] = custom or None
            row["custom_field_definitions"] = definitions or None

    combined_aliases = {
        kind: list(
            set(aliases_by_target["filament"][kind])
            | set(aliases_by_target["spool"][kind])
        )
        for kind in _ALIASES
    }
    _clean_system_definitions(
        connection,
        system_fields,
        filaments,
        spools,
        combined_aliases,
        promoted_sources,
        set(standard_system_aliases),
    )


def downgrade() -> None:
    connection = op.get_bind()
    filaments = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
    for row in connection.execute(sa.select(filaments)).mappings():
        custom = dict(row["custom_fields"] or {})
        definitions = dict(row["custom_field_definitions"] or {})
        changed = False
        for column, (label, field_type, unit) in _DOWNGRADE_FIELDS.items():
            value = row[column]
            if value is None or (column == "is_discontinued" and value is False):
                continue
            key = column
            suffix = 2
            while key in custom:
                key = f"{column}_{suffix}"
                suffix += 1
            custom[key] = value
            definition = {"label": label, "field_type": field_type}
            if unit:
                definition["config"] = {"unit": unit}
            definitions[key] = definition
            changed = True
        if changed:
            connection.execute(
                filaments.update()
                .where(filaments.c.id == row["id"])
                .values(
                    custom_fields=custom,
                    custom_field_definitions=definitions,
                )
            )

    op.drop_column("filaments", "price_currency")
    op.drop_column("filaments", "build_plate_compatibility")
    op.drop_column("filaments", "ams_compatibility")
    op.drop_column("filaments", "pressure_advance_k")
    op.drop_column("filaments", "flow_ratio")
    op.drop_column("filaments", "max_volumetric_speed_mm3_s")
    op.drop_column("filaments", "chamber_temp_c")
    op.drop_column("filaments", "cooling_fan_range_percent")
    op.drop_column("filaments", "softening_temp_c")
    op.drop_column("filaments", "drying_time_hours")
    op.drop_column("filaments", "drying_temp_c")
    op.drop_column("filaments", "is_discontinued")
    op.drop_column("filaments", "image_url")
    op.drop_column("filaments", "datasheet_url")
    op.drop_column("filaments", "manufacturer_sku")
    op.drop_column("filaments", "bed_temp_range_c")
    op.drop_column("filaments", "extruder_temp_range_c")
