"""Admin-Endpoints fuer System, Plugin-Management, Spoolman-Import und Killswitch."""

import logging
import os
import shutil
import sys
import re
from datetime import datetime, timezone
from typing import Any
from pathlib import Path
import time

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete, select, text
from sqlalchemy.inspection import inspect as sa_inspect

import httpx
from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.config import settings
from app.models import (
    AppSettings,
    Color,
    Device,
    Filament,
    FilamentColor,
    FilamentPrinterProfile,
    FilamentPrinterParam,
    FilamentRating,
    InstalledPlugin,
    Location,
    Manufacturer,
    OAuthIdentity,
    OIDCAuthState,
    OIDCSettings,
    Permission,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    PrinterSlotEvent,
    Role,
    RolePermission,
    Spool,
    SpoolEvent,
    SpoolPrinterParam,
    SpoolStatus,
    SystemExtraField,
    User,
    UserApiKey,
    UserPermission,
    UserRole,
    UserSession,
)
from app.services.plugin_service import PluginInstallError, PluginInstallService
from app.services.spoolman_import_service import SpoolmanImportError, SpoolmanImportService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/system", tags=["admin-system"])

# Oeffentlicher Router fuer Plugin-Navigation (kein Admin-Prefix)
public_router = APIRouter(tags=["plugins"])


# ------------------------------------------------------------------ #
#  Response-Schemas
# ------------------------------------------------------------------ #

class PluginNavItem(BaseModel):
    """Navigations-Eintrag fuer ein Plugin mit eigener Seite."""
    plugin_key: str
    name: str
    page_url: str

    class Config:
        from_attributes = True


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
#  Public Endpoints (kein Admin-Prefix)
# ------------------------------------------------------------------ #

@public_router.get("/plugin-nav", response_model=list[PluginNavItem])
async def plugin_nav(
    db: DBSession,
    _principal: PrincipalDep,
):
    result = await db.execute(
        select(InstalledPlugin)
        .where(InstalledPlugin.is_active.is_(True))
        .where(InstalledPlugin.show_in_nav.is_(True))
        .where(InstalledPlugin.page_url.isnot(None))
        .where(InstalledPlugin.page_url != "")
        .order_by(InstalledPlugin.name)
    )
    return result.scalars().all()


# ------------------------------------------------------------------ #
#  Admin Endpoints
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


FILAMAN_PLUGINS_URL = "https://www.filaman.app/plugins/"
GITHUB_SYSTEM_RELEASES_URL = "https://api.github.com/repos/Fire-Devils/filaman-system/releases/latest"

_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def _parse_semver(ver: str) -> tuple[int, ...] | None:
    """Semver-String in vergleichbares Tuple parsen, None bei ungueltigem Format."""
    m = _SEMVER_RE.match(ver)
    return tuple(int(x) for x in m.groups()) if m else None


_ZIP_LINK_RE = re.compile(r'href="([^"]+\.zip)"', re.IGNORECASE)
_ZIP_NAME_RE = re.compile(r'^(.+?)-([\d]+\.[\d]+\.[\d]+)\.zip$')


