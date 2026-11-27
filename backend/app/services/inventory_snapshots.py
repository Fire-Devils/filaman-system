"""Daily stock snapshots: the only source of the dashboard stock charts."""

from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Filament, InventorySnapshot, Spool, SpoolStatus
from app.services.spool_metrics import remaining_value_expression


@dataclass(frozen=True)
class InventoryTotals:
    """Figures of the dashboard tiles (all spools that are not archived)."""

    spool_count: int
    total_weight_g: float
    remaining_value: float | None
    unknown_value_count: int
    purchase_value: float


async def current_inventory(db: AsyncSession) -> InventoryTotals:
    """Spool count, remaining weight and values exactly as the dashboard tiles show them."""
    dialect = db.get_bind().dialect.name
    count, weight, purchase = (
        await db.execute(
            select(
                func.count(Spool.id),
                func.coalesce(func.sum(func.coalesce(Spool.remaining_weight_g, 0)), 0),
                func.coalesce(func.sum(Spool.purchase_price), 0),
            )
            .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
            .where(SpoolStatus.key != "archived")
        )
    ).one()
    value = remaining_value_expression(dialect, known_only=True).label("remaining_value")
    valued = (
        select(value)
        .select_from(Spool)
        .outerjoin(Filament, Spool.filament_id == Filament.id)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(SpoolStatus.key != "archived")
        .subquery()
    )
    total, unknown = (
        await db.execute(
            select(
                func.sum(valued.c.remaining_value),
                func.count() - func.count(valued.c.remaining_value),
            ).select_from(valued)
        )
    ).one()
    return InventoryTotals(
        spool_count=int(count or 0),
        total_weight_g=float(weight or 0),
        remaining_value=0.0 if not count else (None if total is None else float(total)),
        unknown_value_count=int(unknown or 0),
        purchase_value=float(purchase or 0),
    )


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


async def record_inventory_snapshot(
    db: AsyncSession, day: date | None = None
) -> InventorySnapshot:
    """Write or update the snapshot of `day` (default: today UTC) with the current stock."""
    day = day or _today_utc()
    totals = await current_inventory(db)
    snapshot = await db.scalar(
        select(InventorySnapshot).where(InventorySnapshot.snapshot_date == day)
    )
    if snapshot is None:
        snapshot = InventorySnapshot(snapshot_date=day)
        db.add(snapshot)
    snapshot.spool_count = totals.spool_count
    snapshot.total_weight_g = totals.total_weight_g
    snapshot.stock_value = totals.remaining_value
    snapshot.purchase_value = totals.purchase_value
    await db.commit()
    return snapshot


async def run_inventory_snapshot_once() -> None:
    """Background job: own session, errors are logged by the caller."""
    from app.core.database import async_session_maker

    async with async_session_maker() as db:
        await record_inventory_snapshot(db)
