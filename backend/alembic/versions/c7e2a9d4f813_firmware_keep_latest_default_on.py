"""firmware_keep_latest_only defaults to on

Revision ID: c7e2a9d4f813
Revises: b4d8f2a6c1e7
Create Date: 2026-11-23 20:30:00.000000

The setting was added unreleased with default off; it should be on by default.
Existing rows are switched on as well (nobody has chosen "off" in a release yet).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2a9d4f813"
down_revision: str | Sequence[str] | None = "b4d8f2a6c1e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.alter_column(
            "firmware_keep_latest_only", existing_type=sa.Boolean(), server_default=sa.true()
        )
    op.execute(sa.text("UPDATE app_settings SET firmware_keep_latest_only = :on").bindparams(on=True))


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        batch_op.alter_column(
            "firmware_keep_latest_only", existing_type=sa.Boolean(), server_default=sa.false()
        )
