"""add oidc force_sso to oidc_settings

Opt-in force-SSO: when force_sso is true, the login page redirects
unauthenticated hits straight into the OIDC flow instead of showing the local
login form. Default false (upstream-safe). Distinct from login_disabled (which
is a no-auth backdoor) — force_sso still requires a real OIDC login.

Revision ID: add_oidc_force_sso
Revises: add_oidc_auto_provision
Create Date: 2026-07-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'add_oidc_force_sso'
down_revision: Union[str, Sequence[str], None] = 'add_oidc_auto_provision'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('oidc_settings') as batch_op:
        batch_op.add_column(
            sa.Column(
                'force_sso',
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table('oidc_settings') as batch_op:
        batch_op.drop_column('force_sso')
