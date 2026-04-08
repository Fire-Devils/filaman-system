"""add_manufacturer_logo_file

Revision ID: a7c3e9f1b2d4
Revises: 4bff5ed33565
Create Date: 2026-04-08 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a7c3e9f1b2d4"
down_revision: Union[str, Sequence[str], None] = "4bff5ed33565"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "manufacturers",
        sa.Column("logo_file", sa.String(500), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("manufacturers", "logo_file")
