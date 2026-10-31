import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "a9c1e5f7b203_add_standard_filament_properties.py"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location(
        "filament_temperature_migration", MIGRATION_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_schema():
    """Shared metadata-test schema; distinct older schema variants stay explicit."""
    metadata = sa.MetaData()
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    spools = sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("filament_id", sa.Integer),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    system_fields = sa.Table(
        "system_extra_fields",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("target_type", sa.String),
        sa.Column("key", sa.String),
        sa.Column("label", sa.String),
        sa.Column("field_type", sa.String),
        sa.Column("config", sa.JSON),
    )
    return metadata, filaments, spools, system_fields



def label_aliases(aliases):
    """Assert the label contract independently of added wire provenance."""
    if aliases is None:
        return None
    result = {}
    for path, alias in aliases.items():
        if isinstance(alias, dict):
            alias = {key: value for key, value in alias.items() if key != 'wire'}
            if set(alias) == {'target'}:
                alias = alias['target']
        result[path] = alias
    return result


def test_ambiguous_system_keys_are_not_promoted_by_direct_fallback():
    migration = load_migration_module()
    custom = {
        "flow_ratio": 10,
        "fan_speed_min": 20,
        "fan_speed_max": 70,
    }
    values = migration._promote_filamentdb_fields(
        custom,
        {},
        {},
        {"flow_ratio", "fan_speed_min"},
    )

    assert values == {}
    assert custom == {"flow_ratio": 10, "fan_speed_min": 20, "fan_speed_max": 70}


def test_label_alias_uses_the_resolved_target_not_an_endpoint_like_key():
    migration = load_migration_module()
    values = migration._promote_filamentdb_fields(
        {"min_temp": "SKU-42"}, {}, {"min_temp": "manufacturer_sku"}, set()
    )
    assert values["manufacturer_sku"] == "SKU-42"
    assert label_aliases(values["label_field_aliases"]) == {"min_temp": "manufacturer_sku"}


@pytest.mark.parametrize(
    "key,label,field_type,config",
    [
        ("bed", "Bed surface notes", "text", None),
        ("dry_temp", "Drying temperature", "number", {"unit": "°F"}),
        ("dry_temp", "Drying temperature", "range", {"unit": "°C"}),
        ("flow_ratio", "Flow ratio", "range", None),
        ("spoolman_extra.fan_speed_min", "Fan speed", "range", {"unit": "%"}),
        ("spoolman_extra.dry_temp", "Drying temperature", "range", {"unit": "°C"}),
    ],
)
def test_upgrade_keeps_incompatible_unused_system_fields(key, label, field_type, config):
    engine = sa.create_engine("sqlite://")
    metadata, _, _, system_fields = legacy_schema()
    with engine.begin() as connection:
        metadata.create_all(connection)
        field = {
            "id": 1,
            "target_type": "filament",
            "key": key,
            "label": label,
            "field_type": field_type,
            "config": config,
        }
        connection.execute(system_fields.insert(), field)
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(sa.select(system_fields)).mappings().one() == field


@pytest.mark.parametrize("default_value", ["55", "0"])
def test_upgrade_preserves_system_defaults_without_native_replacement(default_value):
    engine = sa.create_engine("sqlite://")
    metadata, filaments, _, system_fields = legacy_schema()
    system_fields.append_column(sa.Column("default_value", sa.String(500)))
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {"id": 1})
        field = {
            "id": 1, "target_type": "filament", "key": "dry_temp",
            "label": "Drying temperature", "field_type": "number",
            "config": {"unit": "°C"}, "default_value": default_value,
        }
        connection.execute(system_fields.insert(), field)
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(sa.select(system_fields)).mappings().one_or_none() == field
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        assert connection.execute(sa.select(upgraded.c.drying_temp_c)).scalar_one() is None


@pytest.mark.parametrize("temperature_target", ["filament", "spool"])
def test_upgrade_keeps_unrelated_same_key_on_other_entity(temperature_target):
    engine = sa.create_engine("sqlite://")
    metadata, _, _, system_fields = legacy_schema()
    other_target = "spool" if temperature_target == "filament" else "filament"
    with engine.begin() as connection:
        metadata.create_all(connection)
        fields = [
            {"id": 1, "target_type": temperature_target, "key": "process",
             "label": "Extruder temperature", "field_type": "number", "config": None},
            {"id": 2, "target_type": other_target, "key": "process",
             "label": "Shipping cost", "field_type": "number", "config": None},
        ]
        connection.execute(system_fields.insert(), fields)
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(sa.select(system_fields)).mappings().all() == [fields[1]]


@pytest.mark.parametrize("system", [False, True], ids=["local", "system"])
def test_upgrade_keeps_label_format_and_downgrade_restores_it(system):
    engine = sa.create_engine("sqlite://")
    metadata, filaments, _, system_fields = legacy_schema()
    definition = {"label": "Drying temperature", "field_type": "number",
                  "config": {"unit": "°C", "decimal_places": 1}}
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {
            "id": 1, "custom_fields": {"dry_temp": 55},
            "custom_field_definitions": None if system else {"dry_temp": definition},
        })
        if system:
            connection.execute(system_fields.insert(), {
                "id": 1, "target_type": "filament", "key": "dry_temp", **definition,
            })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row["custom_fields"] is None
        assert label_aliases(row["label_field_aliases"]) == {
            "dry_temp": {"target": "drying_temp_c", "definition": definition},
        }
        connection.execute(upgraded.update().values(drying_temp_c=65))
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(restored)).mappings().one()
        assert row["custom_fields"]["dry_temp"] == 65
        assert row["custom_field_definitions"]["dry_temp"] == definition


def test_preserving_label_formats_is_idempotent_for_multi_setting_spools():
    migration = load_migration_module()
    definition = {"field_type": "number", "config": {"unit": "°C"}}
    aliases = {"temp_nozzle_min": "extruder_temp_range_c.min"}
    definitions = {"temp_nozzle_min": definition}
    migration._preserve_label_formats(aliases, definitions, {})
    expected = {"temp_nozzle_min": {"target": "extruder_temp_range_c.min", "definition": definition}}
    assert aliases == expected
    migration._preserve_label_formats(aliases, definitions, {})
    assert aliases == expected


