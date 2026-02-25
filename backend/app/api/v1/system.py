"""Admin-Endpoints fuer System, Plugin-Management, Spoolman-Import und Killswitch."""

import logging
import sys
import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete, select

import httpx
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
    capabilities: dict | None = None
    is_active: bool
    installed_at: datetime
    installed_by: int | None

    class Config:
        from_attributes = True


class PluginInstallResponse(BaseModel):
    message: str
    plugin: PluginResponse


class AvailablePluginResponse(BaseModel):
    plugin_key: str
    name: str
    version: str
    description: str | None = None
    download_url: str
    is_installed: bool = False
    installed_version: str | None = None
    update_available: bool = False


class RegistryInstallRequest(BaseModel):
    download_url: str

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


GITHUB_RELEASES_URL = "https://api.github.com/repos/Fire-Devils/filaman-plugins/releases"

_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def _parse_semver(ver: str) -> tuple[int, ...] | None:
    """Semver-String in vergleichbares Tuple parsen, None bei ungueltigem Format."""
    m = _SEMVER_RE.match(ver)
    return tuple(int(x) for x in m.groups()) if m else None



@router.get("/plugins/available", response_model=list[AvailablePluginResponse])
async def list_available_plugins(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Verfuegbare Plugins aus dem GitHub-Registry abrufen.

    Fragt die GitHub Releases API ab, parst Tags im Format
    '{plugin_key}-v{version}' und gibt die jeweils neueste
    Version je Plugin zurueck, inklusive Install-/Update-Status.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(
                GITHUB_RELEASES_URL,
                headers={"Accept": "application/vnd.github+json"},
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "code": "registry_unavailable",
                    "message": f"GitHub-Registry nicht erreichbar: {e}",
                },
            )

    releases = resp.json()

    # Releases nach plugin_key gruppieren, nur neueste Version behalten
    latest: dict[str, dict] = {}
    for rel in releases:
        tag = rel.get("tag_name", "")
        # Format: {plugin_key}-v{version}
        if "-v" not in tag:
            continue
        key, _, ver = tag.rpartition("-v")
        if not key or not ver:
            continue

        semver = _parse_semver(ver)
        if semver is None:
            continue

        # ZIP-Asset finden
        assets = rel.get("assets", [])
        zip_asset = next(
            (a for a in assets if a["name"].endswith(".zip")),
            None,
        )
        if not zip_asset:
            continue

        if key not in latest or (_parse_semver(latest[key]["version"]) or ()) < semver:
            latest[key] = {
                "plugin_key": key,
                "name": rel.get("name", key),
                "version": ver,
                "description": rel.get("body", "")[:200] if rel.get("body") else None,
                "download_url": zip_asset["browser_download_url"],
            }

    # Install-Status ermitteln
    service = PluginInstallService(db)
    installed = await service.list_installed()
    installed_map = {p.plugin_key: p for p in installed}

    result: list[AvailablePluginResponse] = []
    for info in latest.values():
        existing = installed_map.get(info["plugin_key"])
        result.append(AvailablePluginResponse(
            plugin_key=info["plugin_key"],
            name=info["name"],
            version=info["version"],
            description=info["description"],
            download_url=info["download_url"],
            is_installed=existing is not None,
            installed_version=existing.version if existing else None,
            update_available=(
                existing is not None
                and (_parse_semver(info["version"]) or ()) > (_parse_semver(existing.version) or ())
            ),
        ))

    return result


