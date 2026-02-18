from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from pydantic import BaseModel

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
    # Spulen-Verteilung berechnen
    all_spools_stmt = (
        select(
            Spool.remaining_weight_g,
            Spool.low_weight_threshold_g,
            Spool.initial_total_weight_g,
        )
        .join(SpoolStatus)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
    )
    all_spools_result = await db.execute(all_spools_stmt)
    
    spool_distribution = {"full": 0, "normal": 0, "low": 0, "critical": 0, "empty": 0}
    
    for row in all_spools_result.all():
        remaining = row[0]
        threshold = row[1]
        initial = row[2]
        
        if remaining <= 0:
            spool_distribution["empty"] += 1
        elif remaining > threshold:
            if initial and initial > 0:
                pct = (remaining / initial) * 100
                if pct > 75:
                    spool_distribution["full"] += 1
                else:
                    spool_distribution["normal"] += 1
            else:
                spool_distribution["normal"] += 1
        elif remaining > threshold / 2:
            spool_distribution["low"] += 1
        else:
            spool_distribution["critical"] += 1
    
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
    filament_stats_result = await db.execute(filament_stats_stmt)
    filament_stats = [
        FilamentStat(
            filament_type=row[0],
            spool_count=row[1],
            total_weight_g=float(row[2]),
        )
        for row in filament_stats_result.all()
    ]
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
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(Spool.deleted_at.is_(None))
        .where(SpoolStatus.key != "archived")
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
    empty_result = await db.execute(empty_stmt)
    empty_spools = [
        EmptySpool(
            spool_id=row[0],
            filament_designation=row[1],
            filament_type=row[2],
            manufacturer_name=row[3],
        )
        for row in empty_result.all()
    ]

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
    types_result = await db.execute(types_stmt)
    filament_types = [
        FilamentTypeCount(type=row[0], count=row[1])
        for row in types_result.all()
    ]

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
    location_stats_result = await db.execute(location_stats_stmt)
    location_stats = [
        LocationStat(
            location_id=int(row[0]),
            location_name=row[1] or "Unzugewiesen",
            spool_count=int(row[2] or 0),
            total_weight_g=float(row[3]),
        )
        for row in location_stats_result.all()
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
