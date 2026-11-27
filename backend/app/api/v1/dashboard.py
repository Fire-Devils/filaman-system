from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select

from app.api.deps import DBSession, PrincipalDep
from app.api.v1.analytics import _add_months, _month_key, _month_start, get_analytics_summary
from app.api.v1.schemas import InventoryValuation
from app.models import (
    Color,
    Filament,
    FilamentColor,
    InventorySnapshot,
    Location,
    Manufacturer,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    Spool,
    SpoolEvent,
    SpoolStatus,
)
from app.services.inventory_snapshots import current_inventory
from app.services.material_presets import load_presets, match_preset
from app.services.spool_metrics import remaining_value_expression, spool_metric_expressions
from app.services.spool_moisture import EXCLUDED_STATUS_KEYS, compute_moisture

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


class LowStockFilament(BaseModel):
    filament_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str
    total_remaining_g: float
    low_stock_threshold_g: float
    spool_count: int


class MoistureAttentionSpool(BaseModel):
    spool_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str
    level: str
    days_exposed: int
    sensitivity: str
    reference_at: datetime


class EmptySpool(BaseModel):
    spool_id: int
    filament_designation: str
    filament_type: str
    manufacturer_name: str


class DashboardStatsResponse(BaseModel):
    valuation: InventoryValuation | None = Field(None, exclude_if=lambda value: value is None)
    spool_distribution: dict[str, int]
    total_value_available: float
    remaining_value_available: float
    filament_count_active: int
    filament_count_used: int
    filament_stats: list[FilamentStat]
    location_stats: list[LocationStat]
    manufacturers_with_spools: list[ManufacturerSpoolCount]
    low_stock_spools: list[LowStockSpool]
    low_stock_filaments: list[LowStockFilament] = []
    empty_spools: list[EmptySpool]
    moisture_attention: list[MoistureAttentionSpool] = []
    filament_types: list[FilamentTypeCount]
    spool_count_total: int | None = Field(None, exclude_if=lambda value: value is None)
    filament_count_total: int | None = Field(None, exclude_if=lambda value: value is None)


MOISTURE_ATTENTION_LIMIT = 20


async def _moisture_attention(db) -> list[MoistureAttentionSpool]:
    """Spools whose moisture level is damp or wet, most exposed first."""
    rows = await db.execute(
        select(
            Spool.id,
            Spool.opened_at,
            Spool.last_dried_at,
            SpoolStatus.key,
            Filament.designation,
            Filament.material_type,
            Filament.material_subgroup,
            Filament.drying_interval_days,
            Manufacturer.name,
        )
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .join(Filament, Spool.filament_id == Filament.id)
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .where(SpoolStatus.key.notin_(tuple(EXCLUDED_STATUS_KEYS)))
        .where(or_(Spool.opened_at.isnot(None), Spool.last_dried_at.isnot(None)))
    )
    now = datetime.now(timezone.utc)
    presets = await load_presets(db)
    found = []
    for (spool_id, opened, dried, status_key, designation, mtype, msub, fil_interval, mname) in rows.all():
        interval = fil_interval
        if interval is None:
            preset = match_preset(presets, mtype, msub)
            interval = preset.drying_interval_days if preset is not None else None
        moisture = compute_moisture(
            status_key, mtype, msub, opened, dried, now, interval_days=interval
        )
        if moisture is None or moisture["level"] not in ("damp", "wet"):
            continue
        found.append(
            MoistureAttentionSpool(
                spool_id=spool_id,
                filament_designation=designation,
                filament_type=mtype,
                manufacturer_name=mname,
                **moisture,
            )
        )
    found.sort(key=lambda item: (-item.days_exposed, item.spool_id))
    return found[:MOISTURE_ATTENTION_LIMIT]


