"""add filament lookup source setting

Revision ID: a4f6c8d2e901
Revises: f3c7a1e9d204
Create Date: 2026-09-28 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4f6c8d2e901"
down_revision: str | Sequence[str] | None = "f3c7a1e9d204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "filament_lookup_source",
            sa.String(length=20),
            nullable=False,
            server_default="filamandb",
        ),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "filament_lookup_source")
