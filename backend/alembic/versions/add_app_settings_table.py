"""add_app_settings_table

Revision ID: add_app_settings
Revises: add_timezone_aware
Create Date: 2026-03-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_app_settings'
down_revision: Union[str, None] = 'add_timezone_aware'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- app_settings (single-row configuration) ---
    op.create_table(
        'app_settings',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('login_disabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id')
    )


def downgrade() -> None:
    op.drop_table('app_settings')
