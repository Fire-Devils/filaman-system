from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config

from alembic import command

PREVIOUS = "e1b6d3a9c725"
REVISION = "f2a7c9d1b843"


def _fk_actions(connection, table, column):
    return {
        row["on_delete"]
        for row in connection.exec_driver_sql(f"PRAGMA foreign_key_list({table})").mappings()
        if row["from"] == column
    }


def _columns(connection, table):
    return {
        row["name"]: row["notnull"]
        for row in connection.exec_driver_sql(f"PRAGMA table_info({table})").mappings()
    }


def test_spool_events_survive_spool_deletion_and_downgrade_restores(tmp_path, monkeypatch):
    from app.core.config import settings

    url = f"sqlite:///{tmp_path / 'snapshots.db'}"
    monkeypatch.setattr(settings, "database_url", url)
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, PREVIOUS)
    engine = sa.create_engine(url)
    try:
        with engine.begin() as connection:
            now = "CURRENT_TIMESTAMP"
            connection.exec_driver_sql(
                f"INSERT INTO manufacturers (id, name, created_at, updated_at) VALUES (1, 'Acme', {now}, {now})"
            )
            connection.exec_driver_sql(
                "INSERT INTO filaments (id, manufacturer_id, designation, type, diameter_mm, color_mode, "
                f"record_token, created_at, updated_at) VALUES (1, 1, 'PLA', 'PLA', 1.75, 'single', 'tok1', {now}, {now})"
            )
            status_id = connection.exec_driver_sql("SELECT id FROM spool_statuses LIMIT 1").scalar()
            if status_id is None:
                connection.exec_driver_sql(
                    "INSERT INTO spool_statuses (id, key, label, sort_order, is_system, created_at, updated_at) "
                    f"VALUES (1, 'new', 'New', 0, 1, {now}, {now})"
                )
                status_id = 1
            connection.exec_driver_sql(
                "INSERT INTO spools (id, filament_id, status_id, low_weight_threshold_g, created_at, updated_at) "
                f"VALUES (1, 1, {status_id}, 100, {now}, {now})"
            )
            connection.exec_driver_sql(
                "INSERT INTO spool_events (id, spool_id, event_type, event_at, created_at) "
                f"VALUES (1, 1, 'print_consumption', {now}, {now})"
            )

        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == REVISION
            assert "inventory_snapshots" in sa.inspect(connection).get_table_names()
            columns = _columns(connection, "spool_events")
            assert columns["spool_id"] == 0 and "filament_id" in columns
            assert _fk_actions(connection, "spool_events", "spool_id") == {"SET NULL"}
            assert _fk_actions(connection, "spool_events", "filament_id") == {"SET NULL"}
            # Existing events get the filament of their spool.
            assert connection.exec_driver_sql("SELECT filament_id FROM spool_events").scalar_one() == 1
            assert not connection.exec_driver_sql("PRAGMA foreign_key_check").all()
            # With enforcement on, deleting the spool keeps the event.
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.exec_driver_sql("DELETE FROM spools WHERE id = 1")
            row = connection.exec_driver_sql("SELECT spool_id, filament_id FROM spool_events").one()
            assert tuple(row) == (None, 1)

        command.downgrade(config, PREVIOUS)
        with engine.begin() as connection:
            assert "inventory_snapshots" not in sa.inspect(connection).get_table_names()
            columns = _columns(connection, "spool_events")
            assert columns["spool_id"] == 1 and "filament_id" not in columns
            assert _fk_actions(connection, "spool_events", "spool_id") == {"CASCADE"}
            # The orphaned event cannot exist with a NOT NULL spool_id and is dropped.
            assert connection.exec_driver_sql("SELECT COUNT(*) FROM spool_events").scalar_one() == 0
    finally:
        engine.dispose()