@pytest.mark.parametrize("system", [False, True], ids=["local", "system"])
@pytest.mark.parametrize("source,column", [("dry_temp", "drying_temp_c"), ("settings_extruder_temp", "extruder_temp_range_c")])
@pytest.mark.parametrize("field_type,unit,value,valid", [
    ("number", "°C", 130, True), ("number", "°F", 130, False),
    ("text", "°C", 130, False), ("number", "°C", "Unavailable", False),
])
def test_upgrade_respects_qualified_nested_metadata(system, source, column, field_type, unit, value, valid):
    engine = sa.create_engine("sqlite://")
    metadata, filaments, _, system_fields = legacy_schema()
    key = f"spoolman_extra.{source}"
    definition = {"label": "Drying temperature" if source == "dry_temp" else "Extruder temperature",
                  "field_type": field_type, "config": {"unit": unit}}
    custom = {"spoolman_extra": {source: value}}
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {
            "id": 1, "custom_fields": custom,
            "custom_field_definitions": None if system else {key: definition},
        })
        if system:
            connection.execute(system_fields.insert(), {
                "id": 1, "target_type": "filament", "key": key, **definition,
            })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        expected = 130 if column == "drying_temp_c" else {"min": 130, "max": 130}
        assert row[column] == (expected if valid else None)
        if valid:
            assert row["custom_field_definitions"] is None
            assert row["label_field_aliases"][key]["definition"]["config"] == {"unit": unit}
        if not valid:
            assert row["custom_fields"] == custom
            if system:
                assert connection.execute(sa.select(system_fields.c.key)).scalars().all() == [key]
            else:
                assert row["custom_field_definitions"] == {key: definition}


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("source", ["dry_temp", "my_drying_temperature"])
@pytest.mark.parametrize(
    "field_type,unit,expected",
    [("text", "°C", None), ("number", "°F", None), ("number", "°C", 140)],
)
def test_upgrade_respects_local_metadata_for_system_aliases(
    monkeypatch, nested, source, field_type, unit, expected
):
    engine = sa.create_engine("sqlite://")
    metadata, filaments, _, system_fields = legacy_schema()
    custom = {"spoolman_extra": {source: 140}} if nested else {source: 140}
    definitions = {source: {"field_type": field_type, "config": {"unit": unit}}}
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert(),
            {"id": 1, "custom_fields": custom, "custom_field_definitions": definitions},
        )
        connection.execute(
            system_fields.insert(),
            {
                "id": 1,
                "target_type": "filament",
                "key": source,
                "label": "Drying temperature",
                "field_type": "number",
                "config": {"unit": "°C"},
            },
        )
        migration = load_migration_module()
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row["drying_temp_c"] == expected
        assert row["custom_fields"] == (custom if expected is None else None)
        assert row["custom_field_definitions"] == (
            definitions if expected is None or nested else None
        )
        prefix = "spoolman_extra." if nested else ""
        alias = "drying_temp_c" if nested else {
            "target": "drying_temp_c", "definition": {
                "label": "Drying temperature", "field_type": "number", "config": {"unit": "°C"},
            },
        }
        assert label_aliases(row["label_field_aliases"]) == (
            None if expected is None else {prefix + source: alias}
        )
        assert connection.execute(
            sa.select(sa.func.count()).select_from(system_fields)
        ).scalar_one() == (1 if expected is None else 0)


@pytest.mark.parametrize("nested", [False, True])
def test_conflicting_system_alias_values_are_preserved(nested):
    migration = load_migration_module()
    sources = {"dry_temp": 50, "my_drying_temperature": 60}
    custom = {"spoolman_extra": dict(sources)} if nested else dict(sources)
    definitions = {
        key: {"field_type": "number", "config": {"unit": "°C"}}
        for key in sources
    }
    values = migration._promote_filamentdb_fields(
        custom,
        definitions,
        {key: "drying_temp_c" for key in sources},
        set(),
    )
    assert values == {}
    assert custom == ({"spoolman_extra": sources} if nested else sources)
    assert set(definitions) == set(sources)


@pytest.mark.parametrize("target", ["filament", "spool"])
@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("local", [False, True])
@pytest.mark.parametrize(
    "custom,key,field_type,config,column,expected,fallback_value",
    [
        ({"bed": "140"}, "bed", "text", None, "bed_temp_range_c", None, 140),
        ({"bed": 140}, "bed", "number", {"unit": "°F"}, "bed_temp_range_c", None, 140),
        (
            {"temp_nozzle_min": 392},
            "temp_nozzle_min",
            "number",
            {"unit": "°F"},
            "extruder_temp_range_c",
            None,
            {"min": 392},
        ),
        (
            {"temp_nozzle_min": 200, "temp_nozzle_max": "220"},
            "temp_nozzle_max",
            "text",
            None,
            "extruder_temp_range_c",
            None,
            {"min": 200, "max": 220},
        ),
        (
            {"bed": 60},
            "bed",
            "number",
            {"unit": "°C"},
            "bed_temp_range_c",
            {"min": 60, "max": 60},
            60,
        ),
        (
            {"bed": {"min": 50, "max": 60}},
            "bed",
            "range",
            {"unit": "°C"},
            "bed_temp_range_c",
            {"min": 50, "max": 60},
            60,
        ),
        (
            {"temp_nozzle_min": 200, "temp_nozzle_max": 220},
            "temp_nozzle_max",
            "number",
            {"unit": "°C"},
            "extruder_temp_range_c",
            {"min": 200, "max": 220},
            210,
        ),
    ],
)
def test_upgrade_respects_system_temperature_metadata(
    tmp_path,
    monkeypatch,
    target,
    nested,
    local,
    custom,
    key,
    field_type,
    config,
    column,
    expected,
    fallback_value,
):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'system-temperatures.db'}")
    metadata, filaments, spools, system_fields = legacy_schema()
    raw = {"spoolman_extra": custom} if nested else custom
    local_definitions = {key: {"field_type": "range"}} if local else None
    fallback = (
        {"settings_bed_temp": fallback_value}
        if column == "bed_temp_range_c"
        else {"settings_extruder_temp": fallback_value}
    )
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert(),
            {
                "id": 1,
                "custom_fields": raw if target == "filament" else None,
                "custom_field_definitions": local_definitions
                if target == "filament"
                else None,
            },
        )
        connection.execute(
            spools.insert(),
            {
                "id": 1,
                "filament_id": 1,
                "custom_fields": raw if target == "spool" else fallback,
                "custom_field_definitions": local_definitions
                if target == "spool"
                else None,
            },
        )
        if target == "spool" and expected is None:
            connection.execute(
                spools.insert(),
                {
                    "id": 2,
                    "filament_id": 1,
                    "custom_fields": fallback,
                },
            )
        connection.execute(
            system_fields.insert(),
            {
                "id": 1,
                "target_type": target,
                "key": key,
                "label": key,
                "field_type": field_type,
                "config": config,
            },
        )
        connection.execute(
            system_fields.insert(),
            {
                "id": 2,
                "target_type": "spool" if target == "filament" else "filament",
                "key": key,
                "label": key,
                "field_type": "text",
                "config": None,
            },
        )
        migration = load_migration_module()
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row[column] == expected
        alias_table = sa.Table(
            "filaments" if target == "filament" else "spools",
            sa.MetaData(), autoload_with=connection,
        )
        aliases = connection.execute(
            sa.select(alias_table.c.label_field_aliases).where(alias_table.c.id == 1)
        ).scalar_one()
        if expected is None:
            assert not aliases
        else:
            prefix = "spoolman_extra." if nested else ""
            for source_key in custom:
                endpoint = (
                    ".min" if source_key == "temp_nozzle_min"
                    else ".max" if source_key == "temp_nozzle_max" else ""
                )
                expected_alias = column + endpoint
                if not nested and source_key == key and config:
                    if not endpoint and field_type == "number":
                        expected_alias += ".min"
                    expected_alias = {"target": expected_alias, "definition": {
                        "label": key, "field_type": field_type, "config": config,
                    }}
                assert label_aliases(aliases)[prefix + source_key] == expected_alias
        source_table = upgraded if target == "filament" else spools
        remaining = connection.execute(
            sa.select(source_table.c.custom_fields).where(source_table.c.id == 1)
        ).scalar_one()
        assert remaining == (raw if expected is None else None)
        assert connection.execute(
            sa.select(source_table.c.custom_field_definitions).where(
                source_table.c.id == 1
            )
        ).scalar_one() == (local_definitions if expected is None or nested else None)
        definitions = {
            definition["id"]: definition
            for definition in connection.execute(sa.select(system_fields)).mappings()
        }
        assert definitions[2]["field_type"] == "text"
        if expected is None:
            assert set(definitions) == {1, 2}
            assert definitions[1]["field_type"] == field_type
            assert definitions[1]["config"] == config
            assert (
                connection.execute(
                    sa.select(spools.c.custom_fields).where(
                        spools.c.id == (2 if target == "spool" else 1)
                    )
                ).scalar_one()
                == fallback
            )
        else:
            assert set(definitions) == {2}


