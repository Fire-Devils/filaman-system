"""add per-user label image assets

Revision ID: add_label_assets
Revises: e8a1c4d2b907
Create Date: 2026-09-05 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import LONGBLOB

revision: str = "add_label_assets"
down_revision: str | Sequence[str] | None = "e8a1c4d2b907"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("label_presets", schema=None) as batch_op:
        batch_op.create_unique_constraint(
            "uq_label_presets_id_user", ["id", "user_id"]
        )

    op.create_table(
        "label_assets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("media_type", sa.String(length=32), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column(
            "content",
            sa.LargeBinary().with_variant(LONGBLOB(), "mysql"),
            nullable=False,
        ),
        sa.Column("orphaned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("byte_size > 0", name="ck_label_assets_byte_size"),
        sa.CheckConstraint("height > 0", name="ck_label_assets_height"),
        sa.CheckConstraint("length(sha256) = 64", name="ck_label_assets_sha256"),
        sa.CheckConstraint("width > 0", name="ck_label_assets_width"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "user_id", name="uq_label_assets_id_user"),
        sa.UniqueConstraint(
            "user_id", "sha256", name="uq_label_assets_user_sha256"
        ),
    )
    op.create_index(
        "ix_label_assets_user_orphaned",
        "label_assets",
        ["user_id", "orphaned_at"],
        unique=False,
    )

    op.create_table(
        "label_preset_assets",
        sa.Column("preset_id", sa.Integer(), nullable=False),
        sa.Column("asset_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["asset_id", "user_id"],
            ["label_assets.id", "label_assets.user_id"],
            name="fk_label_preset_assets_asset_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["preset_id", "user_id"],
            ["label_presets.id", "label_presets.user_id"],
            name="fk_label_preset_assets_preset_user",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("preset_id", "asset_id"),
    )
    op.create_index(
        "ix_label_preset_assets_asset",
        "label_preset_assets",
        ["asset_id"],
        unique=False,
    )
    op.create_index(
        "ix_label_preset_assets_user",
        "label_preset_assets",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_label_preset_assets_user", table_name="label_preset_assets")
    op.drop_index("ix_label_preset_assets_asset", table_name="label_preset_assets")
    op.drop_table("label_preset_assets")
    op.drop_index("ix_label_assets_user_orphaned", table_name="label_assets")
    op.drop_table("label_assets")
    with op.batch_alter_table("label_presets", schema=None) as batch_op:
        batch_op.drop_constraint("uq_label_presets_id_user", type_="unique")
