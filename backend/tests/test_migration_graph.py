from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

from alembic import command


def test_migration_graph_has_one_head():
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    assert ScriptDirectory.from_config(config).get_heads() == [
        "add_printer_param_initialization"
    ]


@pytest.mark.parametrize("starting_revision", ["merge_standard_fields_ui", "add_filament_print_requests"])
def test_combined_head_upgrades_existing_ui_and_api_databases(tmp_path, monkeypatch, starting_revision):
    from app.core.config import settings

    url = f"sqlite:///{tmp_path / 'upgrade.db'}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, starting_revision)
    engine = sa.create_engine(url)
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "INSERT INTO manufacturers (id, name, created_at, updated_at) "
                "VALUES (1, 'Preserved maker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.exec_driver_sql(
                "SELECT name FROM manufacturers WHERE id = 1"
            ).scalar_one() == "Preserved maker"
            assert connection.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar_one() == "add_printer_param_initialization"
            inspector = sa.inspect(connection)
            assert "filament_printer_initializations" in inspector.get_table_names()
            for table, column in [
                ("filaments", "bed_temp_range_c"),
                ("filaments", "label_field_aliases"),
                ("spools", "label_field_aliases"),
                ("filaments", "filamentdb_spool_image_file"),
                ("filaments", "filamentdb_spool_profile_id"),
                ("label_presets", "selected"),
                ("label_print_requests", "filament_id"),
            ]:
                assert column in {item["name"] for item in inspector.get_columns(table)}
    finally:
        engine.dispose()


def test_alias_columns_upgrade_an_already_applied_draft(tmp_path, monkeypatch):
    from app.core.config import settings

    url = f"sqlite:///{tmp_path / 'draft.db'}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "merge_standard_fields_label_api")
    engine = sa.create_engine(url)
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE filaments DROP COLUMN label_field_aliases")
            connection.exec_driver_sql("ALTER TABLE spools DROP COLUMN label_field_aliases")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            for table in ("filaments", "spools"):
                assert "label_field_aliases" in {
                    item["name"] for item in sa.inspect(connection).get_columns(table)
                }
    finally:
        engine.dispose()


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


@pytest.mark.parametrize("fail", [False, True])
def test_v2_backfill_preserves_identity_unknown_data_and_transaction(monkeypatch, fail):
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    migration = ScriptDirectory.from_config(config).get_revision("migrate_label_presets_v2").module
    engine = sa.create_engine("sqlite://")
    table = sa.Table("label_presets", sa.MetaData(), sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("preset_type", sa.String), sa.Column("data", sa.JSON), sa.Column("selected", sa.Boolean),
        sa.Column("name", sa.String), sa.Column("user_id", sa.Integer), sa.Column("updated_at", sa.String))
    table.metadata.create_all(engine)
    legacy = {"settings": {"label": {"width": 40, "height": 30}}}
    unknown = {"version": 99, "private": "do not erase"}
    preserved = [unknown, {"version": 2, "design": {"edited": True}, "legacy_v1": {}},
                 {"settings": {"label": []}}, {"settings": {"title": {"template": "x" * 131072}}}]
    with engine.begin() as connection:
        connection.execute(table.insert(), [{"id": i, "preset_type": "spool", "data": legacy if i < 102 else unknown,
            "selected": i == 1, "name": f"Preset {i}", "user_id": 7, "updated_at": "old"} for i in range(1, 103)])
        connection.execute(table.insert(), [{"id": 103+i, "preset_type": "filament", "data": data,
            "selected": False, "name": f"Preserve {i}", "user_id": 7, "updated_at": "old"} for i, data in enumerate(preserved)])
        connection.execute(table.insert(), {"id": 107, "preset_type": "sheet", "data": legacy,
            "selected": False, "name": "Sheet", "user_id": 7, "updated_at": "old"})
        connection.exec_driver_sql("CREATE TABLE refs (preset_id INTEGER REFERENCES label_presets(id))")
        connection.exec_driver_sql("INSERT INTO refs VALUES (1)")
    def run():
        with engine.begin() as connection:
            monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
            if fail:
                connection.exec_driver_sql("CREATE TRIGGER fail_update BEFORE UPDATE ON label_presets WHEN NEW.id = 101 BEGIN SELECT RAISE(ABORT, 'forced'); END")
            migration.upgrade()
            migration.upgrade()
            migration.downgrade()  # never resurrect a stale source snapshot
    if fail:
        with pytest.raises(sa.exc.DatabaseError):
            run()
    else:
        run()
    with engine.connect() as connection:
        rows = connection.execute(sa.select(table).order_by(table.c.id)).mappings().all()
        assert rows[0]["data"] == legacy if fail else rows[0]["data"]["legacy_v1"] == legacy["settings"]
        assert rows[101]["data"] == unknown
        assert [row["data"] for row in rows[102:106]] == preserved
        assert rows[-1]["data"] == legacy
        assert rows[100]["data"] == legacy if fail else rows[100]["data"]["version"] == 2
        assert rows[0]["selected"] is True
        assert rows[0]["name"] == "Preset 1" and rows[0]["user_id"] == 7
        assert all(row["updated_at"] == "old" for row in rows)
        assert connection.exec_driver_sql("SELECT preset_id FROM refs").scalar_one() == 1
    engine.dispose()


def test_printer_initialization_migration_cascades_with_both_parents(monkeypatch):
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    migration = ScriptDirectory.from_config(config).get_revision(
        "add_printer_param_initialization"
    ).module
    engine = sa.create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.exec_driver_sql("CREATE TABLE filaments (id INTEGER PRIMARY KEY)")
            connection.exec_driver_sql("CREATE TABLE printers (id INTEGER PRIMARY KEY)")
            monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            connection.exec_driver_sql("INSERT INTO filaments VALUES (1), (2)")
            connection.exec_driver_sql("INSERT INTO printers VALUES (1), (2)")
            connection.exec_driver_sql(
                "INSERT INTO filament_printer_initializations VALUES (1, 1), (2, 1), (2, 2)"
            )
            with pytest.raises(sa.exc.IntegrityError):
                connection.exec_driver_sql(
                    "INSERT INTO filament_printer_initializations VALUES (1, 1)"
                )
            connection.exec_driver_sql("DELETE FROM filaments WHERE id = 1")
            connection.exec_driver_sql("DELETE FROM printers WHERE id = 1")
            assert connection.exec_driver_sql(
                "SELECT filament_id, printer_id FROM filament_printer_initializations"
            ).all() == [(2, 2)]
            migration.downgrade()
            assert "filament_printer_initializations" not in sa.inspect(connection).get_table_names()
    finally:
        engine.dispose()