def test_downgrade_preserves_standard_values_as_typed_custom_fields(
    tmp_path, monkeypatch
):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'rollback.db'}")
    metadata = sa.MetaData()
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("filament_id", sa.Integer, nullable=False),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    sa.Table(
        "system_extra_fields",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("target_type", sa.String(50), nullable=False),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("field_type", sa.String(30), nullable=False),
    )

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert().values(
                id=1,
                custom_fields={"keep": "yes", "min_temp": 200, "max_temp": 220, "extruder_temp": {"min": 200, "max": 220}},
                custom_field_definitions={
                    "keep": {"field_type": "text"},
                    "ams_compatibility": {"field_type": "text"},
                },
            )
        )
        migration = load_migration_module()
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        migration.upgrade()

        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        connection.execute(
            upgraded.update()
            .where(upgraded.c.id == 1)
            .values(
                extruder_temp_range_c={"min": 205, "max": 225},
                drying_temp_c=55,
                manufacturer_sku="PLA-42",
                ams_compatibility=["AMS", "AMS Lite"],
                build_plate_compatibility=[],
                is_discontinued=True,
            )
        )

        migration.downgrade()

        rolled_back = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(rolled_back)).one()
        assert row.custom_fields == {
            "keep": "yes",
            "min_temp": 205,
            "max_temp": 225,
            "extruder_temp": {"min": 205, "max": 225},
            "extruder_temp_range_c": {"min": 205, "max": 225},
            "manufacturer_sku": "PLA-42",
            "is_discontinued": True,
            "drying_temp_c": 55,
            "ams_compatibility_2": ["AMS", "AMS Lite"],
            "build_plate_compatibility": [],
        }
        assert row.custom_field_definitions == {
            "keep": {"field_type": "text"},
            **{key: {"label": "Extruder temperature", "field_type": "number", "config": {"unit": "°C"}}
               for key in ("min_temp", "max_temp")},
            "extruder_temp": {
                "label": "Extruder temperature", "field_type": "range", "config": {"unit": "°C"},
            },
            "extruder_temp_range_c": {
                "label": "Extruder temperature",
                "field_type": "range",
                "config": {"unit": "°C"},
            },
            "manufacturer_sku": {
                "label": "Manufacturer SKU",
                "field_type": "text",
            },
            "is_discontinued": {
                "label": "Discontinued",
                "field_type": "checkbox",
            },
            "drying_temp_c": {
                "label": "Drying temperature",
                "field_type": "number",
                "config": {"unit": "°C"},
            },
            "ams_compatibility": {"field_type": "text"},
            "ams_compatibility_2": {
                "label": "AMS compatibility",
                "field_type": "multiselect",
                "options": ["AMS", "AMS Lite"],
            },
        }
        from app.api.v1.schemas_entity_extra_field import EntityExtraFieldDefinitions
        from pydantic import TypeAdapter

        TypeAdapter(EntityExtraFieldDefinitions).validate_python(
            row.custom_field_definitions
        )
        from app.api.v1.schemas_filament import FilamentResponse

        response = FilamentResponse.model_validate(
            {
                **{
                    name: None
                    for name, field in FilamentResponse.model_fields.items()
                    if field.is_required()
                },
                "id": 1,
                "manufacturer_id": 1,
                "designation": "Rollback",
                "material_type": "PLA",
                "diameter_mm": 1.75,
                "color_mode": "single",
                "custom_fields": row.custom_fields,
                "custom_field_definitions": row.custom_field_definitions,
            }
        )
        assert response.custom_field_definitions["ams_compatibility_2"].options == [
            "AMS",
            "AMS Lite",
        ]


