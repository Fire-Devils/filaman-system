import math
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import joinedload

from app.api.deps import DBSession, PrincipalDep
from app.api.v1.analytics import _add_months, _aware, _month_key, _month_start, get_analytics_summary
from app.api.v1.schemas import InventoryValuation
from app.models import Filament, Location, Manufacturer, Spool, SpoolEvent, SpoolStatus
from app.services.material_presets import load_presets, match_preset
from app.services.spool_metrics import remaining_value_expression
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
        value = remaining_value_expression(db.get_bind().dialect.name, known_only=True).label("remaining_value")
        valued = (
            select(value).select_from(Spool)
            .outerjoin(Filament, Spool.filament_id == Filament.id)
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .where(SpoolStatus.key != "archived")
            .subquery()
        )
        total, unknown = (await db.execute(select(
            func.sum(valued.c.remaining_value),
            func.count() - func.count(valued.c.remaining_value),
        ).select_from(valued))).one()
        totals["valuation"] = InventoryValuation(remaining_value=0 if spool_count_total == 0 else total, unknown_spool_count=unknown)

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
    spool_count: int
    total_weight_g: float
    stock_value: float


class DashboardHistoryResponse(BaseModel):
    months: list[HistoryMonth]


def _usable_number(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _spool_capacity_g(spool: Spool) -> float | None:
    """Net filament weight of a full spool; same order as the SQL remaining percent."""
    filament = spool.filament
    raw = filament.raw_material_weight_g if filament else None
    gross, tare = spool.initial_total_weight_g, spool.empty_spool_weight_g
    if _usable_number(gross) and _usable_number(tare) and gross > tare >= 0:
        return gross - tare
    if _usable_number(raw) and raw > 0:
        return raw
    return None


def _weight_delta(event) -> float:
    """Signed weight change an event applied to remaining_weight_g, 0 if unknown."""
    event_type, delta, meta = event.event_type, event.delta_weight_g, event.meta
    if event_type in ("print_consumption", "manual_adjust") and _usable_number(delta):
        return float(delta)
    if event_type == "spool_full" and isinstance(meta, dict):
        old, new = meta.get("old_remaining_g"), meta.get("new_remaining_g")
        if _usable_number(old) and _usable_number(new):
            return float(new) - float(old)
    return 0.0


@router.get("/history", response_model=DashboardHistoryResponse)
async def get_dashboard_history(
    db: DBSession,
    principal: PrincipalDep,
    months: int = Query(12, ge=1, le=36),
):
    """Monthly series for the dashboard charts, oldest month first.

    spend and consumption_g reuse the analytics summary. The stock series are
    rebuilt backwards from the current state (there are no snapshots), so they
    are approximations:

    - spool_count: a spool exists from its purchase_date / stocked_in_at /
      created_at (same fallback as spend). It stops counting while its status
      is "archived", replayed from the status events (to_status_id). A spool
      that is archived without any status event counts as archived from its
      updated_at. Deleted spools (events cascade) are unknown and missing.
    - total_weight_g: current remaining weight minus the weight deltas of
      print_consumption / relative manual_adjust events and the
      old->new remaining of spool_full events after the month end.
      Measurements and absolute adjustments carry no delta, so weight changes
      they caused are not rewound; clamping to zero loses its excess too.
      Results are clamped to 0..capacity. Archived spools do not count.
    - stock_value: purchase_price pro rata by the weight at month end divided
      by the spool capacity (same rule as the remaining-value tile, only
      spools with a price and a known capacity).
    """
    today = datetime.now(timezone.utc).date()
    first = _add_months(_month_start(today), -(months - 1))
    summary = await get_analytics_summary(db, principal, date_from=first, date_to=today)
    spend = {m.month: m.total for m in summary.purchases.by_month}
    consumed = {m.month: m.weight_g for m in summary.consumption_by_month}

    archived_id = await db.scalar(select(SpoolStatus.id).where(SpoolStatus.key == "archived"))
    spools = (
        (
            await db.execute(
                select(Spool).options(joinedload(Spool.filament), joinedload(Spool.status))
            )
        )
        .scalars()
        .unique()
        .all()
    )

    events_by_spool: dict[int, list] = defaultdict(list)
    rows = await db.execute(
        select(SpoolEvent)
        .where(
            (SpoolEvent.event_type.in_(("print_consumption", "manual_adjust", "spool_full")))
            | SpoolEvent.to_status_id.is_not(None)
        )
        .order_by(SpoolEvent.event_at, SpoolEvent.id)
    )
    for event in rows.scalars():
        events_by_spool[event.spool_id].append(event)

    month_starts = [_add_months(first, i) for i in range(months)]
    ends = [
        datetime.combine(_add_months(start, 1), datetime.min.time(), tzinfo=timezone.utc)
        for start in month_starts
    ]
    count = [0] * months
    weight = [0.0] * months
    value = [0.0] * months

    for spool in spools:
        added = _aware(spool.purchase_date or spool.stocked_in_at or spool.created_at)
        events = events_by_spool.get(spool.id, [])
        status_events = [
            (_aware(e.event_at), e.to_status_id) for e in events if e.to_status_id is not None
        ]
        if archived_id is not None and spool.status_id == archived_id and not any(
            status == archived_id for _, status in status_events
        ):
            status_events.append((_aware(spool.updated_at), archived_id))
            status_events.sort(key=lambda item: item[0])
        deltas = [(_aware(e.event_at), _weight_delta(e)) for e in events if _weight_delta(e)]
        capacity = _spool_capacity_g(spool)
        current = spool.remaining_weight_g
        if not _usable_number(current):
            current = capacity if spool.status and spool.status.key == "new" and capacity else 0.0
        price = spool.purchase_price if _usable_number(spool.purchase_price) else None

        for i, end in enumerate(ends):
            if added >= end:
                continue
            status = None
            for at, to_status in status_events:
                if at >= end:
                    break
                status = to_status
            if archived_id is not None and status == archived_id:
                continue
            count[i] += 1
            at_end = current - sum(d for at, d in deltas if at >= end)
            at_end = max(0.0, at_end if capacity is None else min(at_end, capacity))
            weight[i] += at_end
            if price is not None and capacity:
                value[i] += price * at_end / capacity

    return DashboardHistoryResponse(
        months=[
            HistoryMonth(
                month=_month_key(start),
                spend=spend.get(_month_key(start), 0.0),
                consumption_g=consumed.get(_month_key(start), 0.0),
                spool_count=count[i],
                total_weight_g=round(weight[i], 2),
                stock_value=round(value[i], 2),
            )
            for i, start in enumerate(month_starts)
        ]
    )
