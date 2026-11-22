from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.event_bus import event_bus
from app.models import (
    Filament,
    Location,
    Manufacturer,
    Printer,
    SpoolLinkSuggestion,
)
from app.services import spool_link_service as links

router = APIRouter(prefix="/spool-link-suggestions", tags=["spool-link-suggestions"])


class LinkCandidate(BaseModel):
    id: int
    created_at: datetime
    remaining_weight_g: float | None
    location_name: str | None
    lot_number: str | None


class LinkSuggestionFilament(BaseModel):
    id: int
    designation: str
    manufacturer_name: str | None
    material_type: str | None


class LinkSuggestionResponse(BaseModel):
    id: int
    external_id: str
    source: str
    filament: LinkSuggestionFilament
    printer_name: str | None
    slot_label: str | None
    created_at: datetime
    candidates: list[LinkCandidate]


class LinkRequest(BaseModel):
    spool_id: int


class LinkResult(BaseModel):
    id: int
    status: str
    linked_spool_id: int | None


async def _get_suggestion(db, suggestion_id: int) -> SpoolLinkSuggestion:
    suggestion = await db.get(SpoolLinkSuggestion, suggestion_id)
    if suggestion is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Suggestion not found"},
        )
    return suggestion


def _conflict(exc: links.SpoolLinkError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": exc.code, "message": exc.message},
    )


@router.get("", response_model=list[LinkSuggestionResponse])
async def list_link_suggestions(db: DBSession, principal: PrincipalDep):
    rows = (
        await db.execute(
            select(SpoolLinkSuggestion, Filament, Manufacturer.name, Printer.name)
            .join(Filament, Filament.id == SpoolLinkSuggestion.filament_id)
            .join(Manufacturer, Manufacturer.id == Filament.manufacturer_id, isouter=True)
            .join(Printer, Printer.id == SpoolLinkSuggestion.printer_id, isouter=True)
            .where(SpoolLinkSuggestion.status == links.LINK_PENDING)
            .order_by(SpoolLinkSuggestion.created_at, SpoolLinkSuggestion.id)
        )
    ).all()

    result = []
    for suggestion, filament, manufacturer_name, printer_name in rows:
        candidates = await links.find_link_candidates(db, filament.id)
        location_ids = {c.location_id for c in candidates if c.location_id is not None}
        location_names = {}
        if location_ids:
            location_names = dict(
                (
                    await db.execute(
                        select(Location.id, Location.name).where(Location.id.in_(location_ids))
                    )
                ).all()
            )
        result.append(
            LinkSuggestionResponse(
                id=suggestion.id,
                external_id=suggestion.external_id,
                source=suggestion.source,
                filament=LinkSuggestionFilament(
                    id=filament.id,
                    designation=filament.designation,
                    manufacturer_name=manufacturer_name,
                    material_type=filament.material_type,
                ),
                printer_name=printer_name,
                slot_label=suggestion.slot_label,
                created_at=suggestion.created_at,
                candidates=[
                    LinkCandidate(
                        id=c.id,
                        created_at=c.created_at,
                        remaining_weight_g=c.remaining_weight_g,
                        location_name=location_names.get(c.location_id),
                        lot_number=c.lot_number,
                    )
                    for c in candidates
                ],
            )
        )
    return result


@router.post("/{suggestion_id}/link", response_model=LinkResult)
async def link_suggestion(
    suggestion_id: int,
    data: LinkRequest,
    db: DBSession,
    principal=RequirePermission("spools:update"),
):
    suggestion = await _get_suggestion(db, suggestion_id)
    try:
        spool = await links.link_suggestion(db, suggestion, data.spool_id, principal)
    except links.SpoolLinkError as exc:
        raise _conflict(exc) from exc
    await event_bus.publish({"event": "spools_changed"})
    return LinkResult(id=suggestion.id, status=suggestion.status, linked_spool_id=spool.id)


@router.post("/{suggestion_id}/dismiss", response_model=LinkResult)
async def dismiss_suggestion(
    suggestion_id: int,
    db: DBSession,
    principal=RequirePermission("spools:update"),
):
    suggestion = await _get_suggestion(db, suggestion_id)
    try:
        await links.dismiss_suggestion(db, suggestion)
    except links.SpoolLinkError as exc:
        raise _conflict(exc) from exc
    return LinkResult(id=suggestion.id, status=suggestion.status, linked_spool_id=None)
