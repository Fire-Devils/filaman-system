"""Add an optional packaged plugin icon path."""

from alembic import op
import sqlalchemy as sa

revision = "add_plugin_icon"
down_revision = "merge_printer_param_user_ui"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("installed_plugins", sa.Column("icon", sa.String(250), nullable=True))


def downgrade() -> None:
    op.drop_column("installed_plugins", "icon")