@router.post(
    "/plugins/install-from-registry",
    response_model=PluginInstallResponse,
    status_code=status.HTTP_201_CREATED,
)
async def install_from_registry(
    body: RegistryInstallRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin aus der Registry (GitHub Release) installieren.

    Laedt die ZIP-Datei von der angegebenen URL herunter und
    leitet sie an die bestehende install_from_zip-Pipeline weiter.
    """
    from app.plugins.manager import plugin_manager

    # URL validieren: nur GitHub-Release-Assets erlauben
    if not body.download_url.startswith("https://github.com/Fire-Devils/filaman-plugins/"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_download_url",
                "message": "Nur Downloads aus dem offiziellen Plugin-Repository sind erlaubt",
            },
        )

    # ZIP herunterladen
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        try:
            resp = await client.get(body.download_url)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "code": "download_failed",
                    "message": f"ZIP-Download fehlgeschlagen: {e}",
                },
            )

    zip_data = resp.content

    if not zip_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "empty_download",
                "message": "Heruntergeladene Datei ist leer",
            },
        )

    async def stop_drivers_for_upgrade(driver_key: str) -> None:
        """Laufende Treiber stoppen und Module-Cache bereinigen."""
        for pid, drv in list(plugin_manager.drivers.items()):
            if drv.driver_key == driver_key:
                await plugin_manager.stop_printer(pid)
        prefix = f"app.plugins.{driver_key}"
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith(prefix):
                del sys.modules[mod_name]

    service = PluginInstallService(db)
    try:
        plugin, is_upgrade = await service.install_from_zip(
            zip_data=zip_data,
            installed_by=principal.user_id,
            stop_callback=stop_drivers_for_upgrade,
        )
    except PluginInstallError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": e.code,
                "message": str(e),
            },
        )

    # Treiber fuer zugehoerige Drucker (neu) starten
    if plugin.driver_key:
        result = await db.execute(
            select(Printer).where(
                Printer.driver_key == plugin.driver_key,
                Printer.is_active == True,
                Printer.deleted_at.is_(None),
            )
        )
        for p in result.scalars().all():
            await plugin_manager.start_printer(p)

    action = "aktualisiert" if is_upgrade else "installiert"
    return PluginInstallResponse(
        message=f"Plugin '{plugin.name}' v{plugin.version} erfolgreich {action}",
        plugin=PluginResponse.model_validate(plugin),
    )
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
    """Plugin aus ZIP-Datei installieren oder aktualisieren.

    Fuehrt die vollstaendige Pruefkette durch:
    - ZIP-Validierung
    - Struktur-Pruefung (plugin.json, __init__.py, driver.py)
    - Manifest-Validierung
    - Sicherheits-Pruefung
    - Treiber-Klassen-Pruefung
    - Upgrade oder Neuinstallation
    """
    from app.plugins.manager import plugin_manager

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

    async def stop_drivers_for_upgrade(driver_key: str) -> None:
        """Laufende Treiber stoppen und Module-Cache bereinigen."""
        for pid, drv in list(plugin_manager.drivers.items()):
            if drv.driver_key == driver_key:
                await plugin_manager.stop_printer(pid)
        # Module-Cache invalidieren fuer Neuimport
        prefix = f"app.plugins.{driver_key}"
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith(prefix):
                del sys.modules[mod_name]

    # Installation durchfuehren
    service = PluginInstallService(db)
    try:
        plugin, is_upgrade = await service.install_from_zip(
            zip_data=zip_data,
            installed_by=principal.user_id,
            stop_callback=stop_drivers_for_upgrade,
        )
    except PluginInstallError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": e.code,
                "message": str(e),
            },
        )

    # Treiber fuer zugehoerige Drucker (neu) starten
    if plugin.driver_key:
        result = await db.execute(
            select(Printer).where(
                Printer.driver_key == plugin.driver_key,
                Printer.is_active == True,
                Printer.deleted_at.is_(None),
            )
        )
        for p in result.scalars().all():
            await plugin_manager.start_printer(p)

    action = "aktualisiert" if is_upgrade else "installiert"
    return PluginInstallResponse(
        message=f"Plugin '{plugin.name}' v{plugin.version} erfolgreich {action}",
        plugin=PluginResponse.model_validate(plugin),
    )


@router.delete("/plugins/{plugin_key}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_plugin(
    plugin_key: str,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin deinstallieren."""
    from app.plugins.manager import plugin_manager

    service = PluginInstallService(db)

    # Plugin-Info holen fuer Treiber-Stopp
    plugin_info = await service.get_plugin(plugin_key)
    if plugin_info:
        # Laufende Treiber stoppen
        driver_key = plugin_info.driver_key or plugin_key
        for pid, drv in list(plugin_manager.drivers.items()):
            if drv.driver_key == driver_key:
                await plugin_manager.stop_printer(pid)
        # Module-Cache bereinigen
        prefix = f"app.plugins.{plugin_key}"
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith(prefix):
                del sys.modules[mod_name]

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
        return JSONResponse({
            "summary": preview.summary,
            "vendors": preview.vendors,
            "filaments": preview.filaments,
            "spools": preview.spools,
            "locations": preview.locations,
            "colors": preview.colors,
        })
    except SpoolmanImportError as e:
        logger.warning(f"Spoolman Import Error: {e}", exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": e.code, "message": str(e)}},
        )
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.exception(f"Unexpected error in Spoolman preview: {tb}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler: {str(e)}\n\nTraceback:\n{tb}",
                    "type": type(e).__name__,
                }
            },
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
        logger.warning(f"Spoolman Import Execution Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.exception(f"Unexpected error in Spoolman import execution: {tb}")
        # Return JSONResponse for 500 errors to give more details
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler beim Import: {str(e)}\n\nTraceback:\n{tb}",
                    "type": type(e).__name__,
                }
            },
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
