"""add_device_auto_assign_fields

Revision ID: add_device_auto_assign
Revises: extend_extra_fields
Create Date: 2026-02-26 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_device_auto_assign'
down_revision: Union[str, Sequence[str], None] = 'extend_extra_fields'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('devices', sa.Column('auto_assign_enabled', sa.Boolean(), server_default='0', nullable=False))
    op.add_column('devices', sa.Column('auto_assign_timeout', sa.Integer(), server_default='60', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('devices', 'auto_assign_timeout')
    op.drop_column('devices', 'auto_assign_enabled')
