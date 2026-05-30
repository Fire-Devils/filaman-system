"""add config to system_extra_fields

Revision ID: c9f2a1e4b7d3
Revises: add_rfid_settings
Create Date: 2026-05-18 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c9f2a1e4b7d3"
down_revision: str | Sequence[str] | None = "add_rfid_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("system_extra_fields", schema=None) as batch_op:
        batch_op.add_column(sa.Column("config", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("system_extra_fields", schema=None) as batch_op:
        batch_op.drop_column("config")
