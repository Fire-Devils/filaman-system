"""add mcp server settings

Revision ID: c7e2a9f41b30
Revises: add_plugin_icon
Create Date: 2026-11-12 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e2a9f41b30"
down_revision: str | Sequence[str] | None = "add_plugin_icon"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column("mcp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "app_settings",
        sa.Column("mcp_write_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "mcp_write_enabled")
    op.drop_column("app_settings", "mcp_enabled")
