"""remove permissions that were never enforced

Revision ID: a4d1c8b7e903
Revises: b3c7d1e9f402
Create Date: 2026-09-07 11:10:00.000000

Two groups of permission keys existed in the role editor but were never checked
by any endpoint, so granting or withholding them had no effect:

* ``spools:adjust_weight`` / ``spools:archive`` / ``spools:move_location`` /
  ``spools:consume`` — duplicates of the ``spool_events:create_*`` permissions
  that actually guard those actions.
* ``ratings:read`` / ``ratings:write`` / ``ratings:delete`` — ``FilamentRating``
  has no API endpoints at all.

Removing them keeps the role editor honest. Link rows in ``role_permissions``
and ``user_permissions`` are deleted explicitly rather than relying on
``ON DELETE CASCADE``, because SQLite only enforces foreign keys when
``PRAGMA foreign_keys`` is on, which is not guaranteed during migrations.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4d1c8b7e903"
down_revision: str | Sequence[str] | None = "b3c7d1e9f402"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# key -> (description, category), so downgrade can restore the rows verbatim.
REMOVED_PERMISSIONS: dict[str, tuple[str, str]] = {
    "spools:adjust_weight": ("Adjust spool weight", "spools"),
    "spools:archive": ("Archive spools", "spools"),
    "spools:move_location": ("Move spools to different location", "spools"),
    "spools:consume": ("Record spool consumption", "spools"),
    "ratings:read": ("View ratings", "ratings"),
    "ratings:write": ("Write ratings", "ratings"),
    "ratings:delete": ("Delete ratings", "ratings"),
}

_permissions = sa.table(
    "permissions",
    sa.column("id", sa.Integer),
    sa.column("key", sa.String),
    sa.column("description", sa.Text),
    sa.column("category", sa.String),
    sa.column("is_system", sa.Boolean),
    sa.column("created_at", sa.DateTime),
    sa.column("updated_at", sa.DateTime),
)
_role_permissions = sa.table(
    "role_permissions",
    sa.column("role_id", sa.Integer),
    sa.column("permission_id", sa.Integer),
)
_user_permissions = sa.table(
    "user_permissions",
    sa.column("user_id", sa.Integer),
    sa.column("permission_id", sa.Integer),
)


def upgrade() -> None:
    """Drop the unenforced permissions and every grant pointing at them."""
    connection = op.get_bind()
    keys = list(REMOVED_PERMISSIONS)

    permission_ids = [
        row[0]
        for row in connection.execute(
            sa.select(_permissions.c.id).where(_permissions.c.key.in_(keys))
        )
    ]
    if not permission_ids:
        return

    for table in (_role_permissions, _user_permissions):
        connection.execute(
            table.delete().where(table.c.permission_id.in_(permission_ids))
        )
    connection.execute(_permissions.delete().where(_permissions.c.id.in_(permission_ids)))


def downgrade() -> None:
    """Re-create the permission rows.

    Role and user grants are not restored — that information is gone once the
    link rows were deleted. Re-assign the permissions in the role editor if you
    downgrade and actually need them.
    """
    connection = op.get_bind()
    existing = {
        row[0]
        for row in connection.execute(
            sa.select(_permissions.c.key).where(
                _permissions.c.key.in_(list(REMOVED_PERMISSIONS))
            )
        )
    }
    missing = [key for key in REMOVED_PERMISSIONS if key not in existing]
    if not missing:
        return

    now = datetime.now(UTC)
    connection.execute(
        _permissions.insert(),
        [
            {
                "key": key,
                "description": REMOVED_PERMISSIONS[key][0],
                "category": REMOVED_PERMISSIONS[key][1],
                "is_system": True,
                "created_at": now,
                "updated_at": now,
            }
            for key in missing
        ],
    )
