"""Read-only Spoolman-compatible API router.

Exposes FilaMan data under the Spoolman API shape at /spoolman/api/v1/…
so that tools expecting a Spoolman instance (e.g. spoolman-filament-swatch)
can point at FilaMan without modification.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.api.deps import DBSession

from . import schemas
from .service import SpoolmanService

router = APIRouter(prefix="/api/v1", tags=["Spoolman Compat API"])


# ---------------------------------------------------------------------------
# Health / info
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


@router.get("/info")
async def info() -> dict[str, Any]:
    return {"version": {"application": "filaman-spoolmanapi"}}


# ---------------------------------------------------------------------------
# Vendors
# ---------------------------------------------------------------------------


@router.get("/vendor", response_model=list[schemas.Vendor])
async def list_vendors(
    db: DBSession,
    name: str | None = Query(default=None),
    external_id: str | None = Query(default=None),
    sort: str | None = Query(default=None),
    limit: int | None = Query(default=None),
    offset: int = Query(default=0),
) -> list[schemas.Vendor]:
    svc = SpoolmanService(db)
    items, _total = await svc.list_vendors(
        name=name,
        external_id=external_id,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return items


@router.get("/vendor/{vendor_id}", response_model=schemas.Vendor)
async def get_vendor(vendor_id: int, db: DBSession) -> schemas.Vendor:
    svc = SpoolmanService(db)
    vendor = await svc.get_vendor(vendor_id)
    if vendor is None:
        raise HTTPException(status_code=404, detail="Vendor not found")
    return vendor


# ---------------------------------------------------------------------------
# Filaments
# ---------------------------------------------------------------------------


@router.get("/filament", response_model=list[schemas.Filament])
async def list_filaments(
    db: DBSession,
    vendor_name: str | None = Query(default=None),
    vendor_id: str | None = Query(default=None),
    name: str | None = Query(default=None),
    material: str | None = Query(default=None),
    article_number: str | None = Query(default=None),
    color_hex: str | None = Query(default=None),
    external_id: str | None = Query(default=None),
    sort: str | None = Query(default=None),
    limit: int | None = Query(default=None),
    offset: int = Query(default=0),
) -> list[schemas.Filament]:
    svc = SpoolmanService(db)
    items, _total = await svc.list_filaments(
        vendor_name=vendor_name,
        vendor_id=vendor_id,
        name=name,
        material=material,
        article_number=article_number,
        color_hex=color_hex,
        external_id=external_id,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return items


@router.get("/filament/{filament_id}", response_model=schemas.Filament)
async def get_filament(filament_id: int, db: DBSession) -> schemas.Filament:
    svc = SpoolmanService(db)
    filament = await svc.get_filament(filament_id)
    if filament is None:
        raise HTTPException(status_code=404, detail="Filament not found")
    return filament


# ---------------------------------------------------------------------------
# Spools
# ---------------------------------------------------------------------------


@router.get("/spool", response_model=list[schemas.Spool])
async def list_spools(
    db: DBSession,
    filament_name: str | None = Query(default=None),
    filament_id: str | None = Query(default=None),
    filament_material: str | None = Query(default=None),
    vendor_name: str | None = Query(default=None),
    vendor_id: str | None = Query(default=None),
    location: str | None = Query(default=None),
    lot_nr: str | None = Query(default=None),
    allow_archived: bool = Query(default=False),
    sort: str | None = Query(default=None),
    limit: int | None = Query(default=None),
    offset: int = Query(default=0),
) -> list[schemas.Spool]:
    svc = SpoolmanService(db)
    items, _total = await svc.list_spools(
        filament_name=filament_name,
        filament_id=filament_id,
        filament_material=filament_material,
        vendor_name=vendor_name,
        vendor_id=vendor_id,
        location=location,
        lot_nr=lot_nr,
        allow_archived=allow_archived,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return items


@router.get("/spool/{spool_id}", response_model=schemas.Spool)
async def get_spool(spool_id: int, db: DBSession) -> schemas.Spool:
    svc = SpoolmanService(db)
    spool = await svc.get_spool(spool_id)
    if spool is None:
        raise HTTPException(status_code=404, detail="Spool not found")
    return spool


# ---------------------------------------------------------------------------
# Utility lists
# ---------------------------------------------------------------------------


@router.get("/material")
async def list_materials(db: DBSession) -> list[str]:
    svc = SpoolmanService(db)
    return await svc.list_materials()


@router.get("/location")
async def list_locations(db: DBSession) -> list[str]:
    svc = SpoolmanService(db)
    return await svc.list_locations()
