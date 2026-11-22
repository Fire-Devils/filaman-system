"""add filament.is_abrasive and printer nozzle fields

Revision ID: c3e9a5f7d120
Revises: c3e9a71f2d85
Create Date: 2026-11-22 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e9a5f7d120"
down_revision: str | Sequence[str] | None = "c3e9a71f2d85"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("filaments") as batch:
        batch.add_column(sa.Column("is_abrasive", sa.Boolean(), nullable=True))
    with op.batch_alter_table("printers") as batch:
        batch.add_column(sa.Column("nozzle_diameter_mm", sa.Float(), nullable=True))
        batch.add_column(sa.Column("nozzle_hardened", sa.Boolean(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("printers") as batch:
        batch.drop_column("nozzle_hardened")
        batch.drop_column("nozzle_diameter_mm")
    with op.batch_alter_table("filaments") as batch:
        batch.drop_column("is_abrasive")
