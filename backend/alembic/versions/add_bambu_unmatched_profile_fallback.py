"""add_bambu_unmatched_profile_fallback

Add bambu_unmatched_profile_fallback column to app_settings table.
Controls whether an unmatched filament falls back to the Generic profile
for its material type ("generic") or to the Bambu-brand basic profile ("bambu").

Revision ID: add_bambu_unmatched_fallback
Revises: add_default_spool_core_weight
Create Date: 2026-06-29 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'add_bambu_unmatched_fallback'
down_revision: Union[str, Sequence[str], None] = 'add_default_spool_core_weight'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('app_settings') as batch_op:
        batch_op.add_column(
            sa.Column(
                'bambu_unmatched_profile_fallback',
                sa.String(length=20),
                nullable=False,
                server_default='generic',
            )
        )


def downgrade() -> None:
    with op.batch_alter_table('app_settings') as batch_op:
        batch_op.drop_column('bambu_unmatched_profile_fallback')
