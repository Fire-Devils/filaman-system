"""add spool-full settings to app_settings

Revision ID: a1f4c8e2b6d3
Revises: d9a7c241e6b0
Create Date: 2026-11-26 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1f4c8e2b6d3"
down_revision: str | Sequence[str] | None = "d9a7c241e6b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = (
    ("spool_full_nominal_weight_g", "1000"),
    ("spool_full_tara_min_g", "100"),
    ("spool_full_tara_max_g", "350"),
    ("spool_full_overwrite_threshold_g", "5"),
)


def upgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        for name, default in _COLUMNS:
            batch_op.add_column(
                sa.Column(name, sa.Float(), nullable=False, server_default=default)
            )


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch_op:
        for name, _ in reversed(_COLUMNS):
            batch_op.drop_column(name)
