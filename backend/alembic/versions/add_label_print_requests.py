"""Persist print prompts across backend workers.

Revision ID: add_label_print_requests
Revises: merge_labels_tags_20260916
"""

import sqlalchemy as sa
from alembic import op

revision = "add_label_print_requests"
down_revision = "merge_labels_tags_20260916"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "label_print_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("spool_id", sa.Integer(), sa.ForeignKey("spools.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("preset_id", sa.Integer(), sa.ForeignKey("label_presets.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_label_print_requests_pending",
        "label_print_requests",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_label_print_requests_pending", table_name="label_print_requests")
    op.drop_table("label_print_requests")
