"""Convert supported legacy designer presets in place; preserve unknown data."""

import logging

import sqlalchemy as sa

from alembic import op
from app.services.label_preset_v1 import convert_label_preset_data

revision = "migrate_label_presets_v2"
down_revision = "add_label_preset_selection"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = sa.table("label_presets", sa.column("id", sa.Integer),
                     sa.column("preset_type", sa.String), sa.column("data", sa.JSON))
    connection = op.get_bind()
    last_id = 0
    while rows := connection.execute(sa.select(table).where(
        table.c.id > last_id, table.c.preset_type.in_(("spool", "filament"))
    ).order_by(table.c.id).limit(100)).mappings().all():
        for row in rows:
            original = row["data"]
            converted = convert_label_preset_data(original, row["preset_type"])
            if converted is not original:
                connection.execute(table.update().where(table.c.id == row["id"]).values(data=converted))
            elif not isinstance(original, dict) or original.get("version") != 2:
                logging.getLogger(__name__).warning("Preserved unsupported label preset id=%s", row["id"])
        last_id = rows[-1]["id"]


def downgrade() -> None:
    # V2 was already supported before this revision. Never overwrite later edits
    # with legacy_v1; restore a pre-upgrade backup if an exact rollback is needed.
    pass
