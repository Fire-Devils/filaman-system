"""merge standard filament fields and UI migration branches

Revision ID: merge_standard_fields_ui
Revises: a4f6c8d2e901, a9c1e5f7b203, merge_labels_tags_20260916
"""

from collections.abc import Sequence

revision: str = "merge_standard_fields_ui"
down_revision: str | Sequence[str] | None = (
    "a4f6c8d2e901",
    "a9c1e5f7b203",
    "merge_labels_tags_20260916",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
