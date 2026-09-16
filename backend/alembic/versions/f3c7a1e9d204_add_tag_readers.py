"""add tag_readers, the last tag each reader saw

Revision ID: f3c7a1e9d204
Revises: e8a1c4d2b907
Create Date: 2026-09-16 09:10:00.000000

One row per reader, overwritten on every scan. It is not history: a scan is a
moment, and the row exists so any Gunicorn worker can answer what was just
read, which nothing in process memory can do.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3c7a1e9d204"
down_revision: str | Sequence[str] | None = "e8a1c4d2b907"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tag_readers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("reader_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=True),
        sa.Column("last_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("last_uid", sa.String(length=128), nullable=True),
        sa.Column("last_spool_id", sa.Integer(), nullable=True),
        sa.Column("last_spool_label", sa.String(length=255), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_tag_readers_reader_id"), "tag_readers", ["reader_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_tag_readers_reader_id"), table_name="tag_readers")
    op.drop_table("tag_readers")
