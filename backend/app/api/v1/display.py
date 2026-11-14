"""GET /api/v1/display — read-only feed for dashboards and digital swatch boards.

Auth: any principal with ``display:read`` — a logged-in user, an API key, or
a registered device whose scopes include ``display:read`` (so a wall panel
authenticates like a scale: ``Authorization: Device <token>``).

Polling: send ``If-None-Match`` with the last ``ETag`` and an unchanged board
answers ``304`` with no body.  ``?fields=slots`` trims the payload to what a
swatch board needs.  See ``docs/display-api.md``.

Workers: drivers run in the primary worker only, so live state travels to the
other workers through :data:`app.core.shared_health.shared_display_store`.  A
board can therefore be served a snapshot a few seconds old - fine for climate,
visible on the active bay.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import select

from app.api.deps import DBSession, RequirePermission
from app.core.shared_health import shared_display_store
from app.models import Printer
from app.services.display_service import build_display, compute_etag

router = APIRouter(prefix="/display", tags=["display"])


async def _display_payload(db: DBSession, printers: list[Printer], fields: str) -> dict[str, Any]:
    from app.plugins.manager import plugin_manager

    # The primary can overlay fresher readings. The background publisher owns shared writes.
    live = await plugin_manager.get_display_states(printer.id for printer in printers)
    return await build_display(db, printers, shared_display_store.read_all() | live, fields=fields)


def _respond(request: Request, response: Response, payload: dict[str, Any]) -> Any:
    etag = compute_etag(payload)
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    return payload


@router.get("")
async def get_display(
    request: Request,
    response: Response,
    db: DBSession,
    fields: Literal["full", "slots"] = Query("full"),
    principal=RequirePermission("display:read"),
):
    """All active printers with their AMS slots."""
    result = await db.execute(
        select(Printer)
        .where(Printer.is_active.is_(True), Printer.deleted_at.is_(None))
        .order_by(Printer.id)
    )
    printers = list(result.scalars().all())
    payload = await _display_payload(db, printers, fields)
    return _respond(request, response, payload)


@router.get("/printers/{printer_id}")
async def get_printer_display(
    printer_id: int,
    request: Request,
    response: Response,
    db: DBSession,
    fields: Literal["full", "slots"] = Query("full"),
    principal=RequirePermission("display:read"),
):
    """One printer; same shape as the list entry, wrapped in the same envelope."""
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()
    if printer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )
    payload = await _display_payload(db, [printer], fields)
    return _respond(request, response, payload)
