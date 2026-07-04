"""add oidc auto_provision + default_role to oidc_settings

Opt-in JIT auto-provisioning knobs for OIDC login:
- auto_provision (bool, default false): on a first OIDC login with a verified
  email and no matching local user, CREATE the user instead of rejecting with
  oidc_no_user. Default false preserves the existing link-only behavior.
- default_role (str, nullable): role key (e.g. "viewer") assigned to a
  JIT-created user; null = no role (login works, zero permissions until an
  admin grants) — privilege is never auto-granted.

Revision ID: add_oidc_auto_provision
Revises: add_bambu_unmatched_fallback
Create Date: 2026-07-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'add_oidc_auto_provision'
down_revision: Union[str, Sequence[str], None] = 'add_bambu_unmatched_fallback'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('oidc_settings') as batch_op:
        batch_op.add_column(
            sa.Column(
                'auto_provision',
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch_op.add_column(
            sa.Column('default_role', sa.String(length=50), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table('oidc_settings') as batch_op:
        batch_op.drop_column('default_role')
        batch_op.drop_column('auto_provision')
