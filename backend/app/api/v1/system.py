"""Admin-Endpoints fuer System, Plugin-Management, Spoolman-Import und Killswitch."""

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from pydantic import BaseModel
from sqlalchemy import delete

from app.api.deps import DBSession, RequirePermission
from app.models import (
    Color,
    Filament,
    FilamentColor,
    FilamentPrinterProfile,
    FilamentRating,
    Location,
    Manufacturer,
    Printer,
    PrinterAmsUnit,
    PrinterSlot,
    PrinterSlotAssignment,
    PrinterSlotEvent,
    Spool,
    SpoolEvent,
)
from app.services.plugin_service import PluginInstallError, PluginInstallService
from app.services.spoolman_import_service import SpoolmanImportError, SpoolmanImportService

logger = logging.getLogger(__name__)

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
    plugin_type: str
    driver_key: str | None
    page_url: str | None
    config_schema: dict | None
    is_active: bool
    installed_at: datetime
    installed_by: int | None

    class Config:
        from_attributes = True


class PluginInstallResponse(BaseModel):
    message: str
    plugin: PluginResponse


class PluginToggleRequest(BaseModel):
    is_active: bool


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


@router.patch("/plugins/{plugin_key}/active", response_model=PluginResponse)
async def toggle_plugin_active(
    plugin_key: str,
    body: PluginToggleRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin aktivieren oder deaktivieren."""
    service = PluginInstallService(db)
    try:
        plugin = await service.set_active(plugin_key, body.is_active)
    except PluginInstallError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": e.code,
                "message": str(e),
            },
        )
    return plugin


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


# ------------------------------------------------------------------ #
#  Spoolman Import Endpoints
# ------------------------------------------------------------------ #

class SpoolmanUrlRequest(BaseModel):
    url: str


class SpoolmanConnectionResponse(BaseModel):
    status: str
    url: str
    info: dict[str, Any]


class SpoolmanPreviewResponse(BaseModel):
    summary: dict[str, int]
    vendors: list[dict[str, Any]]
    filaments: list[dict[str, Any]]
    spools: list[dict[str, Any]]
    locations: list[dict[str, Any]]
    colors: list[dict[str, str]]


class SpoolmanImportResultResponse(BaseModel):
    manufacturers_created: int
    manufacturers_skipped: int
    locations_created: int
    locations_skipped: int
    colors_created: int
    colors_skipped: int
    filaments_created: int
    filaments_skipped: int
    spools_created: int
    spools_skipped: int
    errors: list[str]
    warnings: list[str]


@router.post(
    "/spoolman-import/test-connection",
    response_model=SpoolmanConnectionResponse,
)
async def spoolman_test_connection(
    body: SpoolmanUrlRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Verbindung zu Spoolman-Instanz testen."""
    service = SpoolmanImportService(db)
    try:
        result = await service.test_connection(body.url)
        return result
    except SpoolmanImportError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )


@router.post(
    "/spoolman-import/preview",
    response_model=SpoolmanPreviewResponse,
)
async def spoolman_preview(
    body: SpoolmanUrlRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Vorschau der zu importierenden Daten."""
    service = SpoolmanImportService(db)
    try:
        preview = await service.preview(body.url)
        return {
            "summary": preview.summary,
            "vendors": preview.vendors,
            "filaments": preview.filaments,
            "spools": preview.spools,
            "locations": preview.locations,
            "colors": preview.colors,
        }
    except SpoolmanImportError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )


@router.post(
    "/spoolman-import/execute",
    response_model=SpoolmanImportResultResponse,
)
async def spoolman_execute(
    body: SpoolmanUrlRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Spoolman-Import ausfuehren."""
    service = SpoolmanImportService(db)
    try:
        result = await service.execute(body.url)
        return result
    except SpoolmanImportError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )


# ------------------------------------------------------------------ #
#  Killswitch – Alle Daten ausser Users/Auth/RBAC loeschen
# ------------------------------------------------------------------ #

class KillswitchResponse(BaseModel):
    message: str
    deleted: dict[str, int]


@router.delete("/killswitch", response_model=KillswitchResponse)
async def killswitch(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Alle Spulen, Filamente, Hersteller, Farben, Standorte, Drucker
    und zugehoerige Events/Logs loeschen.

    Benutzer, Rollen, Berechtigungen, Devices und Plugins bleiben erhalten.
    Spool-Statuses (Seed-Daten) bleiben ebenfalls erhalten.

    Erfordert Superadmin-Berechtigung (admin:plugins_manage).
    """
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can execute the killswitch",
            },
        )

    deleted: dict[str, int] = {}

    # Reihenfolge beachten: abhaengige Tabellen zuerst loeschen
    tables_in_order: list[tuple[str, type]] = [
        ("printer_slot_events", PrinterSlotEvent),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slots", PrinterSlot),
        ("printer_ams_units", PrinterAmsUnit),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("printers", Printer),
        ("spool_events", SpoolEvent),
        ("spools", Spool),
        ("filament_ratings", FilamentRating),
        ("filament_colors", FilamentColor),
        ("filaments", Filament),
        ("colors", Color),
        ("manufacturers", Manufacturer),
        ("locations", Location),
    ]

    for table_name, model in tables_in_order:
        result = await db.execute(delete(model))
        deleted[table_name] = result.rowcount  # type: ignore[assignment]

    await db.commit()

    total = sum(deleted.values())
    logger.warning(
        "KILLSWITCH executed by user %s – %d rows deleted across %d tables",
        principal.user_id,
        total,
        len([v for v in deleted.values() if v > 0]),
    )

    return KillswitchResponse(
        message=f"Killswitch executed. {total} rows deleted.",
        deleted=deleted,
    )
