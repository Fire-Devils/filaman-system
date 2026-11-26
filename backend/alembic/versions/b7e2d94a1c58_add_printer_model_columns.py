"""add printer model columns to printers

Revision ID: b7e2d94a1c58
Revises: a1f4c8e2b6d3
Create Date: 2026-11-27 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e2d94a1c58"
down_revision: str | Sequence[str] | None = "a1f4c8e2b6d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("printers") as batch_op:
        batch_op.add_column(sa.Column("filamentdb_printer_model_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("printer_manufacturer", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("printer_model", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("printers") as batch_op:
        batch_op.drop_column("printer_model")
        batch_op.drop_column("printer_manufacturer")
        batch_op.drop_column("filamentdb_printer_model_id")
