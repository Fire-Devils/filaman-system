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

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.core.seeds import ADMIN_PERMISSIONS, PERMISSIONS, USER_PERMISSIONS, VIEWER_PERMISSIONS

BACKEND_ROOT = Path(__file__).parents[1]
APP_ROOT = BACKEND_ROOT / "app"
SEEDS_FILE = APP_ROOT / "core" / "seeds" / "__init__.py"

# Every migration that removed permission keys, newest last.
MIGRATION_PATHS = {
    "a4d1c8b7e903": BACKEND_ROOT
    / "alembic"
    / "versions"
    / "a4d1c8b7e903_remove_unenforced_permissions.py",
    "d5f3b8c2a614": BACKEND_ROOT
    / "alembic"
    / "versions"
    / "d5f3b8c2a614_remove_unenforced_read_permissions.py",
}

SEEDED_AT = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

# Known-unenforced keys we deliberately keep, with the reason: the api-key
# endpoints in me_api_keys.py are self-service on the caller's own keys, so they
# guard by ownership (PrincipalDep) rather than by permission. Reading in general
# is open to every authenticated principal — that rule is documented in
# docs/permissions.md, and the read keys that nothing checked were removed in
# migration d5f3b8c2a614. Shrink this set when those endpoints start checking;
# never grow it without deciding that the new key is genuinely decorative.
KNOWN_UNENFORCED = {
    "user_api_keys:read_own",
    "user_api_keys:create_own",
    "user_api_keys:delete_own",
}

REMOVED_BY_MIGRATION = {
    # a4d1c8b7e903
    "spools:adjust_weight",
    "spools:archive",
    "spools:move_location",
    "spools:consume",
    "ratings:read",
    "ratings:write",
    "ratings:delete",
    # d5f3b8c2a614
    "colors:read",
    "locations:read",
    "manufacturers:read",
    "user_api_keys:update_own",
    "user_api_keys:rotate_own",
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


def _load_migration_module(path: Path):
    spec = importlib.util.spec_from_file_location(f"removal_{path.stem}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_removed_set_covers_every_removal_migration():
    """REMOVED_BY_MIGRATION must mirror what the migrations actually delete."""
    from_migrations: set[str] = set()
    for path in MIGRATION_PATHS.values():
        from_migrations |= set(_load_migration_module(path).REMOVED_PERMISSIONS)

    assert from_migrations == REMOVED_BY_MIGRATION, (
        "A removal migration and REMOVED_BY_MIGRATION disagree. Add new keys to "
        "both, so the seed checks below cover them.\n"
        f"only in migrations: {sorted(from_migrations - REMOVED_BY_MIGRATION)}\n"
        f"only in the test set: {sorted(REMOVED_BY_MIGRATION - from_migrations)}"
    )


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


@pytest.mark.parametrize("revision", list(MIGRATION_PATHS))
def test_migration_removes_dead_permissions_and_their_grants(tmp_path, revision):
    """Each removal migration drops its keys, their grants, and nothing else."""
    migration = _load_migration_module(MIGRATION_PATHS[revision])
    dead_keys = list(migration.REMOVED_PERMISSIONS)[:2]
    assert len(dead_keys) == 2, "migration should remove at least two keys"
    survivor = "spool_events:create_status"

    engine = sa.create_engine(f"sqlite:///{tmp_path / 'rbac.db'}")
    metadata, permissions, role_permissions, user_permissions = _rbac_schema()

    with engine.begin() as connection:
        metadata.create_all(connection)
        rows = [
            {
                "id": index,
                "key": key,
                "description": migration.REMOVED_PERMISSIONS[key][0],
                "category": migration.REMOVED_PERMISSIONS[key][1],
                "is_system": True,
                "created_at": SEEDED_AT,
                "updated_at": SEEDED_AT,
            }
            for index, key in enumerate(dead_keys, start=1)
        ]
        survivor_id = len(rows) + 1
        rows.append(
            {
                "id": survivor_id,
                "key": survivor,
                "description": "Create spool status changes",
                "category": "spool_events",
                "is_system": True,
                "created_at": SEEDED_AT,
                "updated_at": SEEDED_AT,
            }
        )
        connection.execute(permissions.insert(), rows)
        connection.execute(
            role_permissions.insert(),
            [
                {"role_id": 2, "permission_id": 1},
                {"role_id": 2, "permission_id": survivor_id},
            ],
        )
        connection.execute(
            user_permissions.insert(), [{"user_id": 7, "permission_id": 2}]
        )

        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        assert [row[0] for row in connection.execute(sa.select(permissions.c.key))] == [
            survivor
        ]
        # The surviving grant is untouched, the dead ones are gone.
        assert [
            row[0]
            for row in connection.execute(sa.select(role_permissions.c.permission_id))
        ] == [survivor_id]
        assert (
            connection.execute(sa.select(user_permissions.c.permission_id)).first()
            is None
        )

        # Re-running must not fail (permissions already removed).
        migration.upgrade()

        migration.downgrade()
        restored = {row[0] for row in connection.execute(sa.select(permissions.c.key))}
        assert restored == set(migration.REMOVED_PERMISSIONS) | {survivor}
        # Grants stay gone; downgrade only restores the permission rows.
        assert [
            row[0]
            for row in connection.execute(sa.select(role_permissions.c.permission_id))
        ] == [survivor_id]

    engine.dispose()
