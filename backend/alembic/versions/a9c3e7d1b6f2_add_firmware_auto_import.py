"""add firmware_auto_import to app_settings

Revision ID: a9c3e7d1b6f2
Revises: f1a7c9d2b5e3
Create Date: 2026-11-24 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9c3e7d1b6f2"
down_revision: str | Sequence[str] | None = "f1a7c9d2b5e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.add_column(
            sa.Column("firmware_auto_import", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.drop_column("firmware_auto_import")
