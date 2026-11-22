"""add print projects, print jobs and print job usages

Revision ID: c3e9a17d5f42
Revises: b8f2d6a41c93
Create Date: 2026-11-22 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e9a17d5f42"
down_revision: str | Sequence[str] | None = "b8f2d6a41c93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "print_projects",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "print_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("print_projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "printer_id",
            sa.Integer(),
            sa.ForeignKey("printers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("source", sa.String(length=50), nullable=False, server_default="manual"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("print_time_s", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("photo_file", sa.String(length=255), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_print_jobs_project_id", "print_jobs", ["project_id"])
    op.create_index("ix_print_jobs_printer_id", "print_jobs", ["printer_id"])
    op.create_index("ix_print_jobs_status", "print_jobs", ["status"])
    op.create_table(
        "print_job_usages",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "print_job_id",
            sa.Integer(),
            sa.ForeignKey("print_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "spool_id",
            sa.Integer(),
            sa.ForeignKey("spools.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("slot_no", sa.Integer(), nullable=True),
        sa.Column("planned_weight_g", sa.Float(), nullable=False, server_default="0"),
        sa.Column("used_weight_g", sa.Float(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=True),
        sa.Column(
            "spool_event_id",
            sa.Integer(),
            sa.ForeignKey("spool_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_print_job_usages_print_job_id", "print_job_usages", ["print_job_id"])
    op.create_index("ix_print_job_usages_spool_id", "print_job_usages", ["spool_id"])


def downgrade() -> None:
    op.drop_index("ix_print_job_usages_spool_id", table_name="print_job_usages")
    op.drop_index("ix_print_job_usages_print_job_id", table_name="print_job_usages")
    op.drop_table("print_job_usages")
    op.drop_index("ix_print_jobs_status", table_name="print_jobs")
    op.drop_index("ix_print_jobs_printer_id", table_name="print_jobs")
    op.drop_index("ix_print_jobs_project_id", table_name="print_jobs")
    op.drop_table("print_jobs")
    op.drop_table("print_projects")
