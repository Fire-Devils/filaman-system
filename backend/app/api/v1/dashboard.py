from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, case, literal_column
from pydantic import BaseModel
import asyncio

from app.api.deps import DBSession, PrincipalDep
from app.models import Filament, Location, Manufacturer, Spool, SpoolStatus

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class ManufacturerSpoolCount(BaseModel):
    id: int
    name: str
    spool_count: int


class FilamentTypeCount(BaseModel):
    type: str
    count: int


class FilamentStat(BaseModel):
    filament_type: str
    spool_count: int
    total_weight_g: float


class LocationStat(BaseModel):
    location_id: int
    location_name: str
    spool_count: int
    total_weight_g: float


class LowStockSpool(BaseModel):
    spool_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str
    remaining_weight_g: float
    low_weight_threshold_g: int


class EmptySpool(BaseModel):
    spool_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str


class DashboardStatsResponse(BaseModel):
    spool_distribution: dict[str, int]
    filament_stats: list[FilamentStat]
    location_stats: list[LocationStat]
    manufacturers_with_spools: list[ManufacturerSpoolCount]
    low_stock_spools: list[LowStockSpool]
    empty_spools: list[EmptySpool]
    filament_types: list[FilamentTypeCount]


@router.get("/stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    db: DBSession,
    principal: PrincipalDep,
    limit: int = Query(20, ge=1, le=50),
):
    # Spulen-Verteilung berechnen (Optimiert: DB-seitige Aggregation)
    spool_distribution_stmt = (
        select(
            func.sum(case((Spool.remaining_weight_g <= 0, 1), else_=0)).label("empty"),
            func.sum(case(
                (
                    (Spool.remaining_weight_g > 0) & 
                    (Spool.remaining_weight_g > Spool.low_weight_threshold_g) &
                    (Spool.initial_total_weight_g > 0) &
                    ((Spool.remaining_weight_g / Spool.initial_total_weight_g) * 100 > 75),
                    1
                ),
                else_=0
            )).label("full"),
            func.sum(case(
                (
                    (Spool.remaining_weight_g > 0) & 
                    (Spool.remaining_weight_g > Spool.low_weight_threshold_g) &
                    (
                        (Spool.initial_total_weight_g.is_(None)) | 
                        (Spool.initial_total_weight_g <= 0) | 
                        ((Spool.remaining_weight_g / Spool.initial_total_weight_g) * 100 <= 75)
                    ),
                    1
                ),
                else_=0
            )).label("normal"),
            func.sum(case(
                (
                    (Spool.remaining_weight_g > 0) & 
                    (Spool.remaining_weight_g <= Spool.low_weight_threshold_g) &
                    (Spool.remaining_weight_g > Spool.low_weight_threshold_g / 2),
                    1
                ),
                else_=0
            )).label("low"),
            func.sum(case(
                (
                    (Spool.remaining_weight_g > 0) & 
                    (Spool.remaining_weight_g <= Spool.low_weight_threshold_g / 2),
                    1
                ),
                else_=0
            )).label("critical")
        )
        .join(SpoolStatus)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
    )
    
    # Filament-Statistik nach Typ
    filament_stats_stmt = (
        select(
            Filament.type,
            func.count(Spool.id).label("spool_count"),
            func.coalesce(func.sum(Spool.remaining_weight_g), 0).label("total_weight"),
        )
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .where(Filament.type.isnot(None))
        .where(Filament.type != "")
        .group_by(Filament.type)
        .order_by(func.sum(Spool.remaining_weight_g).desc())
    )
    
    # Hersteller mit nicht-leeren Spulen (remaining_weight_g > 0)
    non_empty_stmt = (
        select(Manufacturer.id, Manufacturer.name, func.count(Spool.id).label("spool_count"))
        .join(Filament, Filament.manufacturer_id == Manufacturer.id)
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .group_by(Manufacturer.id, Manufacturer.name)
        .order_by(func.count(Spool.id).desc())
        .limit(limit)
    )
    
    # Spulen mit fast-leeren Restgewicht
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
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .where(Spool.remaining_weight_g <= Spool.low_weight_threshold_g)
        .order_by(Spool.remaining_weight_g.asc())
        .limit(limit)
    )
    
    # Leere Spulen (remaining_weight_g <= 0)
    empty_stmt = (
        select(
            Spool.id.label("spool_id"),
            Filament.designation.label("filament_designation"),
            Filament.type.label("filament_type"),
            Manufacturer.name.label("manufacturer_name"),
        )
        .join(Filament, Spool.filament_id == Filament.id)
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g <= 0)
        .order_by(Spool.remaining_weight_g.asc())
        .limit(limit)
    )
    
    # Filament-Typen mit Anzahl
    types_stmt = (
        select(Filament.type, func.count(Filament.id).label("filament_count"))
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
        .where(Spool.deleted_at.is_(None))
        .where(Filament.type.isnot(None))
        .where(Filament.type != "")
        .group_by(Filament.type)
        .order_by(func.count(Filament.id).desc())
    )
    
    # Lagerorte-Statistik
    location_stats_stmt = (
        select(
            Location.id.label("location_id"),
            Location.name.label("location_name"),
            func.count(Spool.id).label("spool_count"),
            func.coalesce(func.sum(Spool.remaining_weight_g), 0).label("total_weight"),
        )
        .outerjoin(Spool, (Spool.location_id == Location.id) & (Spool.deleted_at.is_(None)))
        .outerjoin(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Location.name.isnot(None))
        .where((SpoolStatus.key != "archived") | (SpoolStatus.key.is_(None)))
        .group_by(Location.id, Location.name)
        .order_by(func.count(Spool.id).desc())
    )

    # Execute all queries concurrently
    (
        dist_res, 
        fil_stats_res, 
        mfg_res, 
        low_stock_res, 
        empty_res, 
        types_res, 
        loc_res
    ) = await asyncio.gather(
        db.execute(spool_distribution_stmt),
        db.execute(filament_stats_stmt),
        db.execute(non_empty_stmt),
        db.execute(low_stock_stmt),
        db.execute(empty_stmt),
        db.execute(types_stmt),
        db.execute(location_stats_stmt),
    )

    dist_row = dist_res.first()
    spool_distribution = {
        "empty": int(dist_row[0] or 0) if dist_row else 0,
        "full": int(dist_row[1] or 0) if dist_row else 0,
        "normal": int(dist_row[2] or 0) if dist_row else 0,
        "low": int(dist_row[3] or 0) if dist_row else 0,
        "critical": int(dist_row[4] or 0) if dist_row else 0,
    }

    filament_stats = [
        FilamentStat(
            filament_type=row[0],
            spool_count=row[1],
            total_weight_g=float(row[2]),
        )
        for row in fil_stats_res.all()
    ]

    manufacturers_with_spools = [
        ManufacturerSpoolCount(id=row[0], name=row[1], spool_count=row[2])
        for row in mfg_res.all()
    ]

    low_stock_spools = [
        LowStockSpool(
            spool_id=row[0],
            filament_designation=row[1],
            filament_type=row[2],
            manufacturer_name=row[3],
            remaining_weight_g=float(row[4]),
            low_weight_threshold_g=int(row[5]),
        )
        for row in low_stock_res.all()
    ]

    empty_spools = [
        EmptySpool(
            spool_id=row[0],
            filament_designation=row[1],
            filament_type=row[2],
            manufacturer_name=row[3],
        )
        for row in empty_res.all()
    ]

    filament_types = [
        FilamentTypeCount(type=row[0], count=row[1])
        for row in types_res.all()
    ]

    location_stats = [
        LocationStat(
            location_id=int(row[0]),
            location_name=row[1] or "Unzugewiesen",
            spool_count=int(row[2] or 0),
            total_weight_g=float(row[3]),
        )
        for row in loc_res.all()
        if row[2] and row[2] > 0
    ]

    return DashboardStatsResponse(
        spool_distribution=spool_distribution,
        filament_stats=filament_stats,
        location_stats=location_stats,
        manufacturers_with_spools=manufacturers_with_spools,
        low_stock_spools=low_stock_spools,
        empty_spools=empty_spools,
        filament_types=filament_types,
    )
