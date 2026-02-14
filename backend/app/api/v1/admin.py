from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.core.security import generate_token_secret, hash_password, pwd_context
from app.models import Device, Permission, Role, User, UserRole, RolePermission

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


class DeviceResponse(BaseModel):
    id: int
    name: str
    is_active: bool
    scopes: list[str] | None
    last_used_at: datetime | None
    created_at: datetime | None

    class Config:
        from_attributes = True


class DeviceCreate(BaseModel):
    name: str
    scopes: list[str] | None = None


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
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Email already exists"},
        )

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
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

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(user, key, value)

    await db.commit()
    await db.refresh(user)
    return user


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: int,
    new_password: str,
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

    user.password_hash = hash_password(new_password)
    await db.commit()

    return {"message": "Password reset successfully"}


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
    query = select(Device).where(Device.deleted_at.is_(None)).order_by(Device.name)
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
    secret = generate_token_secret()
    device = Device(
        name=data.name,
        token_hash=hash_password(secret),
        scopes=data.scopes,
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)

    token = f"dev.{device.id}.{secret}"
    return {"id": device.id, "name": device.name, "token": token}


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

    device.deleted_at = datetime.utcnow()
    await db.commit()


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
    device.token_hash = hash_password(secret)
    await db.commit()

    token = f"dev.{device.id}.{secret}"
    return {"id": device.id, "name": device.name, "token": token}
