"""add locations.location_type

Revision ID: c4e2a7b91f30
Revises: 8fb4d987c203
Create Date: 2026-11-16 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e2a7b91f30"
down_revision: str | Sequence[str] | None = "8fb4d987c203"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("locations", sa.Column("location_type", sa.String(length=50), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("locations") as batch_op:
        batch_op.drop_column("location_type")
