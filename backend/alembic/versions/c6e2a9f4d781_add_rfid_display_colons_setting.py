"""add RFID display-colons setting

Revision ID: c6e2a9f4d781
Revises: a4d1c8b7e903
Create Date: 2026-09-07 14:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c6e2a9f4d781"
down_revision: str | Sequence[str] | None = "a4d1c8b7e903"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "rfid_display_colons",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.drop_column("rfid_display_colons")
