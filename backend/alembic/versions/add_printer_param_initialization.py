"""Track once-only native temperature initialization per filament and printer."""

import sqlalchemy as sa
from alembic import op

revision = "add_printer_param_initialization"
down_revision = "add_filament_spool_profile_link"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "filament_printer_initializations",
        sa.Column("filament_id", sa.Integer(), nullable=False),
        sa.Column("printer_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["filament_id"], ["filaments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["printer_id"], ["printers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("filament_id", "printer_id"),
    )
    op.create_index(
        "ix_filament_printer_initializations_printer_id",
        "filament_printer_initializations",
        ["printer_id"],
    )


def downgrade() -> None:
    op.drop_table("filament_printer_initializations")
