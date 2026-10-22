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
    assert values["label_field_aliases"] == {"min_temp": "manufacturer_sku"}


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
        assert row["label_field_aliases"] == {
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
        assert row["label_field_aliases"] == (
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
                assert aliases[prefix + source_key] == expected_alias
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
        from pydantic import TypeAdapter

        from app.api.v1.schemas_entity_extra_field import EntityExtraFieldDefinitions

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
        assert rows[8].label_field_aliases["my_drying_temperature"] == "drying_temp_c"
        assert rows[8].label_field_aliases["my_cooling_fan"] == "cooling_fan_range_percent"
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
