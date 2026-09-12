"""remove read and api-key permissions that were never enforced

Revision ID: d5f3b8c2a614
Revises: c6e2a9f4d781
Create Date: 2026-09-12 10:20:00.000000

Follow-up to ``a4d1c8b7e903`` (GitHub issue #151). Five more keys existed in the
role editor without ever guarding anything:

* ``colors:read`` / ``locations:read`` / ``manufacturers:read`` — reading is open
  to every authenticated principal, so the list and detail endpoints use
  ``PrincipalDep`` instead of ``RequirePermission``. No code ever looked these
  keys up.
* ``user_api_keys:update_own`` / ``user_api_keys:rotate_own`` — ``me_api_keys.py``
  only creates, lists and deletes keys. There is no update and no rotate
  endpoint, so these two were as dead as the ``ratings:*`` keys.

The remaining ``user_api_keys:read_own`` / ``:create_own`` / ``:delete_own`` keys
stay: their endpoints exist and are deliberately self-service on the caller's own
keys. ``docs/permissions.md`` documents the model; the surviving ``*:read`` keys
(``spool_events:read``, ``display:read``, and ``spools``/``filaments``/
``printers:read`` inside ``ensure_any_permission`` in ``printers.py``) are
genuinely checked and untouched here.

Link rows in ``role_permissions`` and ``user_permissions`` are deleted explicitly
rather than relying on ``ON DELETE CASCADE``, because SQLite only enforces
foreign keys when ``PRAGMA foreign_keys`` is on, which is not guaranteed during
migrations.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5f3b8c2a614"
down_revision: str | Sequence[str] | None = "c6e2a9f4d781"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# key -> (description, category), so downgrade can restore the rows verbatim.
REMOVED_PERMISSIONS: dict[str, tuple[str, str]] = {
    "colors:read": ("View colors", "colors"),
    "locations:read": ("View locations", "locations"),
    "manufacturers:read": ("View manufacturers", "manufacturers"),
    "user_api_keys:update_own": ("Update own API keys", "user_api_keys"),
    "user_api_keys:rotate_own": ("Rotate own API keys", "user_api_keys"),
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
