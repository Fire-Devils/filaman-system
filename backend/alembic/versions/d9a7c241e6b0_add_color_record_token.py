"""Add a stable token for each color record.

Revision ID: d9a7c241e6b0
Revises: c7e2a9d4f813
"""

from collections.abc import Sequence
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision: str = "d9a7c241e6b0"
down_revision: str | Sequence[str] | None = "c7e2a9d4f813"
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
    column = next((column for column in sa.inspect(connection).get_columns("colors") if column["name"] == "record_token"), None)
    if column is None:
        op.add_column("colors", sa.Column("record_token", sa.String(32)))
    colors = sa.table(
        "colors", sa.column("id", sa.Integer), sa.column("record_token", sa.String(32))
    )
    ids = connection.execute(sa.select(colors.c.id).where(colors.c.record_token.is_(None))).scalars().all()
    if ids:
        connection.execute(
            colors.update()
            .where(colors.c.id == sa.bindparam("color_id"))
            .values(record_token=sa.bindparam("token")),
            [{"color_id": color_id, "token": uuid4().hex} for color_id in ids],
        )
    if column is None or column["nullable"]:
        with op.batch_alter_table("colors") as batch:
            batch.alter_column("record_token", existing_type=sa.String(32), nullable=False)


def downgrade() -> None:
    _begin_sqlite_ddl_transaction()
    with op.batch_alter_table("colors") as batch:
        batch.drop_column("record_token")
