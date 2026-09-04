"""GET /api/v1/display — read-only feed for dashboards and digital swatch boards.

Auth: any principal with ``display:read`` — a logged-in user, an API key, or
a registered device whose scopes include ``display:read`` (so a wall panel
authenticates like a scale: ``Authorization: Device <token>``).

Polling: send ``If-None-Match`` with the last ``ETag`` and an unchanged board
answers ``304`` with no body.  ``?fields=slots`` trims the payload to what a
swatch board needs.  See ``docs/display-api.md``.
"""

from __future__ import annotations

import inspect
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import select

from app.api.deps import DBSession, RequirePermission
from app.models import Printer
from app.services.display_service import build_display, compute_etag

router = APIRouter(prefix="/display", tags=["display"])


async def _driver_state(printer: Printer) -> dict[str, Any] | None:
    """Ask the printer's running driver for live state; None when unsupported."""
    from app.plugins.manager import plugin_manager

    driver = plugin_manager.drivers.get(printer.id)
    getter = getattr(driver, "get_display_state", None)
    if driver is None or getter is None:
        return None
    result = getter()
    if inspect.isawaitable(result):
        result = await result
    return result if isinstance(result, dict) else None


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
    payload = await build_display(db, printers, _driver_state, fields=fields)
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
    payload = await build_display(db, [printer], _driver_state, fields=fields)
    return _respond(request, response, payload)
