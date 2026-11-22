"""Consumption and cost analytics (read-only, any authenticated principal)."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.api.deps import DBSession, PrincipalDep
from app.models import Filament, PrintJob, PrintJobUsage, Spool, SpoolEvent
from app.services.print_job_service import price_per_gram

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Only these events are real consumption. Measurements and manual adjustments
# are corrections of the stored weight, not material that was used.
CONSUMPTION_EVENT_TYPES = ("print_consumption",)
OTHER_LABEL = "other"
TOP_MANUFACTURERS = 10
TOP_PROJECTS = 5
MAX_RANGE_DAYS = 366 * 15
DEFAULT_MONTHS = 12


class MonthConsumption(BaseModel):
    month: str
    weight_g: float
    cost: float


class MaterialConsumption(BaseModel):
    material_type: str
    weight_g: float
    cost: float


class ManufacturerConsumption(BaseModel):
    manufacturer: str
    weight_g: float
    cost: float


class MonthPurchases(BaseModel):
    month: str
    total: float
    by_material: dict[str, float]


class PurchaseSummary(BaseModel):
    total: float
    by_month: list[MonthPurchases]
    by_material: dict[str, float]


class PrintJobStats(BaseModel):
    count: int
    completed: int
    failed: int
    cancelled: int
    success_rate: float | None
    total_weight_g: float
    total_cost: float
    avg_cost_per_job: float | None
    total_print_time_s: int


class TopProject(BaseModel):
    project_id: int
    name: str
    job_count: int
    weight_g: float
    cost: float


class Totals(BaseModel):
    weight_g: float
    cost: float
    cost_unknown_weight_g: float


class AnalyticsSummary(BaseModel):
    date_from: date
    date_to: date
    consumption_by_month: list[MonthConsumption]
    consumption_by_material: list[MaterialConsumption]
    consumption_by_manufacturer: list[ManufacturerConsumption]
    purchases: PurchaseSummary
    print_jobs: PrintJobStats
    top_projects: list[TopProject]
    totals: Totals


def _month_key(value: datetime | date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _month_start(value: date) -> date:
    return date(value.year, value.month, 1)


def _add_months(value: date, months: int) -> date:
    index = value.year * 12 + (value.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


def _months_between(start: date, end: date) -> list[str]:
    result = []
    cursor = _month_start(start)
    last = _month_start(end)
    while cursor <= last:
        result.append(_month_key(cursor))
        cursor = _add_months(cursor, 1)
    return result


def _utc_bounds(start: date, end: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(start, time.min, tzinfo=timezone.utc),
        datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc),
    )


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _round(value: float) -> float:
    return round(value, 4)


@router.get("/summary", response_model=AnalyticsSummary)
async def get_analytics_summary(
    db: DBSession,
    principal: PrincipalDep,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
):
    today = datetime.now(timezone.utc).date()
    end = date_to or today
    start = date_from or _add_months(_month_start(end), -(DEFAULT_MONTHS - 1))
    if start > end:
        raise HTTPException(status_code=422, detail="'from' must not be after 'to'")
    if (end - start).days > MAX_RANGE_DAYS:
        start = end - timedelta(days=MAX_RANGE_DAYS)
    lo, hi = _utc_bounds(start, end)

    # --- consumption events (bounded by the period) ---
    events = (
        (
            await db.execute(
                select(SpoolEvent)
                .where(
                    SpoolEvent.event_type.in_(CONSUMPTION_EVENT_TYPES),
                    SpoolEvent.delta_weight_g.is_not(None),
                    SpoolEvent.event_at >= lo,
                    SpoolEvent.event_at < hi,
                )
                .options(
                    joinedload(SpoolEvent.spool)
                    .joinedload(Spool.filament)
                    .joinedload(Filament.manufacturer)
                )
            )
        )
        .scalars()
        .unique()
        .all()
    )

    event_ids = [e.id for e in events]
    snapshot: dict[int, float | None] = {}
    for chunk_start in range(0, len(event_ids), 500):
        chunk = event_ids[chunk_start : chunk_start + 500]
        rows = await db.execute(
            select(PrintJobUsage.spool_event_id, PrintJobUsage.cost).where(
                PrintJobUsage.spool_event_id.in_(chunk)
            )
        )
        for event_id, cost in rows:
            snapshot[event_id] = cost

    by_month: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    by_material: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    by_manufacturer: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    total_weight = total_cost = unknown_weight = 0.0
    first_data: date | None = None

    for event in events:
        grams = abs(event.delta_weight_g or 0.0)
        if grams <= 0:
            continue
        cost = snapshot.get(event.id)
        if cost is None:
            ppg = price_per_gram(event.spool)
            cost = grams * ppg if ppg is not None else None
        when = _aware(event.event_at)
        first_data = min(first_data, when.date()) if first_data else when.date()
        filament = event.spool.filament if event.spool else None
        material = (filament.material_type if filament else None) or "unknown"
        manufacturer = (
            filament.manufacturer.name if filament and filament.manufacturer else None
        ) or "unknown"
        for bucket in (
            by_month[_month_key(when)],
            by_material[material],
            by_manufacturer[manufacturer],
        ):
            bucket[0] += grams
            bucket[1] += cost or 0.0
        total_weight += grams
        if cost is None:
            unknown_weight += grams
        else:
            total_cost += cost

    # --- purchases ---
    spools = (
        (
            await db.execute(
                select(Spool)
                .where(Spool.purchase_price.is_not(None))
                .where(
                    (
                        Spool.purchase_date.is_not(None)
                        & (Spool.purchase_date >= lo)
                        & (Spool.purchase_date < hi)
                    )
                    | (
                        Spool.purchase_date.is_(None)
                        & Spool.stocked_in_at.is_not(None)
                        & (Spool.stocked_in_at >= lo)
                        & (Spool.stocked_in_at < hi)
                    )
                )
                .options(joinedload(Spool.filament))
            )
        )
        .scalars()
        .unique()
        .all()
    )
    purchase_month: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    purchase_material: dict[str, float] = defaultdict(float)
    purchase_total = 0.0
    for spool in spools:
        when = _aware(spool.purchase_date or spool.stocked_in_at)
        material = (spool.filament.material_type if spool.filament else None) or "unknown"
        price = spool.purchase_price or 0.0
        purchase_month[_month_key(when)][material] += price
        purchase_material[material] += price
        purchase_total += price
        first_data = min(first_data, when.date()) if first_data else when.date()

    # --- print jobs ---
    jobs = (
        (
            await db.execute(
                select(PrintJob)
                .where(
                    PrintJob.status.in_(("completed", "failed", "cancelled")),
                    PrintJob.finished_at.is_not(None),
                    PrintJob.finished_at >= lo,
                    PrintJob.finished_at < hi,
                )
                .options(joinedload(PrintJob.usages), joinedload(PrintJob.project))
            )
        )
        .scalars()
        .unique()
        .all()
    )
    counts = {"completed": 0, "failed": 0, "cancelled": 0}
    job_weight = job_cost = 0.0
    print_time = 0
    project_stats: dict[int, dict[str, Any]] = {}
    for job in jobs:
        counts[job.status] += 1
        if job.status == "cancelled":
            continue
        weight = sum(u.used_weight_g or 0.0 for u in job.usages)
        cost = sum(u.cost or 0.0 for u in job.usages)
        job_weight += weight
        job_cost += cost
        print_time += job.print_time_s or 0
        if job.project_id is not None and job.project is not None:
            stat = project_stats.setdefault(
                job.project_id,
                {
                    "project_id": job.project_id,
                    "name": job.project.name,
                    "job_count": 0,
                    "weight_g": 0.0,
                    "cost": 0.0,
                },
            )
            stat["job_count"] += 1
            stat["weight_g"] += weight
            stat["cost"] += cost
    finished = counts["completed"] + counts["failed"]

    # --- month series without gaps (long ranges start at the first data) ---
    series_start = start
    if (
        first_data
        and first_data > start
        and _add_months(_month_start(start), 36) <= _month_start(end)
    ):
        series_start = first_data
    months = _months_between(series_start, end)

    materials = sorted(by_material.items(), key=lambda kv: (-kv[1][0], kv[0]))
    manufacturers = sorted(by_manufacturer.items(), key=lambda kv: (-kv[1][0], kv[0]))
    mfr_out = [
        ManufacturerConsumption(manufacturer=name, weight_g=_round(v[0]), cost=_round(v[1]))
        for name, v in manufacturers[:TOP_MANUFACTURERS]
    ]
    rest = manufacturers[TOP_MANUFACTURERS:]
    if rest:
        mfr_out.append(
            ManufacturerConsumption(
                manufacturer=OTHER_LABEL,
                weight_g=_round(sum(v[0] for _, v in rest)),
                cost=_round(sum(v[1] for _, v in rest)),
            )
        )

    top_projects = sorted(project_stats.values(), key=lambda s: (-s["cost"], s["name"]))[
        :TOP_PROJECTS
    ]

    return AnalyticsSummary(
        date_from=start,
        date_to=end,
        consumption_by_month=[
            MonthConsumption(
                month=m,
                weight_g=_round(by_month[m][0]) if m in by_month else 0.0,
                cost=_round(by_month[m][1]) if m in by_month else 0.0,
            )
            for m in months
        ],
        consumption_by_material=[
            MaterialConsumption(material_type=n, weight_g=_round(v[0]), cost=_round(v[1]))
            for n, v in materials
        ],
        consumption_by_manufacturer=mfr_out,
        purchases=PurchaseSummary(
            total=_round(purchase_total),
            by_month=[
                MonthPurchases(
                    month=m,
                    total=_round(sum(purchase_month[m].values())) if m in purchase_month else 0.0,
                    by_material=(
                        {k: _round(v) for k, v in purchase_month[m].items()}
                        if m in purchase_month
                        else {}
                    ),
                )
                for m in months
            ],
            by_material={
                k: _round(v) for k, v in sorted(purchase_material.items(), key=lambda kv: -kv[1])
            },
        ),
        print_jobs=PrintJobStats(
            count=sum(counts.values()),
            completed=counts["completed"],
            failed=counts["failed"],
            cancelled=counts["cancelled"],
            success_rate=_round(counts["completed"] / finished) if finished else None,
            total_weight_g=_round(job_weight),
            total_cost=_round(job_cost),
            avg_cost_per_job=_round(job_cost / finished) if finished else None,
            total_print_time_s=print_time,
        ),
        top_projects=[
            TopProject(
                project_id=s["project_id"],
                name=s["name"],
                job_count=s["job_count"],
                weight_g=_round(s["weight_g"]),
                cost=_round(s["cost"]),
            )
            for s in top_projects
        ],
        totals=Totals(
            weight_g=_round(total_weight),
            cost=_round(total_cost),
            cost_unknown_weight_g=_round(unknown_weight),
        ),
    )
