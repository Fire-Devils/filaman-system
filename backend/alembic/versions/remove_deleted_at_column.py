"""remove_spools_deleted_at_column

Revision ID: remove_deleted_at
Revises: ab38626eada8
Create Date: 2026-02-22 19:15:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'remove_deleted_at'
down_revision: Union[str, Sequence[str], None] = 'ab38626eada8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Remove deleted_at column from spools table."""
    # Drop indexes that used deleted_at
    op.drop_index('ix_spools_filament_deleted', table_name='spools')
    op.drop_index(op.f('ix_spools_deleted_at'), table_name='spools')
    
    # Drop the deleted_at column
    op.drop_column('spools', 'deleted_at')


def downgrade() -> None:
    """Restore deleted_at column to spools table."""
    # Add the deleted_at column back
    op.add_column('spools', sa.Column('deleted_at', sa.DateTime(), nullable=True))
    
    # Recreate the indexes
    op.create_index('ix_spools_filament_deleted', 'spools', ['filament_id', 'deleted_at'], unique=False)
    op.create_index(op.f('ix_spools_deleted_at'), 'spools', ['deleted_at'], unique=False)
