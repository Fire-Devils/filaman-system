"""add entity-specific extra field definitions

Revision ID: d7e4a1c9b2f6
Revises: c9f2a1e4b7d3
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7e4a1c9b2f6"
down_revision: str | Sequence[str] | None = "c9f2a1e4b7d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "filaments",
        sa.Column("custom_field_definitions", sa.JSON(), nullable=True),
    )
    op.add_column(
        "spools",
        sa.Column("custom_field_definitions", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("spools", "custom_field_definitions")
    op.drop_column("filaments", "custom_field_definitions")
