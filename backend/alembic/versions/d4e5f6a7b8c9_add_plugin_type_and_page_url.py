"""Add plugin_type and page_url to installed_plugins

Revision ID: d4e5f6a7b8c9
Revises: c3f8a2b1d9e7
Create Date: 2026-02-15 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3f8a2b1d9e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add plugin_type and page_url columns, make driver_key nullable."""
    op.add_column(
        'installed_plugins',
        sa.Column('plugin_type', sa.String(length=30), nullable=False, server_default='driver'),
    )
    op.add_column(
        'installed_plugins',
        sa.Column('page_url', sa.String(length=500), nullable=True),
    )
    # Make driver_key nullable (was NOT NULL before) for non-driver plugins
    with op.batch_alter_table('installed_plugins') as batch_op:
        batch_op.alter_column(
            'driver_key',
            existing_type=sa.String(length=50),
            nullable=True,
        )


def downgrade() -> None:
    """Remove plugin_type and page_url columns, restore driver_key NOT NULL."""
    with op.batch_alter_table('installed_plugins') as batch_op:
        batch_op.alter_column(
            'driver_key',
            existing_type=sa.String(length=50),
            nullable=False,
        )
    op.drop_column('installed_plugins', 'page_url')
    op.drop_column('installed_plugins', 'plugin_type')
