from fastapi import APIRouter, Depends, HTTPException
from fastapi.routing import APIRoute, APIWebSocketRoute
from sqlalchemy import select
from starlette.routing import Match

from app.api.mcp_plugin_tools import load_plugin_read_tools
from app.api.v1.admin import router as admin_router
from app.api.v1.app_settings_admin import public_router as app_settings_public_router
from app.api.v1.app_settings_admin import router as app_settings_admin_router
from app.api.v1.dashboard import router as dashboard_router
from app.api.v1.devices import router as devices_router
from app.api.v1.display import router as display_router
from app.api.v1.events import router as events_router
from app.api.v1.filamentdb_proxy import router as filamentdb_router
from app.api.v1.filaments import router, router_colors, router_filaments
from app.api.v1.label_assets import router as label_assets_router
from app.api.v1.label_presets import router as label_presets_router
from app.api.v1.labels import router as labels_router
from app.api.v1.me import router as me_router
from app.api.v1.me_api_keys import router as me_api_keys_router
from app.api.v1.oidc_admin import public_router as oidc_public_router
from app.api.v1.oidc_admin import router as oidc_admin_router
from app.api.v1.printer_params import router_filament_params, router_spool_params
from app.api.v1.printers import router as printers_router
from app.api.v1.spoolman import router as spoolman_router
from app.api.v1.spools import (
    router_locations,
    router_spool_measurements,
    router_spools,
)
from app.api.v1.system import public_router as plugin_public_router
from app.api.v1.system import router as system_router
from app.api.v1.system_extra_fields import router as system_extra_fields_router
from app.api.v1.tag import router as tag_router
from app.core import database
from app.models.plugin import InstalledPlugin
from app.services.plugin_service import validate_integration_shell
from app.services.spoolman_projection import adapt_installed_spoolman

try:
    from fastapi.routing import iter_route_contexts
except ImportError:  # Older FastAPI versions flatten included routers.
    iter_route_contexts = None

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(router)
api_router.include_router(router_colors)
api_router.include_router(router_filaments)
api_router.include_router(dashboard_router)
api_router.include_router(router_locations)
api_router.include_router(router_spools)
api_router.include_router(router_spool_measurements)
api_router.include_router(me_router)
api_router.include_router(me_api_keys_router)
api_router.include_router(label_presets_router)
api_router.include_router(label_assets_router)
api_router.include_router(labels_router)
api_router.include_router(printers_router)
api_router.include_router(admin_router)
api_router.include_router(devices_router)
api_router.include_router(display_router)
api_router.include_router(tag_router)
api_router.include_router(system_router)
api_router.include_router(spoolman_router)
api_router.include_router(plugin_public_router)
api_router.include_router(
    system_extra_fields_router,
    prefix="/system-extra-fields",
    tags=["System Extra Fields"],
)
api_router.include_router(
    router_filament_params, prefix="/filaments", tags=["Filament Printer Params"]
)
api_router.include_router(
    router_spool_params, prefix="/spools", tags=["Spool Printer Params"]
)
api_router.include_router(events_router)
api_router.include_router(oidc_admin_router)
api_router.include_router(app_settings_admin_router)
api_router.include_router(oidc_public_router)
api_router.include_router(app_settings_public_router)
api_router.include_router(filamentdb_router)

# Keep installed plugin routes separate from the core API so they can be replaced.
_deferred_plugin_routers: list[tuple[str, APIRouter, dict]] = []


def _integration_dependencies(plugin_key: str, manifest: dict, *routers: APIRouter | None):
    if manifest["plugin_type"] != "integration":
        return []

    for plugin_router in routers:
        if plugin_router is None:
            continue
        routes = (
            (context.original_route for context in iter_route_contexts(plugin_router.routes))
            if iter_route_contexts else plugin_router.routes
        )
        if any(not isinstance(route, (APIRoute, APIWebSocketRoute)) for route in routes):
            raise ValueError("Integration routes must use FastAPI route decorators")

    active_install = select(InstalledPlugin.id).where(
        InstalledPlugin.plugin_key == plugin_key,
        InstalledPlugin.plugin_type == "integration",
        InstalledPlugin.is_active.is_(True),
    )
    page_url = manifest.get("page_url")
    if isinstance(page_url, str) and page_url.startswith("/plugin-view/"):
        # A worker can still have the old router after a plugin changes its launch URL.
        active_install = active_install.where(InstalledPlugin.page_url == page_url)

    async def require_active() -> None:
        # Release the connection before a streaming response or WebSocket starts.
        async with database.async_session_maker() as db:
            if await db.scalar(active_install) is None:
                raise HTTPException(status_code=404, detail="Plugin is unavailable")

    return [Depends(require_active)]


def _build_plugin_router(plugin_key: str, manifest: dict, module) -> APIRouter:
    primary = getattr(module, "router", None)
    if primary is None:
        raise ValueError(f"Plugin '{plugin_key}' has no router")
    admin = getattr(module, "admin_router", None)
    dependencies = _integration_dependencies(plugin_key, manifest, primary, admin)
    group = APIRouter()
    prefix = manifest.get("mount_prefix") or "/api/v1"
    group.include_router(primary, prefix=prefix, dependencies=dependencies)
    launch_request = {"type": "http", "method": "GET", "path": prefix + "/"}
    if prefix.startswith("/plugins/") and not any(
        route.matches(launch_request)[0] == Match.FULL for route in group.routes
    ):
        raise ValueError("The integration router has no GET route for its launch URL")
    if admin is not None:
        group.include_router(admin, prefix="/api/v1", dependencies=dependencies)
    return group


