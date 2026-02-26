"""Extend system_extra_fields and add printer_params tables

Add field_type, options, source columns to system_extra_fields.
Add unique constraint on (target_type, key).
Create filament_printer_params and spool_printer_params tables
for per-printer calibration values (Bambu K, flow ratio, etc.).

Revision ID: extend_extra_fields
Revises: add_plugin_capabilities
Create Date: 2026-02-26 08:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'extend_extra_fields'
down_revision: Union[str, Sequence[str], None] = 'add_plugin_capabilities'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add field_type/options/source to system_extra_fields, create printer_params tables."""

    # --- Extend system_extra_fields ---
    with op.batch_alter_table('system_extra_fields') as batch_op:
        batch_op.add_column(
            sa.Column('field_type', sa.String(length=30), nullable=False, server_default='text')
        )
        batch_op.add_column(
            sa.Column('options', sa.JSON(), nullable=True)
        )
        batch_op.add_column(
            sa.Column('source', sa.String(length=100), nullable=True)
        )
        batch_op.create_unique_constraint(
            'uq_system_extra_fields_target_key', ['target_type', 'key']
        )

    # --- Create filament_printer_params ---
    op.create_table(
        'filament_printer_params',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('filament_id', sa.Integer(), nullable=False),
        sa.Column('printer_id', sa.Integer(), nullable=False),
        sa.Column('param_key', sa.String(length=100), nullable=False),
        sa.Column('param_value', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['filament_id'], ['filaments.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['printer_id'], ['printers.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('filament_id', 'printer_id', 'param_key', name='uq_filament_printer_params'),
    )
    op.create_index('ix_filament_printer_params_filament', 'filament_printer_params', ['filament_id'])
    op.create_index('ix_filament_printer_params_printer', 'filament_printer_params', ['printer_id'])

    # --- Create spool_printer_params ---
    op.create_table(
        'spool_printer_params',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('spool_id', sa.Integer(), nullable=False),
        sa.Column('printer_id', sa.Integer(), nullable=False),
        sa.Column('param_key', sa.String(length=100), nullable=False),
        sa.Column('param_value', sa.String(length=500), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['spool_id'], ['spools.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['printer_id'], ['printers.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('spool_id', 'printer_id', 'param_key', name='uq_spool_printer_params'),
    )
    op.create_index('ix_spool_printer_params_spool', 'spool_printer_params', ['spool_id'])
    op.create_index('ix_spool_printer_params_printer', 'spool_printer_params', ['printer_id'])


def downgrade() -> None:
    """Remove printer_params tables and extra columns from system_extra_fields."""
    op.drop_index('ix_spool_printer_params_printer', table_name='spool_printer_params')
    op.drop_index('ix_spool_printer_params_spool', table_name='spool_printer_params')
    op.drop_table('spool_printer_params')

    op.drop_index('ix_filament_printer_params_printer', table_name='filament_printer_params')
    op.drop_index('ix_filament_printer_params_filament', table_name='filament_printer_params')
    op.drop_table('filament_printer_params')

    with op.batch_alter_table('system_extra_fields') as batch_op:
        batch_op.drop_constraint('uq_system_extra_fields_target_key', type_='unique')
        batch_op.drop_column('source')
        batch_op.drop_column('options')
        batch_op.drop_column('field_type')
