from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DBSession, RequirePermission
from app.core.cache import response_cache
from app.models import AppSettings

router = APIRouter(prefix="/admin/app-settings", tags=["admin"])


class AppSettingsResponse(BaseModel):
    login_disabled: bool
    currency: str
    rfid_extended_data_enabled: bool
    rfid_protocol: str
    default_spool_core_weight_g: float | None = None
    bambu_unmatched_profile_fallback: str = "generic"


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
    rfid_extended_data_enabled: bool | None = None
    rfid_protocol: Literal["openspool", "filaman"] | None = None
    default_spool_core_weight_g: float | None = None
    bambu_unmatched_profile_fallback: Literal["generic", "bambu"] | None = None


@router.get("/", response_model=AppSettingsResponse)
async def get_app_settings(
    db: DBSession,
    principal=RequirePermission("admin:users_manage"),
):
    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        return AppSettingsResponse(login_disabled=False, currency="EUR", rfid_extended_data_enabled=False, rfid_protocol="openspool")

    return AppSettingsResponse(
        login_disabled=settings_row.login_disabled,
        currency=settings_row.currency,
        rfid_extended_data_enabled=settings_row.rfid_extended_data_enabled,
        rfid_protocol=settings_row.rfid_protocol,
        default_spool_core_weight_g=settings_row.default_spool_core_weight_g,
        bambu_unmatched_profile_fallback=settings_row.bambu_unmatched_profile_fallback,
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

    NULLABLE_SETTINGS = {"default_spool_core_weight_g"}
    update_data = data.model_dump(exclude_unset=True)
    update_data = {k: v for k, v in update_data.items() if v is not None or k in NULLABLE_SETTINGS}
    for key, value in update_data.items():
        setattr(settings_row, key, value)

    await db.commit()
    await db.refresh(settings_row)

    response_cache.delete("app_settings_public")

    return AppSettingsResponse(
        login_disabled=settings_row.login_disabled,
        currency=settings_row.currency,
        rfid_extended_data_enabled=settings_row.rfid_extended_data_enabled,
        rfid_protocol=settings_row.rfid_protocol,
        default_spool_core_weight_g=settings_row.default_spool_core_weight_g,
        bambu_unmatched_profile_fallback=settings_row.bambu_unmatched_profile_fallback,
    )


public_router = APIRouter(prefix="/app-settings", tags=["app-settings"])


@public_router.get("/public-info", response_model=AppSettingsResponse)
async def get_public_app_settings(db: DBSession):
    cached = response_cache.get("app_settings_public")
    if cached is not None:
        return cached

    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        resp = AppSettingsResponse(login_disabled=False, currency="EUR", rfid_extended_data_enabled=False, rfid_protocol="openspool")
    else:
        resp = AppSettingsResponse(
            login_disabled=settings_row.login_disabled,
            currency=settings_row.currency,
            rfid_extended_data_enabled=settings_row.rfid_extended_data_enabled,
            rfid_protocol=settings_row.rfid_protocol,
            default_spool_core_weight_g=settings_row.default_spool_core_weight_g,
            bambu_unmatched_profile_fallback=settings_row.bambu_unmatched_profile_fallback,
        )

    response_cache.set("app_settings_public", resp, ttl=300)
    return resp