async def _fetch_available_from_filaman() -> dict[str, dict]:
    """Verfuegbare Plugins von filaman.app/plugins/ abrufen.

    Parst das Directory-Listing nach ZIP-Dateien im Format
    '{plugin_key}-{version}.zip' und gibt ein Dict zurueck:
    {plugin_key: {"plugin_key": ..., "version": ..., "download_url": ...}}
    mit jeweils nur der neuesten Version pro Plugin.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(FILAMAN_PLUGINS_URL)
        resp.raise_for_status()

    html = resp.text
    zip_links = _ZIP_LINK_RE.findall(html)

    latest: dict[str, dict] = {}
    for link in zip_links:
        # Nur den Dateinamen extrahieren (falls relativer oder absoluter Pfad)
        filename = link.rsplit("/", 1)[-1]
        m = _ZIP_NAME_RE.match(filename)
        if not m:
            continue
        key, ver = m.group(1), m.group(2)
        semver = _parse_semver(ver)
        if semver is None:
            continue

        # Download-URL bauen
        if link.startswith("http"):
            download_url = link
        else:
            download_url = FILAMAN_PLUGINS_URL + filename

        if key not in latest or (_parse_semver(latest[key]["version"]) or ()) < semver:
            latest[key] = {
                "plugin_key": key,
                "name": key,
                "version": ver,
                "description": None,
                "download_url": download_url,
            }

    return latest


# ------------------------------------------------------------------ #
#  Version-Check (System + Plugins) with 24h cache
# ------------------------------------------------------------------ #

_VERSION_CACHE: dict[str, Any] = {"data": None, "ts": 0.0}
_VERSION_CACHE_TTL = 86400  # 24 hours in seconds


def _invalidate_version_cache() -> None:
    """Version-Cache invalidieren (nach Plugin-Installation/-Deinstallation)."""
    _VERSION_CACHE["data"] = None
    _VERSION_CACHE["ts"] = 0.0


def _read_installed_version() -> str:
    """Installierte System-Version aus version.txt lesen."""
    # In Docker: /app/version.txt; lokal: ../version.txt relativ zum Backend
    candidates = [
        Path("/app/version.txt"),
        Path(__file__).resolve().parents[3] / "version.txt",
    ]
    for p in candidates:
        if p.is_file():
            return p.read_text().strip()
    return "unknown"


class VersionCheckResponse(BaseModel):
    installed_version: str
    latest_version: str | None = None
    update_available: bool = False
    latest_plugins: list[AvailablePluginResponse] = []


@router.get("/version-check", response_model=VersionCheckResponse)
async def version_check(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """System-Version und Plugin-Updates pruefen (24h Cache)."""
    now = time.time()
    installed = _read_installed_version()

    # Return cached data if still fresh
    if _VERSION_CACHE["data"] is not None and (now - _VERSION_CACHE["ts"]) < _VERSION_CACHE_TTL:
        cached = _VERSION_CACHE["data"]
        # Always use current installed version (may change after update)
        cached["installed_version"] = installed
        cached["update_available"] = (
            (_parse_semver(cached["latest_version"]) or ())
            > (_parse_semver(installed) or ())
        ) if cached["latest_version"] else False
        return VersionCheckResponse(**cached)

    # Fetch latest system version from GitHub
    latest_version: str | None = None
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(
                GITHUB_SYSTEM_RELEASES_URL,
                headers={"Accept": "application/vnd.github+json"},
            )
            resp.raise_for_status()
            release_data = resp.json()
            tag = release_data.get("tag_name", "")
            # Strip leading 'v' if present
            latest_version = tag.lstrip("v") if tag else None
        except httpx.HTTPError:
            logger.warning("Failed to fetch latest system version from GitHub")

    # Fetch available plugins from filaman.app
    plugin_updates: list[AvailablePluginResponse] = []
    try:
        latest = await _fetch_available_from_filaman()

        service = PluginInstallService(db)
        installed_plugins = await service.list_installed()
        installed_map = {p.plugin_key: p for p in installed_plugins}

        for info in latest.values():
            existing = installed_map.get(info["plugin_key"])
            plugin_updates.append(AvailablePluginResponse(
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
    except httpx.HTTPError:
        logger.warning("Failed to fetch plugin updates from filaman.app")

    update_available = (
        (_parse_semver(latest_version) or ()) > (_parse_semver(installed) or ())
    ) if latest_version else False

    result_data = {
        "installed_version": installed,
        "latest_version": latest_version,
        "update_available": update_available,
        "latest_plugins": plugin_updates,
    }

    _VERSION_CACHE["data"] = result_data
    _VERSION_CACHE["ts"] = now

    return VersionCheckResponse(**result_data)

@router.get("/plugins/available", response_model=list[AvailablePluginResponse])
async def list_available_plugins(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Verfuegbare Plugins aus dem FilaMan-Plugin-Verzeichnis abrufen.

    Fragt das Directory-Listing auf filaman.app/plugins/ ab, parst
    ZIP-Dateinamen im Format '{plugin_key}-{version}.zip' und gibt
    die jeweils neueste Version je Plugin zurueck, inklusive Install-/Update-Status.
    """
    try:
        latest = await _fetch_available_from_filaman()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "registry_unavailable",
                "message": f"Plugin-Verzeichnis nicht erreichbar: {e}",
            },
        )

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
    request: Request,
    body: RegistryInstallRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Plugin aus dem FilaMan-Plugin-Verzeichnis installieren.

    Laedt die ZIP-Datei von der angegebenen URL herunter und
    leitet sie an die bestehende install_from_zip-Pipeline weiter.
    """
    from app.plugins.manager import plugin_manager

    # URL validieren: nur Downloads von filaman.app erlauben
    if not body.download_url.startswith(FILAMAN_PLUGINS_URL):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_download_url",
                "message": "Nur Downloads aus dem offiziellen Plugin-Verzeichnis sind erlaubt",
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

    # Import-/Integration-Plugin Router dynamisch mounten
    if plugin.plugin_type in ("import", "integration"):
        from app.api.v1.router import mount_plugin_router_on_app
        mount_plugin_router_on_app(request.app, plugin.plugin_key)

    # Version-Cache invalidieren (Plugin-Status hat sich geaendert)
    _invalidate_version_cache()

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
    request: Request,
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

    # Import-/Integration-Plugin Router dynamisch mounten
    if plugin.plugin_type in ("import", "integration"):
        from app.api.v1.router import mount_plugin_router_on_app
        mount_plugin_router_on_app(request.app, plugin.plugin_key)

    # Version-Cache invalidieren (Plugin-Status hat sich geaendert)
    _invalidate_version_cache()

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
    delete_data: bool = Query(False, description="Also delete SystemExtraFields and printer_params created by this plugin"),
):
    """Plugin deinstallieren."""
    from app.plugins.manager import plugin_manager

    service = PluginInstallService(db)

    # Plugin-Info holen fuer Treiber-Stopp
    plugin_info = await service.get_plugin(plugin_key)
    driver_key = plugin_info.driver_key or plugin_key if plugin_info else plugin_key

    if plugin_info:
        # Laufende Treiber stoppen
        for pid, drv in list(plugin_manager.drivers.items()):
            if drv.driver_key == driver_key:
                await plugin_manager.stop_printer(pid)
        # Module-Cache bereinigen
        prefix = f"app.plugins.{plugin_key}"
        for mod_name in list(sys.modules.keys()):
            if mod_name.startswith(prefix):
                del sys.modules[mod_name]

    # Optionally delete plugin-created data
    if delete_data:
        from app.models.printer import Printer
        from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam
        from app.models.system_extra_field import SystemExtraField

        # Delete SystemExtraFields with source matching this plugin
        await db.execute(
            delete(SystemExtraField).where(SystemExtraField.source == driver_key)
        )

        # Find all printers belonging to this plugin (including soft-deleted)
        printer_result = await db.execute(
            select(Printer.id).where(Printer.driver_key == driver_key)
        )
        printer_ids = [row[0] for row in printer_result.all()]

        if printer_ids:
            await db.execute(
                delete(FilamentPrinterParam).where(
                    FilamentPrinterParam.printer_id.in_(printer_ids)
                )
            )
            await db.execute(
                delete(SpoolPrinterParam).where(
                    SpoolPrinterParam.printer_id.in_(printer_ids)
                )
            )

        await db.commit()
        logger.info(f"Deleted plugin data (SystemExtraFields + printer_params) for driver '{driver_key}'")

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

    # Version-Cache invalidieren (Plugin entfernt)
    _invalidate_version_cache()

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
        ("filament_printer_params", FilamentPrinterParam),
        ("spool_printer_params", SpoolPrinterParam),
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

    try:
        for table_name, model in tables_in_order:
            result = await db.execute(delete(model))
            deleted[table_name] = result.rowcount or 0

        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("KILLSWITCH failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "killswitch_failed", "message": str(exc)},
        )

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


# ------------------------------------------------------------------ #
#  Backup / Restore Endpoints
# ------------------------------------------------------------------ #

class BackupMetadata(BaseModel):
    export_date: str
    app_version: str
    schema_version: str | None


class BackupExportResponse(BaseModel):
    metadata: BackupMetadata
    data: dict[str, list[dict[str, Any]]]


class BackupImportResponse(BaseModel):
    message: str
    imported: dict[str, int]


def _serialize_row(row: Any) -> dict[str, Any]:
    """Serialize SQLAlchemy model instance to dict with JSON-compatible values."""
    result = {}
    mapper = sa_inspect(type(row))
    
    for attr in mapper.column_attrs:
        col = attr.columns[0]
        value = getattr(row, attr.key)
        
        if isinstance(value, datetime):
            result[col.name] = value.isoformat()
        else:
            result[col.name] = value
    
    return result


async def _export_all_data(db: DBSession) -> dict[str, list[dict[str, Any]]]:
    """Export all tables in dependency order."""
    data = {}
    
    # Order: independent tables first, then dependent tables
    tables_order = [
        # Seed/Config data
        ("spool_statuses", SpoolStatus),
        ("permissions", Permission),
        ("roles", Role),
        ("app_settings", AppSettings),
        
        # Users and auth
        ("users", User),
        ("user_roles", UserRole),
        ("user_permissions", UserPermission),
        ("role_permissions", RolePermission),
        ("oauth_identities", OAuthIdentity),
        ("user_api_keys", UserApiKey),
        ("user_sessions", UserSession),
        ("oidc_settings", OIDCSettings),
        ("oidc_auth_states", OIDCAuthState),
        
        # Devices
        ("devices", Device),
        
        # Plugins
        ("installed_plugins", InstalledPlugin),
        
        # Domain data - independent
        ("manufacturers", Manufacturer),
        ("colors", Color),
        ("locations", Location),
        
        # Domain data - dependent
        ("filaments", Filament),
        ("filament_colors", FilamentColor),
        ("filament_ratings", FilamentRating),
        ("system_extra_fields", SystemExtraField),
        ("printers", Printer),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("filament_printer_params", FilamentPrinterParam),
        ("spools", Spool),
        ("spool_printer_params", SpoolPrinterParam),
        ("spool_events", SpoolEvent),
        ("printer_slots", PrinterSlot),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slot_events", PrinterSlotEvent),
    ]
    
    for table_name, model in tables_order:
        result = await db.execute(select(model))
        rows = result.scalars().all()
        data[table_name] = [_serialize_row(row) for row in rows]
        logger.info(f"Exported {len(rows)} rows from {table_name}")
    
    return data


async def _export_inventory_data(db: DBSession) -> dict[str, list[dict[str, Any]]]:
    """Export only inventory/domain data (no users, auth, devices, plugins)."""
    data = {}
    
    # Only domain tables - no users, auth, devices, plugins
    tables_order = [
        # Independent domain data
        ("manufacturers", Manufacturer),
        ("colors", Color),
        ("locations", Location),
        
        # Dependent domain data
        ("filaments", Filament),
        ("filament_colors", FilamentColor),
        ("filament_ratings", FilamentRating),
        ("system_extra_fields", SystemExtraField),
        ("printers", Printer),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("filament_printer_params", FilamentPrinterParam),
        ("spools", Spool),
        ("spool_printer_params", SpoolPrinterParam),
        ("spool_events", SpoolEvent),
        ("printer_slots", PrinterSlot),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slot_events", PrinterSlotEvent),
    ]
    
    for table_name, model in tables_order:
        result = await db.execute(select(model))
        rows = result.scalars().all()
        data[table_name] = [_serialize_row(row) for row in rows]
        logger.info(f"Exported {len(rows)} inventory rows from {table_name}")
    
    return data


async def _get_schema_version(db: DBSession) -> str | None:
    """Get current Alembic schema version from alembic_version table."""
    try:
        result = await db.execute(text("SELECT version_num FROM alembic_version"))
        version = result.scalar_one_or_none()
        return version
    except Exception:
        return None


@router.get("/backup/export")
async def export_backup(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Export complete database backup as JSON.
    
    Exports all tables including users, passwords, sessions, API keys,
    roles, devices, plugins, and all domain data.
    
    WARNING: Contains sensitive data (password hashes, API keys, secrets).
    Store securely!
    """
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can export backups",
            },
        )
    
    logger.info(f"Starting backup export by user {principal.user_id}")
    
    # Get schema version
    schema_version = await _get_schema_version(db)
    
    # Get app version
    app_version = _read_installed_version()
    
    # Export all data
    data = await _export_all_data(db)
    
    metadata = BackupMetadata(
        export_date=datetime.now(timezone.utc).isoformat(),
        app_version=app_version,
        schema_version=schema_version,
    )
    
    logger.info(f"Backup export completed by user {principal.user_id}")
    
    return JSONResponse(
        content={
            "metadata": metadata.model_dump(),
            "data": data,
        },
        headers={
            "Content-Disposition": f'attachment; filename="filaman_backup_{datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")}.json"'
        },
    )


