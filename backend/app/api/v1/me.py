from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep
from app.core.security import hash_password_async, verify_password_async
from app.models import User, Role, Permission, UserRole, RolePermission

router = APIRouter(prefix="/me", tags=["me"])


class MeResponse(BaseModel):
    id: int
    email: str
    display_name: str | None
    language: str
    is_superadmin: bool
    roles: list[str] = []
    permissions: list[str] = []

    class Config:
        from_attributes = True


class MeUpdate(BaseModel):
    display_name: str | None = None
    language: str | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.get("", response_model=MeResponse)
async def get_me(
    principal: PrincipalDep,
    db: DBSession,
):
    result = await db.execute(
        select(User)
        .where(User.id == principal.user_id)
        .options(selectinload(User.roles).selectinload(Role.permissions))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    roles = [r.key for r in user.roles]
    permissions = list(set(
        p.key for r in user.roles for p in r.permissions
    ))

    return MeResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        language=user.language,
        is_superadmin=user.is_superadmin,
        roles=roles,
        permissions=permissions,
    )


@router.patch("", response_model=MeResponse)
async def update_me(
    data: MeUpdate,
    principal: PrincipalDep,
    db: DBSession,
):
    result = await db.execute(
        select(User)
        .where(User.id == principal.user_id)
        .options(selectinload(User.roles).selectinload(Role.permissions))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    if data.display_name is not None:
        user.display_name = data.display_name
    if data.language is not None:
        user.language = data.language

    await db.commit()
    await db.refresh(user, attribute_names=["language", "display_name"])

    roles = [r.key for r in user.roles]
    permissions = list(set(
        p.key for r in user.roles for p in r.permissions
    ))

    return MeResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        language=user.language,
        is_superadmin=user.is_superadmin,
        roles=roles,
        permissions=permissions,
    )


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    principal: PrincipalDep,
    db: DBSession,
):
    result = await db.execute(select(User).where(User.id == principal.user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )

    if not user.password_hash:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "no_password", "message": "User has no password set (OAuth only)"},
        )

    if not await verify_password_async(data.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_password", "message": "Current password is incorrect"},
        )

    user.password_hash = await hash_password_async(data.new_password)
    await db.commit()

    return {"message": "Password changed successfully"}
