"""Admin-Endpoints fuer System, Plugin-Management und Killswitch."""

import base64
import binascii
import importlib
import io
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import AsyncExitStack, ExitStack, asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, BinaryIO, Literal, cast

import httpx
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import DateTime, LargeBinary, delete, select, text
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.inspection import inspect as sa_inspect
from sqlalchemy.orm import undefer
from starlette.concurrency import run_in_threadpool
from starlette.types import Receive, Scope, Send

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.cache import response_cache
from app.core.config import settings
from app.core.security import Principal
from app.core.seeds import BUILTIN_PLUGINS, DEPRECATED_PLUGINS
from app.core.shared_health import shared_display_store, shared_health_store
from app.core.worker_reload import request_worker_reload
from app.models import (
    AppSettings,
    Color,
    Device,
    Filament,
    FilamentColor,
    FilamentPrinterParam,
    FilamentPrinterProfile,
    FilamentRating,
    InstalledPlugin,
    LabelAsset,
    LabelPreset,
    LabelPresetAsset,
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
from app.models.label_preset import (
    label_preset_name_key,
    normalize_label_preset_name,
)
from app.services.backup_stream import (
    BACKUP_FORMAT,
    BACKUP_VERSION,
    BackupRecordTooLarge,
    BackupStreamError,
    LegacyBackupJSONError,
    atomic_binary_writer,
    detect_backup_format,
    read_legacy_backup,
    read_record,
    write_json,
    write_record,
)
from app.services.filamentdb_import_service import (
    FilamentDBImportError,
    FilamentDBImportService,
)
from app.services.label_asset_service import (
    extract_label_asset_ids,
    set_label_preset_asset_references,
    validate_canonical_label_image,
)
from app.services.plugin_service import PluginInstallError, PluginInstallService

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/admin/system", tags=["admin-system"])
BACKUP_BATCH_ROWS = 20
PluginManagementPrincipal = Annotated[
    Principal, RequirePermission("admin:plugins_manage")
]

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
    cached = response_cache.get("plugin_nav")
    if cached is not None:
        return cached

    result = await db.execute(
        select(InstalledPlugin)
        .where(InstalledPlugin.is_active.is_(True))
        .where(InstalledPlugin.show_in_nav.is_(True))
        .where(InstalledPlugin.page_url.isnot(None))
        .where(InstalledPlugin.page_url != "")
        .order_by(InstalledPlugin.name)
    )
    items = result.scalars().all()

    # Cache the serialized list (ORM objects can't be pickled after session closes)
    serialized = [PluginNavItem.model_validate(p) for p in items]
    response_cache.set("plugin_nav", serialized, ttl=600)
    return serialized


# ------------------------------------------------------------------ #
#  Admin Endpoints
# ------------------------------------------------------------------ #


@router.get("/plugins", response_model=list[PluginResponse])
async def list_plugins(
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Alle installierten Plugins auflisten."""
    service = PluginInstallService(db)
    plugins = await service.list_installed()
    return plugins


FILAMAN_PLUGINS_URL = "https://www.filaman.app/plugins/"
GITHUB_SYSTEM_RELEASES_URL = (
    "https://api.github.com/repos/Fire-Devils/filaman-system/releases/latest"
)

_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def _parse_semver(ver: str) -> tuple[int, ...] | None:
    """Semver-String in vergleichbares Tuple parsen, None bei ungueltigem Format."""
    m = _SEMVER_RE.match(ver)
    return tuple(int(x) for x in m.groups()) if m else None


_ZIP_LINK_RE = re.compile(r'href="([^"]+\.zip)"', re.IGNORECASE)
_ZIP_NAME_RE = re.compile(r"^(.+?)-([\d]+\.[\d]+\.[\d]+)\.zip$")


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
    principal: PrincipalDep,
):
    """System-Version und Plugin-Updates pruefen (24h Cache)."""
    now = time.time()
    installed = _read_installed_version()

    # Return cached data if still fresh
    if (
        _VERSION_CACHE["data"] is not None
        and (now - _VERSION_CACHE["ts"]) < _VERSION_CACHE_TTL
    ):
        cached = _VERSION_CACHE["data"]
        # Always use current installed version (may change after update)
        cached["installed_version"] = installed
        cached["update_available"] = (
            (
                (_parse_semver(cached["latest_version"]) or ())
                > (_parse_semver(installed) or ())
            )
            if cached["latest_version"]
            else False
        )
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
            plugin_updates.append(
                AvailablePluginResponse(
                    plugin_key=info["plugin_key"],
                    name=info["name"],
                    version=info["version"],
                    description=info["description"],
                    download_url=info["download_url"],
                    is_installed=existing is not None,
                    installed_version=existing.version if existing else None,
                    update_available=(
                        existing is not None
                        and (_parse_semver(info["version"]) or ())
                        > (_parse_semver(existing.version) or ())
                    ),
                )
            )
    except httpx.HTTPError:
        logger.warning("Failed to fetch plugin updates from filaman.app")

    update_available = (
        ((_parse_semver(latest_version) or ()) > (_parse_semver(installed) or ()))
        if latest_version
        else False
    )

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
    principal: PluginManagementPrincipal,
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
        result.append(
            AvailablePluginResponse(
                plugin_key=info["plugin_key"],
                name=info["name"],
                version=info["version"],
                description=info["description"],
                download_url=info["download_url"],
                is_installed=existing is not None,
                installed_version=existing.version if existing else None,
                update_available=(
                    existing is not None
                    and (_parse_semver(info["version"]) or ())
                    > (_parse_semver(existing.version) or ())
                ),
            )
        )

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
    principal: PluginManagementPrincipal,
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
        importlib.invalidate_caches()

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
        # mount_plugin_router_on_app() only patches the current worker's
        # routes — reload all Gunicorn workers so the route is consistently
        # available regardless of which worker handles the next request.
        request_worker_reload()

    # Caches invalidieren (Plugin-Status hat sich geaendert)
    _invalidate_version_cache()
    response_cache.delete("plugin_nav")

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
    file: Annotated[UploadFile, File()],
    principal: PluginManagementPrincipal,
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
        importlib.invalidate_caches()

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
        # mount_plugin_router_on_app() only patches the current worker's
        # routes — reload all Gunicorn workers so the route is consistently
        # available regardless of which worker handles the next request.
        request_worker_reload()

    # Caches invalidieren (Plugin-Status hat sich geaendert)
    _invalidate_version_cache()
    response_cache.delete("plugin_nav")

    action = "aktualisiert" if is_upgrade else "installiert"
    return PluginInstallResponse(
        message=f"Plugin '{plugin.name}' v{plugin.version} erfolgreich {action}",
        plugin=PluginResponse.model_validate(plugin),
    )


@router.delete("/plugins/{plugin_key}", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_plugin(
    plugin_key: str,
    db: DBSession,
    principal: PluginManagementPrincipal,
    delete_data: bool = Query(
        False,
        description="Also delete SystemExtraFields and printer_params created by this plugin",
    ),
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
        logger.info(
            f"Deleted plugin data (SystemExtraFields + printer_params) for driver '{driver_key}'"
        )

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

    # Fuer Import-/Integration-Plugins bleibt der Router sonst in jedem Worker
    # gemountet, der ihn zuvor dynamisch geladen hat — Worker-Reload erzwingt
    # den konsistenten Kaltstart-Pfad (Plugin-Verzeichnis ist bereits geloescht,
    # also wird die Route ueberall entfernt).
    if plugin_info and plugin_info.plugin_type in ("import", "integration"):
        request_worker_reload()

    # Caches invalidieren (Plugin entfernt)
    _invalidate_version_cache()
    response_cache.delete("plugin_nav")


class PluginToggleResponse(BaseModel):
    plugin: PluginResponse
    affected_printers: int = 0


@router.get("/plugins/{plugin_key}/affected-printers")
async def get_affected_printers(
    plugin_key: str,
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Anzahl aktiver Drucker zurueckgeben, die von diesem Plugin abhaengen."""
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

    if not plugin.driver_key:
        return {"count": 0, "printers": []}

    result = await db.execute(
        select(Printer.id, Printer.name).where(
            Printer.driver_key == plugin.driver_key,
            Printer.is_active == True,
            Printer.deleted_at.is_(None),
        )
    )
    rows = result.all()
    return {
        "count": len(rows),
        "printers": [{"id": r.id, "name": r.name} for r in rows],
    }


@router.patch("/plugins/{plugin_key}/active", response_model=PluginToggleResponse)
async def toggle_plugin_active(
    plugin_key: str,
    body: PluginToggleRequest,
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Plugin aktivieren oder deaktivieren — Treiber werden gestoppt/gestartet."""
    from app.plugins.manager import plugin_manager

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

    affected = 0

    if plugin.driver_key:
        affected_result = await db.execute(
            select(Printer.id).where(
                Printer.driver_key == plugin.driver_key,
                Printer.deleted_at.is_(None),
            )
        )
        affected_printer_ids = [r.id for r in affected_result.all()]

        if not body.is_active:
            # Deaktivierung: alle laufenden Treiber dieses Plugins stoppen
            for pid, drv in list(plugin_manager.drivers.items()):
                if getattr(drv, "driver_key", None) == plugin.driver_key:
                    await plugin_manager.stop_printer(pid)
                    affected += 1

            # Clear shared entries immediately so secondaries don't report
            # stale running/connected states.
            for pid in affected_printer_ids:
                shared_health_store.clear(pid)
                shared_display_store.clear(pid)
        else:
            # Aktivierung: aktive Drucker dieses Plugins starten
            result = await db.execute(
                select(Printer).where(
                    Printer.driver_key == plugin.driver_key,
                    Printer.is_active == True,
                    Printer.deleted_at.is_(None),
                )
            )
            for p in result.scalars().all():
                if p.id not in plugin_manager.drivers:
                    started = await plugin_manager.start_printer(p)
                    if started:
                        affected += 1

    response_cache.delete("plugin_nav")
    return PluginToggleResponse(
        plugin=PluginResponse.model_validate(plugin),
        affected_printers=affected,
    )


@router.get("/plugins/{plugin_key}", response_model=PluginResponse)
async def get_plugin(
    plugin_key: str,
    db: DBSession,
    principal: PluginManagementPrincipal,
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
#  FilamentDB Import Endpoints
# ------------------------------------------------------------------ #


class FilamentDBImportRequest(BaseModel):
    spool_detail_target: str = "filament"  # "filament" | "manufacturer" | "both"
    manufacturer_ids: list[int] | None = None  # FDB-IDs, None = alle
    filament_ids: list[int] | None = (
        None  # FDB-IDs, None = alle der gewaehlten Hersteller
    )
    update_filament_ids: list[int] | None = None  # FDB-IDs zum Aktualisieren
    skip_fuzzy_ids: list[int] | None = (
        None  # FDB-IDs, fuer die Fuzzy-Matching uebersprungen wird
    )
    snapshot_id: str | None = None


class FilamentDBPreviewResponse(BaseModel):
    snapshot_id: str | None = None
    summary: dict[str, int]
    manufacturers: list[dict[str, Any]]
    materials: list[dict[str, Any]]


class FilamentDBFilamentsRequest(BaseModel):
    manufacturer_ids: list[int]
    snapshot_id: str | None = None


class FilamentDBFilamentsResponse(BaseModel):
    snapshot_id: str | None = None
    filaments: list[dict[str, Any]]
    colors: list[dict[str, str]]


class FilamentDBDiffRequest(BaseModel):
    filament_ids: list[int]
    snapshot_id: str | None = None


class FilamentDBImportResultResponse(BaseModel):
    manufacturers_created: int
    manufacturers_skipped: int
    colors_created: int
    colors_skipped: int
    filaments_created: int
    filaments_skipped: int
    filaments_updated: int
    logos_downloaded: int
    logos_failed: int
    errors: list[str]
    warnings: list[str]


async def _require_filamentdb_active(db) -> None:
    """Pruefen ob das FilamentDB-Plugin aktiv ist, sonst 503."""
    result = await db.execute(
        select(InstalledPlugin).where(
            InstalledPlugin.plugin_key == "filamentdb_import",
        )
    )
    plugin = result.scalar_one_or_none()
    if not plugin or not plugin.is_active:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "plugin_disabled",
                "message": "FilamentDB plugin is disabled",
            },
        )


@router.post("/filamentdb-import/test-connection")
async def filamentdb_test_connection(
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Verbindung zur FilamentDB testen."""
    await _require_filamentdb_active(db)
    service = FilamentDBImportService(db)
    try:
        result = await service.test_connection()
        return result
    except FilamentDBImportError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )


@router.post("/filamentdb-import/preview")
async def filamentdb_preview(
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Vorschau der zu importierenden FilamentDB-Daten (nur Hersteller + Materialien)."""
    await _require_filamentdb_active(db)
    service = FilamentDBImportService(db)
    try:
        preview = await service.preview_manufacturers(force_refresh=True)
        return JSONResponse(
            {
                "snapshot_id": preview.snapshot_id,
                "summary": preview.summary,
                "manufacturers": preview.manufacturers,
                "materials": preview.materials,
            }
        )
    except FilamentDBImportError as e:
        logger.warning("FilamentDB Import Error: %s", e, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": e.code, "message": str(e)}},
        )
    except Exception as e:
        import traceback

        tb = traceback.format_exc()
        logger.exception("Unexpected error in FilamentDB preview: %s", tb)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler: {e!s}\n\nTraceback:\n{tb}",
                    "type": type(e).__name__,
                }
            },
        )


@router.post("/filamentdb-import/filaments")
async def filamentdb_filaments(
    body: FilamentDBFilamentsRequest,
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Filamente + Farben fuer ausgewaehlte Hersteller laden."""
    await _require_filamentdb_active(db)
    service = FilamentDBImportService(db)
    try:
        result = await service.fetch_filaments(
            body.manufacturer_ids,
            snapshot_id=body.snapshot_id,
        )
        return JSONResponse(
            {
                "snapshot_id": result.snapshot_id,
                "filaments": result.filaments,
                "colors": result.colors,
            }
        )
    except FilamentDBImportError as e:
        logger.warning("FilamentDB Filaments Error: %s", e, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": e.code, "message": str(e)}},
        )
    except Exception as e:
        import traceback

        tb = traceback.format_exc()
        logger.exception("Unexpected error in FilamentDB filaments: %s", tb)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler: {e!s}\n\nTraceback:\n{tb}",
                    "type": type(e).__name__,
                }
            },
        )


