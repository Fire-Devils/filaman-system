from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory


def test_migration_graph_has_one_head():
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    assert ScriptDirectory.from_config(config).get_heads() == [
        "add_label_preset_selection"
    ]


def test_preset_selection_migration_adds_a_default_false_boolean(monkeypatch):
    backend = Path(__file__).parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    migration = ScriptDirectory.from_config(config).get_revision(
        "add_label_preset_selection"
    ).module
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE label_presets (id INTEGER PRIMARY KEY)")
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        connection.exec_driver_sql("INSERT INTO label_presets (id) VALUES (1)")
        assert connection.exec_driver_sql(
            "SELECT selected FROM label_presets WHERE id = 1"
        ).scalar_one() == 0
        migration.downgrade()
        assert "selected" not in {
            column["name"] for column in sa.inspect(connection).get_columns("label_presets")
        }
    engine.dispose()
