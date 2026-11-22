"""add spool_link_suggestions

Revision ID: b8f2d6a41c93
Revises: e7a3c91d5b28
Create Date: 2026-11-22 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8f2d6a41c93"
down_revision: str | Sequence[str] | None = "e7a3c91d5b28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "spool_link_suggestions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("external_id", sa.String(length=255), nullable=False),
        sa.Column(
            "filament_id",
            sa.Integer(),
            sa.ForeignKey("filaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(length=50), nullable=False),
        sa.Column(
            "printer_id",
            sa.Integer(),
            sa.ForeignKey("printers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("slot_label", sa.String(length=100), nullable=True),
        sa.Column("tag_data", sa.JSON(), nullable=True),
        sa.Column("remaining_weight_g", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column(
            "linked_spool_id",
            sa.Integer(),
            sa.ForeignKey("spools.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_spool_link_suggestions_external_id",
        "spool_link_suggestions",
        ["external_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_spool_link_suggestions_external_id", table_name="spool_link_suggestions")
    op.drop_table("spool_link_suggestions")
