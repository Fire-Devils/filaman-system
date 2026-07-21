"""add per-user label presets

Revision ID: add_label_presets
Revises: add_bambu_unmatched_fallback
Create Date: 2026-07-13 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "add_label_presets"
down_revision: Union[str, Sequence[str], None] = "add_bambu_unmatched_fallback"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "label_presets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("preset_type", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("name_key", sa.String(length=64), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "preset_type IN ('spool', 'filament', 'sheet')",
            name="ck_label_presets_type",
        ),
        sa.CheckConstraint("name <> ''", name="ck_label_presets_name_not_empty"),
        sa.CheckConstraint(
            "length(name_key) = 64",
            name="ck_label_presets_name_key_length",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "preset_type",
            "name_key",
            name="uq_label_presets_user_type_name_key",
        ),
    )
    op.create_index(
        "ix_label_presets_user_type",
        "label_presets",
        ["user_id", "preset_type"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_label_presets_user_type", table_name="label_presets")
    op.drop_table("label_presets")
