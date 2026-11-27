"""inventory snapshots; spool events survive permanent spool deletion

Revision ID: f2a7c9d1b843
Revises: e1b6d3a9c725
Create Date: 2026-11-28 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a7c9d1b843"
down_revision: str | Sequence[str] | None = "e1b6d3a9c725"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Gives the unnamed foreign keys of old SQLite tables a name while batch-recreating.
NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def _fk_name(bind, column: str, referred: str) -> str:
    """Name of the foreign key spool_events.<column> -> <referred>."""
    if bind.dialect.name == "sqlite":
        return f"fk_spool_events_{column}_{referred}"
    for fk in sa.inspect(bind).get_foreign_keys("spool_events"):
        if fk["constrained_columns"] == [column] and fk["referred_table"] == referred:
            return fk["name"]
    raise RuntimeError(f"foreign key spool_events.{column} not found")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "inventory_snapshots" not in inspector.get_table_names():
        op.create_table(
            "inventory_snapshots",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("snapshot_date", sa.Date(), nullable=False),
            sa.Column("spool_count", sa.Integer(), nullable=False),
            sa.Column("total_weight_g", sa.Float(), nullable=False),
            sa.Column("stock_value", sa.Float(), nullable=True),
            sa.Column("purchase_value", sa.Float(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("snapshot_date", name="uq_inventory_snapshots_snapshot_date"),
        )

    columns = {col["name"] for col in inspector.get_columns("spool_events")}
    old_fk = _fk_name(bind, "spool_id", "spools")
    with op.batch_alter_table("spool_events", naming_convention=NAMING) as batch_op:
        if "filament_id" not in columns:
            batch_op.add_column(sa.Column("filament_id", sa.Integer(), nullable=True))
        batch_op.drop_constraint(old_fk, type_="foreignkey")
        batch_op.alter_column("spool_id", existing_type=sa.Integer(), nullable=True)
        batch_op.create_foreign_key(
            "fk_spool_events_spool_id_spools", "spools", ["spool_id"], ["id"], ondelete="SET NULL"
        )
        batch_op.create_foreign_key(
            "fk_spool_events_filament_id_filaments",
            "filaments",
            ["filament_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index("ix_spool_events_filament_id", ["filament_id"])

    bind.exec_driver_sql(
        "UPDATE spool_events SET filament_id = "
        "(SELECT spools.filament_id FROM spools WHERE spools.id = spool_events.spool_id) "
        "WHERE filament_id IS NULL"
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Events of deleted spools cannot satisfy the NOT NULL column again.
    bind.exec_driver_sql("DELETE FROM spool_events WHERE spool_id IS NULL")
    with op.batch_alter_table("spool_events", naming_convention=NAMING) as batch_op:
        batch_op.drop_index("ix_spool_events_filament_id")
        batch_op.drop_constraint("fk_spool_events_filament_id_filaments", type_="foreignkey")
        batch_op.drop_constraint("fk_spool_events_spool_id_spools", type_="foreignkey")
        batch_op.drop_column("filament_id")
        batch_op.alter_column("spool_id", existing_type=sa.Integer(), nullable=False)
        batch_op.create_foreign_key(
            "fk_spool_events_spool_id_spools", "spools", ["spool_id"], ["id"], ondelete="CASCADE"
        )
    op.drop_table("inventory_snapshots")
