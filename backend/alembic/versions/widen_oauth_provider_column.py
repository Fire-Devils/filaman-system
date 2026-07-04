"""widen_oauth_identities_provider_to_255

oauth_identities.provider stores the OIDC issuer URL (e.g. an Authentik issuer
like "https://auth.example.com/application/o/<app-slug>/", commonly 50-60+
chars), but the column was String(50). A real issuer URL overflows it, raising
StringDataRightTruncationError on the OIDC callback (auth_oidc.py, at the
identity upsert) → HTTP 500 at /auth/oidc/callback, blocking SSO login on a
fresh DB. Widen provider to String(255) to match provider_subject/provider_email.

Revision ID: widen_oauth_provider
Revises: add_bambu_unmatched_fallback
Create Date: 2026-07-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'widen_oauth_provider'
down_revision: Union[str, Sequence[str], None] = 'add_bambu_unmatched_fallback'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('oauth_identities') as batch_op:
        batch_op.alter_column(
            'provider',
            existing_type=sa.String(length=50),
            type_=sa.String(length=255),
            existing_nullable=False,
        )


def downgrade() -> None:
    # Note: only safe if no stored provider value exceeds 50 chars (a real OIDC
    # issuer URL does), so this is best-effort — kept for chain symmetry.
    with op.batch_alter_table('oauth_identities') as batch_op:
        batch_op.alter_column(
            'provider',
            existing_type=sa.String(length=255),
            type_=sa.String(length=50),
            existing_nullable=False,
        )
