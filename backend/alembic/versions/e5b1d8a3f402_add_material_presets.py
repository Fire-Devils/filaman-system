"""add material_presets, filaments.drying_interval_days, app_settings.default_empty_spool_weight_g

Revision ID: e5b1d8a3f402
Revises: c3e9a5f7d120
Create Date: 2026-11-23 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5b1d8a3f402"
down_revision: str | Sequence[str] | None = "c3e9a5f7d120"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copy of the default list (migrations must not import app modules).
# (material_type, ext_min, ext_max, bed_min, bed_max, flow, dry_temp, dry_hours,
#  interval_days, density)
_SEED_ROWS = (
    ('PLA', 190, 230, 50, 65, 0.98, 55, 8, 90, 1.24),
    ('PLA-CF', 210, 240, 45, 65, 0.96, 55, 8, 60, 1.29),
    ('PETG', 220, 260, 70, 85, 0.95, 65, 8, 30, 1.27),
    ('PETG-CF', 240, 270, 70, 85, 0.95, 65, 8, 30, 1.29),
    ('PCTG', 240, 270, 70, 90, 0.95, 65, 6, 30, 1.23),
    ('PET-CF', 260, 290, 70, 90, 0.96, 80, 10, 21, 1.29),
    ('ABS', 240, 270, 90, 110, 0.95, 80, 8, 30, 1.04),
    ('ASA', 240, 270, 90, 110, 0.95, 80, 8, 30, 1.07),
    ('HIPS', 230, 250, 90, 110, 0.98, 70, 6, 30, 1.04),
    ('PC', 260, 300, 100, 120, 0.95, 80, 8, 14, 1.2),
    ('TPU', 210, 240, 30, 60, 1.0, 55, 8, 14, 1.21),
    ('PA', 260, 290, 80, 100, 0.98, 80, 12, 7, 1.14),
    ('PA-CF', 260, 300, 80, 100, 0.96, 80, 12, 7, 1.17),
    ('PP', 220, 250, 80, 100, 0.98, 70, 6, 60, 0.9),
    ('PPS', 300, 340, 100, 120, 0.98, 90, 8, 14, 1.35),
    ('PVA', 190, 220, 45, 60, 1.0, 55, 8, 3, 1.23),
    ('BVOH', 190, 220, 50, 70, 1.0, 55, 8, 3, 1.14),
)

_COLUMNS = (
    "material_type",
    "extruder_temp_min_c",
    "extruder_temp_max_c",
    "bed_temp_min_c",
    "bed_temp_max_c",
    "flow_ratio",
    "drying_temp_c",
    "drying_time_hours",
    "drying_interval_days",
    "density_g_cm3",
)


def upgrade() -> None:
    material_presets = op.create_table(
        "material_presets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("material_type", sa.String(50), nullable=False),
        sa.Column("extruder_temp_min_c", sa.Float(), nullable=True),
        sa.Column("extruder_temp_max_c", sa.Float(), nullable=True),
        sa.Column("bed_temp_min_c", sa.Float(), nullable=True),
        sa.Column("bed_temp_max_c", sa.Float(), nullable=True),
        sa.Column("flow_ratio", sa.Float(), nullable=True),
        sa.Column("drying_temp_c", sa.Float(), nullable=True),
        sa.Column("drying_time_hours", sa.Float(), nullable=True),
        sa.Column("drying_interval_days", sa.Integer(), nullable=True),
        sa.Column("density_g_cm3", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("material_type", name="uq_material_presets_material_type"),
    )
    op.bulk_insert(material_presets, [dict(zip(_COLUMNS, row)) for row in _SEED_ROWS])

    with op.batch_alter_table("filaments") as batch:
        batch.add_column(sa.Column("drying_interval_days", sa.Integer(), nullable=True))
    with op.batch_alter_table("app_settings") as batch:
        batch.add_column(sa.Column("default_empty_spool_weight_g", sa.Float(), nullable=True))

    op.execute("UPDATE app_settings SET default_empty_spool_weight_g = 250")


def downgrade() -> None:
    with op.batch_alter_table("app_settings") as batch:
        batch.drop_column("default_empty_spool_weight_g")
    with op.batch_alter_table("filaments") as batch:
        batch.drop_column("drying_interval_days")
    op.drop_table("material_presets")
