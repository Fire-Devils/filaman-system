from fastapi import APIRouter, Query
from sqlalchemy import func, select, case
from pydantic import BaseModel

from app.api.deps import DBSession, PrincipalDep
from app.models import Filament, Location, Manufacturer, Spool, SpoolStatus

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class ManufacturerSpoolCount(BaseModel):
    id: int
    name: str
    spool_count: int


class FilamentTypeCount(BaseModel):
    material_type: str
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
    total_value_available: float
    filament_count_active: int
    filament_count_used: int
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
            func.sum(
                case(
                    (
                        (Spool.remaining_weight_g > 0)
                        & (Spool.remaining_weight_g > Spool.low_weight_threshold_g)
                        & (Spool.initial_total_weight_g > 0)
                        & (
                            (Spool.remaining_weight_g / Spool.initial_total_weight_g)
                            * 100
                            > 75
                        ),
                        1,
                    ),
                    else_=0,
                )
            ).label("full"),
            func.sum(
                case(
                    (
                        (Spool.remaining_weight_g > 0)
                        & (Spool.remaining_weight_g > Spool.low_weight_threshold_g)
                        & (
                            (Spool.initial_total_weight_g.is_(None))
                            | (Spool.initial_total_weight_g <= 0)
                            | (
                                (
                                    Spool.remaining_weight_g
                                    / Spool.initial_total_weight_g
                                )
                                * 100
                                <= 75
                            )
                        ),
                        1,
                    ),
                    else_=0,
                )
            ).label("normal"),
            func.sum(
                case(
                    (
                        (Spool.remaining_weight_g > 0)
                        & (Spool.remaining_weight_g <= Spool.low_weight_threshold_g)
                        & (Spool.remaining_weight_g > Spool.low_weight_threshold_g / 2),
                        1,
                    ),
                    else_=0,
                )
            ).label("low"),
            func.sum(
                case(
                    (
                        (Spool.remaining_weight_g > 0)
                        & (
                            Spool.remaining_weight_g <= Spool.low_weight_threshold_g / 2
                        ),
                        1,
                    ),
                    else_=0,
                )
            ).label("critical"),
        )
        .join(SpoolStatus)
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
    )

    # Filament-Statistik nach Typ
    filament_stats_stmt = (
        select(
            Filament.material_type,
            func.count(Spool.id).label("spool_count"),
            func.coalesce(func.sum(Spool.remaining_weight_g), 0).label("total_weight"),
        )
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g > 0)
        .where(Filament.material_type.isnot(None))
        .where(Filament.material_type != "")
        .group_by(Filament.material_type)
        .order_by(func.sum(Spool.remaining_weight_g).desc())
    )

    # Hersteller mit nicht-leeren Spulen (remaining_weight_g > 0)
    non_empty_stmt = (
        select(
            Manufacturer.id,
            Manufacturer.name,
            func.count(Spool.id).label("spool_count"),
        )
        .join(Filament, Filament.manufacturer_id == Manufacturer.id)
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
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
            Filament.material_type.label("filament_type"),
            Manufacturer.name.label("manufacturer_name"),
            Spool.remaining_weight_g,
            Spool.low_weight_threshold_g,
        )
        .join(Filament, Spool.filament_id == Filament.id)
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
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
            Filament.material_type.label("filament_type"),
            Manufacturer.name.label("manufacturer_name"),
        )
        .join(Filament, Spool.filament_id == Filament.id)
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
        .where(Spool.remaining_weight_g.isnot(None))
        .where(Spool.remaining_weight_g <= 0)
        .order_by(Spool.remaining_weight_g.asc())
        .limit(limit)
    )

    # Filament-Typen mit Anzahl
    types_stmt = (
        select(Filament.material_type, func.count(Filament.id).label("filament_count"))
        .join(Spool, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
        .where(Filament.material_type.isnot(None))
        .where(Filament.material_type != "")
        .group_by(Filament.material_type)
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
        .outerjoin(
            Spool,
            (Spool.location_id == Location.id)
            & (
                Spool.status_id
                != select(SpoolStatus.id)
                .where(SpoolStatus.key == "archived")
                .scalar_subquery()
            ),
        )
        .where(Location.name.isnot(None))
        .group_by(Location.id, Location.name)
        .order_by(func.count(Spool.id).desc())
    )

    # Gesamtwert verfügbarer Spulen
    total_value_stmt = (
        select(func.coalesce(func.sum(Spool.purchase_price), 0))
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
    )

    # Filament-Anzahl nach Scope:
    # active = mindestens eine nicht-archivierte, nicht-leere Spule
    filament_count_active_stmt = select(
        func.count(func.distinct(Filament.id))
    ).where(
        Filament.id.in_(
            select(Spool.filament_id)
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .where(SpoolStatus.key != "archived")
            .where(Spool.remaining_weight_g.isnot(None))
            .where(Spool.remaining_weight_g > 0)
        )
    )

    # used = jemals mindestens eine Spule verknüpft (inkl. archiviert/leer)
    filament_count_used_stmt = select(
        func.count(func.distinct(Spool.filament_id))
    ).where(Spool.filament_id.isnot(None))

    # Execute all queries sequentially (async sessions do not support concurrent operations)
    dist_res = await db.execute(spool_distribution_stmt)
    fil_stats_res = await db.execute(filament_stats_stmt)
    mfg_res = await db.execute(non_empty_stmt)
    low_stock_res = await db.execute(low_stock_stmt)
    empty_res = await db.execute(empty_stmt)
    types_res = await db.execute(types_stmt)
    loc_res = await db.execute(location_stats_stmt)
    total_val_res = await db.execute(total_value_stmt)
    filament_count_active_res = await db.execute(filament_count_active_stmt)
    filament_count_used_res = await db.execute(filament_count_used_stmt)

    total_value_available = float(total_val_res.scalar() or 0.0)

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
        FilamentTypeCount(material_type=row[0], count=row[1]) for row in types_res.all()
    ]

    location_stats = [
        LocationStat(
            location_id=int(row[0]),
            location_name=row[1] or "Unzugewiesen",
            spool_count=int(row[2] or 0),
            total_weight_g=float(row[3]),
        )
        for row in loc_res.all()
    ]

    return DashboardStatsResponse(
        spool_distribution=spool_distribution,
        total_value_available=total_value_available,
        filament_count_active=int(filament_count_active_res.scalar() or 0),
        filament_count_used=int(filament_count_used_res.scalar() or 0),
        filament_stats=filament_stats,
        location_stats=location_stats,
        manufacturers_with_spools=manufacturers_with_spools,
        low_stock_spools=low_stock_spools,
        empty_spools=empty_spools,
        filament_types=filament_types,
    )
