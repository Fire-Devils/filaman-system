"""Merge standard-field and label-API migrations without rewriting either branch."""

revision = "merge_standard_fields_label_api"
down_revision = ("merge_standard_fields_ui", "add_filament_print_requests")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