def test_upgrade_promotes_known_filament_and_spool_temperature_shapes(
    tmp_path, monkeypatch
):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    metadata = sa.MetaData()
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    spools = sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("filament_id", sa.Integer, nullable=False),
        sa.Column("custom_fields", sa.JSON),
        sa.Column("custom_field_definitions", sa.JSON),
    )
    system_fields = sa.Table(
        "system_extra_fields",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("target_type", sa.String(50), nullable=False),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("field_type", sa.String(30), nullable=False),
        sa.Column("config", sa.JSON),
    )

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert(),
            [
                {
                    "id": 1,
                    "custom_fields": {
                        "extruder": "[200,220]",
                        "bed": {"min": 55, "max": 65},
                        "keep": "yes",
                    },
                    "custom_field_definitions": {
                        "extruder": {"field_type": "range"},
                        "bed": {"field_type": "range"},
                        "keep": {"field_type": "text"},
                    },
                },
                {
                    "id": 2,
                    "custom_fields": {
                        "settings_extruder_temp": 210,
                        "sku": "PLA-42",
                        "dry_temp": 55,
                        "dry_time_hours": 6,
                        "softening_temp": 65,
                        "fan_speed_min": 40,
                        "fan_speed_max": 80,
                        "chamber_temp": 35,
                        "max_volumetric_speed": 18,
                        "flow_ratio": 0.97,
                        "k_value": 0.025,
                        "spoolman_extra": {
                            "heatbed_temp": "60",
                            "keep_nested": "yes",
                        },
                    },
                    "custom_field_definitions": {
                        "settings_extruder_temp": {"field_type": "number"}
                    },
                },
                {"id": 3, "custom_fields": None, "custom_field_definitions": None},
                {"id": 4, "custom_fields": None, "custom_field_definitions": None},
                {
                    "id": 5,
                    "custom_fields": {"bed": "hot"},
                    "custom_field_definitions": {"bed": {"field_type": "range"}},
                },
                {
                    "id": 6,
                    "custom_fields": {"my_print_range": [215, 235]},
                    "custom_field_definitions": {
                        "my_print_range": {"field_type": "range"}
                    },
                },
                {
                    "id": 7,
                    "custom_fields": {"settings_bed_temp": "hot"},
                    "custom_field_definitions": None,
                },
                {
                    "id": 8,
                    "custom_fields": {
                        "my_drying_temperature": "57",
                        "my_cooling_fan": [30, 90],
                    },
                    "custom_field_definitions": {
                        "my_drying_temperature": {"field_type": "number"},
                        "my_cooling_fan": {"field_type": "range"},
                    },
                },
                {
                    "id": 9,
                    "custom_fields": {"my_cooling_fan": [30, 120]},
                    "custom_field_definitions": {
                        "my_cooling_fan": {"field_type": "range"}
                    },
                },
                {
                    "id": 10,
                    "custom_fields": {"extruder": 200, "nozzle_temp": 220},
                    "custom_field_definitions": None,
                },
                {"id": 11, "custom_fields": None, "custom_field_definitions": None},
                {
                    "id": 12,
                    "custom_fields": {
                        "my_sku": "ABC-123",
                        "my_datasheet": "https://example.com/data.pdf",
                        "my_image": "https://example.com/image.png",
                        "my_discontinued": True,
                        "my_ams": ["ams", "ams-lite"],
                        "my_plates": "pei,textured-pei",
                        "my_currency": "usd",
                    },
                    "custom_field_definitions": None,
                },
                {
                    "id": 13,
                    "custom_fields": {"currency_a": "USD", "currency_b": "EUR"},
                    "custom_field_definitions": None,
                },
                {
                    "id": 14,
                    "custom_fields": {"sku": "DIRECT", "my_sku": "SYSTEM"},
                    "custom_field_definitions": None,
                },
                {
                    "id": 15,
                    "custom_fields": {"image_url": "https://example.com/ambiguous"},
                    "custom_field_definitions": None,
                },
                {
                    "id": 16,
                    "custom_fields": {"hotend_temp": 215},
                    "custom_field_definitions": None,
                },
                {
                    "id": 17,
                    "custom_fields": {"long_sku": "x" * 256},
                    "custom_field_definitions": None,
                },
                {
                    "id": 18,
                    "custom_fields": {
                        "long_url": "https://example.com/" + "x" * 500,
                    },
                    "custom_field_definitions": None,
                },
                {
                    "id": 19,
                    "custom_fields": {"my_drying_temperature": 10**1000},
                    "custom_field_definitions": None,
                },
                {
                    "id": 20,
                    "custom_fields": {
                        "spoolman_extra": {
                            "my_drying_temperature": "58",
                            "my_ams": '["AMS","AMS Lite"]',
                            "keep_nested": "yes",
                        }
                    },
                    "custom_field_definitions": None,
                },
                {
                    "id": 21,
                    "custom_fields": {
                        "spoolman_extra": {
                            "dry_temp": "60",
                            "flow_ratio": "0.96",
                            "fan_speed_min": "20",
                            "fan_speed_max": "70",
                            "keep_nested": "untouched",
                        }
                    },
                    "custom_field_definitions": None,
                },
                {
                    "id": 22,
                    "custom_fields": {"spoolman_extra": {"sku": '"SKU-123"'}},
                    "custom_field_definitions": None,
                },
                {
                    "id": 23,
                    "custom_fields": {
                        "spoolman_extra": {"my_datasheet": '"http://[bad"'}
                    },
                    "custom_field_definitions": None,
                },
                {
                    "id": 24,
                    "custom_fields": {"spoolman_extra": {"my_currency": '"ÉUR"'}},
                    "custom_field_definitions": None,
                },
                {
                    "id": 25,
                    "custom_fields": {"my_drying_time": 90},
                    "custom_field_definitions": None,
                },
                {
                    "id": 26,
                    "custom_fields": {"spoolman_extra": {"fahrenheit_bed": "130"}},
                    "custom_field_definitions": None,
                },
                {
                    "id": 27,
                    "custom_fields": {"dry_time_hours": 90},
                    "custom_field_definitions": {
                        "dry_time_hours": {"config": {"unit": "min"}}
                    },
                },
                {
                    "id": 28,
                    "custom_fields": {"fan_speed_min": 120},
                    "custom_field_definitions": {
                        "fan_speed_min": {"config": {"unit": "rpm"}}
                    },
                },
                {
                    "id": 29,
                    "custom_fields": {"spoolman_extra": {"sku": "12345"}},
                    "custom_field_definitions": None,
                },
                {
                    "id": 31,
                    "custom_fields": {"dry_time_hours": "6"},
                    "custom_field_definitions": {
                        "dry_time_hours": {"field_type": "text"}
                    },
                },
            ],
        )
        connection.execute(
            spools.insert(),
            [
                {
                    "id": 31,
                    "filament_id": 3,
                    "custom_fields": {"extruder_temp": [205, 225], "bed_temp": 60},
                    "custom_field_definitions": {
                        "extruder_temp": {"field_type": "range"},
                        "bed_temp": {"field_type": "number"},
                    },
                },
                {
                    "id": 32,
                    "filament_id": 3,
                    "custom_fields": {"extruder_temp": [205, 225], "bed_temp": 60},
                    "custom_field_definitions": None,
                },
                {
                    "id": 41,
                    "filament_id": 4,
                    "custom_fields": {"extruder_temp": 200},
                    "custom_field_definitions": None,
                },
                {
                    "id": 42,
                    "filament_id": 4,
                    "custom_fields": {"extruder_temp": 210},
                    "custom_field_definitions": None,
                },
                {
                    "id": 51,
                    "filament_id": 11,
                    "custom_fields": {"extruder_temp": 200},
                    "custom_field_definitions": None,
                },
                {
                    "id": 52,
                    "filament_id": 11,
                    "custom_fields": {"extruder_temp": "hot"},
                    "custom_field_definitions": None,
                },
            ],
        )
        connection.execute(
            system_fields.insert(),
            [
                {
                    "id": 1,
                    "target_type": "filament",
                    "key": "extruder",
                    "label": "Extruder",
                    "field_type": "range",
                },
                {
                    "id": 2,
                    "target_type": "filament",
                    "key": "bed",
                    "label": "Bed",
                    "field_type": "range",
                },
                {
                    "id": 3,
                    "target_type": "spool",
                    "key": "extruder_temp",
                    "label": "Extruder temperature",
                    "field_type": "range",
                },
                {
                    "id": 4,
                    "target_type": "filament",
                    "key": "my_print_range",
                    "label": "Nozzle Temperature",
                    "field_type": "float_range",
                },
                {
                    "id": 5,
                    "target_type": "filament",
                    "key": "settings_extruder_temp",
                    "label": "Extruder Temperature",
                    "field_type": "number",
                },
                {
                    "id": 6,
                    "target_type": "filament",
                    "key": "settings_bed_temp",
                    "label": "Bed Temperature",
                    "field_type": "number",
                },
                {
                    "id": 7,
                    "target_type": "filament",
                    "key": "my_drying_temperature",
                    "label": "Drying Temperature",
                    "field_type": "number",
                },
                {
                    "id": 8,
                    "target_type": "filament",
                    "key": "my_cooling_fan",
                    "label": "Cooling Fan Speed",
                    "field_type": "range",
                },
                {
                    "id": 9,
                    "target_type": "filament",
                    "key": "my_sku",
                    "label": "Manufacturer SKU",
                    "field_type": "text",
                },
                {
                    "id": 10,
                    "target_type": "filament",
                    "key": "my_datasheet",
                    "label": "Datasheet URL",
                    "field_type": "url",
                },
                {
                    "id": 11,
                    "target_type": "filament",
                    "key": "my_image",
                    "label": "Image URL",
                    "field_type": "url",
                },
                {
                    "id": 12,
                    "target_type": "filament",
                    "key": "my_discontinued",
                    "label": "Discontinued",
                    "field_type": "checkbox",
                },
                {
                    "id": 13,
                    "target_type": "filament",
                    "key": "my_ams",
                    "label": "AMS Compatibility",
                    "field_type": "multiselect",
                },
                {
                    "id": 14,
                    "target_type": "filament",
                    "key": "my_plates",
                    "label": "Build Plate Compatibility",
                    "field_type": "text",
                },
                {
                    "id": 15,
                    "target_type": "filament",
                    "key": "my_currency",
                    "label": "Price Currency",
                    "field_type": "text",
                },
                {
                    "id": 16,
                    "target_type": "filament",
                    "key": "currency_a",
                    "label": "Price Currency",
                    "field_type": "text",
                },
                {
                    "id": 17,
                    "target_type": "filament",
                    "key": "currency_b",
                    "label": "Currency",
                    "field_type": "text",
                },
                {
                    "id": 18,
                    "target_type": "filament",
                    "key": "image_url",
                    "label": "Datasheet URL",
                    "field_type": "url",
                },
                {
                    "id": 19,
                    "target_type": "filament",
                    "key": "hotend_temp",
                    "label": "Bed Temperature",
                    "field_type": "number",
                },
                {
                    "id": 20,
                    "target_type": "filament",
                    "key": "long_sku",
                    "label": "Manufacturer SKU",
                    "field_type": "text",
                },
                {
                    "id": 21,
                    "target_type": "filament",
                    "key": "long_url",
                    "label": "Datasheet URL",
                    "field_type": "url",
                },
                {
                    "id": 22,
                    "target_type": "filament",
                    "key": "fan_speed_min",
                    "label": "Fan Speed Min",
                    "field_type": "number",
                },
                {
                    "id": 23,
                    "target_type": "filament",
                    "key": "fan_speed_max",
                    "label": "Fan Speed Max",
                    "field_type": "number",
                },
                {
                    "id": 24,
                    "target_type": "spool",
                    "key": "sku",
                    "label": "Spool SKU",
                    "field_type": "text",
                },
                {
                    "id": 25,
                    "target_type": "spool",
                    "key": "fan_speed_min",
                    "label": "Spool fan speed",
                    "field_type": "number",
                },
            ],
        )
        connection.execute(
            system_fields.insert(),
            [
                {
                    "id": 26,
                    "target_type": "filament",
                    "key": "my_drying_time",
                    "label": "Drying Time",
                    "field_type": "number",
                    "config": {"unit": "min"},
                },
                {
                    "id": 27,
                    "target_type": "filament",
                    "key": "fahrenheit_bed",
                    "label": "Bed Temperature",
                    "field_type": "number",
                    "config": {"unit": "°F"},
                },
            ],
        )

        migration = load_migration_module()
        monkeypatch.setattr(
            migration, "op", Operations(MigrationContext.configure(connection))
        )
        for record_id, custom in (
            (40, {"bed": 140}),
            (41, {"temp_nozzle_min": 130, "temp_nozzle_max": 140}),
        ):
            connection.execute(
                filaments.insert().values(
                    id=record_id,
                    custom_fields=custom,
                    custom_field_definitions={
                        key: {"field_type": "number", "config": {"unit": "°F"}}
                        for key in custom
                    },
                )
            )
        connection.execute(filaments.insert().values(id=42))
        connection.execute(
            spools.insert().values(
                id=420,
                filament_id=42,
                custom_fields={"bed": 140},
                custom_field_definitions={
                    "bed": {"field_type": "number", "config": {"unit": "°F"}}
                },
            )
        )
        migration.upgrade()

        migrated = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        rows = {
            row.id: row
            for row in connection.execute(sa.select(migrated).order_by(migrated.c.id))
        }
        assert rows[1].extruder_temp_range_c == {"min": 200, "max": 220}
        for record_id in (40, 41, 42):
            assert rows[record_id].bed_temp_range_c is None
        assert rows[41].extruder_temp_range_c is None
        assert rows[40].custom_fields == {"bed": 140}
        assert rows[40].custom_field_definitions["bed"]["config"] == {"unit": "°F"}
        assert rows[41].custom_fields == {
            "temp_nozzle_min": 130,
            "temp_nozzle_max": 140,
        }
        assert rows[1].bed_temp_range_c == {"min": 55, "max": 65}
        assert rows[1].custom_fields == {"keep": "yes"}
        assert rows[1].custom_field_definitions == {"keep": {"field_type": "text"}}
        assert rows[2].extruder_temp_range_c == {"min": 210, "max": 210}
        assert rows[2].bed_temp_range_c == {"min": 60, "max": 60}
        assert rows[2].custom_fields == {
            "settings_extruder_temp": 210,
            "spoolman_extra": {"keep_nested": "yes"},
        }
        assert rows[2].custom_field_definitions is None
        assert rows[2].manufacturer_sku == "PLA-42"
        assert rows[2].drying_temp_c == 55
        assert rows[2].drying_time_hours == 6
        assert rows[2].softening_temp_c == 65
        assert rows[2].cooling_fan_range_percent == {"min": 40, "max": 80}
        assert rows[2].chamber_temp_c == 35
        assert rows[2].max_volumetric_speed_mm3_s == 18
        assert rows[2].flow_ratio == 0.97
        assert rows[2].pressure_advance_k == 0.025
        assert rows[3].extruder_temp_range_c == {"min": 205, "max": 225}
        assert rows[3].bed_temp_range_c == {"min": 60, "max": 60}
        assert rows[4].extruder_temp_range_c is None
        assert rows[5].bed_temp_range_c is None
        assert rows[5].custom_fields == {"bed": "hot"}
        assert rows[6].extruder_temp_range_c == {"min": 215, "max": 235}
        assert rows[6].custom_fields is None
        assert rows[7].bed_temp_range_c is None
        assert rows[7].custom_fields == {"settings_bed_temp": "hot"}
        assert rows[8].drying_temp_c == 57
        assert rows[8].cooling_fan_range_percent == {"min": 30, "max": 90}
        assert rows[8].custom_fields is None
        assert rows[8].custom_field_definitions is None
        assert label_aliases(rows[8].label_field_aliases)["my_drying_temperature"] == "drying_temp_c"
        assert label_aliases(rows[8].label_field_aliases)["my_cooling_fan"] == "cooling_fan_range_percent"
        assert rows[9].cooling_fan_range_percent is None
        assert rows[9].custom_fields == {"my_cooling_fan": [30, 120]}
        assert rows[10].extruder_temp_range_c is None
        assert rows[10].custom_fields == {"extruder": 200, "nozzle_temp": 220}
        assert rows[11].extruder_temp_range_c is None
        assert rows[12].manufacturer_sku == "ABC-123"
        assert rows[12].datasheet_url == "https://example.com/data.pdf"
        assert rows[12].image_url == "https://example.com/image.png"
        assert rows[12].is_discontinued is True
        assert rows[12].ams_compatibility == ["ams", "ams-lite"]
        assert rows[12].build_plate_compatibility == ["pei", "textured-pei"]
        assert rows[12].price_currency == "USD"
        assert rows[12].custom_fields is None
        assert rows[13].price_currency is None
        assert rows[13].custom_fields == {"currency_a": "USD", "currency_b": "EUR"}
        assert rows[14].manufacturer_sku is None
        assert rows[14].custom_fields == {"sku": "DIRECT", "my_sku": "SYSTEM"}
        assert rows[15].datasheet_url is None
        assert rows[15].image_url is None
        assert rows[15].custom_fields == {
            "image_url": "https://example.com/ambiguous"
        }
        assert rows[16].extruder_temp_range_c is None
        assert rows[16].bed_temp_range_c is None
        assert rows[16].custom_fields == {"hotend_temp": 215}
        assert rows[17].manufacturer_sku is None
        assert rows[17].custom_fields == {"long_sku": "x" * 256}
        assert rows[18].datasheet_url is None
        assert rows[18].custom_fields == {
            "long_url": "https://example.com/" + "x" * 500
        }
        assert rows[19].drying_temp_c is None
        assert rows[19].custom_fields == {"my_drying_temperature": 10**1000}
        assert rows[20].drying_temp_c == 58
        assert rows[20].ams_compatibility == ["AMS", "AMS Lite"]
        assert rows[20].custom_fields == {"spoolman_extra": {"keep_nested": "yes"}}
        assert rows[21].drying_temp_c == 60
        assert rows[21].flow_ratio == 0.96
        assert rows[21].cooling_fan_range_percent == {"min": 20, "max": 70}
        assert rows[21].custom_fields == {"spoolman_extra": {"keep_nested": "untouched"}}
        assert rows[22].manufacturer_sku == "SKU-123"
        assert rows[22].custom_fields is None
        assert rows[23].datasheet_url is None
        assert rows[23].custom_fields == {
            "spoolman_extra": {"my_datasheet": '"http://[bad"'}
        }
        assert rows[24].price_currency is None
        assert rows[24].custom_fields == {"spoolman_extra": {"my_currency": '"ÉUR"'}}
        assert rows[25].drying_time_hours is None
        assert rows[25].custom_fields == {"my_drying_time": 90}
        assert rows[26].bed_temp_range_c is None
        assert rows[26].custom_fields == {"spoolman_extra": {"fahrenheit_bed": "130"}}
        assert rows[27].drying_time_hours is None
        assert rows[27].custom_fields == {"dry_time_hours": 90}
        assert rows[28].cooling_fan_range_percent is None
        assert rows[28].custom_fields == {"fan_speed_min": 120}
        assert rows[29].manufacturer_sku == "12345"
        assert rows[29].custom_fields is None
        assert rows[31].drying_time_hours is None
        assert rows[31].custom_fields == {"dry_time_hours": "6"}

        migrated_spools = sa.Table("spools", sa.MetaData(), autoload_with=connection)
        spool_rows = {
            row.id: row for row in connection.execute(sa.select(migrated_spools))
        }
        assert spool_rows[31].custom_fields is None
        assert spool_rows[31].custom_field_definitions is None
        assert spool_rows[32].custom_fields is None
        assert spool_rows[41].custom_fields == {"extruder_temp": 200}
        assert spool_rows[42].custom_fields == {"extruder_temp": 210}
        assert spool_rows[51].custom_fields == {"extruder_temp": 200}
        assert spool_rows[52].custom_fields == {"extruder_temp": "hot"}
        assert spool_rows[420].custom_fields == {"bed": 140}
        assert spool_rows[420].custom_field_definitions == {
            "bed": {"field_type": "number", "config": {"unit": "°F"}}
        }

        remaining_fields = set(
            connection.execute(
                sa.select(system_fields.c.target_type, system_fields.c.key)
            ).tuples()
        )
        assert remaining_fields == {
            ("filament", "bed"),
            ("filament", "currency_a"),
            ("filament", "currency_b"),
            ("filament", "extruder"),
            ("filament", "hotend_temp"),
            ("filament", "image_url"),
            ("filament", "long_sku"),
            ("filament", "long_url"),
            ("filament", "my_drying_temperature"),
            ("filament", "my_sku"),
            ("filament", "settings_bed_temp"),
            ("spool", "extruder_temp"),
            ("filament", "my_cooling_fan"),
            ("filament", "my_datasheet"),
            ("filament", "my_currency"),
            ("spool", "sku"),
            ("spool", "fan_speed_min"),
            ("filament", "my_drying_time"),
            ("filament", "fahrenheit_bed"),
            ("filament", "fan_speed_min"),
        }

    engine.dispose()


