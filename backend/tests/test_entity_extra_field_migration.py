import importlib.util
import json
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "d7e4a1c9b2f6_add_entity_extra_field_definitions.py"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location(
        "entity_extra_field_definitions_migration",
        MIGRATION_PATH,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_and_downgrade_preserve_legacy_custom_fields(tmp_path, monkeypatch):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    metadata = sa.MetaData()
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON, nullable=True),
    )
    spools = sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON, nullable=True),
    )
    legacy_filament_fields = {"drying": {"temperature": 55}}
    legacy_spool_fields = {"storage": {"humidity": 30}}

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert().values(id=1, custom_fields=legacy_filament_fields),
        )
        connection.execute(
            spools.insert().values(id=1, custom_fields=legacy_spool_fields),
        )

        migration = load_migration_module()
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)

        migration.upgrade()
        assert "custom_field_definitions" in {
            column["name"] for column in sa.inspect(connection).get_columns("filaments")
        }
        assert "custom_field_definitions" in {
            column["name"] for column in sa.inspect(connection).get_columns("spools")
        }
        assert json.loads(
            connection.execute(
                sa.text("SELECT custom_fields FROM filaments WHERE id = 1"),
            ).scalar_one(),
        ) == legacy_filament_fields
        assert json.loads(
            connection.execute(
                sa.text("SELECT custom_fields FROM spools WHERE id = 1"),
            ).scalar_one(),
        ) == legacy_spool_fields

        connection.execute(
            sa.text(
                "UPDATE filaments SET custom_field_definitions = :definitions WHERE id = 1",
            ),
            {
                "definitions": json.dumps(
                    {
                        "drying.temperature": {
                            "label": "Drying temperature",
                            "field_type": "number",
                        },
                    },
                ),
            },
        )

        migration.downgrade()
        assert "custom_field_definitions" not in {
            column["name"] for column in sa.inspect(connection).get_columns("filaments")
        }
        assert "custom_field_definitions" not in {
            column["name"] for column in sa.inspect(connection).get_columns("spools")
        }
        assert json.loads(
            connection.execute(
                sa.text("SELECT custom_fields FROM filaments WHERE id = 1"),
            ).scalar_one(),
        ) == legacy_filament_fields
        assert json.loads(
            connection.execute(
                sa.text("SELECT custom_fields FROM spools WHERE id = 1"),
            ).scalar_one(),
        ) == legacy_spool_fields

    engine.dispose()
