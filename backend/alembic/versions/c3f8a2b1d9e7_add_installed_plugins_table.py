"""Add installed_plugins table

Revision ID: c3f8a2b1d9e7
Revises: a1b2c3d4e5f6
Create Date: 2026-02-15 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3f8a2b1d9e7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'installed_plugins',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('plugin_key', sa.String(length=50), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('version', sa.String(length=30), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('author', sa.String(length=200), nullable=True),
        sa.Column('homepage', sa.String(length=500), nullable=True),
        sa.Column('license', sa.String(length=100), nullable=True),
        sa.Column('driver_key', sa.String(length=50), nullable=False),
        sa.Column('config_schema', sa.JSON(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='1'),
        sa.Column('installed_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('installed_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_installed_plugins_plugin_key', 'installed_plugins', ['plugin_key'], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_installed_plugins_plugin_key', table_name='installed_plugins')
    op.drop_table('installed_plugins')
