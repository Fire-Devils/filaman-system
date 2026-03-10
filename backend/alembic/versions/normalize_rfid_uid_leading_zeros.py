"""normalize_rfid_uid_leading_zeros

Revision ID: normalize_rfid_uid
Revises: add_app_settings
Create Date: 2026-03-10 08:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'normalize_rfid_uid'
down_revision: Union[str, None] = 'add_app_settings'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _normalize_uid(uid: str) -> str:
    """Pad each hex segment to at least 2 characters with leading zeros.

    Old scale firmware stripped leading zeros from NFC tag UIDs.
    Example: '4:f5:2:3a' -> '04:f5:02:3a'
    """
    return ":".join(segment.zfill(2) for segment in uid.split(":"))


def _normalize_table(table_name: str, pk_column: str = "id") -> None:
    """Normalize all rfid_uid values in the given table."""
    conn = op.get_bind()

    rows = conn.execute(
        sa.text(f"SELECT {pk_column}, rfid_uid FROM {table_name} WHERE rfid_uid IS NOT NULL")
    ).fetchall()

    for row_pk, rfid_uid in rows:
        normalized = _normalize_uid(rfid_uid)
        if normalized != rfid_uid:
            conn.execute(
                sa.text(f"UPDATE {table_name} SET rfid_uid = :uid WHERE {pk_column} = :pk"),
                {"uid": normalized, "pk": row_pk},
            )


def upgrade() -> None:
    """Normalize rfid_uid values: pad hex segments with leading zeros."""
    _normalize_table("spools")
    _normalize_table("printer_slot_assignments", pk_column="slot_id")
    _normalize_table("printer_slot_events")


def downgrade() -> None:
    """No downgrade — the normalized format is the correct one."""
    pass
