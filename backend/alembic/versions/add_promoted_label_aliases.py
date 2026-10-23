"""Ensure earlier draft installations also have the label alias columns."""

import sqlalchemy as sa
from alembic import op

revision = "add_promoted_label_aliases"
down_revision = "merge_standard_fields_label_api"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("filaments", "spools"):
        columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}
        if "label_field_aliases" not in columns:
            op.add_column(table, sa.Column("label_field_aliases", sa.JSON(), nullable=True))


def downgrade() -> None:
    # The standard-fields migration owns these columns and removes them on rollback.
    pass
