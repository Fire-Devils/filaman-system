from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DBSession, RequirePermission
from app.models import AppSettings

router = APIRouter(prefix="/admin/app-settings", tags=["admin"])


class AppSettingsResponse(BaseModel):
    login_disabled: bool
    currency: str


class AppSettingsUpdate(BaseModel):
    login_disabled: bool | None = None
    currency: (
        Literal[
            "EUR",
            "USD",
            "GBP",
            "CHF",
            "CAD",
            "AUD",
            "JPY",
            "SEK",
            "NOK",
            "DKK",
            "PLN",
            "CZK",
        ]
        | None
    ) = None


@router.get("/", response_model=AppSettingsResponse)
async def get_app_settings(
    db: DBSession,
    principal=RequirePermission("admin:users_manage"),
):
    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        return AppSettingsResponse(login_disabled=False, currency="EUR")

    return AppSettingsResponse(
        login_disabled=settings_row.login_disabled, currency=settings_row.currency
    )


@router.put("/", response_model=AppSettingsResponse)
async def update_app_settings(
    data: AppSettingsUpdate,
    db: DBSession,
    principal=RequirePermission("admin:users_manage"),
):
    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        settings_row = AppSettings(id=1)
        db.add(settings_row)

    update_data = data.model_dump(exclude_unset=True)
    update_data = {k: v for k, v in update_data.items() if v is not None}
    for key, value in update_data.items():
        setattr(settings_row, key, value)

    await db.commit()
    await db.refresh(settings_row)

    return AppSettingsResponse(
        login_disabled=settings_row.login_disabled, currency=settings_row.currency
    )


public_router = APIRouter(prefix="/app-settings", tags=["app-settings"])


@public_router.get("/public-info", response_model=AppSettingsResponse)
async def get_public_app_settings(db: DBSession):
    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        return AppSettingsResponse(login_disabled=False, currency="EUR")

    return AppSettingsResponse(
        login_disabled=settings_row.login_disabled, currency=settings_row.currency
    )
