from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.core.security import (
    generate_device_code,
    generate_token_secret,
    hash_password_async,
    hash_token,
)
from app.models import Device, Permission, Role, RolePermission, User, UserRole

router = APIRouter(prefix="/admin", tags=["admin"])


class UserResponse(BaseModel):
    id: int
    email: str
    display_name: str | None
    language: str
    is_active: bool
    is_superadmin: bool
    last_login_at: datetime | None

    class Config:
        from_attributes = True


class UserDetailResponse(UserResponse):
    roles: list[str]


class UserCreate(BaseModel):
    email: str
    password: str
    display_name: str | None = None
    language: str = "en"
    is_superadmin: bool = False


class UserUpdate(BaseModel):
    email: str | None = None
    display_name: str | None = None
    language: str | None = None
    is_active: bool | None = None
    is_superadmin: bool | None = None


class RoleResponse(BaseModel):
    id: int
    key: str
    name: str
    description: str | None
    is_system: bool

    class Config:
        from_attributes = True


class RoleDetailResponse(RoleResponse):
    permissions: list[str]


class PermissionResponse(BaseModel):
    id: int
    key: str
    description: str | None
    category: str | None

    class Config:
        from_attributes = True


class RoleCreate(BaseModel):
    key: str
    name: str
    description: str | None = None


class RoleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class DeviceResponse(BaseModel):
    id: int
    name: str
    is_active: bool
    scopes: list[str] | None
    last_used_at: datetime | None
    last_seen_at: datetime | None
    ip_address: str | None
    created_at: datetime | None
    registration_pending: bool
    is_online: bool = False
    auto_assign_enabled: bool = False
    auto_assign_timeout: int = 60
    firmware_project: str | None = None
    firmware_version: str | None = None
    last_ota_result: str | None = None
    last_ota_error: str | None = None
    last_ota_from: str | None = None
    last_ota_to: str | None = None
    last_ota_at: datetime | None = None

    class Config:
        from_attributes = True


class DeviceCreate(BaseModel):
    name: str
    device_type: str = "scale"


class DeviceUpdate(BaseModel):
    name: str | None = None
    auto_assign_enabled: bool | None = None
    auto_assign_timeout: int | None = None

def _require_unrestricted_superadmin(principal):
    if not principal.is_superadmin or principal.scopes is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Only unrestricted superadmins can manage superadmin accounts"},
        )


async def _guard_user_write(db, user_id, *, principal, removes_active_root=False):
    active_roots = select(User.id).where(
        User.is_superadmin.is_(True), User.is_active.is_(True), User.deleted_at.is_(None),
    ).order_by(User.id).with_for_update()
    if removes_active_root:
        await db.execute(active_roots)
    # A conditional write locks the target even on SQLite, closing promotion races through commit.
    claim = update(User).where(User.id == user_id, User.deleted_at.is_(None))
    if not principal.is_superadmin or principal.scopes is not None:
        claim = claim.where(User.is_superadmin.is_(False))
    result = await db.execute(claim.values(id=User.id, updated_at=User.updated_at))
    if result.rowcount != 1:
        existing = await db.scalar(select(User.id).where(User.id == user_id, User.deleted_at.is_(None)))
        if existing is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "not_found", "message": "User not found"},
            )
        _require_unrestricted_superadmin(principal)
    if removes_active_root and (await db.scalars(active_roots)).all() == [user_id]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_request", "message": "Cannot remove the last active superadmin"},
        )


async def _write_user(db, user, values, principal):
    removes_active_root = (
        values.get("is_superadmin") is False or values.get("is_active") is False or values.get("deleted_at") is not None
    )
    await _guard_user_write(db, user.id, principal=principal, removes_active_root=removes_active_root)
    if values:
        await db.execute(update(User).where(User.id == user.id).values(**values))
    await db.commit()
    await db.refresh(user)


@router.get("/users", response_model=PaginatedResponse[UserResponse])

