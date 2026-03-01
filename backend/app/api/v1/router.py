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
api_router.include_router(oidc_public_router)


# ---------------------------------------------------------------------------
# Auto-discovery: mount routers from user-installed import plugins
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
            if manifest.get("plugin_type") != "import":
                continue

            plugin_key = manifest.get("plugin_key", plugin_dir.name)
            module = importlib.import_module(f"{plugin_key}.router")
            plugin_router = getattr(module, "router", None)
            if plugin_router is None:
                _logger.warning(
                    "Plugin '%s' hat router.py aber kein 'router' Attribut",
                    plugin_key,
                )
                continue

            api_router.include_router(plugin_router)
            _logger.info("Plugin-Router '%s' erfolgreich gemountet", plugin_key)

        except Exception as exc:
            _logger.warning(
                "Plugin-Router '%s' konnte nicht geladen werden: %s",
                plugin_dir.name,
                exc,
            )


_mount_plugin_routers()
