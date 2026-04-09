"""add_manufacturer_label_logo_file

Revision ID: b8d4e0f2c3a5
Revises: a7c3e9f1b2d4
Create Date: 2026-04-09 10:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b8d4e0f2c3a5"
down_revision: Union[str, Sequence[str], None] = "a7c3e9f1b2d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "manufacturers",
        sa.Column("label_logo_file", sa.String(500), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("manufacturers", "label_logo_file")
