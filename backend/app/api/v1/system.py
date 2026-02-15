"""Admin-Endpoints fuer System und Plugin-Management."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from pydantic import BaseModel

from app.api.deps import DBSession, RequirePermission
from app.services.plugin_service import PluginInstallError, PluginInstallService

router = APIRouter(prefix="/admin/system", tags=["admin-system"])


# ------------------------------------------------------------------ #
#  Response-Schemas
# ------------------------------------------------------------------ #

class PluginResponse(BaseModel):
    id: int
    plugin_key: str
    name: str
    version: str
    description: str | None
    author: str | None
    homepage: str | None
    license: str | None
    driver_key: str
    config_schema: dict | None
    is_active: bool
    installed_at: datetime
    installed_by: int | None

    class Config:
        from_attributes = True


class PluginInstallResponse(BaseModel):
    message: str
    plugin: PluginResponse


# ------------------------------------------------------------------ #
#  Endpoints
# ------------------------------------------------------------------ #

@router.get("/plugins", response_model=list[PluginResponse])
async def list_plugins(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Alle installierten Plugins auflisten."""
    service = PluginInstallService(db)
    plugins = await service.list_installed()
    return plugins


@router.post(
    "/plugins/install",
    response_model=PluginInstallResponse,
    status_code=status.HTTP_201_CREATED,
)
async def install_plugin(
    db: DBSession,
    file: UploadFile = File(...),
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin aus ZIP-Datei installieren.

    Fuehrt die vollstaendige Pruefkette durch:
    - ZIP-Validierung
    - Struktur-Pruefung (plugin.json, __init__.py, driver.py)
    - Manifest-Validierung
    - Sicherheits-Pruefung
    - Treiber-Klassen-Pruefung
    - Konflikt-Pruefung
    """
    # Content-Type pruefen
    if file.content_type not in (
        "application/zip",
        "application/x-zip-compressed",
        "application/octet-stream",
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Erwartet ZIP-Datei, erhalten: {file.content_type}",
            },
        )

    # Datei lesen
    zip_data = await file.read()

    if not zip_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "empty_file",
                "message": "Leere Datei",
            },
        )

    # Installation durchfuehren
    service = PluginInstallService(db)
    try:
        plugin = await service.install_from_zip(
            zip_data=zip_data,
            installed_by=principal.user_id,
        )
    except PluginInstallError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": e.code,
                "message": str(e),
            },
        )

    return PluginInstallResponse(
        message=f"Plugin '{plugin.name}' v{plugin.version} erfolgreich installiert",
        plugin=PluginResponse.model_validate(plugin),
    )


@router.delete("/plugins/{plugin_key}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_plugin(
    plugin_key: str,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin deinstallieren."""
    service = PluginInstallService(db)
    try:
        await service.uninstall(plugin_key)
    except PluginInstallError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": e.code,
                "message": str(e),
            },
        )


@router.get("/plugins/{plugin_key}", response_model=PluginResponse)
async def get_plugin(
    plugin_key: str,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Details eines installierten Plugins abrufen."""
    service = PluginInstallService(db)
    plugin = await service.get_plugin(plugin_key)

    if not plugin:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "not_found",
                "message": f"Plugin '{plugin_key}' nicht gefunden",
            },
        )

    return plugin
