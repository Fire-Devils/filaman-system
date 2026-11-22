"""add spool opened_at and last_dried_at for moisture tracking

Revision ID: c3e9a71f2d85
Revises: c3e9a17d5f42
Create Date: 2026-11-22 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e9a71f2d85"
down_revision: str | Sequence[str] | None = "c3e9a17d5f42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _backfill_opened_at(bind) -> None:
    """opened_at = time of the first event that moved a spool to opened/active."""
    statuses = sa.table("spool_statuses", sa.column("id"), sa.column("key"))
    events = sa.table(
        "spool_events",
        sa.column("spool_id"),
        sa.column("event_at", sa.DateTime(timezone=True)),
        sa.column("to_status_id"),
    )
    spools = sa.table(
        "spools",
        sa.column("id"),
        sa.column("opened_at", sa.DateTime(timezone=True)),
    )
    first_open = (
        sa.select(sa.func.min(events.c.event_at))
        .select_from(events.join(statuses, events.c.to_status_id == statuses.c.id))
        .where(events.c.spool_id == spools.c.id)
        .where(statuses.c.key.in_(("opened", "active")))
        .scalar_subquery()
    )
    bind.execute(sa.update(spools).values(opened_at=first_open))


def upgrade() -> None:
    op.add_column(
        "spools",
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "spools",
        sa.Column("last_dried_at", sa.DateTime(timezone=True), nullable=True),
    )
    _backfill_opened_at(op.get_bind())


def downgrade() -> None:
    with op.batch_alter_table("spools") as batch_op:
        batch_op.drop_column("last_dried_at")
        batch_op.drop_column("opened_at")
