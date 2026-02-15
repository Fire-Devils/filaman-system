from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Permission, Role, SpoolStatus, User, UserRole
from app.core.config import settings


SPOOL_STATUSES = [
    {"key": "new", "label": "New", "description": "New spool, not yet used", "sort_order": 1},
    {"key": "opened", "label": "Opened", "description": "Spool opened but not yet in use", "sort_order": 2},
    {"key": "drying", "label": "Drying", "description": "Currently drying in dryer", "sort_order": 3},
    {"key": "active", "label": "Active", "description": "Currently in use", "sort_order": 4},
    {"key": "empty", "label": "Empty", "description": "No filament remaining", "sort_order": 5},
    {"key": "archived", "label": "Archived", "description": "Archived, no longer in use", "sort_order": 6},
]

PERMISSIONS = [
    {"key": "filaments:read", "description": "View filaments", "category": "filaments"},
    {"key": "filaments:create", "description": "Create filaments", "category": "filaments"},
    {"key": "filaments:update", "description": "Update filaments", "category": "filaments"},
    {"key": "filaments:delete", "description": "Delete filaments", "category": "filaments"},
    {"key": "manufacturers:read", "description": "View manufacturers", "category": "manufacturers"},
    {"key": "manufacturers:create", "description": "Create manufacturers", "category": "manufacturers"},
    {"key": "manufacturers:update", "description": "Update manufacturers", "category": "manufacturers"},
    {"key": "manufacturers:delete", "description": "Delete manufacturers", "category": "manufacturers"},
    {"key": "colors:read", "description": "View colors", "category": "colors"},
    {"key": "colors:create", "description": "Create colors", "category": "colors"},
    {"key": "colors:update", "description": "Update colors", "category": "colors"},
    {"key": "colors:delete", "description": "Delete colors", "category": "colors"},
    {"key": "spools:read", "description": "View spools", "category": "spools"},
    {"key": "spools:create", "description": "Create spools", "category": "spools"},
    {"key": "spools:update", "description": "Update spools", "category": "spools"},
    {"key": "spools:delete", "description": "Delete spools", "category": "spools"},
    {"key": "spools:adjust_weight", "description": "Adjust spool weight", "category": "spools"},
    {"key": "spools:archive", "description": "Archive spools", "category": "spools"},
    {"key": "spools:move_location", "description": "Move spools to different location", "category": "spools"},
    {"key": "spools:consume", "description": "Record spool consumption", "category": "spools"},
    {"key": "spool_events:read", "description": "View spool events", "category": "spool_events"},
    {"key": "spool_events:create_measurement", "description": "Create spool measurements", "category": "spool_events"},
    {"key": "spool_events:create_adjustment", "description": "Create spool adjustments", "category": "spool_events"},
    {"key": "spool_events:create_consumption", "description": "Create spool consumption records", "category": "spool_events"},
    {"key": "spool_events:create_status", "description": "Create spool status changes", "category": "spool_events"},
    {"key": "spool_events:create_move_location", "description": "Create spool location moves", "category": "spool_events"},
    {"key": "locations:read", "description": "View locations", "category": "locations"},
    {"key": "locations:create", "description": "Create locations", "category": "locations"},
    {"key": "locations:update", "description": "Update locations", "category": "locations"},
    {"key": "locations:delete", "description": "Delete locations", "category": "locations"},
    {"key": "printers:read", "description": "View printers", "category": "printers"},
    {"key": "printers:create", "description": "Create printers", "category": "printers"},
    {"key": "printers:update", "description": "Update printers", "category": "printers"},
    {"key": "printers:delete", "description": "Delete printers", "category": "printers"},
    {"key": "ratings:read", "description": "View ratings", "category": "ratings"},
    {"key": "ratings:write", "description": "Write ratings", "category": "ratings"},
    {"key": "ratings:delete", "description": "Delete ratings", "category": "ratings"},
    {"key": "user_api_keys:read_own", "description": "View own API keys", "category": "user_api_keys"},
    {"key": "user_api_keys:create_own", "description": "Create own API keys", "category": "user_api_keys"},
    {"key": "user_api_keys:update_own", "description": "Update own API keys", "category": "user_api_keys"},
    {"key": "user_api_keys:rotate_own", "description": "Rotate own API keys", "category": "user_api_keys"},
    {"key": "user_api_keys:delete_own", "description": "Delete own API keys", "category": "user_api_keys"},
    {"key": "admin:users_manage", "description": "Manage users (admin)", "category": "admin"},
    {"key": "admin:rbac_manage", "description": "Manage roles and permissions (admin)", "category": "admin"},
    {"key": "admin:devices_manage", "description": "Manage devices (admin)", "category": "admin"},
    {"key": "admin:plugins_manage", "description": "Manage plugins (admin)", "category": "admin"},
]

