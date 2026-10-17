"""Allow filament targets in the shared browser print queue."""

from contextlib import contextmanager

import sqlalchemy as sa

from alembic import op

revision = "add_filament_print_requests"
down_revision = "migrate_label_presets_v2"
branch_labels = None
depends_on = None


@contextmanager
def preserve_sqlite_sequence():
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        yield
        return
    query = sa.text("SELECT seq FROM sqlite_sequence WHERE name='label_print_requests'")
    previous = connection.scalar(query) or 0
    yield
    current = connection.scalar(query)
    # Batch recreation must not reuse a claimed/dismissed request ID, even for an empty queue.
    if current is None:
        connection.execute(sa.text("INSERT INTO sqlite_sequence (name, seq) VALUES ('label_print_requests', :seq)"), {"seq": previous})
    elif current < previous:
        connection.execute(sa.text("UPDATE sqlite_sequence SET seq=:seq WHERE name='label_print_requests'"), {"seq": previous})


def upgrade() -> None:
    with preserve_sqlite_sequence(), op.batch_alter_table(
        "label_print_requests", table_kwargs={"sqlite_autoincrement": True},
    ) as batch:
        batch.alter_column("spool_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("filament_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_label_print_request_filament", "filaments", ["filament_id"], ["id"], ondelete="CASCADE")
        batch.create_check_constraint("ck_label_print_request_target",
            "(spool_id IS NOT NULL AND filament_id IS NULL) OR (spool_id IS NULL AND filament_id IS NOT NULL)")


def downgrade() -> None:
    # Filament prompts are transient; spool prompts survive the downgrade.
    op.execute("DELETE FROM label_print_requests WHERE filament_id IS NOT NULL")
    with preserve_sqlite_sequence(), op.batch_alter_table(
        "label_print_requests", table_kwargs={"sqlite_autoincrement": True},
    ) as batch:
        batch.drop_constraint("ck_label_print_request_target", type_="check")
        batch.drop_constraint("fk_label_print_request_filament", type_="foreignkey")
        batch.drop_column("filament_id")
        batch.alter_column("spool_id", existing_type=sa.Integer(), nullable=False)
