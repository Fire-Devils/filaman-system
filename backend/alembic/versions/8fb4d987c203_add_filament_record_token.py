"""Add a stable token for each filament record.

Revision ID: 8fb4d987c203
Revises: c7e2a9f41b30
"""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision: str = "8fb4d987c203"
down_revision: str | Sequence[str] | None = "c7e2a9f41b30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _begin_sqlite_ddl_transaction() -> sa.Connection:
    connection = op.get_bind()
    if connection.dialect.name == "sqlite" and not connection.connection.driver_connection.in_transaction:
        # SQLite's legacy driver mode does not open a transaction for DDL.
        connection.exec_driver_sql("BEGIN")
    return connection


def upgrade() -> None:
    connection = _begin_sqlite_ddl_transaction()
    op.add_column("filaments", sa.Column("record_token", sa.String(32)))
    filaments = sa.table(
        "filaments", sa.column("id", sa.Integer), sa.column("record_token", sa.String(32))
    )
    ids = connection.execute(sa.select(filaments.c.id)).scalars().all()
    if ids:
        connection.execute(
            filaments.update()
            .where(filaments.c.id == sa.bindparam("filament_id"))
            .values(record_token=sa.bindparam("token")),
            [{"filament_id": filament_id, "token": uuid4().hex} for filament_id in ids],
        )
    with op.batch_alter_table("filaments") as batch:
        batch.alter_column("record_token", existing_type=sa.String(32), nullable=False)


def downgrade() -> None:
    _begin_sqlite_ddl_transaction()
    op.drop_column("filaments", "record_token")
