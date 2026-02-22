"""add_spools_filament_deleted_index

Revision ID: ab38626eada8
Revises: 9a3956828c05
Create Date: 2026-02-22 16:35:59.111031

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ab38626eada8'
down_revision: Union[str, Sequence[str], None] = '9a3956828c05'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index('ix_spools_filament_deleted', 'spools', ['filament_id', 'deleted_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_spools_filament_deleted', table_name='spools')
