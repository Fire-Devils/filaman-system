"""add filaments.low_stock_threshold_g

Revision ID: e7a3c91d5b28
Revises: c4e2a7b91f30
Create Date: 2026-11-22 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a3c91d5b28"
down_revision: str | Sequence[str] | None = "c4e2a7b91f30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("filaments", sa.Column("low_stock_threshold_g", sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("filaments") as batch_op:
        batch_op.drop_column("low_stock_threshold_g")
