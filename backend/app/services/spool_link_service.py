"""Link suggestions: match an unknown external tag to an existing sealed spool.

Plugins call ``propose_spool_link`` when they see a tag no spool knows. If sealed
(status ``new``) spools of the same filament exist, a suggestion is stored and the
user links it with one click instead of ending up with a duplicate spool.
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models import Spool, SpoolLinkSuggestion, SpoolStatus
from app.services.spool_service import SpoolService

LINK_NO_CANDIDATES = "no_candidates"
LINK_PENDING = "pending"
LINK_DISMISSED = "dismissed"
LINK_LINKED = "linked"


class SpoolLinkError(Exception):
    """Raised for a link or dismiss request that cannot be applied (maps to HTTP 409)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def find_link_candidates(db: AsyncSession, filament_id: int) -> list[Spool]:
    result = await db.execute(
        select(Spool)
        .join(SpoolStatus, Spool.status_id == SpoolStatus.id)
        .where(
            Spool.filament_id == filament_id,
            SpoolStatus.key == "new",
            Spool.external_id.is_(None),
            Spool.rfid_uid.is_(None),
        )
        .order_by(Spool.created_at, Spool.id)
    )
    return list(result.scalars().all())


async def propose_spool_link(
    db: AsyncSession,
    *,
    external_id: str,
    filament_id: int,
    source: str,
    printer_id: int | None = None,
    slot_label: str | None = None,
    tag_data: dict[str, Any] | None = None,
    remaining_weight_g: float | None = None,
) -> str:
    latest = (
        await db.execute(
            select(SpoolLinkSuggestion)
            .where(SpoolLinkSuggestion.external_id == external_id)
            .order_by(SpoolLinkSuggestion.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is not None and latest.status == LINK_DISMISSED:
        return LINK_DISMISSED
    if latest is not None and latest.status == LINK_LINKED:
        still_linked = await db.scalar(
            select(Spool.id).where(Spool.external_id == external_id)
        )
        if still_linked is not None:
            return LINK_LINKED
        # The tag was removed from the linked spool again; treat it as unknown.
        latest = None
    if latest is not None and latest.status == LINK_PENDING:
        if not await find_link_candidates(db, filament_id):
            # The sealed spools are gone (opened, deleted, tagged elsewhere), so
            # the suggestion can never be applied and must not block creation.
            latest.status = LINK_DISMISSED
            await db.commit()
            await event_bus.publish({"event": "spools_changed"})
            return LINK_NO_CANDIDATES
        latest.printer_id = printer_id
        latest.slot_label = slot_label
        latest.tag_data = tag_data
        latest.remaining_weight_g = remaining_weight_g
        await db.commit()
        return LINK_PENDING

    if not await find_link_candidates(db, filament_id):
        return LINK_NO_CANDIDATES

    db.add(
        SpoolLinkSuggestion(
            external_id=external_id,
            filament_id=filament_id,
            source=source,
            printer_id=printer_id,
            slot_label=slot_label,
            tag_data=tag_data,
            remaining_weight_g=remaining_weight_g,
            status=LINK_PENDING,
        )
    )
    await db.commit()
    await event_bus.publish({"event": "spools_changed"})
    return LINK_PENDING


def _require_pending(suggestion: SpoolLinkSuggestion) -> None:
    if suggestion.status != LINK_PENDING:
        raise SpoolLinkError("not_pending", "Suggestion is not pending")


async def link_suggestion(
    db: AsyncSession,
    suggestion: SpoolLinkSuggestion,
    spool_id: int,
    principal=None,
) -> Spool:
    _require_pending(suggestion)
    candidates = await find_link_candidates(db, suggestion.filament_id)
    spool = next((item for item in candidates if item.id == spool_id), None)
    if spool is None:
        raise SpoolLinkError("not_a_candidate", "Spool is not a link candidate")

    taken = await db.scalar(
        select(Spool.id).where(
            Spool.external_id == suggestion.external_id, Spool.id != spool.id
        )
    )
    if taken is not None:
        raise SpoolLinkError("external_id_in_use", "External ID already belongs to another spool")

    spool.external_id = suggestion.external_id
    if suggestion.tag_data:
        merged = dict(spool.custom_fields or {})
        for key, value in suggestion.tag_data.items():
            if merged.get(key) in (None, ""):
                merged[key] = value
        spool.custom_fields = merged
    if suggestion.remaining_weight_g is not None and spool.remaining_weight_g is None:
        spool.remaining_weight_g = suggestion.remaining_weight_g

    suggestion.status = LINK_LINKED
    suggestion.linked_spool_id = spool.id

    service = SpoolService(db)
    target_key = "opened"
    if await service._get_status_by_key(target_key) is None:
        target_key = "active"
    try:
        if await service._get_status_by_key(target_key) is not None:
            # change_status commits everything staged above in one transaction.
            await service.change_status(
                spool=spool,
                status_key=target_key,
                event_at=datetime.now(timezone.utc),
                principal=principal,
                source=suggestion.source,
                note="Linked to external tag",
                meta={"link_suggestion_id": suggestion.id},
            )
        else:
            await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise SpoolLinkError(
            "external_id_in_use", "External ID already belongs to another spool"
        ) from exc
    return spool


async def dismiss_suggestion(db: AsyncSession, suggestion: SpoolLinkSuggestion) -> None:
    _require_pending(suggestion)
    suggestion.status = LINK_DISMISSED
    await db.commit()
