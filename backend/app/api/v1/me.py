from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep
from app.core.csrf import maybe_attach_csrf_cookie
from app.core.security import hash_password_async, verify_password_async
from app.models import Role, User

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


WidgetId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


class PreferencesResponse(BaseModel):
    dashboard_hidden_widgets: list[str] = []


class PreferencesUpdate(BaseModel):
    dashboard_hidden_widgets: Annotated[list[WidgetId], Field(max_length=50)] | None = None


class SidebarItemPreference(BaseModel):
    id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_/-]{1,128}$")]
    shown: bool = True
    pinned: bool | None = None


class SidebarPreferences(BaseModel):
    navigation: Annotated[list[SidebarItemPreference], Field(max_length=128)] = Field(default_factory=list)
    plugins: Annotated[list[SidebarItemPreference], Field(max_length=512)] = Field(default_factory=list)
    compact: bool = False
    hover: bool = True
    remember: bool = False
    showColorMode: bool = True


class SidebarPreferencesResponse(BaseModel):
    sidebar: SidebarPreferences | None = None
    theme: Literal["brand", "light", "dark"] | None = None
    expanded: bool | None = None


class SidebarPreferencesUpdate(SidebarPreferencesResponse):
    expected_sidebar: SidebarPreferences | None = None
    import_legacy: bool = False


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.get("", response_model=MeResponse)
async def get_me(
    request: Request,
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

    payload = MeResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        language=user.language,
        is_superadmin=user.is_superadmin,
        roles=roles,
        permissions=permissions,
    )
    response = JSONResponse(content=jsonable_encoder(payload))
    maybe_attach_csrf_cookie(request, response)
    return response


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


def _preferences_payload(user: User) -> PreferencesResponse:
    prefs = user.ui_preferences or {}
    return PreferencesResponse(
        dashboard_hidden_widgets=list(prefs.get("dashboard_hidden_widgets") or [])
    )


async def _preferences_user(db: AsyncSession, user_id: int, *, lock: bool = False) -> User:
    query = select(User).where(User.id == user_id).execution_options(populate_existing=True)
    if lock:
        if db.get_bind().dialect.name == "sqlite":
            # Acquire SQLite's write lock before reading the shared preferences JSON.
            await db.execute(update(User).where(User.id == user_id).values(updated_at=User.updated_at))
        else:
            query = query.with_for_update()
    user = await db.scalar(query)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "User not found"},
        )
    return user


@router.get("/preferences", response_model=PreferencesResponse)
async def get_preferences(principal: PrincipalDep, db: DBSession):
    user = await _preferences_user(db, principal.user_id)
    return _preferences_payload(user)


@router.patch("/preferences", response_model=PreferencesResponse)
async def update_preferences(
    data: PreferencesUpdate,
    principal: PrincipalDep,
    db: DBSession,
):
    user = await _preferences_user(db, principal.user_id, lock=True)

    # Reassign a new dict so SQLAlchemy detects the JSON change.
    prefs = dict(user.ui_preferences or {})
    if data.dashboard_hidden_widgets is not None:
        prefs["dashboard_hidden_widgets"] = sorted(set(data.dashboard_hidden_widgets))
    user.ui_preferences = prefs

    await db.commit()
    return _preferences_payload(user)


@router.get("/preferences/sidebar", response_model=SidebarPreferencesResponse)
async def get_sidebar_preferences(principal: PrincipalDep, db: DBSession, account_id: int | None = None):
    _check_sidebar_account(principal.user_id, account_id)
    user = await _preferences_user(db, principal.user_id)
    return SidebarPreferencesResponse.model_validate((user.ui_preferences or {}).get("sidebar_settings", {}))


@router.patch("/preferences/sidebar", response_model=SidebarPreferencesResponse)
async def update_sidebar_preferences(
    data: SidebarPreferencesUpdate, principal: PrincipalDep, db: DBSession, account_id: int | None = None
):
    _check_sidebar_account(principal.user_id, account_id)
    user = await _preferences_user(db, principal.user_id, lock=True)
    prefs = dict(user.ui_preferences or {})
    current = SidebarPreferencesResponse.model_validate(prefs.get("sidebar_settings", {}))
    if "expected_sidebar" in data.model_fields_set and data.expected_sidebar != current.sidebar:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "sidebar_changed", "message": "Sidebar settings have changed"},
        )
    importing_sidebar = data.import_legacy and current.sidebar is None
    if data.sidebar is not None and (not data.import_legacy or importing_sidebar):
        current.sidebar = data.sidebar
    if data.theme is not None and (not data.import_legacy or current.theme is None):
        current.theme = data.theme
    if current.sidebar and current.sidebar.remember:
        if data.expanded is not None and (not data.import_legacy or importing_sidebar):
            current.expanded = data.expanded
    else:
        current.expanded = None
    prefs["sidebar_settings"] = current.model_dump()
    user.ui_preferences = prefs
    await db.commit()
    return current


def _check_sidebar_account(user_id: int, account_id: int | None) -> None:
    if account_id is not None and account_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Signed-in account changed")


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