@pytest.mark.parametrize('clear', [False, True])
async def test_downgrade_current_import_restores_legacy_temperature_schema_and_json_ranges(db_session, clear):
    import json

    from app.models.filament import Filament
    from app.services.spoolman_import_service import SpoolmanImportService

    from tests.fixtures.spoolmanapi_v1.service import SpoolmanService
    from tests.support.spoolman_fixture_server import SpoolmanFixtureServer

    data = json.loads((Path(__file__).parent / 'fixtures/spoolman/rich_fields.json').read_text())
    data['filament'][0].update(settings_extruder_temp=210, settings_bed_temp=None,
                              extra={'bed': '[50,70]'})
    service = SpoolmanImportService(db_session, client_factory=SpoolmanFixtureServer(data).client_factory)
    result = await service.execute('http://spoolman')
    assert result.errors == []
    imported = await db_session.scalar(sa.select(Filament).order_by(Filament.id))
    metadata, filaments, _, _ = legacy_schema()
    with sa.create_engine('sqlite://').begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {'id': 1})
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table('filaments', sa.MetaData(), autoload_with=connection)
        native = None if clear else {'min': 215.6, 'max': 230}
        connection.execute(upgraded.update().values(
            extruder_temp_range_c=native, bed_temp_range_c={'min': 60, 'max': 75},
            label_field_aliases=imported.label_field_aliases,
            custom_fields={'sku': {'owner': 'user'}},
        ))
        migration.downgrade()
        restored = sa.Table('filaments', sa.MetaData(), autoload_with=connection)
        custom = connection.execute(sa.select(restored.c.custom_fields)).scalar_one()
    wire = SpoolmanService(None)._filament_to_schema(Filament(
        id=1, designation='Rollback', manufacturer=None, filament_colors=[], custom_fields=custom))
    assert wire.settings_extruder_temp == (None if clear else 216)
    assert clear or type(wire.settings_extruder_temp) is int
    assert wire.extra['spoolman_extra']['bed'] == '[60, 75]'
    assert wire.extra['sku'] == {'owner': 'user'}
    if not clear:
        assert custom['extruder_temp_range_c'] == native


