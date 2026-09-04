"""add second RFID slot (rfid_uid_2) to spools and canonicalise rfid_uid

Revision ID: b3c7d1e9f402
Revises: ef529a7422d8
Create Date: 2026-09-03 17:00:00.000000

A Bambu spool carries one RFID chip per side.  ``spools.rfid_uid_2`` lets a
spool own both, so the scale/AMS identifies it from whichever side is read.

Existing ``rfid_uid`` values are rewritten to the canonical spelling the
application now uses for every comparison (upper-case hex byte pairs joined
by ``:``, e.g. ``04:EF:14:10:C8:2A:81``).  Non-hex legacy values are only
upper-cased.  A row whose canonical spelling is already taken by another row
is left untouched and reported, so the upgrade never fails on dirty data.
"""

import logging
import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3c7d1e9f402"
down_revision: str | Sequence[str] | None = "ef529a7422d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

# Kept in sync with app.core.rfid.normalize_rfid_uid; copied here so the
# migration stays self-contained if the helper ever moves.
_SEPARATORS = re.compile(r"[\s:\-]")
_HEX_CHARS = frozenset("0123456789ABCDEF")


def _normalize(uid: str | None) -> str | None:
    if uid is None:
        return None
    raw = uid.strip()
    if not raw:
        return None
    compact = _SEPARATORS.sub("", raw).upper()
    if compact and len(compact) % 2 == 0 and set(compact) <= _HEX_CHARS:
        return ":".join(compact[i : i + 2] for i in range(0, len(compact), 2))
    return raw.upper()


def _canonicalize_existing_uids(connection: sa.Connection) -> list[tuple[int, str]]:
    """Rewrite rfid_uid to canonical form; return rows skipped due to collisions."""
    rows = connection.execute(
        sa.text("SELECT id, rfid_uid FROM spools WHERE rfid_uid IS NOT NULL")
    ).fetchall()
    taken = {uid for _, uid in rows}
    skipped: list[tuple[int, str]] = []
    for spool_id, uid in rows:
        canonical = _normalize(uid)
        if canonical is None:
            connection.execute(
                sa.text("UPDATE spools SET rfid_uid = NULL WHERE id = :id"),
                {"id": spool_id},
            )
            taken.discard(uid)
            continue
        if canonical == uid:
            continue
        if canonical in taken:
            skipped.append((spool_id, uid))
            continue
        connection.execute(
            sa.text("UPDATE spools SET rfid_uid = :uid WHERE id = :id"),
            {"uid": canonical, "id": spool_id},
        )
        taken.discard(uid)
        taken.add(canonical)
    for spool_id, uid in skipped:
        logger.warning(
            "spools.rfid_uid %r on spool %s not canonicalised: another spool "
            "already holds that chip in canonical spelling. Resolve manually.",
            uid,
            spool_id,
        )
    return skipped


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "spools", sa.Column("rfid_uid_2", sa.String(length=100), nullable=True)
    )
    op.create_index(
        op.f("ix_spools_rfid_uid_2"), "spools", ["rfid_uid_2"], unique=True
    )
    _canonicalize_existing_uids(op.get_bind())


def downgrade() -> None:
    """Downgrade schema (second chip is dropped; rfid_uid is untouched)."""
    op.drop_index(op.f("ix_spools_rfid_uid_2"), table_name="spools")
    with op.batch_alter_table("spools", schema=None) as batch_op:
        batch_op.drop_column("rfid_uid_2")
