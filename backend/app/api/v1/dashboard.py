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


class LowStockSpool(BaseModel):
    spool_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str
    remaining_weight_g: float
    low_weight_threshold_g: int


class DashboardStatsResponse(BaseModel):
    manufacturers_with_spools: list[ManufacturerSpoolCount]
    low_stock_spools: list[LowStockSpool]
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

    # Spulen mit fast-leeren Restgewicht (remaining_weight_g > 0 AND remaining_weight_g <= low_weight_threshold_g)
    low_stock_stmt = (
        select(
            Spool.id.label("spool_id"),
            Filament.designation.label("filament_designation"),
            Filament.type.label("filament_type"),
            Manufacturer.name.label("manufacturer_name"),
            Spool.remaining_weight_g,
            Spool.low_weight_threshold_g,
        )
        .join(Filament, Spool.filament_id == Filament.id)
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .where(Spool.deleted_at.is_(None))
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .where(Spool.remaining_weight_g <= Spool.low_weight_threshold_g)
        .order_by(Spool.remaining_weight_g.asc())
        .limit(limit)
    )
    low_stock_result = await db.execute(low_stock_stmt)
    low_stock_spools = [
        LowStockSpool(
            spool_id=row[0],
            filament_designation=row[1],
            filament_type=row[2],
            manufacturer_name=row[3],
            remaining_weight_g=float(row[4]),
            low_weight_threshold_g=int(row[5]),
        )
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
        low_stock_spools=low_stock_spools,
        filament_types=filament_types,
    )
