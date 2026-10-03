from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from app.models import LabelPrintRequest


def related_tables():
    metadata = sa.MetaData()
    for name in ("spools", "users", "label_presets"):
        sa.Table(name, metadata, sa.Column("id", sa.Integer, primary_key=True))
    return metadata


def test_model_does_not_reuse_ids_after_queue_cleanup():
    metadata = related_tables()
    requests = LabelPrintRequest.__table__.to_metadata(metadata)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        first_id = connection.execute(
            requests.insert().values(spool_id=1, user_id=1).returning(requests.c.id)
        ).scalar_one()
        connection.execute(requests.delete())
        next_id = connection.execute(
            requests.insert().values(spool_id=1, user_id=1).returning(requests.c.id)
        ).scalar_one()
        assert next_id > first_id
    engine.dispose()


def test_model_cascades_requests_when_their_explicit_preset_is_deleted():
    metadata = related_tables()
    requests = LabelPrintRequest.__table__.to_metadata(metadata)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        metadata.create_all(connection)
        for name in ("spools", "users", "label_presets"):
            connection.exec_driver_sql(f"INSERT INTO {name} (id) VALUES (1)")
        connection.execute(
            requests.insert().values(spool_id=1, user_id=1, preset_id=1)
        )

        connection.exec_driver_sql("DELETE FROM label_presets WHERE id = 1")

        assert connection.exec_driver_sql(
            "SELECT COUNT(*) FROM label_print_requests"
        ).scalar_one() == 0
    engine.dispose()


def test_initial_migration_prevents_id_reuse_and_cascades_preset_deletes():
    backend = Path(__file__).parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    migration = scripts.get_revision("add_label_print_requests").module
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        related_tables().create_all(connection)
        for name in ("spools", "users", "label_presets"):
            connection.exec_driver_sql(f"INSERT INTO {name} (id) VALUES (1)")
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
        connection.exec_driver_sql(
            "INSERT INTO label_print_requests (id, spool_id, user_id, preset_id) "
            "VALUES (41, 1, 1, 1)"
        )
        assert sa.inspect(connection).get_indexes("label_print_requests")[0]["column_names"] == [
            "user_id", "created_at"
        ]
        connection.exec_driver_sql("DELETE FROM label_presets WHERE id = 1")
        assert connection.exec_driver_sql("SELECT COUNT(*) FROM label_print_requests").scalar_one() == 0
        next_id = connection.exec_driver_sql(
            "INSERT INTO label_print_requests (spool_id, user_id) VALUES (1, 1) RETURNING id"
        ).scalar_one()
        assert next_id > 41
    engine.dispose()
