"""add device_firmware table and OTA columns on devices

Revision ID: f1a7c9d2b5e3
Revises: e5b1d8a3f402
Create Date: 2026-11-24 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a7c9d2b5e3"
down_revision: str | Sequence[str] | None = "e5b1d8a3f402"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "device_firmware",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project", sa.String(64), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("sha256", name="uq_device_firmware_sha256"),
        sa.UniqueConstraint("project", "version", name="uq_device_firmware_project_version"),
    )
    op.create_index("ix_device_firmware_project", "device_firmware", ["project"])

    with op.batch_alter_table("devices") as batch:
        batch.add_column(sa.Column("firmware_project", sa.String(64), nullable=True))
        batch.add_column(sa.Column("firmware_version", sa.String(32), nullable=True))
        batch.add_column(sa.Column("last_ota_result", sa.String(16), nullable=True))
        batch.add_column(sa.Column("last_ota_error", sa.String(255), nullable=True))
        batch.add_column(sa.Column("last_ota_from", sa.String(32), nullable=True))
        batch.add_column(sa.Column("last_ota_to", sa.String(32), nullable=True))
        batch.add_column(sa.Column("last_ota_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch:
        for col in (
            "last_ota_at", "last_ota_to", "last_ota_from", "last_ota_error",
            "last_ota_result", "firmware_version", "firmware_project",
        ):
            batch.drop_column(col)
    op.drop_index("ix_device_firmware_project", table_name="device_firmware")
    op.drop_table("device_firmware")