async def list_users(
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    query = select(User).where(User.deleted_at.is_(None)).order_by(User.email)
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().all()

    count_query = select(func.count()).select_from(User).where(User.deleted_at.is_(None))
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    data: UserCreate,
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    if data.is_superadmin:
        _require_unrestricted_superadmin(principal)
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Email already exists"},
        )

    user = User(
        email=data.email,
        password_hash=await hash_password_async(data.password),
        display_name=data.display_name,
        language=data.language,
        is_superadmin=data.is_superadmin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/users/{user_id}", response_model=UserDetailResponse)
async def get_user(
    user_id: int,
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    result = await db.execute(
        select(User)
        .where(User.id == user_id, User.deleted_at.is_(None))
        .options(selectinload(User.roles))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    return UserDetailResponse(
        **{k: getattr(user, k) for k in UserResponse.model_fields},
        roles=[r.key for r in user.roles],
    )


@router.patch("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: UserUpdate,
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    result = await db.execute(
        select(User).where(User.id == user_id, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    if user.is_superadmin or data.is_superadmin:
        _require_unrestricted_superadmin(principal)
    await _write_user(db, user, data.model_dump(exclude_unset=True), principal)
    return user


class ResetPasswordRequest(BaseModel):
    new_password: str


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: int,
    data: ResetPasswordRequest,
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    result = await db.execute(
        select(User).where(User.id == user_id, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    if user.is_superadmin:
        _require_unrestricted_superadmin(principal)

    password_hash = await hash_password_async(data.new_password)
    await _write_user(db, user, {"password_hash": password_hash}, principal)
    return {"message": "Password reset successfully"}


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: int,
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    # 1. Fetch target user
    result = await db.execute(select(User).where(User.id == user_id, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    # 2. Prevent self-deletion
    if user.id == principal.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_request", "message": "You cannot delete your own account"},
        )

    if user.is_superadmin:
        _require_unrestricted_superadmin(principal)
    await _write_user(db, user, {"deleted_at": datetime.now(timezone.utc)}, principal)


@router.put("/users/{user_id}/roles")
async def set_user_roles(

    user_id: int,
    role_keys: list[str],
    db: DBSession,
    principal = RequirePermission("admin:users_manage"),
):
    result = await db.execute(
        select(User).where(User.id == user_id, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    if user.is_superadmin:
        _require_unrestricted_superadmin(principal)

    await _guard_user_write(db, user.id, principal=principal)
    await db.execute(UserRole.__table__.delete().where(UserRole.user_id == user_id))

    if role_keys:
        roles_result = await db.execute(select(Role).where(Role.key.in_(role_keys)))
        roles = roles_result.scalars().all()

        for role in roles:
            db.add(UserRole(user_id=user_id, role_id=role.id))

    await db.commit()
    return {"message": "Roles updated", "roles": [r.key for r in roles] if role_keys else []}


@router.get("/roles", response_model=list[RoleResponse])
async def list_roles(
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(select(Role).order_by(Role.name))
    return result.scalars().all()


@router.post("/roles", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
async def create_role(
    data: RoleCreate,
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    import re
    if not re.match(r'^[a-z][a-z0-9_]{1,48}[a-z0-9]$', data.key):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "validation_error", "message": "Key must be 3-50 lowercase alphanumeric characters or underscores, starting with a letter"},
        )

    result = await db.execute(select(Role).where(Role.key == data.key))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "A role with this key already exists"},
        )

    role = Role(
        key=data.key,
        name=data.name,
        description=data.description,
        is_system=False,
    )
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return role


@router.patch("/roles/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: int,
    data: RoleUpdate,
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()

    if not role:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Role not found"},
        )

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(role, key, value)

    await db.commit()
    await db.refresh(role)
    return role


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: int,
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()

    if not role:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Role not found"},
        )

    if role.is_system:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "System roles cannot be deleted"},
        )

    await db.execute(RolePermission.__table__.delete().where(RolePermission.role_id == role_id))
    await db.execute(UserRole.__table__.delete().where(UserRole.role_id == role_id))
    await db.delete(role)
    await db.commit()


@router.get("/roles/{role_id}", response_model=RoleDetailResponse)
async def get_role(
    role_id: int,
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(
        select(Role).where(Role.id == role_id).options(selectinload(Role.permissions))
    )
    role = result.scalar_one_or_none()

    if not role:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Role not found"},
        )

    return RoleDetailResponse(
        id=role.id,
        key=role.key,
        name=role.name,
        description=role.description,
        is_system=role.is_system,
        permissions=[p.key for p in role.permissions],
    )


@router.put("/roles/{role_id}/permissions")
async def set_role_permissions(
    role_id: int,
    permission_keys: list[str],
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()

    if not role:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Role not found"},
        )

    await db.execute(RolePermission.__table__.delete().where(RolePermission.role_id == role_id))

    if permission_keys:
        perms_result = await db.execute(
            select(Permission).where(Permission.key.in_(permission_keys))
        )
        permissions = perms_result.scalars().all()

        for perm in permissions:
            db.add(RolePermission(role_id=role_id, permission_id=perm.id))

    await db.commit()
    return {"message": "Permissions updated", "permissions": [p.key for p in permissions] if permission_keys else []}


@router.get("/permissions", response_model=list[PermissionResponse])
async def list_permissions(
    db: DBSession,
    principal = RequirePermission("admin:rbac_manage"),
):
    result = await db.execute(select(Permission).order_by(Permission.category, Permission.key))
    return result.scalars().all()


@router.get("/devices", response_model=PaginatedResponse[DeviceResponse])
async def list_devices(
    db: DBSession,
    principal = RequirePermission("admin:devices_manage"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    query = select(Device).where(Device.deleted_at.is_(None)).order_by(Device.name, Device.id)
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().all()

    count_query = select(func.count()).select_from(Device).where(Device.deleted_at.is_(None))
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router.post("/devices", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_device(
    data: DeviceCreate,
    db: DBSession,
    principal = RequirePermission("admin:devices_manage"),
):
    # Generate unique device_code
    code = None
    for _ in range(10):
        code = generate_device_code()
        result = await db.execute(select(Device).where(Device.device_code == code))
        if not result.scalar_one_or_none():
            break
        code = None
    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "server_error", "message": "Failed to generate unique device code"},
        )

    device = Device(
        name=data.name,
        device_type=data.device_type,
        device_code=code,
        token_hash="pending_registration",  # Placeholder until registered
        is_active=False,  # Pending registration
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)

    return {"id": device.id, "name": device.name, "device_code": device.device_code}


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    device_id: int,
    db: DBSession,
    principal = RequirePermission("admin:devices_manage"),
):
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.deleted_at.is_(None))
    )
    device = result.scalar_one_or_none()

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found"},
        )

    device.deleted_at = datetime.now(timezone.utc)
    await db.commit()


@router.put("/devices/{device_id}", response_model=DeviceResponse)
async def update_device(
    device_id: int,
    data: DeviceUpdate,
    db: DBSession,
    principal = RequirePermission("admin:devices_manage"),
):
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.deleted_at.is_(None))
    )
    device = result.scalar_one_or_none()

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found"},
        )

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(device, key, value)

    await db.commit()
    await db.refresh(device)
    return device

@router.post("/devices/{device_id}/rotate", response_model=dict)
async def rotate_device_token(
    device_id: int,
    db: DBSession,
    principal = RequirePermission("admin:devices_manage"),
):
    result = await db.execute(
        select(Device).where(Device.id == device_id, Device.deleted_at.is_(None))
    )
    device = result.scalar_one_or_none()

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found"},
        )

    secret = generate_token_secret()
    device.token_hash = hash_token(secret)
    await db.commit()

    token = f"dev.{device.id}.{secret}"
    return {"id": device.id, "name": device.name, "token": token}