def test_downgrade_legacy_scalars_and_range_strings_use_current_native_values():
    metadata, filaments, _, _ = legacy_schema()
    with sa.create_engine('sqlite://').begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {'id': 1, 'custom_fields': {
            'extruder_temp': 210, 'spoolman_extra': {'bed_temp': '[50,70]'},
        }})
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table('filaments', sa.MetaData(), autoload_with=connection)
        connection.execute(upgraded.update().values(extruder_temp_range_c={'min': 220.5, 'max': 240},
                                                    bed_temp_range_c={'min': 60, 'max': 75}))
        migration.downgrade()
        restored = sa.Table('filaments', sa.MetaData(), autoload_with=connection)
        custom = connection.execute(sa.select(restored.c.custom_fields)).scalar_one()
    assert custom['extruder_temp'] == 220.5
    assert custom['spoolman_extra']['bed_temp'] == '[60, 75]'
    assert custom['extruder_temp_range_c'] == {'min': 220.5, 'max': 240}


@pytest.mark.parametrize(
    "source,wire_value,target,native,source_definition,expected_type",
    [
        ("plates", "PEI, Textured", "build_plate_compatibility", ["PEI", "Textured"],
         {"label": "Build plates", "field_type": "text"}, "text"),
        ("plates", ["PEI", "Textured"], "build_plate_compatibility", ["PEI", "Textured"],
         {"label": "Build plates", "field_type": "multiselect"}, "multiselect"),
        ("extruder_temp", 210, "extruder_temp_range_c", {"min": 210, "max": 210}, None, "number"),
        ("extruder_temp", "210", "extruder_temp_range_c", {"min": 210, "max": 210}, None, "text"),
        ("spoolman_extra.bed_temp", '["50", "70"]', "bed_temp_range_c", {"min": 50, "max": 70},
         None, "text"),
        ("spoolman_extra.bed_temp", '{"min":"50","max":"70"}', "bed_temp_range_c",
         {"min": 50, "max": 70}, {"label": "Bed temperature", "field_type": "range",
                                "config": {"unit": "°C"}}, "text"),
        ("extruder_temp", "210", "extruder_temp_range_c", {"min": 210, "max": 210},
         {"label": "Nozzle temperature", "field_type": "number",
          "config": {"unit": "°C", "decimal_places": 1}}, "number"),
        ("extruder_temp", {"min": "210", "max": "230"}, "extruder_temp_range_c",
         {"min": 210, "max": 230}, None, "range"),
    ],
)
def test_downgrade_source_definitions_match_restored_wire_values(
    source, wire_value, target, native, source_definition, expected_type,
):
    from app.services.system_extra_field_compatibility import (
        is_existing_value_compatible,
    )

    metadata, filaments, _, system_fields = legacy_schema()
    custom = {"spoolman_extra": {source.split(".")[1]: wire_value}} if "." in source else {source: wire_value}
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {"id": 1, "custom_fields": custom})
        if source_definition:
            connection.execute(system_fields.insert(), {
                "id": 1, "target_type": "filament", "key": source, **source_definition,
            })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row[target] == native
        saved_definition = row["label_field_aliases"][source].get("definition")
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(restored)).mappings().one()

    restored_value = row["custom_fields"]
    for part in source.split("."):
        restored_value = restored_value[part]
    assert restored_value == wire_value
    definition = row["custom_field_definitions"][source]
    assert definition["field_type"] == expected_type
    assert is_existing_value_compatible(
        restored_value, definition["field_type"], definition.get("options"), definition.get("config"),
    )
    if saved_definition and expected_type == source_definition["field_type"]:
        assert definition == saved_definition
    if expected_type == "multiselect":
        assert definition.get("options") == source_definition.get("options")
    assert row["custom_fields"][target] == native
    recovery_definition = row["custom_field_definitions"][target]
    assert recovery_definition["field_type"] == ("multiselect" if isinstance(native, list) else "range")
    assert is_existing_value_compatible(
        native, recovery_definition["field_type"], recovery_definition.get("options"),
        recovery_definition.get("config"),
    )


