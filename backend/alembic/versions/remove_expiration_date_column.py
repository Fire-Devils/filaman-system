"""remove_expiration_date_column

Revision ID: remove_expiration_date
Revises: remove_deleted_at
Create Date: 2026-02-22 19:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'remove_expiration_date'
down_revision: Union[str, Sequence[str], None] = 'remove_deleted_at'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Remove expiration_date column from spools table."""
    op.drop_column('spools', 'expiration_date')


def downgrade() -> None:
    """Restore expiration_date column to spools table."""
    op.add_column('spools', sa.Column('expiration_date', sa.DateTime(), nullable=True))
