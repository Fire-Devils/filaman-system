"""add firmware_keep_latest_only to app_settings

Revision ID: b4d8f2a6c1e7
Revises: a9c3e7d1b6f2
Create Date: 2026-11-24 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b4d8f2a6c1e7"
down_revision: str | Sequence[str] | None = "a9c3e7d1b6f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.add_column(
            sa.Column("firmware_keep_latest_only", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.drop_column("firmware_keep_latest_only")
