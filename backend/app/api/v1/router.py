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
