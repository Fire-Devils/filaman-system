"""Retain the FilaManDB packaging image separately from the product image."""

import sqlalchemy as sa

from alembic import op

revision = 'add_filament_spool_image'
down_revision = 'add_promoted_label_aliases'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('filaments', sa.Column('filamentdb_spool_image_file', sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column('filaments', 'filamentdb_spool_image_file')
