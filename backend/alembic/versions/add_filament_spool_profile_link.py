"""Retain the selected catalog reel independently of measured spool properties."""

import sqlalchemy as sa

from alembic import op

revision = 'add_filament_spool_profile_link'
down_revision = 'add_filament_spool_image'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('filaments', sa.Column('filamentdb_spool_profile_id', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('filaments', 'filamentdb_spool_profile_id')
