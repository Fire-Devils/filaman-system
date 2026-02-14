from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import async_session_maker
from app.core.security import Principal
from app.models import Device, Role, User

async def get_db():
    async with async_session_maker() as session:
        yield session


DBSession = Annotated[AsyncSession, Depends(get_db)]


async def require_auth(request: Request) -> Principal:
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "Authentication required"},
        )
    return principal


PrincipalDep = Annotated[Principal, Depends(require_auth)]


async def resolve_user_permissions(db: AsyncSession, user_id: int) -> set[str]:
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.roles).selectinload(Role.permissions))
    )
    user = result.scalar_one_or_none()
    if user is None:
        return set()

    permissions = set()
    for role in user.roles:
        for perm in role.permissions:
            permissions.add(perm.key)

    return permissions


def RequirePermission(permission_key: str):
    async def dependency(
        request: Request,
        db: DBSession,
    ) -> Principal:
        principal = getattr(request.state, "principal", None)
        if principal is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "unauthenticated", "message": "Authentication required"},
            )

        if principal.is_superadmin:
            return principal

        if principal.auth_type == "device":
            if principal.scopes is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={"code": "forbidden", "message": "Device has no scopes assigned"},
                )
            if permission_key not in principal.scopes:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={"code": "forbidden", "message": f"Permission '{permission_key}' required"},
                )
            return principal

        rbac_permissions = await resolve_user_permissions(db, principal.user_id)

        if principal.scopes is not None:
            effective = rbac_permissions.intersection(set(principal.scopes))
        else:
            effective = rbac_permissions

        if permission_key not in effective:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "forbidden", "message": f"Permission '{permission_key}' required"},
            )

        return principal

    return Depends(dependency)
