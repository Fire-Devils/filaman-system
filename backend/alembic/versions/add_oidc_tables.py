"""add_oidc_tables

Revision ID: add_oidc_tables
Revises: add_device_auto_assign
Create Date: 2026-02-27 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_oidc_tables'
down_revision: Union[str, None] = 'add_device_auto_assign'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- oidc_settings (single-row configuration) ---
    op.create_table(
        'oidc_settings',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('0')),
        sa.Column('issuer_url', sa.String(500), nullable=True),
        sa.Column('client_id', sa.String(255), nullable=True),
        sa.Column('client_secret_enc', sa.Text(), nullable=True),
        sa.Column('scopes', sa.String(500), nullable=False, server_default='openid email profile'),
        sa.Column('button_text', sa.String(100), nullable=False, server_default='Login with SSO'),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )

    # --- oidc_auth_states (server-side PKCE state) ---
    op.create_table(
        'oidc_auth_states',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('state', sa.String(128), nullable=False, unique=True),
        sa.Column('code_verifier', sa.String(128), nullable=False),
        sa.Column('nonce', sa.String(128), nullable=False),
        sa.Column('redirect_uri', sa.String(500), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_oidc_auth_states_state', 'oidc_auth_states', ['state'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_oidc_auth_states_state', table_name='oidc_auth_states')
    op.drop_table('oidc_auth_states')
    op.drop_table('oidc_settings')
