"""default RFID display-colons setting to off

Revision ID: e8a1c4d2b907
Revises: d5f3b8c2a614
Create Date: 2026-09-12 20:20:00.000000

The column shipped with server_default=true. New rows and unset clients
should show compact UIDs unless an admin has already saved the toggle.
Existing stored values are left unchanged.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e8a1c4d2b907"
down_revision: str | Sequence[str] | None = "d5f3b8c2a614"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.alter_column(
            "rfid_display_colons",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=sa.false(),
        )


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.alter_column(
            "rfid_display_colons",
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=sa.true(),
        )
