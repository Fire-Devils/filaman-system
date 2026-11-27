"""Repair FilaMan-DB contribution columns on databases migrated early.

The first version of c3a9e5d1f742 (on devel only) stored the FilaMan-DB token
in app_settings and had no payload_hash. That revision was later changed in
place, so databases which already ran it miss the new columns. This revision
adds whatever is missing and moves an existing instance token to the first
superadmin. On fresh databases it does nothing.

Revision ID: d8f1b2c4e6a9
Revises: c3a9e5d1f742
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8f1b2c4e6a9"
down_revision: str | Sequence[str] | None = "c3a9e5d1f742"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _columns(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()

    user_cols = _columns(bind, "users")
    with op.batch_alter_table("users") as batch_op:
        if "filamentdb_token_enc" not in user_cols:
            batch_op.add_column(sa.Column("filamentdb_token_enc", sa.Text(), nullable=True))
        if "filamentdb_token_name" not in user_cols:
            batch_op.add_column(sa.Column("filamentdb_token_name", sa.String(length=255), nullable=True))

    if "payload_hash" not in _columns(bind, "filamentdb_contributions"):
        with op.batch_alter_table("filamentdb_contributions") as batch_op:
            batch_op.add_column(sa.Column("payload_hash", sa.String(length=64), nullable=True))

    settings_cols = _columns(bind, "app_settings")
    if "filamentdb_token_enc" in settings_cols:
        row = bind.execute(
            sa.text(
                "SELECT filamentdb_token_enc, filamentdb_token_name FROM app_settings "
                "WHERE filamentdb_token_enc IS NOT NULL ORDER BY id LIMIT 1"
            )
        ).first()
        if row is not None:
            admin_id = bind.execute(
                sa.text(
                    "SELECT id FROM users WHERE is_superadmin = :yes AND deleted_at IS NULL "
                    "ORDER BY id LIMIT 1"
                ),
                {"yes": True},
            ).scalar()
            if admin_id is not None:
                bind.execute(
                    sa.text(
                        "UPDATE users SET filamentdb_token_enc = :enc, filamentdb_token_name = :name "
                        "WHERE id = :id AND filamentdb_token_enc IS NULL"
                    ),
                    {"enc": row[0], "name": row[1], "id": admin_id},
                )
        with op.batch_alter_table("app_settings") as batch_op:
            batch_op.drop_column("filamentdb_token_enc")
            if "filamentdb_token_name" in settings_cols:
                batch_op.drop_column("filamentdb_token_name")


def downgrade() -> None:
    # c3a9e5d1f742 in its current form already creates these columns.
    pass