@pytest.mark.parametrize("choice", ["Smooth PEI, high-temp", '["PEI", "Glass"]', '{"plate":"PEI"}'])
@pytest.mark.parametrize("nested", [False, True])
def test_upgrade_preserves_single_choice_items(choice, nested):
    metadata, filaments, _, system_fields = legacy_schema()
    system_fields.append_column(sa.Column("options", sa.JSON))
    custom = {"spoolman_extra": {"plates": choice}} if nested else {"plates": choice}
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {"id": 1, "custom_fields": custom})
        connection.execute(system_fields.insert(), {
            "id": 1, "target_type": "filament", "key": "plates",
            "label": "Build Plates", "field_type": "dropdown", "options": [choice],
        })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row["build_plate_compatibility"] == [choice]
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(restored)).mappings().one()
        assert all(row["custom_fields"][key] == value for key, value in custom.items())
        definition_key = "spoolman_extra.plates" if nested else "plates"
        assert row["custom_field_definitions"][definition_key] == {
            "label": "Build Plates", "field_type": "dropdown", "options": [choice], "config": None,
        }


@pytest.mark.parametrize("key,label,field_type,default,explicit,column,target_type", [
    ("dry_temp", "Drying temperature", "number", "0", 70, "drying_temp_c", "filament"),
    ("discontinued", "Discontinued", "checkbox", "false", True, "is_discontinued", "filament"),
    ("sku", "Manufacturer SKU", "text", "default", "current", "manufacturer_sku", "filament"),
    ("plates", "Build Plates", "multiselect", '["default"]', ["current"], "build_plate_compatibility", "filament"),
    ("bed", "Bed temperature", "range", '{"min":0,"max":0}', {"min": 55, "max": 65}, "bed_temp_range_c", "filament"),
    ("bed", "Bed temperature", "range", '{"min":0,"max":0}', {"min": 55, "max": 65}, "bed_temp_range_c", "spool"),
])
def test_upgrade_keeps_explicit_default_bearing_sources(target_type, key, label, field_type, default, explicit, column):
    metadata, filaments, spools, system_fields = legacy_schema()
    system_fields.append_column(sa.Column("default_value", sa.String(500)))
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {"id": 1, "custom_fields": {key: explicit} if target_type == "filament" else None})
        if target_type == "spool":
            connection.execute(spools.insert(), {"id": 1, "filament_id": 1, "custom_fields": {key: explicit}})
        connection.execute(system_fields.insert(), {
            "id": 1, "target_type": target_type, "key": key, "label": label,
            "field_type": field_type, "default_value": default,
        })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(upgraded)).mappings().one()
        assert row[column] == (False if column == "is_discontinued" else None)
        source = sa.Table("filaments" if target_type == "filament" else "spools", sa.MetaData(), autoload_with=connection)
        assert connection.execute(sa.select(source.c.custom_fields)).scalar_one() == {key: explicit}
        assert connection.execute(sa.select(system_fields.c.default_value)).scalar_one() == default


