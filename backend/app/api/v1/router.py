from fastapi import APIRouter

from app.api.v1.admin import router as admin_router
from app.api.v1.dashboard import router as dashboard_router
from app.api.v1.devices import router as devices_router
from app.api.v1.filaments import router, router_colors, router_filaments
from app.api.v1.me import router as me_router
from app.api.v1.printers import router as printers_router
from app.api.v1.spools import (
    router_locations,
    router_spool_measurements,
    router_spools,
)
from app.api.v1.system import router as system_router
from app.api.v1.system_extra_fields import router as system_extra_fields_router
from app.api.v1.printer_params import router_filament_params, router_spool_params
from app.api.v1.events import router as events_router
from app.api.v1.oidc_admin import public_router as oidc_public_router
from app.api.v1.oidc_admin import router as oidc_admin_router
from app.api.v1.app_settings_admin import router as app_settings_admin_router
from app.api.v1.app_settings_admin import public_router as app_settings_public_router

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(router)
api_router.include_router(router_colors)
api_router.include_router(router_filaments)
api_router.include_router(dashboard_router)
api_router.include_router(router_locations)
api_router.include_router(router_spools)
api_router.include_router(router_spool_measurements)
api_router.include_router(me_router)
api_router.include_router(printers_router)
api_router.include_router(admin_router)
api_router.include_router(devices_router)
api_router.include_router(system_router)
api_router.include_router(system_extra_fields_router, prefix="/system-extra-fields", tags=["System Extra Fields"])
api_router.include_router(router_filament_params, prefix="/filaments", tags=["Filament Printer Params"])
api_router.include_router(router_spool_params, prefix="/spools", tags=["Spool Printer Params"])
api_router.include_router(events_router)
api_router.include_router(oidc_admin_router)
api_router.include_router(app_settings_admin_router)
api_router.include_router(oidc_public_router)
api_router.include_router(app_settings_public_router)

# Plugins mit eigenem mount_prefix werden hier gesammelt und spaeter
# von mount_deferred_plugin_routers() direkt auf die FastAPI-App gemountet.
_deferred_plugin_routers: list[tuple] = []


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

    if not manifest_path.exists() or not router_path.exists():
        _logger.warning(
            "mount_plugin_router_on_app: manifest oder router.py nicht gefunden fuer '%s' in %s",
            plugin_key,
            plugin_dir,
        )
        return False

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("plugin_type") not in ("import", "integration"):
            return False

        mount_prefix = manifest.get("mount_prefix")

        if str(PLUGINS_DIR) not in sys.path:
            sys.path.insert(0, str(PLUGINS_DIR))

        # Alle Module des Plugins aus dem Cache entfernen
        for mod_name in list(sys.modules.keys()):
            if mod_name == plugin_key or mod_name.startswith(f"{plugin_key}."):
                del sys.modules[mod_name]

        # Finder-Caches invalidieren damit Python neue Dateien/Pakete erkennt
        importlib.invalidate_caches()

        module = importlib.import_module(f"{plugin_key}.router")
        plugin_router = getattr(module, "router", None)
        if plugin_router is None:
            _logger.warning(
                "Plugin '%s' hat router.py aber kein 'router' Attribut",
                plugin_key,
            )
            return False

        # Mount-Prefix bestimmen: eigener mount_prefix oder Standard /api/v1
        router_mount_prefix = mount_prefix if mount_prefix else "/api/v1"

        # Alte Routes dieses Plugins entfernen (bei Update/Reinstall),
        # damit die neuen nicht von verwaisten alten Routen ueberschattet werden.
        if plugin_router.prefix:
            full_prefix = f"{router_mount_prefix}{plugin_router.prefix}"
            app.router.routes = [
                route for route in app.router.routes
                if not (hasattr(route, 'path') and route.path.startswith(full_prefix))
            ]
        elif mount_prefix:
            # Plugin hat eigenen mount_prefix — alte Routen unter diesem Prefix entfernen
            app.router.routes = [
                route for route in app.router.routes
                if not (hasattr(route, 'path') and route.path.startswith(mount_prefix))
            ]

        app.include_router(plugin_router, prefix=router_mount_prefix)

        # Optional: admin_router fuer Plugin-spezifische Admin-Endpoints.
        # Admin-Router wird immer unter /api/v1 gemountet (FilaMan Admin-Bereich).
        plugin_admin_router = getattr(module, "admin_router", None)
        if plugin_admin_router is not None:
            if plugin_admin_router.prefix:
                admin_full_prefix = f"/api/v1{plugin_admin_router.prefix}"
                app.router.routes = [
                    route for route in app.router.routes
                    if not (hasattr(route, 'path') and route.path.startswith(admin_full_prefix))
                ]
            app.include_router(plugin_admin_router, prefix="/api/v1")
            _logger.info("Plugin-Admin-Router '%s' dynamisch auf App gemountet", plugin_key)

        # Catch-all StaticFiles-Mount (name="static") muss am Ende der
        # Route-Liste bleiben, sonst schattiert er die neuen API-Routen.
        routes = app.router.routes
        for i, route in enumerate(routes):
            if getattr(route, "name", None) == "static":
                routes.append(routes.pop(i))
                break

        _logger.info(
            "Plugin-Router '%s' dynamisch auf App gemountet (prefix=%s)",
            plugin_key, router_mount_prefix,
        )
        return True

    except Exception:
        _logger.exception("Plugin-Router '%s' konnte nicht dynamisch geladen werden", plugin_key)
        return False


