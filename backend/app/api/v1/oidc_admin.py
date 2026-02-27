from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DBSession, RequirePermission
from app.core.oidc_crypto import encrypt_secret
from app.models import OIDCSettings

router = APIRouter(prefix="/admin/oidc-settings", tags=["admin"])
public_router = APIRouter(prefix="/oidc", tags=["oidc"])


class OIDCSettingsResponse(BaseModel):
    enabled: bool
    issuer_url: str | None
    client_id: str | None
    has_client_secret: bool
    scopes: str
    button_text: str


class OIDCSettingsUpdate(BaseModel):
    enabled: bool | None = None
    issuer_url: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    scopes: str | None = None
    button_text: str | None = None


@router.get("/", response_model=OIDCSettingsResponse)
async def get_oidc_settings(
    db: DBSession,
    principal=RequirePermission("admin:users_manage"),
):
    result = await db.execute(select(OIDCSettings).where(OIDCSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        return OIDCSettingsResponse(
            enabled=False,
            issuer_url=None,
            client_id=None,
            has_client_secret=False,
            scopes="openid email profile",
            button_text="Login with SSO",
        )

    return OIDCSettingsResponse(
        enabled=settings_row.enabled,
        issuer_url=settings_row.issuer_url,
        client_id=settings_row.client_id,
        has_client_secret=bool(settings_row.client_secret_enc),
        scopes=settings_row.scopes,
        button_text=settings_row.button_text,
    )


@router.put("/", response_model=OIDCSettingsResponse)
async def update_oidc_settings(
    data: OIDCSettingsUpdate,
    db: DBSession,
    principal=RequirePermission("admin:users_manage"),
):
    if data.issuer_url is not None and not data.issuer_url.startswith("https://"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "validation_error", "message": "issuer_url must start with https://"},
        )

    result = await db.execute(select(OIDCSettings).where(OIDCSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None:
        settings_row = OIDCSettings(id=1)
        db.add(settings_row)

    update_data = data.model_dump(exclude_unset=True)
    client_secret = update_data.pop("client_secret", None)
    for key, value in update_data.items():
        setattr(settings_row, key, value)

    if client_secret:
        settings_row.client_secret_enc = encrypt_secret(client_secret)

    await db.commit()
    await db.refresh(settings_row)

    return OIDCSettingsResponse(
        enabled=settings_row.enabled,
        issuer_url=settings_row.issuer_url,
        client_id=settings_row.client_id,
        has_client_secret=bool(settings_row.client_secret_enc),
        scopes=settings_row.scopes,
        button_text=settings_row.button_text,
    )


@public_router.get("/public-info")
async def get_public_oidc_info(db: DBSession):
    result = await db.execute(select(OIDCSettings).where(OIDCSettings.id == 1))
    settings_row = result.scalar_one_or_none()
    if settings_row is None or not settings_row.enabled:
        return {"enabled": False, "button_text": ""}
    return {"enabled": True, "button_text": settings_row.button_text}
