"""Permanent spool deletion that keeps the statistics-relevant data."""

from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models import Filament, Spool, SpoolEvent
from app.services.print_job_service import price_per_gram

SPOOL_DELETED_EVENT = "spool_deleted"


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


async def preserve_spool_statistics(db: AsyncSession, spool_ids: Iterable[int]) -> int:
    """Prepare spools for hard deletion; call before the delete in the same transaction.

    Fills filament_id on the spools' events, stores the price per gram on their
    consumption events (cost stays computable) and writes one `spool_deleted` event per
    spool (purchase data and a plain-text filament fallback). The events keep
    existing afterwards because spool_events.spool_id is SET NULL on delete.
    """
    ids = list(dict.fromkeys(spool_ids))
    if not ids:
        return 0
    spools = (
        (
            await db.execute(
                select(Spool)
                .where(Spool.id.in_(ids))
                .options(joinedload(Spool.filament).joinedload(Filament.manufacturer))
            )
        )
        .scalars()
        .unique()
        .all()
    )
    now = datetime.now(timezone.utc)
    for spool in spools:
        filament = spool.filament
        await db.execute(
            update(SpoolEvent)
            .where(SpoolEvent.spool_id == spool.id, SpoolEvent.filament_id.is_(None))
            .values(filament_id=spool.filament_id)
        )
        ppg = price_per_gram(spool)
        if ppg is not None:
            # The consumption events lose their spool: keep what they cost per gram.
            consumption = await db.execute(
                select(SpoolEvent).where(
                    SpoolEvent.spool_id == spool.id,
                    SpoolEvent.event_type == "print_consumption",
                )
            )
            for event in consumption.scalars():
                event.meta = {**(event.meta or {}), "price_per_gram": ppg}
        meta: dict[str, Any] = {
            "purchase_price": spool.purchase_price,
            "purchase_date": _iso(spool.purchase_date),
            "stocked_in_at": _iso(spool.stocked_in_at),
            "created_at": _iso(spool.created_at),
            "filament_id": spool.filament_id,
            "remaining_weight_g": spool.remaining_weight_g,
            "manufacturer": filament.manufacturer.name
            if filament and filament.manufacturer
            else None,
            "material": filament.material_type if filament else None,
        }
        db.add(
            SpoolEvent(
                spool_id=spool.id,
                filament_id=spool.filament_id,
                event_type=SPOOL_DELETED_EVENT,
                event_at=now,
                source="system",
                meta=meta,
            )
        )
    await db.flush()
    return len(spools)