ROLES = [
    {"key": "viewer", "name": "Viewer", "description": "Read-only access"},
    {"key": "user", "name": "User", "description": "Standard user with read/write access"},
    {"key": "admin", "name": "Administrator", "description": "Full access administrator"},
]

VIEWER_PERMISSIONS = [
    "filaments:read",
    "manufacturers:read",
    "locations:read",
    "spools:read",
    "spool_events:read",
    "printers:read",
    "ratings:read",
    "colors:read",
]

USER_PERMISSIONS = [
    "filaments:read",
    "manufacturers:read",
    "locations:read",
    "printers:read",
    "ratings:read",
    "spools:read",
    "spools:create",
    "spools:update",
    "spools:adjust_weight",
    "spools:move_location",
    "spools:archive",
    "spools:consume",
    "spool_events:read",
    "spool_events:create_measurement",
    "spool_events:create_adjustment",
    "spool_events:create_consumption",
    "spool_events:create_status",
    "spool_events:create_move_location",
    "ratings:write",
    "ratings:delete",
    "user_api_keys:read_own",
    "user_api_keys:create_own",
    "user_api_keys:update_own",
    "user_api_keys:rotate_own",
    "user_api_keys:delete_own",
]

ADMIN_PERMISSIONS = [p["key"] for p in PERMISSIONS]


async def seed_spool_statuses(db: AsyncSession) -> None:
    for status_data in SPOOL_STATUSES:
        result = await db.execute(select(SpoolStatus).where(SpoolStatus.key == status_data["key"]))
        if result.scalar_one_or_none() is None:
            status = SpoolStatus(**status_data, is_system=True)
            db.add(status)
    await db.commit()


async def seed_permissions(db: AsyncSession) -> None:
    for perm_data in PERMISSIONS:
        result = await db.execute(select(Permission).where(Permission.key == perm_data["key"]))
        existing = result.scalar_one_or_none()
        if existing is None:
            permission = Permission(**perm_data, is_system=True)
            db.add(permission)
        elif existing.category != perm_data.get("category"):
            existing.category = perm_data.get("category")
    await db.commit()


async def seed_roles(db: AsyncSession) -> None:
    for role_data in ROLES:
        result = await db.execute(select(Role).where(Role.key == role_data["key"]))
        if result.scalar_one_or_none() is None:
            role = Role(**role_data, is_system=True)
            db.add(role)
    await db.commit()


async def seed_role_permissions(db: AsyncSession) -> None:
    from app.models.rbac import RolePermission

    role_perms_map = {
        "viewer": VIEWER_PERMISSIONS,
        "user": USER_PERMISSIONS,
        "admin": ADMIN_PERMISSIONS,
    }

    for role_key, perm_keys in role_perms_map.items():
        if perm_keys is None:
            continue

        role_result = await db.execute(select(Role).where(Role.key == role_key))
        role = role_result.scalar_one_or_none()
        if role is None:
            continue

        for perm_key in perm_keys:
            perm_result = await db.execute(select(Permission).where(Permission.key == perm_key))
            permission = perm_result.scalar_one_or_none()
            if permission is None:
                continue

            existing = await db.execute(
                select(RolePermission).where(
                    RolePermission.role_id == role.id,
                    RolePermission.permission_id == permission.id,
                )
            )
            if existing.scalar_one_or_none() is None:
                role_perm = RolePermission(role_id=role.id, permission_id=permission.id)
                db.add(role_perm)

    await db.commit()


async def seed_admin_user_from_env(db: AsyncSession) -> None:
    if not settings.admin_email or not settings.admin_password:
        return

    result = await db.execute(select(User).where(User.email == settings.admin_email))
    if result.scalar_one_or_none() is not None:
        return

    from passlib.context import CryptContext

    pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
    password_hash = pwd_context.hash(settings.admin_password)

    admin_role_result = await db.execute(select(Role).where(Role.key == "admin"))
    admin_role = admin_role_result.scalar_one_or_none()

    user = User(
        email=settings.admin_email,
        password_hash=password_hash,
        display_name=settings.admin_display_name or "Admin",
        language=settings.admin_language or "en",
        is_superadmin=settings.admin_superadmin,
        email_verified=True,
        is_active=True,
    )
    db.add(user)
    await db.flush()

    if admin_role:
        user_role = UserRole(user_id=user.id, role_id=admin_role.id)
        db.add(user_role)

    await db.commit()


async def run_all_seeds(db: AsyncSession) -> None:
    await seed_spool_statuses(db)
    await seed_permissions(db)
    await seed_roles(db)
    await seed_role_permissions(db)
    await seed_admin_user_from_env(db)
