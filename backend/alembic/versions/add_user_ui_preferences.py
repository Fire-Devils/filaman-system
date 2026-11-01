"""Add per-user UI preferences (e.g. hidden dashboard widgets)."""

import sqlalchemy as sa

from alembic import op

revision = "add_user_ui_preferences"
down_revision = "add_filament_print_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("ui_preferences", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("ui_preferences")
