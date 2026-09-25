"""merge label assets and tag readers migration branches

Revision ID: merge_labels_tags_20260916
Revises: add_label_assets, f3c7a1e9d204
"""

from collections.abc import Sequence

revision: str = "merge_labels_tags_20260916"
down_revision: str | Sequence[str] | None = ("add_label_assets", "f3c7a1e9d204")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
