"""add_manufacturer_logo_fields

Revision ID: c9a1e6f4b2d0
Revises: b37af859a415
Create Date: 2026-04-01 16:30:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c9a1e6f4b2d0"
down_revision: Union[str, Sequence[str], None] = "b37af859a415"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("manufacturers") as batch_op:
        batch_op.add_column(sa.Column("logo_url", sa.String(length=500), nullable=True))
        batch_op.add_column(sa.Column("logo_file_path", sa.String(length=500), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("manufacturers") as batch_op:
        batch_op.drop_column("logo_file_path")
        batch_op.drop_column("logo_url")