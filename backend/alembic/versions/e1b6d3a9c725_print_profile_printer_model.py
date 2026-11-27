"""print profiles belong to a printer model, printer link becomes optional

Revision ID: e1b6d3a9c725
Revises: d8f1b2c4e6a9
Create Date: 2026-11-27 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1b6d3a9c725"
down_revision: str | Sequence[str] | None = "d8f1b2c4e6a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "filament_printer_profiles"
MODEL_COLUMNS = ("filamentdb_printer_model_id", "printer_manufacturer", "printer_model")


def _columns(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    existing = _columns(bind, TABLE)
    with op.batch_alter_table(TABLE) as batch_op:
        if "filamentdb_printer_model_id" not in existing:
            batch_op.add_column(sa.Column("filamentdb_printer_model_id", sa.Integer(), nullable=True))
        if "printer_manufacturer" not in existing:
            batch_op.add_column(sa.Column("printer_manufacturer", sa.String(length=255), nullable=True))
        if "printer_model" not in existing:
            batch_op.add_column(sa.Column("printer_model", sa.String(length=255), nullable=True))
        batch_op.alter_column("printer_id", existing_type=sa.Integer(), nullable=True)

    # Bestehende Profile übernehmen das Modell ihres Druckers.
    for column in MODEL_COLUMNS:
        bind.exec_driver_sql(
            f"UPDATE {TABLE} SET {column} = "
            f"(SELECT printers.{column} FROM printers WHERE printers.id = {TABLE}.printer_id) "
            f"WHERE {column} IS NULL"
        )


def downgrade() -> None:
    bind = op.get_bind()
    # Profile ohne Drucker passen nicht mehr in die NOT-NULL-Spalte.
    bind.exec_driver_sql(f"DELETE FROM {TABLE} WHERE printer_id IS NULL")
    with op.batch_alter_table(TABLE) as batch_op:
        batch_op.alter_column("printer_id", existing_type=sa.Integer(), nullable=False)
        for column in MODEL_COLUMNS:
            batch_op.drop_column(column)
