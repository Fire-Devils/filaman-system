"""Every seeded permission should actually guard something.

Permissions show up in the admin role editor, so a key that no endpoint ever
checks is a lie: an admin grants or withholds it and nothing changes. Migration
a4d1c8b7e903 removed the two groups that were dead (spool action duplicates and
the ratings keys for a feature that has no API). These tests keep that state.
"""

import importlib.util
import re
from datetime import datetime, timezone
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.core.seeds import ADMIN_PERMISSIONS, PERMISSIONS, USER_PERMISSIONS, VIEWER_PERMISSIONS

BACKEND_ROOT = Path(__file__).parents[1]
APP_ROOT = BACKEND_ROOT / "app"
SEEDS_FILE = APP_ROOT / "core" / "seeds" / "__init__.py"

MIGRATION_PATH = (
    BACKEND_ROOT / "alembic" / "versions" / "a4d1c8b7e903_remove_unenforced_permissions.py"
)

SEEDED_AT = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

# Known-unenforced keys we deliberately keep, with the reason. Read access is
# currently granted to every authenticated principal (the list endpoints use
# PrincipalDep), and the api-key endpoints are self-service on the caller's own
# keys. Shrink this set when those endpoints start checking; never grow it
# without deciding that the new key is genuinely decorative.
KNOWN_UNENFORCED = {
    "colors:read",
    "locations:read",
    "manufacturers:read",
    "user_api_keys:read_own",
    "user_api_keys:create_own",
    "user_api_keys:update_own",
    "user_api_keys:rotate_own",
    "user_api_keys:delete_own",
}

REMOVED_BY_MIGRATION = {
    "spools:adjust_weight",
    "spools:archive",
    "spools:move_location",
    "spools:consume",
    "ratings:read",
    "ratings:write",
    "ratings:delete",
}


def _permission_keys_used_in_app() -> set[str]:
    """Every "resource:action"-shaped literal in app/, excluding the seeds."""
    used: set[str] = set()
    for path in APP_ROOT.rglob("*.py"):
        if path == SEEDS_FILE:
            continue
        used |= set(re.findall(r'["\']([a-z0-9_]+:[a-z0-9_]+)["\']', path.read_text()))
    return used


def test_no_new_unenforced_permissions():
    defined = {perm["key"] for perm in PERMISSIONS}
    unenforced = defined - _permission_keys_used_in_app()

    assert unenforced == KNOWN_UNENFORCED, (
        "Seeded permissions that no code ever checks changed. Either guard the "
        "new key with RequirePermission/ensure_any_permission, or drop it from "
        "PERMISSIONS — do not silently extend KNOWN_UNENFORCED.\n"
        f"unexpectedly dead: {sorted(unenforced - KNOWN_UNENFORCED)}\n"
        f"now enforced (remove from KNOWN_UNENFORCED): {sorted(KNOWN_UNENFORCED - unenforced)}"
    )


def test_removed_permissions_are_gone_from_seeds():
    defined = {perm["key"] for perm in PERMISSIONS}
    assert defined & REMOVED_BY_MIGRATION == set()
    for role_permissions in (VIEWER_PERMISSIONS, USER_PERMISSIONS, ADMIN_PERMISSIONS):
        assert set(role_permissions) & REMOVED_BY_MIGRATION == set()


def test_role_defaults_only_reference_defined_permissions():
    defined = {perm["key"] for perm in PERMISSIONS}
    for role_permissions in (VIEWER_PERMISSIONS, USER_PERMISSIONS, ADMIN_PERMISSIONS):
        assert set(role_permissions) <= defined


def _load_migration_module():
    spec = importlib.util.spec_from_file_location("remove_unenforced", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _rbac_schema():
    metadata = sa.MetaData()
    permissions = sa.Table(
        "permissions",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("key", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("category", sa.String(50), nullable=True),
        sa.Column("is_system", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )
    role_permissions = sa.Table(
        "role_permissions",
        metadata,
        sa.Column("role_id", sa.Integer, primary_key=True),
        sa.Column("permission_id", sa.Integer, primary_key=True),
    )
    user_permissions = sa.Table(
        "user_permissions",
        metadata,
        sa.Column("user_id", sa.Integer, primary_key=True),
        sa.Column("permission_id", sa.Integer, primary_key=True),
    )
    return metadata, permissions, role_permissions, user_permissions


def test_migration_removes_dead_permissions_and_their_grants(tmp_path):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'rbac.db'}")
    metadata, permissions, role_permissions, user_permissions = _rbac_schema()

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            permissions.insert(),
            [
                {
                    "id": 1,
                    "key": "spools:archive",
                    "description": "Archive spools",
                    "category": "spools",
                    "is_system": True,
                    "created_at": SEEDED_AT,
                    "updated_at": SEEDED_AT,
                },
                {
                    "id": 2,
                    "key": "ratings:write",
                    "description": "Write ratings",
                    "category": "ratings",
                    "is_system": True,
                    "created_at": SEEDED_AT,
                    "updated_at": SEEDED_AT,
                },
                {
                    "id": 3,
                    "key": "spool_events:create_status",
                    "description": "Create spool status changes",
                    "category": "spool_events",
                    "is_system": True,
                    "created_at": SEEDED_AT,
                    "updated_at": SEEDED_AT,
                },
            ],
        )
        connection.execute(
            role_permissions.insert(),
            [
                {"role_id": 2, "permission_id": 1},
                {"role_id": 2, "permission_id": 3},
            ],
        )
        connection.execute(
            user_permissions.insert(), [{"user_id": 7, "permission_id": 2}]
        )

        migration = _load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        assert [row[0] for row in connection.execute(sa.select(permissions.c.key))] == [
            "spool_events:create_status"
        ]
        # The surviving grant is untouched, the dead ones are gone.
        assert [
            row[0]
            for row in connection.execute(sa.select(role_permissions.c.permission_id))
        ] == [3]
        assert (
            connection.execute(sa.select(user_permissions.c.permission_id)).first()
            is None
        )

        # Re-running must not fail (permissions already removed).
        migration.upgrade()

        migration.downgrade()
        restored = {row[0] for row in connection.execute(sa.select(permissions.c.key))}
        assert restored == set(migration.REMOVED_PERMISSIONS) | {
            "spool_events:create_status"
        }
        # Grants stay gone; downgrade only restores the permission rows.
        assert [
            row[0]
            for row in connection.execute(sa.select(role_permissions.c.permission_id))
        ] == [3]

    engine.dispose()
