from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from pydantic import BaseModel

from app.api.deps import DBSession, PrincipalDep
from app.models import Filament, Manufacturer, Spool

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class ManufacturerSpoolCount(BaseModel):
    id: int
    name: str
    spool_count: int


class FilamentTypeCount(BaseModel):
    type: str
    count: int


class DashboardStatsResponse(BaseModel):
    manufacturers_with_spools: list[ManufacturerSpoolCount]
    manufacturers_with_low_stock: list[ManufacturerSpoolCount]
    filament_types: list[FilamentTypeCount]


@router.get("/stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    db: DBSession,
    principal: PrincipalDep,
    limit: int = Query(20, ge=1, le=50),
):
    # Hersteller mit nicht-leeren Spulen (remaining_weight_g > 0)
    non_empty_stmt = (
        select(Manufacturer.id, Manufacturer.name, func.count(Spool.id).label("spool_count"))
        .join(Filament, Filament.manufacturer_id == Manufacturer.id)
        .join(Spool, Spool.filament_id == Filament.id)
        .where(Spool.deleted_at.is_(None))
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .group_by(Manufacturer.id, Manufacturer.name)
        .order_by(func.count(Spool.id).desc())
        .limit(limit)
    )
    non_empty_result = await db.execute(non_empty_stmt)
    manufacturers_with_spools = [
        ManufacturerSpoolCount(id=row[0], name=row[1], spool_count=row[2])
        for row in non_empty_result.all()
    ]

    # Hersteller mit fast-leeren Spulen (remaining_weight_g > 0 AND remaining_weight_g <= low_weight_threshold_g)
    low_stock_stmt = (
        select(Manufacturer.id, Manufacturer.name, func.count(Spool.id).label("spool_count"))
        .join(Filament, Filament.manufacturer_id == Manufacturer.id)
        .join(Spool, Spool.filament_id == Filament.id)
        .where(Spool.deleted_at.is_(None))
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .where(Spool.remaining_weight_g <= Spool.low_weight_threshold_g)
        .group_by(Manufacturer.id, Manufacturer.name)
        .order_by(func.count(Spool.id).desc())
        .limit(limit)
    )
    low_stock_result = await db.execute(low_stock_stmt)
    manufacturers_with_low_stock = [
        ManufacturerSpoolCount(id=row[0], name=row[1], spool_count=row[2])
        for row in low_stock_result.all()
    ]

    # Filament-Typen mit Anzahl
    types_stmt = (
        select(Filament.type, func.count(Filament.id).label("filament_count"))
        .where(Filament.type.isnot(None))
        .where(Filament.type != "")
        .group_by(Filament.type)
        .order_by(func.count(Filament.id).desc())
    )
    types_result = await db.execute(types_stmt)
    filament_types = [
        FilamentTypeCount(type=row[0], count=row[1])
        for row in types_result.all()
    ]

    return DashboardStatsResponse(
        manufacturers_with_spools=manufacturers_with_spools,
        manufacturers_with_low_stock=manufacturers_with_low_stock,
        filament_types=filament_types,
    )
