import importlib.util
from pathlib import Path

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
                custom_fields={"keep": "yes"},
                custom_field_definitions={"keep": {"field_type": "text"}},
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
                is_discontinued=True,
            )
        )

        migration.downgrade()

        rolled_back = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(rolled_back)).one()
        assert row.custom_fields == {
            "keep": "yes",
            "extruder_temp_range_c": {"min": 205, "max": 225},
            "manufacturer_sku": "PLA-42",
            "is_discontinued": True,
            "drying_temp_c": 55,
            "ams_compatibility": ["AMS", "AMS Lite"],
        }
        assert row.custom_field_definitions == {
            "keep": {"field_type": "text"},
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
            "ams_compatibility": {
                "label": "AMS compatibility",
                "field_type": "multiselect",
            },
        }


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
        migration.upgrade()

        migrated = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        rows = {
            row.id: row
            for row in connection.execute(sa.select(migrated).order_by(migrated.c.id))
        }
        assert rows[1].extruder_temp_range_c == {"min": 200, "max": 220}
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
