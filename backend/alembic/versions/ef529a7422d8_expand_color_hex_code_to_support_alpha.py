"""expand color hex_code to support alpha values

Revision ID: ef529a7422d8
Revises: d7e4a1c9b2f6
Create Date: 2026-04-07 16:20:00.000000

"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

_KNOWN_SPOOLMANDB_ARGB_VALUES = {
    "00FFFFFF": "FFFFFF00",
    "3C8AD77F": "8AD77F3C",
    "3CD8100C": "D8100C3C",
    "3CF8A813": "F8A8133C",
}

# revision identifiers, used by Alembic.
revision: str = "ef529a7422d8"
down_revision: str | Sequence[str] | None = "d7e4a1c9b2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("colors", schema=None) as batch_op:
        batch_op.alter_column(
            "hex_code",
            existing_type=sa.String(length=7),
            type_=sa.String(length=9),
            existing_nullable=False,
        )

    _repair_imported_spoolman_colors()


def _repair_imported_spoolman_colors() -> None:
    """Convert known legacy ARGB values only on Spoolman-imported filaments."""
    colors = sa.table(
        "colors",
        sa.column("id", sa.Integer),
        sa.column("name", sa.String),
        sa.column("hex_code", sa.String),
    )
    filaments = sa.table(
        "filaments",
        sa.column("id", sa.Integer),
        sa.column("custom_fields", sa.JSON),
    )
    filament_colors = sa.table(
        "filament_colors",
        sa.column("filament_id", sa.Integer),
        sa.column("color_id", sa.Integer),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            colors.c.id,
            colors.c.name,
            colors.c.hex_code,
            filaments.c.id,
            filaments.c.custom_fields,
        )
        .select_from(
            colors.join(
                filament_colors,
                filament_colors.c.color_id == colors.c.id,
            ).join(
                filaments,
                filaments.c.id == filament_colors.c.filament_id,
            )
        )
        .where(colors.c.hex_code.is_not(None))
    )

    repairs: set[tuple[int, int, str, str]] = set()
    for color_id, color_name, hex_code, filament_id, custom_fields in rows:
        if isinstance(custom_fields, str):
            try:
                custom_fields = json.loads(custom_fields)
            except json.JSONDecodeError:
                continue
        if (
            not isinstance(custom_fields, dict)
            or custom_fields.get("spoolman_id") is None
        ):
            continue

        raw = str(hex_code).strip().lstrip("#").upper()
        replacement = _KNOWN_SPOOLMANDB_ARGB_VALUES.get(raw)
        if replacement:
            repairs.add(
                (
                    filament_id,
                    color_id,
                    str(color_name),
                    f"#{replacement}",
                )
            )

    replacement_ids: dict[tuple[str, str], int] = {}
    for filament_id, color_id, color_name, replacement in sorted(repairs):
        replacement_key = (color_name, replacement)
        replacement_id = replacement_ids.get(replacement_key)
        if replacement_id is None:
            replacement_id = connection.execute(
                sa.select(colors.c.id).where(
                    colors.c.name == color_name,
                    colors.c.hex_code == replacement,
                )
            ).scalar_one_or_none()
        if replacement_id is None:
            connection.execute(
                colors.insert().values(
                    name=color_name,
                    hex_code=replacement,
                )
            )
            replacement_id = connection.execute(
                sa.select(colors.c.id).where(
                    colors.c.name == color_name,
                    colors.c.hex_code == replacement,
                )
            ).scalar_one()
        replacement_ids[replacement_key] = replacement_id

        connection.execute(
            filament_colors.update()
            .where(
                filament_colors.c.filament_id == filament_id,
                filament_colors.c.color_id == color_id,
            )
            .values(color_id=replacement_id)
        )

    repaired_color_ids = {color_id for _, color_id, _, _ in repairs}
    for color_id in sorted(repaired_color_ids):
        still_used = connection.execute(
            sa.select(filament_colors.c.color_id)
            .where(filament_colors.c.color_id == color_id)
            .limit(1)
        ).first()
        if still_used is None:
            connection.execute(colors.delete().where(colors.c.id == color_id))


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(
        sa.text(
            "UPDATE colors SET hex_code = substr(hex_code, 1, 7) "
            "WHERE length(hex_code) > 7"
        )
    )
    with op.batch_alter_table("colors", schema=None) as batch_op:
        batch_op.alter_column(
            "hex_code",
            existing_type=sa.String(length=9),
            type_=sa.String(length=7),
            existing_nullable=False,
        )
