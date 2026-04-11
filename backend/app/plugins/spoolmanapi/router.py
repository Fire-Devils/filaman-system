"""Spoolman-compatible REST API router.

Actual endpoints live under /api/v1 (standard Spoolman API layout).
Short-path aliases (/spoolman/spool, /spoolman/filament, /spoolman/vendor)
issue a 307 redirect so that clients configured without the /api/v1 prefix
(e.g. Bambuddy) are transparently forwarded to the correct location.

Mounted at /spoolman via plugin.json mount_prefix.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse

from app.api.deps import DBSession, PrincipalDep
from . import schemas
from .service import SpoolmanService


# ---------------------------------------------------------------------------
# Implementation router – all real routes live here under /api/v1
# ---------------------------------------------------------------------------
_v1 = APIRouter(prefix="/api/v1")


# --- Vendors ---

@_v1.get("/vendor", response_model=list[schemas.Vendor])
async def list_vendors(
    db: DBSession,
    principal: PrincipalDep,
    response: Response,
    name: str | None = Query(None),
    external_id: str | None = Query(None),
    sort: str | None = Query(None),
    limit: int | None = Query(None),
    offset: int = Query(0, ge=0),
):
    items, total = await SpoolmanService(db).list_vendors(
        name=name, external_id=external_id, sort=sort, limit=limit, offset=offset,
    )
    response.headers["X-Total-Count"] = str(total)
    return items


@_v1.get("/vendor/{vendor_id}", response_model=schemas.Vendor)
async def get_vendor(vendor_id: int, db: DBSession, principal: PrincipalDep):
    vendor = await SpoolmanService(db).get_vendor(vendor_id)
    if vendor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vendor not found")
    return vendor


@_v1.post("/vendor", response_model=schemas.Vendor, status_code=status.HTTP_201_CREATED)
async def create_vendor(data: schemas.VendorParameters, db: DBSession, principal: PrincipalDep):
    return await SpoolmanService(db).create_vendor(data)


@_v1.patch("/vendor/{vendor_id}", response_model=schemas.Vendor)
async def update_vendor(vendor_id: int, data: schemas.VendorUpdateParameters, db: DBSession, principal: PrincipalDep):
    vendor = await SpoolmanService(db).update_vendor(vendor_id, data)
    if vendor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vendor not found")
    return vendor


@_v1.delete("/vendor/{vendor_id}", status_code=status.HTTP_200_OK)
async def delete_vendor(vendor_id: int, db: DBSession, principal: PrincipalDep):
    if not await SpoolmanService(db).delete_vendor(vendor_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vendor not found")
    return {}


# --- Filaments ---

@_v1.get("/filament", response_model=list[schemas.Filament])
async def list_filaments(
    db: DBSession,
    principal: PrincipalDep,
    response: Response,
    vendor_name: str | None = Query(None),
    vendor_id: str | None = Query(None),
    name: str | None = Query(None),
    material: str | None = Query(None),
    article_number: str | None = Query(None),
    color_hex: str | None = Query(None),
    external_id: str | None = Query(None),
    sort: str | None = Query(None),
    limit: int | None = Query(None),
    offset: int = Query(0, ge=0),
):
    items, total = await SpoolmanService(db).list_filaments(
        vendor_name=vendor_name, vendor_id=vendor_id, name=name, material=material,
        article_number=article_number, color_hex=color_hex, external_id=external_id,
        sort=sort, limit=limit, offset=offset,
    )
    response.headers["X-Total-Count"] = str(total)
    return items


@_v1.get("/filament/{filament_id}", response_model=schemas.Filament)
async def get_filament(filament_id: int, db: DBSession, principal: PrincipalDep):
    filament = await SpoolmanService(db).get_filament(filament_id)
    if filament is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")
    return filament


@_v1.post("/filament", response_model=schemas.Filament, status_code=status.HTTP_201_CREATED)
async def create_filament(data: schemas.FilamentParameters, db: DBSession, principal: PrincipalDep):
    return await SpoolmanService(db).create_filament(data)


@_v1.patch("/filament/{filament_id}", response_model=schemas.Filament)
async def update_filament(filament_id: int, data: schemas.FilamentUpdateParameters, db: DBSession, principal: PrincipalDep):
    filament = await SpoolmanService(db).update_filament(filament_id, data)
    if filament is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")
    return filament


# --- Spools ---

@_v1.get("/spool", response_model=list[schemas.Spool])
async def list_spools(
    db: DBSession,
    principal: PrincipalDep,
    response: Response,
    filament_name: str | None = Query(None),
    filament_id: str | None = Query(None),
    filament_material: str | None = Query(None),
    vendor_name: str | None = Query(None),
    vendor_id: str | None = Query(None),
    location: str | None = Query(None),
    lot_nr: str | None = Query(None),
    allow_archived: bool = Query(False),
    sort: str | None = Query(None),
    limit: int | None = Query(None),
    offset: int = Query(0, ge=0),
):
    items, total = await SpoolmanService(db).list_spools(
        filament_name=filament_name, filament_id=filament_id,
        filament_material=filament_material, vendor_name=vendor_name,
        vendor_id=vendor_id, location=location, lot_nr=lot_nr,
        allow_archived=allow_archived, sort=sort, limit=limit, offset=offset,
    )
    response.headers["X-Total-Count"] = str(total)
    return items


@_v1.get("/spool/{spool_id}", response_model=schemas.Spool)
async def get_spool(spool_id: int, db: DBSession, principal: PrincipalDep):
    spool = await SpoolmanService(db).get_spool(spool_id)
    if spool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spool not found")
    return spool


@_v1.post("/spool", response_model=schemas.Spool, status_code=status.HTTP_201_CREATED)
async def create_spool(data: schemas.SpoolParameters, db: DBSession, principal: PrincipalDep):
    return await SpoolmanService(db).create_spool(data)


@_v1.patch("/spool/{spool_id}", response_model=schemas.Spool)
async def update_spool(spool_id: int, data: schemas.SpoolUpdateParameters, db: DBSession, principal: PrincipalDep):
    spool = await SpoolmanService(db).update_spool(spool_id, data)
    if spool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spool not found")
    return spool


@_v1.delete("/spool/{spool_id}", status_code=status.HTTP_200_OK)
async def delete_spool(spool_id: int, db: DBSession, principal: PrincipalDep):
    """Archives the spool (Spoolman-compatible DELETE behaviour)."""
    if not await SpoolmanService(db).delete_spool(spool_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spool not found")
    return {}


@_v1.put("/spool/{spool_id}/use", response_model=schemas.Spool)
async def use_spool(spool_id: int, data: schemas.SpoolUseParameters, db: DBSession, principal: PrincipalDep):
    spool = await SpoolmanService(db).use_spool(spool_id, data)
    if spool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spool not found")
    return spool


@_v1.put("/spool/{spool_id}/measure", response_model=schemas.Spool)
async def measure_spool(spool_id: int, data: schemas.SpoolMeasureParameters, db: DBSession, principal: PrincipalDep):
    spool = await SpoolmanService(db).measure_spool(spool_id, data)
    if spool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Spool not found")
    return spool


# --- Info ---

@_v1.get("/info")
async def get_info():
    """Version info endpoint probed by Spoolman clients."""
    return {"version": "0.21.0", "git_commit": "filaman", "debug_mode": False}


# ---------------------------------------------------------------------------
# Main router – mounted at /spoolman by plugin.json
# ---------------------------------------------------------------------------
router = APIRouter(tags=["spoolman"])

# Register /api/v1/... routes first so they take precedence over the redirects.
router.include_router(_v1)

# Short-path compatibility redirects:
# Clients configured with /spoolman as base URL and no /api/v1 prefix
# (e.g. Bambuddy calling /spoolman/spool) are forwarded transparently.
_KNOWN_RESOURCES = {"spool", "filament", "vendor", "info"}


@router.api_route(
    "/{resource}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def _compat_redirect(resource: str, request: Request):
    if resource not in _KNOWN_RESOURCES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    target = f"/spoolman/api/v1/{resource}"
    if request.url.query:
        target += f"?{request.url.query}"
    return RedirectResponse(url=target, status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.api_route(
    "/{resource}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def _compat_redirect_with_path(resource: str, path: str, request: Request):
    if resource not in _KNOWN_RESOURCES:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    target = f"/spoolman/api/v1/{resource}/{path}"
    if request.url.query:
        target += f"?{request.url.query}"
    return RedirectResponse(url=target, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
