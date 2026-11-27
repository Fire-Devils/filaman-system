import importlib.util
from datetime import datetime
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "e1b6d3a9c725_print_profile_printer_model.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("print_profile_model_migration", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _schema(engine):
    metadata = sa.MetaData()
    printers = sa.Table(
        "printers",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("filamentdb_printer_model_id", sa.Integer),
        sa.Column("printer_manufacturer", sa.String(255)),
        sa.Column("printer_model", sa.String(255)),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    sa.Table(
        "filament_printer_profiles",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("filament_id", sa.Integer, nullable=False),
        sa.Column("printer_id", sa.Integer, sa.ForeignKey("printers.id"), nullable=False),
        sa.Column("profile_name", sa.String(255), nullable=False),
        sa.Column("is_default_for_printer", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    metadata.create_all(engine)
    return printers


def test_upgrade_copies_printer_model_and_makes_printer_optional():
    migration = _load()
    engine = sa.create_engine("sqlite://")
    printers = _schema(engine)
    with engine.begin() as connection:
        connection.execute(
            printers.insert(),
            [
                {"id": 1, "name": "A", "filamentdb_printer_model_id": 7,
                 "printer_manufacturer": "Prusa", "printer_model": "MK4",
                 "created_at": datetime.now(), "updated_at": datetime.now()},
                {"id": 2, "name": "B", "filamentdb_printer_model_id": None,
                 "printer_manufacturer": None, "printer_model": None, "created_at": datetime.now(), "updated_at": datetime.now()},
            ],
        )
        for pid, printer_id in ((1, 1), (2, 2)):
            connection.exec_driver_sql(
                "INSERT INTO filament_printer_profiles (id, filament_id, printer_id, profile_name, "
                "is_default_for_printer, created_at, updated_at) "
                f"VALUES ({pid}, 1, {printer_id}, 'p', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

    with engine.connect() as connection:
        rows = connection.exec_driver_sql(
            "SELECT id, filamentdb_printer_model_id, printer_manufacturer, printer_model "
            "FROM filament_printer_profiles ORDER BY id"
        ).all()
        assert rows == [(1, 7, "Prusa", "MK4"), (2, None, None, None)]
        columns = {c["name"]: c for c in sa.inspect(connection).get_columns("filament_printer_profiles")}
        assert columns["printer_id"]["nullable"] is True
        connection.exec_driver_sql(
            "INSERT INTO filament_printer_profiles (id, filament_id, printer_id, profile_name, "
            "is_default_for_printer, printer_manufacturer, printer_model, created_at, updated_at) "
            "VALUES (3, 1, NULL, 'free', 0, 'Bambu', 'X1C', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        )
