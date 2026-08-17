import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "ef529a7422d8_expand_color_hex_code_to_support_alpha.py"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location(
        "color_alpha_migration",
        MIGRATION_PATH,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_repairs_only_known_spoolman_import_colors(tmp_path, monkeypatch):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    metadata = sa.MetaData()
    colors = sa.Table(
        "colors",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("hex_code", sa.String(7), nullable=False),
    )
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON, nullable=True),
    )
    filament_colors = sa.Table(
        "filament_colors",
        metadata,
        sa.Column("filament_id", sa.Integer, nullable=False),
        sa.Column("color_id", sa.Integer, nullable=False),
    )

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            colors.insert(),
            [
                {"id": 1, "name": "Imported legacy", "hex_code": "#3CD8100C"},
                {"id": 2, "name": "Imported canonical", "hex_code": "#3C112233"},
                {"id": 3, "name": "Native same bytes", "hex_code": "#3C8AD77F"},
            ],
        )
        connection.execute(
            filaments.insert(),
            [
                {"id": 1, "custom_fields": {"spoolman_id": 10}},
                {"id": 2, "custom_fields": None},
            ],
        )
        connection.execute(
            filament_colors.insert(),
            [
                {"filament_id": 1, "color_id": 1},
                {"filament_id": 1, "color_id": 2},
                {"filament_id": 2, "color_id": 1},
                {"filament_id": 2, "color_id": 3},
            ],
        )

        migration = load_migration_module()
        operations = Operations(MigrationContext.configure(connection))
        monkeypatch.setattr(migration, "op", operations)

        migration.upgrade()
        assigned_colors = [
            (row.filament_id, row.hex_code)
            for row in connection.execute(
                sa.select(
                    filament_colors.c.filament_id,
                    colors.c.hex_code,
                )
                .select_from(
                    filament_colors.join(
                        colors,
                        filament_colors.c.color_id == colors.c.id,
                    )
                )
                .order_by(
                    filament_colors.c.filament_id,
                    colors.c.hex_code,
                )
            )
        ]
        assert assigned_colors == [
            (1, "#3C112233"),
            (1, "#D8100C3C"),
            (2, "#3C8AD77F"),
            (2, "#3CD8100C"),
        ]
        assert sa.inspect(connection).get_columns("colors")[2]["type"].length == 9

        migration.downgrade()
        assert all(
            len(row.hex_code) == 7
            for row in connection.execute(sa.select(colors.c.hex_code))
        )
        assert sa.inspect(connection).get_columns("colors")[2]["type"].length == 7

    engine.dispose()


def test_upgrade_survives_leftover_batch_temp_table(tmp_path):
    """An interrupted previous run can leave `_alembic_tmp_colors` behind."""
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    metadata = sa.MetaData()
    colors = sa.Table(
        "colors",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("hex_code", sa.String(7), nullable=False),
    )
    filaments = sa.Table(
        "filaments",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_fields", sa.JSON, nullable=True),
    )
    filament_colors = sa.Table(
        "filament_colors",
        metadata,
        sa.Column("filament_id", sa.Integer, nullable=False),
        sa.Column("color_id", sa.Integer, nullable=False),
    )

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            colors.insert(), [{"id": 1, "name": "Basic White", "hex_code": "#FFFFFF"}]
        )
        connection.execute(
            sa.text("CREATE TABLE _alembic_tmp_colors (id INTEGER)")
        )

        migration = load_migration_module()
        operations = Operations(MigrationContext.configure(connection))
        migration.op = operations

        migration.upgrade()
        assert sa.inspect(connection).get_columns("colors")[2]["type"].length == 9

    engine.dispose()