def _replace_plugin_router(app, plugin_key: str, plugin_router: APIRouter | None, mcp_tools: dict | None = None) -> None:
    if not hasattr(app.state, "plugin_routes"):
        app.state.plugin_routes = {}
    registered = app.state.plugin_routes
    previous = registered.get(plugin_key, set())
    routes = app.router.routes
    start = len(routes)
    # FastAPI either appends an included router or flattens it into route entries.
    if plugin_router is not None:
        app.include_router(plugin_router)
    added = routes[start:]
    position = next((
        index for index, route in enumerate(routes[:start])
        if id(route) in previous or getattr(route, "name", None) == "static"
    ), start)
    routes[position:] = added + [route for route in routes[position:start] if id(route) not in previous]
    if plugin_router is not None:
        registered[plugin_key] = {id(route) for route in added}
    else:
        registered.pop(plugin_key, None)
    if not hasattr(app.state, "plugin_mcp_tools"):
        app.state.plugin_mcp_tools = {}
    if mcp_tools:
        app.state.plugin_mcp_tools[plugin_key] = mcp_tools
    else:
        app.state.plugin_mcp_tools.pop(plugin_key, None)
    app.openapi_schema = None


def mount_plugin_router_on_app(app, plugin_key: str) -> bool:
    """Dynamisch einen Plugin-Router auf die laufende App mounten.

    Wird nach Plugin-Installation aufgerufen, damit Import-/Integration-Plugins
    sofort verfuegbar sind ohne Server-Neustart.
    Returns True bei Erfolg.
    """
    import importlib
    import json
    import logging
    import sys

    from app.services.plugin_service import PLUGINS_DIR

    _logger = logging.getLogger(__name__)

    plugin_dir = PLUGINS_DIR / plugin_key
    manifest_path = plugin_dir / "plugin.json"
    router_path = plugin_dir / "router.py"

    if not manifest_path.is_file() or not router_path.is_file():
        _replace_plugin_router(app, plugin_key, None)
        return False

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("plugin_type") not in ("import", "integration"):
            _replace_plugin_router(app, plugin_key, None)
            return False

        validate_integration_shell(manifest, plugin_dir)
        if str(PLUGINS_DIR) not in sys.path:
            sys.path.insert(0, str(PLUGINS_DIR))

        # Alle Module des Plugins aus dem Cache entfernen
        for mod_name in list(sys.modules.keys()):
            if mod_name == plugin_key or mod_name.startswith(f"{plugin_key}."):
                del sys.modules[mod_name]

        # Finder-Caches invalidieren damit Python neue Dateien/Pakete erkennt
        importlib.invalidate_caches()

        module = importlib.import_module(f"{plugin_key}.router")
        adapt_installed_spoolman(module, plugin_key, manifest)
        _replace_plugin_router(
            app, plugin_key, _build_plugin_router(plugin_key, manifest, module),
            load_plugin_read_tools(plugin_key, manifest, module, manifest_path),
        )
        _logger.info("Plugin-Router '%s' dynamisch auf App gemountet", plugin_key)
        return True

    except Exception:
        getattr(app.state, "plugin_mcp_tools", {}).pop(plugin_key, None)
        _logger.exception(
            "Plugin-Router '%s' konnte nicht dynamisch geladen werden", plugin_key
        )
        return False


def mount_deferred_plugin_routers(app) -> None:
    """Mount the discovered plugin routers after the core API."""
    import logging

    _logger = logging.getLogger(__name__)

    for plugin_key, plugin_router, mcp_tools in _deferred_plugin_routers:
        _replace_plugin_router(app, plugin_key, plugin_router, mcp_tools)
        _logger.info("Plugin-Router '%s' auf App gemountet", plugin_key)


# ---------------------------------------------------------------------------
# Auto-discovery: mount routers from user-installed import/integration plugins
# ---------------------------------------------------------------------------
def _mount_plugin_routers() -> None:
    import importlib
    import json
    import logging
    import sys

    from app.services.plugin_service import PLUGINS_DIR, plugin_archive_lock

    _logger = logging.getLogger(__name__)

    if not PLUGINS_DIR.is_dir():
        return

    # Ensure PLUGINS_DIR is on sys.path so plugin packages are importable.
    # This must happen HERE because this function runs at module-import time,
    # before plugin_manager.py gets a chance to set up sys.path.
    if str(PLUGINS_DIR) not in sys.path:
        sys.path.insert(0, str(PLUGINS_DIR))

    with plugin_archive_lock(reading=True, blocking=True):
        for plugin_dir in sorted(PLUGINS_DIR.iterdir()):
            if not plugin_dir.is_dir():
                continue
            manifest_path = plugin_dir / "plugin.json"
            router_path = plugin_dir / "router.py"
            if not manifest_path.is_file() or not router_path.is_file():
                continue

            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if manifest.get("plugin_type") not in ("import", "integration"):
                    continue

                validate_integration_shell(manifest, plugin_dir)
                plugin_key = manifest.get("plugin_key", plugin_dir.name)
                module = importlib.import_module(f"{plugin_key}.router")
                adapt_installed_spoolman(module, plugin_key, manifest)
                _deferred_plugin_routers.append(
                    (plugin_key, _build_plugin_router(plugin_key, manifest, module),
                     load_plugin_read_tools(plugin_key, manifest, module, manifest_path))
                )

            except Exception as exc:  # noqa: BLE001 — third-party plugin failures must not prevent startup.
                _logger.warning(
                    "Plugin-Router '%s' konnte nicht geladen werden: %s",
                    plugin_dir.name,
                    exc,
                )


_mount_plugin_routers()
