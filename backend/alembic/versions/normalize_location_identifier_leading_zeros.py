"""normalize_location_identifier_leading_zeros

Revision ID: normalize_location_identifier
Revises: normalize_rfid_uid
Create Date: 2026-03-10 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'normalize_location_identifier'
down_revision: Union[str, None] = 'normalize_rfid_uid'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _normalize_uid(uid: str) -> str:
    """Pad each hex segment to at least 2 characters with leading zeros.

    Old scale firmware stripped leading zeros from NFC tag UIDs.
    Example: '4:f5:2:3a' -> '04:f5:02:3a'
    """
    return ":".join(segment.zfill(2) for segment in uid.split(":"))


def upgrade() -> None:
    """Normalize identifier values in locations: pad hex segments with leading zeros."""
    conn = op.get_bind()

    rows = conn.execute(
        sa.text("SELECT id, identifier FROM locations WHERE identifier IS NOT NULL")
    ).fetchall()

    for row_id, identifier in rows:
        normalized = _normalize_uid(identifier)
        if normalized != identifier:
            conn.execute(
                sa.text("UPDATE locations SET identifier = :identifier WHERE id = :id"),
                {"identifier": normalized, "id": row_id},
            )


def downgrade() -> None:
    """No downgrade — the normalized format is the correct one."""
    pass