def mount_deferred_plugin_routers(app) -> None:
    """Plugin-Router mit eigenem mount_prefix auf die App mounten.

    Muss aus main.py nach App-Erstellung aufgerufen werden, da diese Plugins
    direkt auf der App gemountet werden (nicht auf api_router).
    """
    import logging

    _logger = logging.getLogger(__name__)

    for plugin_key, plugin_router, mount_prefix, plugin_admin_router in _deferred_plugin_routers:
        app.include_router(plugin_router, prefix=mount_prefix)
        _logger.info("Plugin-Router '%s' unter '%s' gemountet", plugin_key, mount_prefix)

        if plugin_admin_router is not None:
            # Admin-Router bleibt unter /api/v1 (FilaMan Admin-Bereich)
            app.include_router(plugin_admin_router, prefix="/api/v1")
            _logger.info("Plugin-Admin-Router '%s' unter '/api/v1' gemountet", plugin_key)


# ---------------------------------------------------------------------------
# Auto-discovery: mount routers from user-installed import/integration plugins
# ---------------------------------------------------------------------------
def _mount_plugin_routers() -> None:
    import importlib
    import json
    import logging
    import sys

    from app.services.plugin_service import PLUGINS_DIR

    _logger = logging.getLogger(__name__)

    if not PLUGINS_DIR.is_dir():
        return

    # Ensure PLUGINS_DIR is on sys.path so plugin packages are importable.
    # This must happen HERE because this function runs at module-import time,
    # before plugin_manager.py gets a chance to set up sys.path.
    if str(PLUGINS_DIR) not in sys.path:
        sys.path.insert(0, str(PLUGINS_DIR))

    for plugin_dir in sorted(PLUGINS_DIR.iterdir()):
        if not plugin_dir.is_dir():
            continue
        manifest_path = plugin_dir / "plugin.json"
        router_path = plugin_dir / "router.py"
        if not manifest_path.exists() or not router_path.exists():
            continue

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("plugin_type") not in ("import", "integration"):
                continue

            plugin_key = manifest.get("plugin_key", plugin_dir.name)
            mount_prefix = manifest.get("mount_prefix")

            module = importlib.import_module(f"{plugin_key}.router")
            plugin_router = getattr(module, "router", None)
            if plugin_router is None:
                _logger.warning(
                    "Plugin '%s' hat router.py aber kein 'router' Attribut",
                    plugin_key,
                )
                continue

            plugin_admin_router = getattr(module, "admin_router", None)

            if mount_prefix:
                # Plugin definiert eigenen Mount-Punkt — deferred mount auf app
                _deferred_plugin_routers.append(
                    (plugin_key, plugin_router, mount_prefix, plugin_admin_router)
                )
                _logger.info(
                    "Plugin-Router '%s' fuer deferred mount unter '%s' vorgemerkt",
                    plugin_key, mount_prefix,
                )
            else:
                api_router.include_router(plugin_router)
                _logger.info("Plugin-Router '%s' erfolgreich gemountet", plugin_key)

                if plugin_admin_router is not None:
                    api_router.include_router(plugin_admin_router)
                    _logger.info("Plugin-Admin-Router '%s' erfolgreich gemountet", plugin_key)

        except Exception as exc:
            _logger.warning(
                "Plugin-Router '%s' konnte nicht geladen werden: %s",
                plugin_dir.name,
                exc,
            )


_mount_plugin_routers()
