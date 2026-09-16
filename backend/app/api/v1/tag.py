"""Tag scans: a reader says what it just read, and a browser can follow it.

Put a spool on a scale, hold its tag to the reader, and the browser opens that
spool.  The same call is a complete lookup, so a reader that only wants to know
which spool it is holding can ignore the browser side entirely.

Auth: a registered device on the strength of its token, or any other principal
with ``spools:read`` - a logged-in user or an app on an API key.  A tag reader
is not necessarily a scale: a phone app, an ESPHome reader on a shelf and a
bench scale are all the same thing here, and none of them should have to become
a device row first.

Workers: FilaMan runs several Gunicorn workers and ``event_bus`` is per-worker,
so a scan is recorded in the database rather than broadcast.  That is the only
thing every worker can see, and it is why the browser polls.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas_tag import (
    TagReaderResponse,
    TagScanRequest,
    TagScanResponse,
    TagScanStateResponse,
)
from app.core.rfid import rfid_hex_key
from app.core.security import Principal
from app.models import Device, TagReader
from app.services.spool_service import SpoolService

router = APIRouter(prefix="/tag", tags=["tag"])

# A reader id has to survive the reader's own restarts, because a browser binds
# to it. Longer than any sensible name and short enough for an index.
_READER_ID_MAX = 64


async def _reader_principal(request: Request, db: DBSession, principal: PrincipalDep) -> Principal:
    """Anything that may report a scan.

    A registered device gets in on the strength of its token alone, exactly as
    it does for weighing and locating: those routes take ``get_current_device``
    and never look at scopes, and a scale shipped without any would otherwise
    stop being able to speak here. Everything else - a user session, an app on
    an API key - needs ``spools:read``, which is what reporting a scan amounts
    to: it resolves a spool and changes nothing.
    """
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "Authentication required"},
        )
    if principal.auth_type == "device":
        return principal
    checker = RequirePermission("spools:read").dependency
    return await checker(request=request, db=db)


async def _identify_reader(
    db: DBSession, principal: Principal, body: TagScanRequest
) -> tuple[str, str | None]:
    """The reader's stable id and its human name.

    A reader that sends its own id keeps it. One that sends none gets an id
    derived from the credential it used, which is stable for as long as that
    credential is - a device keeps its id across reboots, an app across
    restarts.
    """
    if body.reader_id:
        return body.reader_id[:_READER_ID_MAX], (body.name or None)

    if principal.auth_type == "device" and principal.device_id is not None:
        device = await db.get(Device, principal.device_id)
        return f"device-{principal.device_id}", body.name or (device.name if device else None)
    if principal.auth_type == "api_key" and principal.api_key_id is not None:
        return f"apikey-{principal.api_key_id}", body.name or None
    if principal.user_id is not None:
        return f"user-{principal.user_id}", body.name or principal.user_display_name
    return "unknown", body.name or None


@router.post("/scan", response_model=TagScanResponse)
async def report_scan(
    body: TagScanRequest,
    db: DBSession,
    principal: Principal = Depends(_reader_principal),
):
    """Report a tag a reader has just read, and get the match back.

    ``alt_uid`` is the same physical tag written the other way. A Bambu spool
    carries a hardware uid on the chip and a tray uuid in its payload, and which
    one it is on file under depends on who wrote the record - the driver files
    it under the tray uuid, a scale that linked it under the chip uid. The
    reader cannot know, so it may offer both and the server tries each.
    """
    uid = rfid_hex_key(body.uid) or body.uid.strip().upper()
    service = SpoolService(db)
    spool = await service.get_spool_by_identifier(rfid_uid=uid, external_id=None)
    if spool is None and body.alt_uid:
        alt = rfid_hex_key(body.alt_uid) or body.alt_uid.strip().upper()
        if alt != uid:
            spool = await service.get_spool_by_identifier(rfid_uid=alt, external_id=None)

    label = spool.filament.designation if spool and spool.filament else None
    reader_id, name = await _identify_reader(db, principal, body)

    now = datetime.now(timezone.utc)
    reader = await db.scalar(select(TagReader).where(TagReader.reader_id == reader_id))
    if reader is None:
        reader = TagReader(reader_id=reader_id)
        db.add(reader)
    if name:
        reader.name = name
    # Milliseconds since the epoch, so scans from two readers compare without
    # anyone keeping a counter.
    reader.last_seq = int(now.timestamp() * 1000)
    reader.last_uid = uid
    reader.last_spool_id = spool.id if spool else None
    reader.last_spool_label = label
    reader.last_seen_at = now
    await db.commit()

    return TagScanResponse(
        uid=uid,
        reader_id=reader_id,
        matched_spool_id=spool.id if spool else None,
        filament_name=label,
    )


@router.get("/last-scan", response_model=TagScanStateResponse)
async def get_last_scan(
    db: DBSession,
    reader_id: str | None = Query(default=None, max_length=_READER_ID_MAX),
    principal: Principal = Depends(_reader_principal),
):
    """The newest scan any reader has reported, or that one reader's.

    Nothing scanned yet answers ``seq: 0`` rather than 404: it is a normal
    state, not an error, and a polling client should not have to tell the two
    apart.
    """
    query = select(TagReader).order_by(TagReader.last_seq.desc()).limit(1)
    if reader_id:
        query = select(TagReader).where(TagReader.reader_id == reader_id).limit(1)
    reader = await db.scalar(query)
    if reader is None or not reader.last_seq:
        return TagScanStateResponse()
    return TagScanStateResponse(
        seq=reader.last_seq,
        reader_id=reader.reader_id,
        reader_name=reader.name,
        uid=reader.last_uid,
        spool_id=reader.last_spool_id,
        spool_label=reader.last_spool_label,
        timestamp=reader.last_seen_at.isoformat() if reader.last_seen_at else None,
    )


@router.get("/readers", response_model=list[TagReaderResponse])
async def list_readers(
    db: DBSession,
    principal: Principal = Depends(_reader_principal),
):
    """Readers that have reported a scan, newest first.

    So a screen can offer a picker instead of asking somebody to type an id.
    """
    result = await db.execute(select(TagReader).order_by(TagReader.last_seq.desc()))
    return [
        TagReaderResponse(
            reader_id=reader.reader_id,
            name=reader.name,
            last_seen=reader.last_seen_at.isoformat() if reader.last_seen_at else None,
        )
        for reader in result.scalars().all()
    ]