@router.get("/locations", response_model=list[LocationStat])
async def get_dashboard_locations(db: DBSession, principal: PrincipalDep):
    statement = (
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
    result = await db.execute(statement)
    return [
        LocationStat(
            location_id=int(row[0]),
            location_name=row[1] or "Unzugewiesen",
            spool_count=int(row[2] or 0),
            total_weight_g=float(row[3]),
        )
        for row in result.all()
    ]

@router.get("/stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    db: DBSession,
    principal: PrincipalDep,
    limit: int = Query(20, ge=1, le=50),
    include_totals: bool = False,
    include_valuation: bool = False,
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

    # Filamente unter ihrem Mindestbestand: Summe der Restgewichte aller Spulen
    # (ohne archived/empty; "new" zaehlt mit, NULL zaehlt als 0).
    counted_spools = (
        select(
            Spool.filament_id.label("filament_id"),
            func.coalesce(func.sum(func.coalesce(Spool.remaining_weight_g, 0)), 0).label("total"),
            func.count(Spool.id).label("spool_count"),
        )
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key.notin_(("archived", "empty")))
        .group_by(Spool.filament_id)
        .subquery()
    )
    low_total = func.coalesce(counted_spools.c.total, 0)
    low_stock_filaments_stmt = (
        select(
            Filament.id,
            Filament.designation,
            Filament.material_type,
            Manufacturer.name,
            low_total.label("total"),
            Filament.low_stock_threshold_g,
            func.coalesce(counted_spools.c.spool_count, 0).label("spool_count"),
        )
        .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
        .outerjoin(counted_spools, counted_spools.c.filament_id == Filament.id)
        .where(Filament.low_stock_threshold_g.isnot(None))
        .where(Filament.low_stock_threshold_g > 0)
        .where(low_total < Filament.low_stock_threshold_g)
        .order_by(low_total / Filament.low_stock_threshold_g, Filament.id)
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

    # Gesamtwert verfügbarer Spulen
    total_value_stmt = (
        select(
            func.coalesce(func.sum(Spool.purchase_price), 0),
            func.count(Spool.id),
            func.coalesce(func.sum(remaining_value_expression(db.get_bind().dialect.name)), 0),
        )
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .outerjoin(Filament, Spool.filament_id == Filament.id)
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
    low_stock_filaments_res = await db.execute(low_stock_filaments_stmt)
    empty_res = await db.execute(empty_stmt)
    types_res = await db.execute(types_stmt)
    location_stats = await get_dashboard_locations(db, principal)
    total_val_res = await db.execute(total_value_stmt)
    filament_count_active_res = await db.execute(filament_count_active_stmt)
    filament_count_used_res = await db.execute(filament_count_used_stmt)

    total_value_available, spool_count_total, remaining_value_available = total_val_res.one()

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

    low_stock_filaments = [
        LowStockFilament(
            filament_id=row[0],
            filament_designation=row[1],
            filament_type=row[2],
            manufacturer_name=row[3],
            total_remaining_g=float(row[4]),
            low_stock_threshold_g=float(row[5]),
            spool_count=int(row[6]),
        )
        for row in low_stock_filaments_res.all()
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

    moisture_attention = await _moisture_attention(db)

    totals = {}
    if include_totals:
        totals = {
            "spool_count_total": spool_count_total,
            "filament_count_total": await db.scalar(select(func.count(Filament.id))) or 0,
        }

    if include_valuation:
        inventory = await current_inventory(db)
        totals["valuation"] = InventoryValuation(
            remaining_value=inventory.remaining_value,
            unknown_spool_count=inventory.unknown_value_count,
        )

    return DashboardStatsResponse(
        spool_distribution=spool_distribution,
        total_value_available=float(total_value_available),
        remaining_value_available=float(remaining_value_available),
        filament_count_active=int(filament_count_active_res.scalar() or 0),
        filament_count_used=int(filament_count_used_res.scalar() or 0),
        filament_stats=filament_stats,
        location_stats=location_stats,
        manufacturers_with_spools=manufacturers_with_spools,
        low_stock_spools=low_stock_spools,
        low_stock_filaments=low_stock_filaments,
        empty_spools=empty_spools,
        moisture_attention=moisture_attention,
        filament_types=filament_types,
        **totals,
    )


class HistoryMonth(BaseModel):
    month: str
    spend: float
    consumption_g: float
    # Stock figures come from daily snapshots; None = nothing recorded that month.
    spool_count: int | None = None
    total_weight_g: float | None = None
    stock_value: float | None = None


class DashboardHistoryResponse(BaseModel):
    months: list[HistoryMonth]


@router.get("/history", response_model=DashboardHistoryResponse)
async def get_dashboard_history(
    db: DBSession,
    principal: PrincipalDep,
    months: int = Query(12, ge=1, le=36),
):
    """Monthly series for the dashboard charts, oldest month first.

    spend and consumption_g come from the analytics summary. The stock figures
    (spool_count, total_weight_g, stock_value) are real data only: the last daily
    snapshot of each month, the live tile values for the current month and None
    for months without a snapshot (no estimates, no interpolation).
    """
    today = datetime.now(timezone.utc).date()
    first = _add_months(_month_start(today), -(months - 1))
    summary = await get_analytics_summary(db, principal, date_from=first, date_to=today)
    spend = {m.month: m.total for m in summary.purchases.by_month}
    consumed = {m.month: m.weight_g for m in summary.consumption_by_month}

    snapshots = (
        (
            await db.execute(
                select(InventorySnapshot)
                .where(InventorySnapshot.snapshot_date >= first)
                .order_by(InventorySnapshot.snapshot_date)
            )
        )
        .scalars()
        .all()
    )
    last_snapshot = {_month_key(s.snapshot_date): s for s in snapshots}  # later days win

    live = await current_inventory(db)
    current_key = _month_key(today)

    result = []
    for i in range(months):
        key = _month_key(_add_months(first, i))
        if key == current_key:
            count, weight, value = live.spool_count, live.total_weight_g, live.remaining_value
        elif key in last_snapshot:
            snap = last_snapshot[key]
            count, weight, value = snap.spool_count, snap.total_weight_g, snap.stock_value
        else:
            count = weight = value = None
        result.append(
            HistoryMonth(
                month=key,
                spend=spend.get(key, 0.0),
                consumption_g=consumed.get(key, 0.0),
                spool_count=count,
                total_weight_g=None if weight is None else round(weight, 2),
                stock_value=None if value is None else round(value, 2),
            )
        )
    return DashboardHistoryResponse(months=result)


# --- Extra dashboard cards: stale spools, top consumers, stock range, printer slots ---

CONSUMPTION_EVENT_TYPE = "print_consumption"
STALE_LIST_LIMIT = 100


def _months_ago(now: datetime, months: int) -> datetime:
    index = now.year * 12 + (now.month - 1) - months
    year, month = index // 12, index % 12 + 1
    # Clamp to the last day of the target month (e.g. 31 May minus 3 months).
    last_day = (_add_months(date(year, month, 1), 1) - timedelta(days=1)).day
    return now.replace(year=year, month=month, day=min(now.day, last_day))


def _weight_expression(dialect: str):
    """Remaining grams as the tiles count them (inferred weight of new spools included)."""
    return spool_metric_expressions(dialect)["effective_remaining_weight_g"]


async def _color_hexes(db, filament_ids: set[int]) -> dict[int, list[str]]:
    if not filament_ids:
        return {}
    rows = await db.execute(
        select(FilamentColor.filament_id, Color.hex_code)
        .join(Color, FilamentColor.color_id == Color.id)
        .where(FilamentColor.filament_id.in_(filament_ids))
        .order_by(FilamentColor.filament_id, FilamentColor.position)
    )
    result: dict[int, list[str]] = {}
    for filament_id, hex_code in rows.all():
        result.setdefault(filament_id, []).append(hex_code)
    return result


class StaleSpool(BaseModel):
    spool_id: int
    filament_id: int
    filament_designation: str
    material_type: str
    color_name: str | None
    colors: list[str]
    manufacturer_name: str
    remaining_weight_g: float
    remaining_value: float | None
    last_used_at: datetime | None
    reference_at: datetime


class StaleSpoolsResponse(BaseModel):
    months: int
    items: list[StaleSpool]
    total_count: int
    total_weight_g: float
    total_value: float
    unknown_value_count: int


@router.get("/stale-spools", response_model=StaleSpoolsResponse)
async def get_stale_spools(
    db: DBSession,
    principal: PrincipalDep,
    months: int = Query(6, ge=1, le=60),
):
    """Spools in stock that were not used for `months` months.

    "Not used" = newest print_consumption event is older than the cutoff; spools that
    never were used count from purchase_date, else stocked_in_at, else created_at.
    """
    dialect = db.get_bind().dialect.name
    cutoff = _months_ago(datetime.now(timezone.utc), months)
    last_use = (
        select(SpoolEvent.spool_id.label("spool_id"), func.max(SpoolEvent.event_at).label("at"))
        .where(SpoolEvent.event_type == CONSUMPTION_EVENT_TYPE, SpoolEvent.spool_id.is_not(None))
        .group_by(SpoolEvent.spool_id)
        .subquery()
    )
    weight = _weight_expression(dialect).label("weight")
    value = remaining_value_expression(dialect, known_only=True).label("value")
    reference = func.coalesce(
        last_use.c.at, Spool.purchase_date, Spool.stocked_in_at, Spool.created_at
    )
    rows = (
        await db.execute(
            select(
                Spool.id,
                Filament.id,
                Filament.designation,
                Filament.material_type,
                Filament.manufacturer_color_name,
                Manufacturer.name,
                weight,
                value,
                last_use.c.at,
                reference.label("reference"),
            )
            .select_from(Spool)
            .join(Filament, Spool.filament_id == Filament.id)
            .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .outerjoin(last_use, last_use.c.spool_id == Spool.id)
            .where(SpoolStatus.key != "archived", weight > 0, reference < cutoff)
            .order_by(reference, Spool.id)
        )
    ).all()
    shown = rows[:STALE_LIST_LIMIT]
    colors = await _color_hexes(db, {row[1] for row in shown})
    known = [float(row[7]) for row in rows if row[7] is not None]
    return StaleSpoolsResponse(
        months=months,
        items=[
            StaleSpool(
                spool_id=row[0],
                filament_id=row[1],
                filament_designation=row[2],
                material_type=row[3],
                color_name=row[4],
                colors=colors.get(row[1], []),
                manufacturer_name=row[5],
                remaining_weight_g=round(float(row[6]), 1),
                remaining_value=None if row[7] is None else round(float(row[7]), 2),
                last_used_at=row[8],
                reference_at=row[9],
            )
            for row in shown
        ],
        total_count=len(rows),
        total_weight_g=round(sum(float(row[6]) for row in rows), 1),
        total_value=round(sum(known), 2),
        unknown_value_count=len(rows) - len(known),
    )


def _consumption_since(days: int):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    return (
        SpoolEvent.event_type == CONSUMPTION_EVENT_TYPE,
        SpoolEvent.delta_weight_g.is_not(None),
        SpoolEvent.event_at >= since,
    )


class TopConsumer(BaseModel):
    filament_id: int
    filament_designation: str
    material_type: str
    color_name: str | None
    colors: list[str]
    manufacturer_name: str
    consumed_g: float
    spools_in_stock: int


class TopConsumersResponse(BaseModel):
    days: int
    items: list[TopConsumer]


@router.get("/top-consumers", response_model=TopConsumersResponse)
async def get_top_consumers(
    db: DBSession,
    principal: PrincipalDep,
    days: int = Query(90, ge=1, le=730),
    limit: int = Query(8, ge=1, le=50),
):
    """Filaments with the highest print consumption in the last `days` days.

    Events of permanently deleted spools still count through SpoolEvent.filament_id.
    """
    filament_id = func.coalesce(Spool.filament_id, SpoolEvent.filament_id)
    consumed = func.sum(func.abs(SpoolEvent.delta_weight_g))
    top = (
        await db.execute(
            select(filament_id.label("fid"), consumed.label("consumed"))
            .select_from(SpoolEvent)
            .outerjoin(Spool, SpoolEvent.spool_id == Spool.id)
            .where(*_consumption_since(days))
            .group_by(filament_id)
            .having(filament_id.is_not(None))
            .order_by(consumed.desc(), filament_id)
            .limit(limit)
        )
    ).all()
    ids = {row[0] for row in top}
    if not ids:
        return TopConsumersResponse(days=days, items=[])
    dialect = db.get_bind().dialect.name
    details = {
        row[0]: row
        for row in (
            await db.execute(
                select(
                    Filament.id,
                    Filament.designation,
                    Filament.material_type,
                    Filament.manufacturer_color_name,
                    Manufacturer.name,
                )
                .join(Manufacturer, Filament.manufacturer_id == Manufacturer.id)
                .where(Filament.id.in_(ids))
            )
        ).all()
    }
    weight = _weight_expression(dialect)
    stock = dict(
        (
            await db.execute(
                select(Spool.filament_id, func.count(Spool.id))
                .select_from(Spool)
                .join(Filament, Spool.filament_id == Filament.id)
                .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
                .where(Spool.filament_id.in_(ids), SpoolStatus.key != "archived", weight > 0)
                .group_by(Spool.filament_id)
            )
        ).all()
    )
    colors = await _color_hexes(db, ids)
    return TopConsumersResponse(
        days=days,
        items=[
            TopConsumer(
                filament_id=fid,
                filament_designation=details[fid][1],
                material_type=details[fid][2],
                color_name=details[fid][3],
                colors=colors.get(fid, []),
                manufacturer_name=details[fid][4],
                consumed_g=round(float(total), 1),
                spools_in_stock=int(stock.get(fid, 0)),
            )
            for fid, total in top
            if fid in details
        ],
    )


class StockRangeMaterial(BaseModel):
    material_type: str
    remaining_g: float
    consumed_g: float
    # Forecast: remaining / (consumed over `days` / days). None = no consumption in the window.
    days_left: float | None


class StockRangeResponse(BaseModel):
    days: int
    items: list[StockRangeMaterial]


@router.get("/stock-range", response_model=StockRangeResponse)
async def get_stock_range(
    db: DBSession,
    principal: PrincipalDep,
    days: int = Query(90, ge=7, le=730),
):
    """Per material: stock, consumption of the last `days` days and the extrapolated range.

    The range is a forecast (remaining weight divided by the average daily consumption),
    shortest range first, materials without consumption last.
    """
    dialect = db.get_bind().dialect.name
    weight = _weight_expression(dialect)
    stock = dict(
        (
            await db.execute(
                select(Filament.material_type, func.coalesce(func.sum(weight), 0))
                .select_from(Spool)
                .join(Filament, Spool.filament_id == Filament.id)
                .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
                .where(SpoolStatus.key != "archived")
                .group_by(Filament.material_type)
            )
        ).all()
    )
    filament_id = func.coalesce(Spool.filament_id, SpoolEvent.filament_id)
    used = dict(
        (
            await db.execute(
                select(Filament.material_type, func.sum(func.abs(SpoolEvent.delta_weight_g)))
                .select_from(SpoolEvent)
                .outerjoin(Spool, SpoolEvent.spool_id == Spool.id)
                .join(Filament, Filament.id == filament_id)
                .where(*_consumption_since(days))
                .group_by(Filament.material_type)
            )
        ).all()
    )
    items = []
    for material in set(stock) | set(used):
        remaining = float(stock.get(material) or 0)
        consumed = float(used.get(material) or 0)
        if remaining <= 0 and consumed <= 0:
            continue
        items.append(
            StockRangeMaterial(
                material_type=material,
                remaining_g=round(remaining, 1),
                consumed_g=round(consumed, 1),
                days_left=round(remaining / (consumed / days), 1) if consumed > 0 else None,
            )
        )
    items.sort(key=lambda m: (m.days_left is None, m.days_left or 0, m.material_type))
    return StockRangeResponse(days=days, items=items)


class PrinterSlotOccupancy(BaseModel):
    slot_no: int
    name: str | None
    spool_id: int | None
    filament_designation: str | None
    material_type: str | None
    color_name: str | None
    colors: list[str]
    manufacturer_name: str | None
    remaining_weight_g: float | None


class PrinterOccupancy(BaseModel):
    printer_id: int
    printer_name: str
    slots: list[PrinterSlotOccupancy]


class PrinterSlotsResponse(BaseModel):
    printers: list[PrinterOccupancy]


@router.get("/printer-slots", response_model=PrinterSlotsResponse)
async def get_printer_slots(db: DBSession, principal: PrincipalDep):
    """Active printers with their active slots and the spool loaded in each."""
    dialect = db.get_bind().dialect.name
    weight = _weight_expression(dialect).label("weight")
    rows = (
        await db.execute(
            select(
                Printer.id,
                Printer.name,
                PrinterSlot.slot_no,
                PrinterSlot.name,
                Spool.id,
                Filament.id,
                Filament.designation,
                Filament.material_type,
                Filament.manufacturer_color_name,
                Manufacturer.name,
                weight,
            )
            .select_from(PrinterSlot)
            .join(Printer, PrinterSlot.printer_id == Printer.id)
            .outerjoin(PrinterSlotAssignment, PrinterSlotAssignment.slot_id == PrinterSlot.id)
            .outerjoin(Spool, Spool.id == PrinterSlotAssignment.spool_id)
            .outerjoin(Filament, Filament.id == Spool.filament_id)
            .outerjoin(Manufacturer, Manufacturer.id == Filament.manufacturer_id)
            .where(
                Printer.deleted_at.is_(None),
                Printer.is_active.is_(True),
                PrinterSlot.is_active.is_(True),
            )
            .order_by(Printer.name, Printer.id, PrinterSlot.slot_no)
        )
    ).all()
    colors = await _color_hexes(db, {row[5] for row in rows if row[5] is not None})
    printers: dict[int, PrinterOccupancy] = {}
    for row in rows:
        printer = printers.setdefault(
            row[0], PrinterOccupancy(printer_id=row[0], printer_name=row[1], slots=[])
        )
        printer.slots.append(
            PrinterSlotOccupancy(
                slot_no=row[2],
                name=row[3],
                spool_id=row[4],
                filament_designation=row[6],
                material_type=row[7],
                color_name=row[8],
                colors=colors.get(row[5], []) if row[5] is not None else [],
                manufacturer_name=row[9],
                remaining_weight_g=None if row[10] is None else round(float(row[10]), 1),
            )
        )
    return PrinterSlotsResponse(printers=list(printers.values()))
