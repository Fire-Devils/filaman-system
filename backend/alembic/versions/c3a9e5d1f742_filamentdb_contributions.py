"""FilaMan-DB community contributions: per-user token columns, build_plate, contributions table

Revision ID: c3a9e5d1f742
Revises: b7e2d94a1c58
Create Date: 2026-11-27 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3a9e5d1f742"
down_revision: str | Sequence[str] | None = "b7e2d94a1c58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("filamentdb_token_enc", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("filamentdb_token_name", sa.String(length=255), nullable=True))

    with op.batch_alter_table("filament_printer_profiles") as batch_op:
        batch_op.add_column(sa.Column("build_plate", sa.String(length=100), nullable=True))

    op.create_table(
        "filamentdb_contributions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entity_type", sa.String(length=30), nullable=False),
        sa.Column("local_id", sa.Integer(), nullable=False),
        sa.Column("remote_submission_id", sa.Integer(), nullable=True),
        sa.Column("remote_entity_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column(
            "depends_on_id",
            sa.Integer(),
            sa.ForeignKey("filamentdb_contributions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("payload_hash", sa.String(length=64), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("entity_type", "local_id", name="uq_filamentdb_contrib_entity"),
    )
    op.create_index(
        "ix_filamentdb_contributions_entity_type", "filamentdb_contributions", ["entity_type"]
    )
    op.create_index("ix_filamentdb_contributions_status", "filamentdb_contributions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_filamentdb_contributions_status", table_name="filamentdb_contributions")
    op.drop_index("ix_filamentdb_contributions_entity_type", table_name="filamentdb_contributions")
    op.drop_table("filamentdb_contributions")
    with op.batch_alter_table("filament_printer_profiles") as batch_op:
        batch_op.drop_column("build_plate")
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("filamentdb_token_enc")
        batch_op.drop_column("filamentdb_token_name")
