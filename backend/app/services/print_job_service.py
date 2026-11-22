"""Print job log: creation, completion (consumption booking) and cost snapshot.

Consumption is booked through ``SpoolService.record_consumption`` so spool
weight, auto-opened/auto-empty handling and spool events stay in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.security import Principal
from app.models import (
    Filament,
    PrintJob,
    PrintJobUsage,
    PrinterSlot,
    PrinterSlotAssignment,
    Spool,
)
from app.services.spool_service import SpoolService

PRINT_JOB_EVENT_SOURCE = "print_job"

# Usages with the spool's filament and manufacturer, as the API shows them.
JOB_LOAD_OPTION = (
    selectinload(PrintJob.usages)
    .selectinload(PrintJobUsage.spool)
    .selectinload(Spool.filament)
    .selectinload(Filament.manufacturer)
)


class PrintJobError(Exception):
    """Base class; ``code`` is returned to API clients."""

    code = "print_job_error"


class PrintJobStateError(PrintJobError):
    code = "print_job_not_pending"


class PrintJobValidationError(PrintJobError):
    code = "invalid_print_job"


@dataclass
class UsageInput:
    spool_id: int | None = None
    slot_no: int | None = None
    planned_weight_g: float = 0.0


def price_per_gram(spool: Spool | None) -> float | None:
    """Price of one gram of filament, or None when no price is known.

    Spool purchase price over the net start weight (gross start weight minus the
    empty spool, else the filament's net weight); otherwise the filament's list
    price over its net weight.
    """
    if spool is None:
        return None
    filament = spool.filament
    filament_net = filament.raw_material_weight_g if filament else None
    if filament_net is not None and filament_net <= 0:
        filament_net = None

    if spool.purchase_price is not None:
        net = None
        if spool.initial_total_weight_g:
            net = spool.initial_total_weight_g - (spool.empty_spool_weight_g or 0)
        if net is None or net <= 0:
            net = filament_net
        if net:
            return spool.purchase_price / net

    if filament is not None and filament.price is not None and filament_net:
        return filament.price / filament_net
    return None


def compute_cost(spool: Spool | None, used_weight_g: float) -> float | None:
    ppg = price_per_gram(spool)
    if ppg is None:
        return None
    return round(used_weight_g * ppg, 4)


async def resolve_spool_for_slot(
    db: AsyncSession, printer_id: int, slot_no: int
) -> Spool | None:
    """The spool currently assigned to a printer slot, if any."""
    spool_id = await db.scalar(
        select(PrinterSlotAssignment.spool_id)
        .join(PrinterSlot, PrinterSlot.id == PrinterSlotAssignment.slot_id)
        .where(PrinterSlot.printer_id == printer_id, PrinterSlot.slot_no == slot_no)
    )
    if spool_id is None:
        return None
    return await SpoolService(db).get_spool(spool_id)


async def build_usages(
    db: AsyncSession, printer_id: int | None, inputs: list[UsageInput]
) -> list[PrintJobUsage]:
    usages: list[PrintJobUsage] = []
    for item in inputs:
        if not isfinite(item.planned_weight_g) or item.planned_weight_g < 0:
            raise PrintJobValidationError("Weight must be a finite number >= 0")
        spool_id = item.spool_id
        if spool_id is None and item.slot_no is not None:
            if printer_id is None:
                raise PrintJobValidationError("slot_no needs a printer")
            spool = await resolve_spool_for_slot(db, printer_id, item.slot_no)
            spool_id = spool.id if spool else None
        elif spool_id is not None and await db.get(Spool, spool_id) is None:
            raise PrintJobValidationError(f"Spool {spool_id} not found")
        usages.append(
            PrintJobUsage(
                spool_id=spool_id,
                slot_no=item.slot_no,
                planned_weight_g=item.planned_weight_g,
            )
        )
    return usages


async def get_job(db: AsyncSession, job_id: int) -> PrintJob | None:
    return await db.scalar(
        select(PrintJob)
        .where(PrintJob.id == job_id)
        .options(JOB_LOAD_OPTION)
        .execution_options(populate_existing=True)
    )


async def complete_job(
    db: AsyncSession,
    job: PrintJob,
    usages_override: dict[int, float] | None = None,
    success: bool = True,
    principal: Principal | None = None,
) -> PrintJob:
    """Book the consumption of every usage and close the job.

    ``usages_override`` maps usage id to the actually used grams. A job that is
    no longer pending raises ``PrintJobStateError`` and books nothing, so a
    retry or double click can never subtract the grams twice. A failed print
    consumes filament too.
    """
    if job.status != "pending":
        raise PrintJobStateError(f"Print job is already {job.status}")
    override = usages_override or {}
    known_ids = {u.id for u in job.usages}
    unknown = set(override) - known_ids
    if unknown:
        raise PrintJobValidationError(f"Unknown usage ids: {sorted(unknown)}")
    for grams in override.values():
        if not isfinite(grams) or grams < 0:
            raise PrintJobValidationError("Weight must be a finite number >= 0")

    now = datetime.now(timezone.utc)
    service = SpoolService(db)
    for usage in job.usages:
        used = override.get(usage.id, usage.planned_weight_g)
        usage.used_weight_g = used
        if usage.spool_id is None:
            continue
        spool = await service.get_spool(usage.spool_id)
        if spool is None:
            continue
        usage.cost = compute_cost(spool, used)
        if used <= 0:
            continue
        # A stable key makes the booking single-shot and keeps it out of the
        # 5-minute aggregation of ordinary consumption events.
        event, _ = await service.record_consumption(
            spool=spool,
            delta_weight_g=used,
            event_at=job.finished_at or now,
            principal=principal,
            source=PRINT_JOB_EVENT_SOURCE,
            note=f"Print job: {job.name}",
            source_event_key=f"print_job:{job.id}:{usage.id}",
        )
        event.meta = {
            **(event.meta or {}),
            "print_job_id": job.id,
            "print_job_usage_id": usage.id,
        }
        usage.spool_event_id = event.id

    job.status = "completed" if success else "failed"
    job.finished_at = job.finished_at or now
    if job.print_time_s is None and job.started_at is not None:
        job.print_time_s = max(0, int((job.finished_at - job.started_at).total_seconds()))
    await db.commit()
    return await get_job(db, job.id)  # type: ignore[return-value]


async def cancel_job(db: AsyncSession, job: PrintJob) -> PrintJob:
    """Discard a pending job without booking anything."""
    if job.status != "pending":
        raise PrintJobStateError(f"Print job is already {job.status}")
    job.status = "cancelled"
    job.finished_at = datetime.now(timezone.utc)
    await db.commit()
    return await get_job(db, job.id)  # type: ignore[return-value]
