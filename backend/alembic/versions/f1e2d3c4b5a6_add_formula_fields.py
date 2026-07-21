"""Add formula fields to system_extra_fields

Adds formula (JSON), show_in_detail, show_in_template,
and include_in_api columns to system_extra_fields.  All new columns
have defaults so existing rows are unaffected.

Revision ID: f1e2d3c4b5a6
Revises: c9f2a1e4b7d3
Create Date: 2026-05-17

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f1e2d3c4b5a6"
down_revision: str | Sequence[str] | None = "c9f2a1e4b7d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("system_extra_fields") as batch_op:
        batch_op.add_column(sa.Column("formula", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("show_in_detail", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        batch_op.add_column(
            sa.Column("show_in_template", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("include_in_api", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("system_extra_fields") as batch_op:
        batch_op.drop_column("include_in_api")
        batch_op.drop_column("show_in_template")
        batch_op.drop_column("show_in_detail")
        batch_op.drop_column("formula")