@router.post("/filamentdb-import/diff")
async def filamentdb_diff(
    body: FilamentDBDiffRequest,
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """Existierende Filamente mit FilamentDB-Daten vergleichen."""
    await _require_filamentdb_active(db)
    service = FilamentDBImportService(db)
    try:
        diff = await service.diff_filaments(
            body.filament_ids,
            snapshot_id=body.snapshot_id,
        )
        return JSONResponse(
            {
                "snapshot_id": diff.snapshot_id,
                "results": diff.results,
            }
        )
    except FilamentDBImportError as e:
        logger.warning("FilamentDB Diff Error: %s", e, exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": {"code": e.code, "message": str(e)}},
        )
    except Exception as e:
        import traceback

        tb = traceback.format_exc()
        logger.exception("Unexpected error in FilamentDB diff: %s", tb)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler: {e!s}\n\nTraceback:\n{tb}",
                    "type": type(e).__name__,
                }
            },
        )


@router.post(
    "/filamentdb-import/execute",
    response_model=FilamentDBImportResultResponse,
)
async def filamentdb_execute(
    body: FilamentDBImportRequest,
    db: DBSession,
    principal: PluginManagementPrincipal,
):
    """FilamentDB-Import ausfuehren."""
    await _require_filamentdb_active(db)
    # Validate spool_detail_target
    valid_targets = ("filament", "manufacturer", "both")
    if body.spool_detail_target not in valid_targets:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_target",
                "message": f"spool_detail_target muss einer von {valid_targets} sein",
            },
        )

    service = FilamentDBImportService(db)
    try:
        result = await service.execute(
            body.spool_detail_target,
            manufacturer_ids=body.manufacturer_ids,
            filament_ids=body.filament_ids,
            update_filament_ids=body.update_filament_ids,
            skip_fuzzy_ids=body.skip_fuzzy_ids,
            snapshot_id=body.snapshot_id,
        )
        return result
    except FilamentDBImportError as e:
        logger.warning("FilamentDB Import Execution Error: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": e.code, "message": str(e)},
        )
    except Exception as e:
        import traceback

        tb = traceback.format_exc()
        logger.exception("Unexpected error in FilamentDB import execution: %s", tb)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "detail": {
                    "code": "internal_error",
                    "message": f"Unerwarteter Fehler beim Import: {e!s}\n\nTraceback:\n{tb}",
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
    principal: PluginManagementPrincipal,
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
            deleted[table_name] = cast(CursorResult[Any], result).rowcount or 0

        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("KILLSWITCH failed")
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

    response_cache.clear()

    return KillswitchResponse(
        message=f"Killswitch executed. {total} rows deleted.",
        deleted=deleted,
    )


# ------------------------------------------------------------------ #
#  Backup / Restore Endpoints
# ------------------------------------------------------------------ #


class BackupPluginInfo(BaseModel):
    plugin_key: str
    version: str


class BackupMetadata(BaseModel):
    export_date: str
    app_version: str
    schema_version: str | None
    plugins: list[BackupPluginInfo] | None = None


class BackupImportResponse(BaseModel):
    message: str
    imported: dict[str, int]
    plugins_installed: list[str] | None = None
    plugins_warnings: list[str] | None = None


COMPLETE_BACKUP_TABLES: tuple[tuple[str, type[Any]], ...] = (
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
    ("label_assets", LabelAsset),
    ("label_presets", LabelPreset),
    ("label_preset_assets", LabelPresetAsset),
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
)

INVENTORY_BACKUP_TABLES: tuple[tuple[str, type[Any]], ...] = (
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
)


def _serialize_row(row: Any) -> dict[str, Any]:
    """Serialize SQLAlchemy model instance to dict with JSON-compatible values."""
    result = {}
    mapper = sa_inspect(type(row))

    for attr in mapper.column_attrs:
        col = attr.columns[0]
        value = getattr(row, attr.key)

        if isinstance(value, datetime):
            result[col.name] = value.isoformat()
        elif isinstance(value, bytes):
            result[col.name] = base64.b64encode(value).decode("ascii")
        else:
            result[col.name] = value

    return result


def _deserialize_row(
    model: type[Any], table_name: str, row_data: dict[str, Any]
) -> dict[str, Any]:
    mapper = sa_inspect(model)
    col_to_attr = {attr.columns[0].name: attr.key for attr in mapper.column_attrs}
    columns = {attr.columns[0].name: attr.columns[0] for attr in mapper.column_attrs}
    attr_data: dict[str, Any] = {}
    for col_name, value in row_data.items():
        attr_name = col_to_attr.get(col_name, col_name)
        column_type = getattr(columns.get(col_name), "type", None)
        if isinstance(value, str) and isinstance(column_type, LargeBinary):
            try:
                attr_data[attr_name] = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError(
                    f"Invalid base64 data for {table_name}.{col_name}"
                ) from exc
            continue
        is_datetime_column = isinstance(column_type, DateTime) or isinstance(
            getattr(column_type, "impl", None), DateTime
        )
        if isinstance(value, str) and is_datetime_column:
            try:
                attr_data[attr_name] = datetime.fromisoformat(
                    value.replace("Z", "+00:00")
                )
            except (ValueError, AttributeError):
                attr_data[attr_name] = value
        else:
            attr_data[attr_name] = value
    return attr_data


async def _write_backup_file(
    db: DBSession,
    path: Path,
    *,
    kind: str,
    metadata: dict[str, Any],
    tables: tuple[tuple[str, type[Any]], ...],
    format: Literal["json", "jsonl", "auto"] = "jsonl",
) -> Path:
    """Write rows atomically to disk; auto falls back for oversized JSONL records."""
    if format == "auto":
        try:
            return await _write_backup_file(
                db, path, kind=kind, metadata=metadata, tables=tables, format="jsonl"
            )
        except BackupRecordTooLarge:
            pass
        return await _write_backup_file(
            db, path, kind=kind, metadata=metadata, tables=tables, format="json"
        )

    path = path.with_suffix(f".{format}")
    counts = {table_name: 0 for table_name, _model in tables}
    with atomic_binary_writer(path) as stream:
        if format == "jsonl":
            write_record(
                stream,
                {
                    "format": BACKUP_FORMAT,
                    "version": BACKUP_VERSION,
                    "kind": kind,
                    "metadata": metadata,
                },
            )
        else:
            stream.write(b'{"metadata":')
            write_json(stream, metadata)
            stream.write(b',"data":{')
        for table_index, (table_name, model) in enumerate(tables):
            if format == "json":
                if table_index:
                    stream.write(b",")
                write_json(stream, table_name)
                stream.write(b":[")
            result = await db.stream(
                select(model)
                .options(undefer("*"))
                .execution_options(
                    yield_per=1 if model is LabelAsset else BACKUP_BATCH_ROWS
                )
            )
            try:
                async for row in result.scalars():
                    try:
                        if format == "jsonl":
                            write_record(
                                stream,
                                {"table": table_name, "row": _serialize_row(row)},
                            )
                        else:
                            if counts[table_name]:
                                stream.write(b",")
                            write_json(stream, _serialize_row(row))
                    except BackupRecordTooLarge as exc:
                        raise BackupRecordTooLarge(
                            f"Cannot export {table_name}: {exc}"
                        ) from exc
                    counts[table_name] += 1
            finally:
                await result.close()
            if format == "json":
                stream.write(b"]")
        if format == "jsonl":
            write_record(stream, {"end": True, "counts": counts})
        else:
            stream.write(b"}}")
    return path


class _BackupFileResponse(FileResponse):
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Also covers range rejection, failed sends, and task cancellation.
            Path(self.path).unlink(missing_ok=True)


def _temporary_backup_path() -> Path:
    descriptor, name = tempfile.mkstemp(suffix=".jsonl")
    os.close(descriptor)
    path = Path(name)
    path.unlink()
    return path


async def _get_schema_version(db: DBSession) -> str | None:
    """Get current Alembic schema version from alembic_version table."""
    try:
        result = await db.execute(text("SELECT version_num FROM alembic_version"))
        version = result.scalar_one_or_none()
        return version
    except SQLAlchemyError:
        return None


@router.get("/backup/export")
async def export_backup(
    db: DBSession,
    principal: PluginManagementPrincipal,
    format: Literal["json", "jsonl", "auto"] = "json",
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

    # Collect non-builtin, non-deprecated plugin info for metadata
    builtin_keys = {p["plugin_key"] for p in BUILTIN_PLUGINS}
    deprecated_keys = set(DEPRECATED_PLUGINS)
    result = await db.execute(
        select(InstalledPlugin).where(InstalledPlugin.installed_by.isnot(None))
    )
    user_plugins = result.scalars().all()
    backup_plugins = [
        BackupPluginInfo(plugin_key=p.plugin_key, version=p.version)
        for p in user_plugins
        if p.plugin_key not in builtin_keys and p.plugin_key not in deprecated_keys
    ]

    metadata = BackupMetadata(
        export_date=datetime.now(timezone.utc).isoformat(),
        app_version=app_version,
        schema_version=schema_version,
        plugins=backup_plugins if backup_plugins else None,
    )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = _temporary_backup_path()
    try:
        path = await _write_backup_file(
            db,
            path,
            kind="complete",
            metadata=metadata.model_dump(),
            tables=COMPLETE_BACKUP_TABLES,
            format=format,
        )
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    logger.info(f"Backup export completed by user {principal.user_id}")
    return _BackupFileResponse(
        path,
        media_type=(
            "application/x-ndjson" if path.suffix == ".jsonl" else "application/json"
        ),
        filename=f"filaman_backup_{timestamp}{path.suffix}",
    )


@router.get("/backup/export-inventory")
async def export_inventory_backup(
    db: DBSession,
    principal: PluginManagementPrincipal,
    format: Literal["json", "jsonl", "auto"] = "json",
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

    metadata = BackupMetadata(
        export_date=datetime.now(timezone.utc).isoformat(),
        app_version=app_version,
        schema_version=schema_version,
    )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = _temporary_backup_path()
    try:
        path = await _write_backup_file(
            db,
            path,
            kind="inventory",
            metadata=metadata.model_dump(),
            tables=INVENTORY_BACKUP_TABLES,
            format=format,
        )
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    logger.info(f"Inventory backup export completed by user {principal.user_id}")
    return _BackupFileResponse(
        path,
        media_type=(
            "application/x-ndjson" if path.suffix == ".jsonl" else "application/json"
        ),
        filename=f"filaman_inventory_{timestamp}{path.suffix}",
    )


async def _create_auto_backup(db: DBSession) -> Path:
    """Create automatic backup before import/restore operations."""
    backup_dir = _get_backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"auto_backup_before_import_{timestamp}.jsonl"
    schema_version = await _get_schema_version(db)
    app_version = _read_installed_version()

    metadata = {
        "export_date": datetime.now(timezone.utc).isoformat(),
        "app_version": app_version,
        "schema_version": schema_version,
        "auto_backup": True,
    }

    backup_path = await _write_backup_file(
        db,
        backup_path,
        kind="complete",
        metadata=metadata,
        tables=COMPLETE_BACKUP_TABLES,
        format="auto",
    )

    logger.info(f"Auto-backup created: {backup_path}")
    return backup_path


async def _delete_all_data(db: DBSession) -> dict[str, int]:
    """Delete all data from all tables in reverse dependency order."""
    deleted = {}

    for table_name, model in reversed(COMPLETE_BACKUP_TABLES):
        result = await db.execute(delete(model))
        deleted[table_name] = cast(CursorResult[Any], result).rowcount or 0
        logger.info(f"Deleted {deleted[table_name]} rows from {table_name}")

    return deleted


async def _delete_inventory_data(db: DBSession) -> dict[str, int]:
    """Delete only inventory/domain data (preserve users, auth, devices, plugins)."""
    deleted = {}

    for table_name, model in reversed(INVENTORY_BACKUP_TABLES):
        result = await db.execute(delete(model))
        deleted[table_name] = cast(CursorResult[Any], result).rowcount or 0
        logger.info(f"Deleted {deleted[table_name]} inventory rows from {table_name}")

    return deleted


async def _import_inventory_data(
    db: DBSession, data: Mapping[str, Any]
) -> dict[str, int]:
    """Import only inventory/domain data."""
    return await _import_mapping_data(db, data, INVENTORY_BACKUP_TABLES)


async def _import_backup_row(
    db: DBSession,
    table_name: str,
    model: type[Any],
    row_data: Mapping[str, Any],
) -> None:
    attr_data = _deserialize_row(model, table_name, dict(row_data))

    if model is LabelPreset and isinstance(attr_data.get("name"), str):
        attr_data["name"] = normalize_label_preset_name(attr_data["name"])
        attr_data["name_key"] = label_preset_name_key(attr_data["name"])
    elif model is LabelAsset:
        canonical = await run_in_threadpool(
            validate_canonical_label_image, attr_data.get("content", b"")
        )
        if (
            canonical.sha256 != attr_data.get("sha256")
            or canonical.byte_size != attr_data.get("byte_size")
            or canonical.width != attr_data.get("width")
            or canonical.height != attr_data.get("height")
            or attr_data.get("media_type") != "image/png"
        ):
            raise ValueError("Invalid canonical label image in backup")
    elif model is LabelPresetAsset:
        preset_id = attr_data.get("preset_id")
        asset_id = attr_data.get("asset_id")
        preset = await db.get(LabelPreset, preset_id)
        asset = await db.get(LabelAsset, asset_id)
        if (
            preset is None
            or asset is None
            or preset.user_id != attr_data.get("user_id")
            or asset.user_id != attr_data.get("user_id")
        ):
            raise ValueError("Invalid label image reference in backup")
        return

    instance = model(**attr_data)
    db.add(instance)


async def _finish_backup_import(
    db: DBSession, imported: dict[str, int]
) -> dict[str, int]:
    if "label_preset_assets" not in imported:
        return imported

    rebuilt_references = 0
    last_id: int | None = None
    while True:
        query = select(LabelPreset).order_by(LabelPreset.id).limit(BACKUP_BATCH_ROWS)
        if last_id is not None:
            query = query.where(LabelPreset.id > last_id)
        presets = list((await db.scalars(query)).all())
        if not presets:
            break
        for preset in presets:
            asset_ids = extract_label_asset_ids(preset.data)
            await set_label_preset_asset_references(db, preset, asset_ids)
            rebuilt_references += len(asset_ids)
        last_id = presets[-1].id
    imported["label_preset_assets"] = rebuilt_references
    return imported


async def _import_mapping_data(
    db: DBSession,
    data: Mapping[str, Any],
    tables: tuple[tuple[str, type[Any]], ...],
) -> dict[str, int]:
    imported = {table_name: 0 for table_name, _model in tables}
    for table_name, model in tables:
        source = data.get(table_name, [])
        if isinstance(source, io.IOBase):
            rows = (json.loads(line) for line in source)
        elif isinstance(source, list):
            rows = iter(source)
        else:
            raise BackupStreamError(f"Backup table {table_name} must be a list")
        count = 0
        for count, row_data in enumerate(rows, start=1):
            if not isinstance(row_data, Mapping):
                raise BackupStreamError(
                    f"Backup row for {table_name} must be an object"
                )
            await _import_backup_row(db, table_name, model, row_data)
            if model is LabelAsset or count % BACKUP_BATCH_ROWS == 0:
                await db.flush()
        if count:
            await db.flush()
            logger.info("Imported %d rows into %s", count, table_name)
        imported[table_name] = count
    return await _finish_backup_import(db, imported)


async def _import_all_data(
    db: DBSession, data: Mapping[str, Any]
) -> dict[str, int]:
    """Import all data in dependency order."""
    return await _import_mapping_data(db, data, COMPLETE_BACKUP_TABLES)


def _read_jsonl_header(
    stream: BinaryIO, expected_kind: Literal["complete", "inventory"]
) -> dict[str, Any]:
    header = read_record(stream)
    if (
        header is None
        or set(header) != {"format", "version", "kind", "metadata"}
        or header.get("format") != BACKUP_FORMAT
        or header.get("version") != BACKUP_VERSION
        or header.get("kind") != expected_kind
        or not isinstance(header.get("metadata"), dict)
    ):
        raise BackupStreamError("Invalid backup header")
    return header["metadata"]


async def _import_jsonl_data(
    db: DBSession,
    stream: BinaryIO,
    *,
    expected_kind: Literal["complete", "inventory"],
    tables: tuple[tuple[str, type[Any]], ...],
) -> tuple[dict[str, int], dict[str, Any]]:
    metadata = _read_jsonl_header(stream, expected_kind)
    positions = {table_name: index for index, (table_name, _model) in enumerate(tables)}
    models = dict(tables)
    imported = {table_name: 0 for table_name, _model in tables}
    current_position = -1

    while (record := read_record(stream)) is not None:
        if record.get("end") is True:
            if (
                set(record) != {"end", "counts"}
                or record.get("counts") != imported
            ):
                raise BackupStreamError("Backup footer counts do not match")
            if read_record(stream) is not None:
                raise BackupStreamError("Backup contains data after its footer")
            if current_position >= 0:
                await db.flush()
            return await _finish_backup_import(db, imported), metadata

        if set(record) != {"table", "row"} or not isinstance(record.get("row"), dict):
            raise BackupStreamError("Invalid backup row record")
        table_name = record.get("table")
        if not isinstance(table_name, str) or table_name not in positions:
            raise BackupStreamError("Backup contains an unknown table")
        position = positions[table_name]
        if position < current_position:
            raise BackupStreamError("Backup tables are out of order")
        if position > current_position:
            if current_position >= 0:
                await db.flush()
            current_position = position
        await _import_backup_row(db, table_name, models[table_name], record["row"])
        imported[table_name] += 1
        if (
            models[table_name] is LabelAsset
            or imported[table_name] % BACKUP_BATCH_ROWS == 0
        ):
            await db.flush()

    raise BackupStreamError("Backup footer is missing")


async def _reinstall_plugins_from_backup(
    db: DBSession,
    plugins: list[BackupPluginInfo],
) -> tuple[list[str], list[str]]:
    """Reinstall user-installed plugins from backup via the plugin registry.

    Downloads and installs plugins that were listed in the backup metadata.
    Skips builtin and deprecated plugins.

    Returns:
        Tuple of (installed plugin messages, warning messages).
    """
    builtin_keys = {p["plugin_key"] for p in BUILTIN_PLUGINS}
    deprecated_keys = set(DEPRECATED_PLUGINS)

    # Filter to only installable plugins
    to_install = [
        p
        for p in plugins
        if p.plugin_key not in builtin_keys and p.plugin_key not in deprecated_keys
    ]

    if not to_install:
        return [], []

    installed: list[str] = []
    warnings: list[str] = []

    # Fetch available plugins from registry
    try:
        available = await _fetch_available_from_filaman()
    except Exception as exc:  # noqa: BLE001 — optional plugin reinstalls must not fail a completed restore.
        logger.warning("Plugin-Registry nicht erreichbar: %s", exc)
        for p in to_install:
            warnings.append(
                f"Plugin '{p.plugin_key}' konnte nicht installiert werden "
                f"(Registry nicht erreichbar)"
            )
        return installed, warnings

    service = PluginInstallService(db)

    for plugin_info in to_install:
        key = plugin_info.plugin_key
        registry_entry = available.get(key)

        if not registry_entry:
            warnings.append(f"Plugin '{key}' ist nicht in der Registry verfuegbar")
            continue

        download_url = registry_entry["download_url"]

        # Download ZIP from registry
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                resp = await client.get(download_url)
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            warnings.append(f"Plugin '{key}': Download fehlgeschlagen ({exc})")
            continue

        zip_data = resp.content
        if not zip_data:
            warnings.append(f"Plugin '{key}': Heruntergeladene Datei ist leer")
            continue

        # Install via existing pipeline (finds DB record from import → upgrade)
        try:
            plugin, _ = await service.install_from_zip(
                zip_data=zip_data,
                installed_by=None,
            )
            installed.append(f"Plugin '{plugin.name}' v{plugin.version} installiert")
            logger.info(
                "Backup-Import: Plugin '%s' v%s aus Registry installiert",
                plugin.name,
                plugin.version,
            )
        except PluginInstallError as exc:
            warnings.append(f"Plugin '{key}': Installation fehlgeschlagen ({exc})")
            logger.warning(
                "Backup-Import: Plugin '%s' konnte nicht installiert werden: %s",
                key,
                exc,
            )

    return installed, warnings


_BACKUP_CONTENT_TYPES = {
    "application/json",
    "application/x-ndjson",
    "application/jsonl",
    "text/plain",
    "application/octet-stream",
}


@asynccontextmanager
async def _prepare_backup_upload(
    file: UploadFile, expected_kind: Literal["complete", "inventory"]
) -> AsyncIterator[tuple[Literal["jsonl", "legacy-json"], dict[str, Any], dict[str, BinaryIO] | None]]:
    await file.seek(0)
    backup_format = detect_backup_format(file.file)
    if backup_format == "jsonl":
        metadata = _read_jsonl_header(file.file, expected_kind)
        await file.seek(0)
        yield backup_format, metadata, None
        return

    tables = COMPLETE_BACKUP_TABLES if expected_kind == "complete" else INVENTORY_BACKUP_TABLES
    with ExitStack() as stack:
        metadata, data = await run_in_threadpool(
            stack.enter_context,
            read_legacy_backup(file.file, {name for name, _model in tables}),
        )
        yield backup_format, metadata, data


def _invalid_backup_error(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "code": "invalid_json" if isinstance(exc, LegacyBackupJSONError) else "invalid_backup_structure",
            "message": str(exc),
        },
    )


@router.post("/backup/import", response_model=BackupImportResponse)
async def import_backup(
    db: DBSession,
    file: Annotated[UploadFile, File()],
    principal: PluginManagementPrincipal,
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

    if (file.content_type or "").partition(";")[0].strip().lower() not in _BACKUP_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Expected backup file, received: {file.content_type}",
            },
        )

    async with AsyncExitStack() as stack:
        try:
            backup_format, backup_metadata, legacy_data = await stack.enter_async_context(
                _prepare_backup_upload(file, "complete")
            )
        except BackupStreamError as exc:
            raise _invalid_backup_error(exc) from exc

        raw_plugins = backup_metadata.get("plugins")
        try:
            plugin_list = [BackupPluginInfo(**item) for item in raw_plugins or []]
        except (TypeError, ValueError) as exc:
            raise _invalid_backup_error(
                BackupStreamError("Invalid plugin metadata")
            ) from exc

        logger.info(f"Starting backup import by user {principal.user_id}")
        logger.info(f"Backup metadata: {backup_metadata}")

        try:
            # Step 1: Create automatic backup of current data
            auto_backup_path = await _create_auto_backup(db)
            logger.info(f"Auto-backup created at: {auto_backup_path}")

            # Clean session identity map — the auto-backup loaded all objects
            # via select(), and bulk-delete below bypasses the ORM.  Without
            # expunge_all() the session may still track stale instances whose
            # PKs collide with the rows we are about to re-insert, causing
            # SQLAlchemy to skip INSERTs or emit UPDATEs instead.
            db.expunge_all()

            # For SQLite: defer FK constraint checks until COMMIT so that
            # INSERT order within a single flush does not matter.  This
            # PRAGMA *can* be set inside a transaction (unlike foreign_keys).
            if settings.database_url.startswith("sqlite"):
                await db.execute(text("PRAGMA defer_foreign_keys = ON"))

            # Step 2: Delete all existing data
            deleted = await _delete_all_data(db)
            logger.info(f"Deleted data: {deleted}")

            # Step 3: Import new data
            if backup_format == "jsonl":
                file.file.seek(0)
                imported, backup_metadata = await _import_jsonl_data(
                    db,
                    file.file,
                    expected_kind="complete",
                    tables=COMPLETE_BACKUP_TABLES,
                )
            else:
                assert legacy_data is not None
                imported = await _import_all_data(db, legacy_data)
            logger.info(f"Imported data: {imported}")

            # Commit transaction (deferred FK constraints checked here)
            await db.commit()

            logger.info(f"Backup import completed successfully by user {principal.user_id}")

            response_cache.clear()

            # Step 4: Reinstall user-installed plugins from backup
            plugins_installed = None
            plugins_warnings = None
            if plugin_list:
                plugins_installed, plugins_warnings = await _reinstall_plugins_from_backup(
                    db, plugin_list
                )
                if plugins_installed:
                    logger.info(
                        "Backup-Import: %d Plugin(s) installiert",
                        len(plugins_installed),
                    )
                if plugins_warnings:
                    logger.warning(
                        "Backup-Import: %d Plugin-Warnung(en)",
                        len(plugins_warnings),
                    )

            return BackupImportResponse(
                message=f"Backup imported successfully. Auto-backup created at: {auto_backup_path.name}",
                imported=imported,
                plugins_installed=plugins_installed or None,
                plugins_warnings=plugins_warnings or None,
            )

        except (BackupStreamError, ValueError) as exc:
            await db.rollback()
            logger.warning("Backup import rejected: %s", exc)
            raise _invalid_backup_error(exc) from exc
        except Exception as exc:  # noqa: BLE001 — rollback any failure without logging sensitive backup values.
            await db.rollback()
            logger.error("Backup import failed (%s)", type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "code": "import_failed",
                    "message": "Import failed",
                },
            )