@router.get("/backup/export-inventory")
async def export_inventory_backup(
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Export inventory data only (no users, auth, devices, plugins).
    
    Exports: manufacturers, colors, locations, filaments, spools, printers,
    ratings, events, and all related domain data.
    
    Does NOT export: users, passwords, API keys, sessions, roles, permissions,
    devices, plugins, OIDC settings.
    
    Safe to share between instances.
    """
    logger.info(f"Starting inventory backup export by user {principal.user_id}")
    
    schema_version = await _get_schema_version(db)
    app_version = _read_installed_version()
    
    data = await _export_inventory_data(db)
    
    metadata = BackupMetadata(
        export_date=datetime.now(timezone.utc).isoformat(),
        app_version=app_version,
        schema_version=schema_version,
    )
    
    logger.info(f"Inventory backup export completed by user {principal.user_id}")
    
    return JSONResponse(
        content={
            "metadata": metadata.model_dump(),
            "data": data,
        },
        headers={
            "Content-Disposition": f'attachment; filename="filaman_inventory_{datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")}.json"'
        },
    )


async def _create_auto_backup(db: DBSession) -> Path:
    """Create automatic backup before import/restore operations."""
    backup_dir = Path("/app/data/backups")
    backup_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"auto_backup_before_import_{timestamp}.json"
    
    # Export data
    data = await _export_all_data(db)
    schema_version = await _get_schema_version(db)
    app_version = _read_installed_version()
    
    metadata = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "app_version": app_version,
        "schema_version": schema_version,
        "auto_backup": True,
    }
    
    backup_content = {
        "metadata": metadata,
        "data": data,
    }
    
    # Write to file
    import json
    backup_path.write_text(json.dumps(backup_content, indent=2))
    
    logger.info(f"Auto-backup created: {backup_path}")
    return backup_path


async def _delete_all_data(db: DBSession) -> dict[str, int]:
    """Delete all data from all tables in reverse dependency order."""
    deleted = {}
    
    # Reverse order: dependent tables first, then independent tables
    tables_order = [
        ("printer_slot_events", PrinterSlotEvent),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slots", PrinterSlot),
        ("spool_events", SpoolEvent),
        ("spool_printer_params", SpoolPrinterParam),
        ("spools", Spool),
        ("filament_printer_params", FilamentPrinterParam),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("printers", Printer),
        ("system_extra_fields", SystemExtraField),
        ("filament_ratings", FilamentRating),
        ("filament_colors", FilamentColor),
        ("filaments", Filament),
        ("locations", Location),
        ("colors", Color),
        ("manufacturers", Manufacturer),
        
        # Plugins
        ("installed_plugins", InstalledPlugin),
        
        # Devices
        ("devices", Device),
        
        # Users and auth
        ("oidc_auth_states", OIDCAuthState),
        ("oidc_settings", OIDCSettings),
        ("user_sessions", UserSession),
        ("user_api_keys", UserApiKey),
        ("oauth_identities", OAuthIdentity),
        ("role_permissions", RolePermission),
        ("user_permissions", UserPermission),
        ("user_roles", UserRole),
        ("users", User),
        ("roles", Role),
        ("permissions", Permission),
        
        # Config and seed data
        ("app_settings", AppSettings),
        ("spool_statuses", SpoolStatus),
    ]
    
    for table_name, model in tables_order:
        result = await db.execute(delete(model))
        deleted[table_name] = result.rowcount or 0
        logger.info(f"Deleted {deleted[table_name]} rows from {table_name}")
    
    return deleted


async def _delete_inventory_data(db: DBSession) -> dict[str, int]:
    """Delete only inventory/domain data (preserve users, auth, devices, plugins)."""
    deleted = {}
    
    # Reverse order: dependent tables first
    tables_order = [
        ("printer_slot_events", PrinterSlotEvent),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slots", PrinterSlot),
        ("spool_events", SpoolEvent),
        ("spool_printer_params", SpoolPrinterParam),
        ("spools", Spool),
        ("filament_printer_params", FilamentPrinterParam),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("printers", Printer),
        ("system_extra_fields", SystemExtraField),
        ("filament_ratings", FilamentRating),
        ("filament_colors", FilamentColor),
        ("filaments", Filament),
        ("locations", Location),
        ("colors", Color),
        ("manufacturers", Manufacturer),
    ]
    
    for table_name, model in tables_order:
        result = await db.execute(delete(model))
        deleted[table_name] = result.rowcount or 0
        logger.info(f"Deleted {deleted[table_name]} inventory rows from {table_name}")
    
    return deleted


async def _import_inventory_data(db: DBSession, data: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    """Import only inventory/domain data."""
    imported = {}
    
    # Same order as export
    tables_order = [
        ("manufacturers", Manufacturer),
        ("colors", Color),
        ("locations", Location),
        ("filaments", Filament),
        ("filament_colors", FilamentColor),
        ("filament_ratings", FilamentRating),
        ("system_extra_fields", SystemExtraField),
        ("printers", Printer),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("filament_printer_params", FilamentPrinterParam),
        ("spools", Spool),
        ("spool_printer_params", SpoolPrinterParam),
        ("spool_events", SpoolEvent),
        ("printer_slots", PrinterSlot),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slot_events", PrinterSlotEvent),
    ]
    
    for table_name, model in tables_order:
        rows = data.get(table_name, [])
        if rows:
            mapper = sa_inspect(model)
            col_to_attr = {attr.columns[0].name: attr.key for attr in mapper.column_attrs}
            
            for row_data in rows:
                attr_data = {}
                for col_name, value in row_data.items():
                    attr_name = col_to_attr.get(col_name, col_name)
                    
                    if isinstance(value, str) and "T" in value:
                        try:
                            attr_data[attr_name] = datetime.fromisoformat(value.replace("Z", "+00:00"))
                        except (ValueError, AttributeError):
                            attr_data[attr_name] = value
                    else:
                        attr_data[attr_name] = value
                
                db.add(model(**attr_data))
            
            imported[table_name] = len(rows)
            logger.info(f"Imported {len(rows)} inventory rows into {table_name}")
        else:
            imported[table_name] = 0
    
    return imported


async def _import_all_data(db: DBSession, data: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    """Import all data in dependency order."""
    imported = {}
    
    # Same order as export
    tables_order = [
        ("spool_statuses", SpoolStatus),
        ("permissions", Permission),
        ("roles", Role),
        ("app_settings", AppSettings),
        ("users", User),
        ("user_roles", UserRole),
        ("user_permissions", UserPermission),
        ("role_permissions", RolePermission),
        ("oauth_identities", OAuthIdentity),
        ("user_api_keys", UserApiKey),
        ("user_sessions", UserSession),
        ("oidc_settings", OIDCSettings),
        ("oidc_auth_states", OIDCAuthState),
        ("devices", Device),
        ("installed_plugins", InstalledPlugin),
        ("manufacturers", Manufacturer),
        ("colors", Color),
        ("locations", Location),
        ("filaments", Filament),
        ("filament_colors", FilamentColor),
        ("filament_ratings", FilamentRating),
        ("system_extra_fields", SystemExtraField),
        ("printers", Printer),
        ("filament_printer_profiles", FilamentPrinterProfile),
        ("filament_printer_params", FilamentPrinterParam),
        ("spools", Spool),
        ("spool_printer_params", SpoolPrinterParam),
        ("spool_events", SpoolEvent),
        ("printer_slots", PrinterSlot),
        ("printer_slot_assignments", PrinterSlotAssignment),
        ("printer_slot_events", PrinterSlotEvent),
    ]
    
    for table_name, model in tables_order:
        rows = data.get(table_name, [])
        if rows:
            mapper = sa_inspect(model)
            col_to_attr = {attr.columns[0].name: attr.key for attr in mapper.column_attrs}
            
            for row_data in rows:
                attr_data = {}
                for col_name, value in row_data.items():
                    attr_name = col_to_attr.get(col_name, col_name)
                    
                    if isinstance(value, str) and "T" in value:
                        try:
                            attr_data[attr_name] = datetime.fromisoformat(value.replace("Z", "+00:00"))
                        except (ValueError, AttributeError):
                            attr_data[attr_name] = value
                    else:
                        attr_data[attr_name] = value
                
                db.add(model(**attr_data))
            
            imported[table_name] = len(rows)
            logger.info(f"Imported {len(rows)} rows into {table_name}")
        else:
            imported[table_name] = 0
    
    return imported


@router.post("/backup/import", response_model=BackupImportResponse)
async def import_backup(
    db: DBSession,
    file: UploadFile = File(...),
    principal=RequirePermission("admin:plugins_manage"),
):
    """Import complete database backup from JSON.
    
    WARNING: This will DELETE ALL EXISTING DATA and replace it with the backup.
    An automatic backup of current data will be created before import.
    
    Only superadmins can perform this operation.
    """
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can import backups",
            },
        )
    
    # Validate content type
    if file.content_type not in ("application/json", "text/plain", "application/octet-stream"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Expected JSON file, received: {file.content_type}",
            },
        )
    
    # Read and parse JSON
    import json
    try:
        content = await file.read()
        backup_data = json.loads(content)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_json",
                "message": f"Invalid JSON file: {str(e)}",
            },
        )
    
    # Validate structure
    if "metadata" not in backup_data or "data" not in backup_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_backup_structure",
                "message": "Backup file must contain 'metadata' and 'data' fields",
            },
        )
    
    logger.info(f"Starting backup import by user {principal.user_id}")
    logger.info(f"Backup metadata: {backup_data['metadata']}")
    
    try:
        # Step 1: Create automatic backup of current data
        auto_backup_path = await _create_auto_backup(db)
        logger.info(f"Auto-backup created at: {auto_backup_path}")
        
        # Step 2: Delete all existing data
        deleted = await _delete_all_data(db)
        logger.info(f"Deleted data: {deleted}")
        
        # Step 3: Import new data
        imported = await _import_all_data(db, backup_data["data"])
        logger.info(f"Imported data: {imported}")
        
        # Commit transaction
        await db.commit()
        
        logger.info(f"Backup import completed successfully by user {principal.user_id}")
        
        return BackupImportResponse(
            message=f"Backup imported successfully. Auto-backup created at: {auto_backup_path.name}",
            imported=imported,
        )
    
    except Exception as exc:
        await db.rollback()
        logger.exception(f"Backup import failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "import_failed",
                "message": f"Import failed: {str(exc)}",
            },
        )


@router.post("/backup/import-inventory", response_model=BackupImportResponse)
async def import_inventory_backup(
    db: DBSession,
    file: UploadFile = File(...),
    principal=RequirePermission("admin:plugins_manage"),
):
    """Import inventory data only (preserves users, auth, devices, plugins).
    
    Imports: manufacturers, colors, locations, filaments, spools, printers,
    and all related domain data.
    
    Does NOT import/affect: users, passwords, sessions, roles, permissions,
    devices, plugins, OIDC settings.
    
    An automatic backup will be created before import.
    """
    if "application/json" not in file.content_type and "text/plain" not in file.content_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Expected JSON file, received: {file.content_type}",
            },
        )
    
    import json
    try:
        content = await file.read()
        backup_data = json.loads(content)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_json",
                "message": f"Invalid JSON file: {str(e)}",
            },
        )
    
    if "metadata" not in backup_data or "data" not in backup_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_backup_structure",
                "message": "Backup file must contain 'metadata' and 'data' fields",
            },
        )
    
    logger.info(f"Starting inventory backup import by user {principal.user_id}")
    logger.info(f"Backup metadata: {backup_data['metadata']}")
    
    try:
        auto_backup_path = await _create_auto_backup(db)
        logger.info(f"Auto-backup created at: {auto_backup_path}")
        
        deleted = await _delete_inventory_data(db)
        logger.info(f"Deleted inventory data: {deleted}")
        
        imported = await _import_inventory_data(db, backup_data["data"])
        logger.info(f"Imported inventory data: {imported}")
        
        await db.commit()
        
        logger.info(f"Inventory backup import completed successfully by user {principal.user_id}")
        
        return BackupImportResponse(
            message=f"Inventory backup imported successfully. Auto-backup created at: {auto_backup_path.name}",
            imported=imported,
        )
    
    except Exception as exc:
        await db.rollback()
        logger.exception(f"Inventory backup import failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "import_failed",
                "message": f"Import failed: {str(exc)}",
            },
        )


# ------------------------------------------------------------------ #
#  SQLite Backup List & Restore
# ------------------------------------------------------------------ #

def _get_backup_dir() -> Path:
    """Backup-Verzeichnis ermitteln (env BACKUP_DIR oder Standard)."""
    return Path(os.environ.get("BACKUP_DIR", "/app/data/backups"))


def _get_db_path() -> Path | None:
    """SQLite-Datenbankpfad aus DATABASE_URL extrahieren. None bei Nicht-SQLite."""
    url = settings.database_url
    if "sqlite" not in url:
        return None
    # sqlite+aiosqlite:///path/to/db oder sqlite:///path/to/db
    parts = url.split("///", 1)
    if len(parts) != 2:
        return None
    return Path(parts[1])


class SqliteBackupEntry(BaseModel):
    filename: str
    size_bytes: int
    created_at: str


class SqliteBackupListResponse(BaseModel):
    is_sqlite: bool
    backup_dir: str
    backups: list[SqliteBackupEntry]


class SqliteRestoreRequest(BaseModel):
    filename: str


class SqliteRestoreResponse(BaseModel):
    message: str
    restored_file: str
    auto_backup: str


@router.get("/backup/sqlite-list", response_model=SqliteBackupListResponse)
async def list_sqlite_backups(
    principal=RequirePermission("admin:plugins_manage"),
):
    """Vorhandene SQLite-Backup-Dateien auflisten."""
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Only superadmins can list backups"},
        )

    db_path = _get_db_path()
    if db_path is None:
        return SqliteBackupListResponse(is_sqlite=False, backup_dir="", backups=[])

    backup_dir = _get_backup_dir()
    if not backup_dir.is_dir():
        return SqliteBackupListResponse(
            is_sqlite=True, backup_dir=str(backup_dir), backups=[]
        )

    entries: list[SqliteBackupEntry] = []
    for f in sorted(backup_dir.glob("*.db"), reverse=True):
        stat = f.stat()
        entries.append(
            SqliteBackupEntry(
                filename=f.name,
                size_bytes=stat.st_size,
                created_at=datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
            )
        )

    return SqliteBackupListResponse(
        is_sqlite=True, backup_dir=str(backup_dir), backups=entries
    )


@router.post("/backup/sqlite-restore", response_model=SqliteRestoreResponse)
async def restore_sqlite_backup(
    body: SqliteRestoreRequest,
    db: DBSession,
    principal=RequirePermission("admin:plugins_manage"),
):
    """SQLite-Backup wiederherstellen.

    Erstellt zuerst ein Auto-Backup, schliesst dann alle DB-Verbindungen
    und kopiert die Backup-Datei ueber die aktuelle Datenbank.
    """
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Only superadmins can restore backups"},
        )

    db_path = _get_db_path()
    if db_path is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "not_sqlite",
                "message": "SQLite restore is only available for SQLite databases",
            },
        )

    safe_name = re.match(r"^[\w.\-]+$", body.filename)
    if not safe_name or ".." in body.filename:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_filename", "message": "Invalid backup filename"},
        )

    backup_dir = _get_backup_dir()
    backup_file = backup_dir / body.filename

    if not backup_file.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "backup_not_found",
                "message": f"Backup file '{body.filename}' not found",
            },
        )

    logger.info(
        "SQLite restore requested by user %s: %s", principal.user_id, body.filename
    )

    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        auto_backup_name = f"auto_before_restore_{timestamp}.db"
        auto_backup_path = backup_dir / auto_backup_name
        shutil.copy2(str(db_path), str(auto_backup_path))
        logger.info("Auto-backup created before restore: %s", auto_backup_path)

        from app.core.database import engine
        await engine.dispose()

        shutil.copy2(str(backup_file), str(db_path))
        logger.info("SQLite database restored from: %s", backup_file)

    except Exception as exc:
        logger.exception("SQLite restore failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "restore_failed", "message": f"Restore failed: {exc}"},
        )

    return SqliteRestoreResponse(
        message=f"Database restored from '{body.filename}'. Please reload the application.",
        restored_file=body.filename,
        auto_backup=auto_backup_name,
    )


@router.delete("/backup/sqlite/{filename}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sqlite_backup(
    filename: str,
    principal=RequirePermission("admin:plugins_manage"),
):
    """Einzelne SQLite-Backup-Datei loeschen."""
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Only superadmins can delete backups"},
        )

    safe_name = re.match(r"^[\w.\-]+$", filename)
    if not safe_name or ".." in filename:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_filename", "message": "Invalid backup filename"},
        )

    backup_file = _get_backup_dir() / filename

    if not backup_file.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "backup_not_found",
                "message": f"Backup file '{filename}' not found",
            },
        )

    backup_file.unlink()
    logger.info("SQLite backup deleted by user %s: %s", principal.user_id, filename)
