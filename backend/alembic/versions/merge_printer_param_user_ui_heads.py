"""Merge printer-param-initialization and user-UI-preferences migrations without rewriting either branch."""

revision = "merge_printer_param_user_ui"
down_revision = ("add_printer_param_initialization", "add_user_ui_preferences")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