@router.post("/backup/import-inventory", response_model=BackupImportResponse)
async def import_inventory_backup(
    db: DBSession,
    file: Annotated[UploadFile, File()],
    principal: PluginManagementPrincipal,
):
    """Import inventory data only (preserves users, auth, devices, plugins).

    Imports: manufacturers, colors, locations, filaments, spools, printers,
    and all related domain data.

    Does NOT import/affect: users, passwords, sessions, roles, permissions,
    devices, plugins, OIDC settings.

    An automatic backup will be created before import.
    """
    if (file.content_type or "").partition(";")[0].strip().lower() not in _BACKUP_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_content_type",
                "message": f"Expected backup file, received: {file.content_type}",
            },
        )

    async with AsyncExitStack() as stack:
        try:
            backup_format, backup_metadata, legacy_data = await stack.enter_async_context(
                _prepare_backup_upload(file, "inventory")
            )
        except BackupStreamError as exc:
            raise _invalid_backup_error(exc) from exc

        logger.info(f"Starting inventory backup import by user {principal.user_id}")
        logger.info(f"Backup metadata: {backup_metadata}")

        try:
            auto_backup_path = await _create_auto_backup(db)
            logger.info(f"Auto-backup created at: {auto_backup_path}")

            # Clean session identity map — see import_backup for rationale
            db.expunge_all()

            # For SQLite: defer FK constraint checks until COMMIT
            if settings.database_url.startswith("sqlite"):
                await db.execute(text("PRAGMA defer_foreign_keys = ON"))

            deleted = await _delete_inventory_data(db)
            logger.info(f"Deleted inventory data: {deleted}")

            if backup_format == "jsonl":
                file.file.seek(0)
                imported, _metadata = await _import_jsonl_data(
                    db,
                    file.file,
                    expected_kind="inventory",
                    tables=INVENTORY_BACKUP_TABLES,
                )
            else:
                assert legacy_data is not None
                imported = await _import_inventory_data(db, legacy_data)
            logger.info(f"Imported inventory data: {imported}")

            await db.commit()

            logger.info(
                f"Inventory backup import completed successfully by user {principal.user_id}"
            )

            response_cache.clear()

            return BackupImportResponse(
                message=f"Inventory backup imported successfully. Auto-backup created at: {auto_backup_path.name}",
                imported=imported,
            )

        except (BackupStreamError, ValueError) as exc:
            await db.rollback()
            logger.warning("Inventory backup import rejected: %s", exc)
            raise _invalid_backup_error(exc) from exc
        except Exception as exc:  # noqa: BLE001 — rollback any failure without logging sensitive backup values.
            await db.rollback()
            logger.error("Inventory backup import failed (%s)", type(exc).__name__)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "code": "import_failed",
                    "message": "Import failed",
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
    principal: PluginManagementPrincipal,
):
    """Vorhandene SQLite-Backup-Dateien auflisten."""
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can list backups",
            },
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
    principal: PluginManagementPrincipal,
):
    """SQLite-Backup wiederherstellen.

    Erstellt zuerst ein Auto-Backup, schliesst dann alle DB-Verbindungen
    und kopiert die Backup-Datei ueber die aktuelle Datenbank.
    """
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can restore backups",
            },
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
        logger.exception("SQLite restore failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "restore_failed", "message": f"Restore failed: {exc}"},
        )

    response_cache.clear()

    return SqliteRestoreResponse(
        message=f"Database restored from '{body.filename}'. Please reload the application.",
        restored_file=body.filename,
        auto_backup=auto_backup_name,
    )


@router.delete("/backup/sqlite/{filename}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sqlite_backup(
    filename: str,
    principal: PluginManagementPrincipal,
):
    """Einzelne SQLite-Backup-Datei loeschen."""
    if not principal.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Only superadmins can delete backups",
            },
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