@pytest.mark.parametrize("storage", ["system", "local"])
@pytest.mark.parametrize("custom,key", [
    ({"sku": "SKU-🧵"}, "sku"),
    ({"a.b": "SKU-🧵", "a": {"b": "keep nested"}}, "a.b"),
    ({"spoolman_extra.sku": "SKU-🧵", "spoolman_extra": {"keep": "keep nested"}}, "spoolman_extra.sku"),
])
def test_downgrade_restores_literal_source_keys_and_complete_definitions(storage, custom, key):
    metadata, filaments, _, system_fields = legacy_schema()
    system_fields.append_column(sa.Column("options", sa.JSON))
    definition = {"label": "Manufacturer SKU 🧵", "field_type": "dropdown", "options": ["SKU-🧵", "SKU-44"], "config": None}
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        # Noncanonical keys need a System definition to identify the native target.
        if storage == "system" or key != "sku":
            connection.execute(system_fields.insert(), {"id": 1, "target_type": "filament", "key": key, **definition})
        connection.execute(filaments.insert(), {"id": 1, "custom_fields": custom,
            "custom_field_definitions": {key: definition} if storage == "local" else None})
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        assert connection.execute(sa.select(upgraded.c.manufacturer_sku)).scalar_one() == "SKU-🧵"
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(restored)).mappings().one()
        assert all(row["custom_fields"][source] == value for source, value in custom.items())
        assert row["custom_field_definitions"][key] == definition



@pytest.mark.parametrize("key,custom,definition,target,expected", [
    ("plates", {"plates": "Smooth PEI, high-temp"},
     {"label": "Build Plates 🧵", "field_type": "dropdown", "options": ["Smooth PEI, high-temp", "Textured PEI"], "config": None},
     "build_plate_compatibility", ["Smooth PEI, high-temp"]),
    ("a.b", {"a.b": "SKU-42", "a": {"b": "keep nested"}},
     {"label": "Manufacturer SKU 🧵", "field_type": "dropdown", "options": ["SKU-42", "SKU-44"], "config": None},
     "manufacturer_sku", "SKU-42"),
    ("dry_temp", {"dry_temp": 70},
     {"label": "Drying temperature", "field_type": "number", "config": {"unit": "°C"}},
     "drying_temp_c", None),
])
async def test_migrated_sources_survive_native_rename_and_downgrade(
    db_session, auth_client, key, custom, definition, target, expected,
):
    from app.models.filament import Filament, Manufacturer
    from app.models.system_extra_field import SystemExtraField

    manufacturer = Manufacturer(name="Migration source")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation="Before upgrade", material_type="PLA", diameter_mm=1.75, custom_fields=custom)
    db_session.add(filament)
    db_session.add(SystemExtraField(target_type="filament", key=key,
        default_value="0" if key == "dry_temp" else None, **definition))
    await db_session.commit()
    filament_id = filament.id

    def upgrade_legacy_schema(connection):
        # Keep the complete native API schema, removing only this revision's additions.
        for table in ("filaments", "spools"):
            connection.exec_driver_sql(f'ALTER TABLE {table} DROP COLUMN label_field_aliases')
        for column in (
            "extruder_temp_range_c", "bed_temp_range_c", "manufacturer_sku", "datasheet_url",
            "image_url", "is_discontinued", "drying_temp_c", "drying_time_hours", "softening_temp_c",
            "cooling_fan_range_percent", "chamber_temp_c", "max_volumetric_speed_mm3_s", "flow_ratio",
            "pressure_advance_k", "ams_compatibility", "build_plate_compatibility", "price_currency",
        ):
            connection.exec_driver_sql(f'ALTER TABLE filaments DROP COLUMN {column}')
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

    connection = await db_session.connection()
    await connection.run_sync(upgrade_legacy_schema)
    await db_session.commit()
    db_session.expire_all()
    client, csrf = auth_client
    response = await client.get(f"/api/v1/filaments/{filament_id}")
    assert response.status_code == 200
    dto = response.json()
    assert dto[target] == expected
    if key == "dry_temp":
        assert dto["custom_fields"] == custom
    assert (await client.patch(f"/api/v1/filaments/{filament_id}", headers={"X-CSRF-Token": csrf},
        json={"designation": "Unrelated rename"})).status_code == 200
    reopened = (await client.get(f"/api/v1/filaments/{filament_id}")).json()
    assert reopened[target] == expected
    assert reopened["label_field_aliases"] == dto["label_field_aliases"]

    def downgrade_and_read(connection):
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        return connection.execute(sa.select(restored.c.custom_fields, restored.c.custom_field_definitions)
            .where(restored.c.id == filament_id)).one()

    connection = await db_session.connection()
    restored_custom, restored_definitions = await connection.run_sync(downgrade_and_read)
    assert all(restored_custom[source] == value for source, value in custom.items())
    if key != "dry_temp":
        assert restored_definitions[key] == definition


@pytest.mark.parametrize("source", [
    None, [], "sku", {}, [1], [None], [["sku"]],
    ["spoolman_extra", {}], ["other", "sku"], ["spoolman_extra", "sku", "child"],
])
def test_malformed_source_metadata_falls_back_safely_in_projection_and_downgrade(source):
    from types import SimpleNamespace

    from app.services.spoolman_projection import project_extra

    metadata, filaments, _, _ = legacy_schema()
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {
            "id": 1, "custom_fields": {"spoolman_extra": {"sku": "SKU-42"}},
        })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = dict(connection.execute(sa.select(upgraded)).mappings().one())
        aliases = row["label_field_aliases"]
        aliases["spoolman_extra.sku"]["wire"]["source"] = source
        aliases["spoolman_extra.sku.child"] = {
            "target": "manufacturer_sku", "wire": {"source": source},
        }
        row.update(manufacturer_sku="SKU-43", label_field_aliases=aliases)
        assert project_extra(SimpleNamespace(**row), {}) == {
            "spoolman_extra": {"sku": "SKU-43"},
        }
        connection.execute(upgraded.update().values(
            manufacturer_sku="SKU-43", label_field_aliases=aliases,
        ))
        migration.downgrade()
        restored = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        custom = connection.execute(sa.select(restored.c.custom_fields)).scalar_one()
    assert custom["spoolman_extra"] == {"sku": "SKU-43"}
