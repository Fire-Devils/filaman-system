import logging

import httpx
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Header, status
from sqlalchemy import select

from app.api.deps import DBSession

logger = logging.getLogger(__name__)
from app.api.v1.schemas_device import HeartbeatRequest, LocateRequest, LocateResponse, WeighRequest, WeighResponse, WriteTagRequest, WriteTagResponse, RfidResultRequest, RfidResultResponse, WriteStatusResponse
from app.core.security import Principal, generate_token_secret, hash_password_async
from app.models import Device, Location, Spool
from app.services.spool_service import SpoolService

router = APIRouter(prefix="/devices", tags=["devices"])


async def get_current_device(
    db: DBSession,
    authorization: str = Header(..., alias="Authorization"),
) -> Device:
    # Parse "Device <token>"
    if not authorization.startswith("Device "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "Invalid authorization header"},
        )
    
    token = authorization[7:] # Remove "Device "
    
    # Use existing logic from middleware to parse token
    from app.core.security import parse_token
    parsed = parse_token(token)
    if parsed is None or parsed[0] != "dev":
         raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "Invalid token format"},
        )
    
    _, device_id, _ = parsed
    
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    
    if not device or not device.is_active or device.deleted_at:
         raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated", "message": "Device not found or inactive"},
        )
    
    # Update last_used_at
    device.last_used_at = datetime.utcnow()
    await db.commit()
    
    return device


@router.post("/register", response_model=dict)
async def register_device(
    db: DBSession,
    x_device_code: str = Header(..., alias="X-Device-Code"),
):
    # Find device by code
    result = await db.execute(select(Device).where(Device.device_code == x_device_code))
    device = result.scalar_one_or_none()
    
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Invalid device code"},
        )
        
    if device.token_hash: # If token already exists, maybe it's already registered?
        # Allow re-registration? Or reject?
        # Let's allow re-registration but generate new token (rotate)
        pass
        
    # Generate Token
    secret = generate_token_secret()
    device.token_hash = await hash_password_async(secret)
    device.device_code = None # Invalidate the code (one-time use)
    device.is_active = True  # Activate device after registration
    await db.commit()
    
    token = f"dev.{device.id}.{secret}"
    return {"token": token}


@router.post("/heartbeat", response_model=dict)
async def device_heartbeat(
    data: HeartbeatRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    device.ip_address = data.ip_address
    device.last_seen_at = datetime.utcnow()
    await db.commit()
    return {"status": "ok"}


@router.get("/active", response_model=list[dict])
async def list_active_devices(
    db: DBSession,
):
    # Find active devices (last seen < 3 min)
    now = datetime.utcnow()
    # We filter in Python because of the 3 min logic, or we can do it in SQL
    # select * from devices where last_seen_at > now - 3min
    from datetime import timedelta
    threshold = now - timedelta(minutes=3)
    
    result = await db.execute(
        select(Device).where(
            Device.last_seen_at >= threshold,
            Device.deleted_at.is_(None),
            Device.is_active.is_(True)
        )
    )
    devices = result.scalars().all()
    
    return [
        {
            "id": d.id,
            "name": d.name,
            "ip_address": d.ip_address,
        }
        for d in devices
    ]


@router.post("/{device_id}/write-tag", response_model=WriteTagResponse)
async def write_rfid_tag(
    device_id: int,
    data: WriteTagRequest,
    db: DBSession,
):
    # Find Device
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    
    if not device or not device.is_active or device.deleted_at or not device.ip_address:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found, inactive or has no IP address"},
        )

    # Prepare request to device
    device_url = f"http://{device.ip_address}/api/v1/rfid/write"
    payload = {}
    if data.spool_id:
        payload["spool_id"] = data.spool_id
    elif data.location_id:
        payload["location_id"] = data.location_id
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_request", "message": "Either spool_id or location_id must be provided"},
        )

    # Log the attempt
    logger.info(f"Triggering RFID write on device {device_id} at {device_url}")
    logger.debug(f"Payload: {payload}")

    # Initialize status in custom_fields
    if device.custom_fields is None:
        device.custom_fields = {}
    
    # We use a copy to ensure SQLAlchemy detects the change in the dict
    new_custom_fields = dict(device.custom_fields)
    new_custom_fields["last_write_result"] = {
        "status": "pending",
        "timestamp": datetime.utcnow().isoformat()
    }
    device.custom_fields = new_custom_fields
    await db.commit()

    # Fire & Forget: Send request to device but don't wait for RFID result
    # The device will send the result back via /rfid-result endpoint
    try:
        headers = {
            "User-Agent": "FilaMan-Backend/1.0",
            "Accept": "application/json",
        }
        
        async with httpx.AsyncClient(
            timeout=5.0,  # Short timeout just to trigger the device
            http2=False,
            headers=headers,
            follow_redirects=True,
        ) as client:
            # Fire and forget - we don't wait for the RFID result
            await client.post(device_url, json=payload)
            
    except Exception as e:
        # Log but don't fail - the device might still process the request
        logger.warning(f"Could not reach device {device_id} for trigger: {e}")

    # Return immediately - device will send result via /rfid-result
    return WriteTagResponse(
        success=True, 
        message="Schreibvorgang wurde gestartet. Bitte Tag bereit halten..."
    )


@router.get("/{device_id}/write-status", response_model=WriteStatusResponse)
async def get_write_status(
    device_id: int,
    db: DBSession,
):
    """
    Fragt den Status des letzten Schreibvorgangs für ein Gerät ab.
    """
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found"},
        )
        
    last_result = (device.custom_fields or {}).get("last_write_result")
    if not last_result:
        return WriteStatusResponse(status="none")
        
    return WriteStatusResponse(**last_result)


@router.post("/rfid-result", response_model=RfidResultResponse)
async def device_rfid_result(
    data: RfidResultRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    """
    Device ruft diesen Endpoint auf, nachdem der RFID-Schreibvorgang abgeschlossen ist.
    """
    logger.info(f"Received RFID result from device {device.id}: success={data.success}, tag_uuid={data.tag_uuid}")
    
    # Initialize status update
    write_result = {
        "status": "success" if data.success else "error",
        "tag_uuid": data.tag_uuid,
        "error_message": data.error_message,
        "timestamp": datetime.utcnow().isoformat(),
        "removed_from": None
    }
    
    if not data.success:
        logger.warning(f"RFID write failed on device {device.id}: {data.error_message}")
        if device.custom_fields is None: device.custom_fields = {}
        new_cf = dict(device.custom_fields)
        new_cf["last_write_result"] = write_result
        device.custom_fields = new_cf
        await db.commit()
        return RfidResultResponse(status="ok", message="Failure noted")
    
    if not data.tag_uuid:
        logger.warning(f"RFID result missing tag_uuid from device {device.id}")
        write_result["status"] = "error"
        write_result["error_message"] = "No tag_uuid provided"
        if device.custom_fields is None: device.custom_fields = {}
        new_cf = dict(device.custom_fields)
        new_cf["last_write_result"] = write_result
        device.custom_fields = new_cf
        await db.commit()
        return RfidResultResponse(status="error", message="No tag_uuid provided")

    # Duplicate check and cleanup (only for active spools, not archived/deleted)
    removed_info = []
    
    # Check spools - only active spools (not deleted/archived)
    spool_query = select(Spool).where(
        Spool.rfid_uid == data.tag_uuid,
        Spool.deleted_at.is_(None)  # Ignore archived/deleted spools
    )
    if data.spool_id:
        spool_query = spool_query.where(Spool.id != data.spool_id)
    
    spools_res = await db.execute(spool_query)
    for s in spools_res.scalars().all():
        removed_info.append(f"Spule #{s.id}")
        s.rfid_uid = None
        logger.info(f"Cleared duplicate RFID UID from spool {s.id}")

    # Check locations
    loc_query = select(Location).where(Location.identifier == data.tag_uuid)
    if data.location_id:
        loc_query = loc_query.where(Location.id != data.location_id)
    
    locs_res = await db.execute(loc_query)
    for l in locs_res.scalars().all():
        removed_info.append(f"Standort '{l.name}'")
        l.identifier = None
        logger.info(f"Cleared duplicate identifier from location {l.id}")

    if removed_info:
        write_result["removed_from"] = ", ".join(removed_info)
    
    # Determine target: spool_id OR tag_uuid (find spool by tag_uuid if no spool_id provided)
    target_spool = None
    target_location = None
    
    # Try to find spool by spool_id first, then by tag_uuid
    if data.spool_id:
        spool_res = await db.execute(select(Spool).where(Spool.id == data.spool_id))
        target_spool = spool_res.scalar_one_or_none()
        if target_spool:
            target_spool.rfid_uid = data.tag_uuid
            logger.info(f"Updated spool {data.spool_id} with RFID UID {data.tag_uuid}")
        else:
            write_result["status"] = "error"
            write_result["error_message"] = "Target spool not found"
    elif data.tag_uuid:
        # No spool_id provided, try to find spool by tag_uuid
        spool_res = await db.execute(select(Spool).where(Spool.rfid_uid == data.tag_uuid))
        target_spool = spool_res.scalar_one_or_none()
        if target_spool:
            logger.info(f"Found spool {target_spool.id} by tag_uuid {data.tag_uuid}")
        else:
            # Spool not found by tag_uuid - this is expected for new spools without tags
            logger.info(f"No spool found with tag_uuid {data.tag_uuid}")
    
    # Handle location
    if data.location_id:
        loc_res = await db.execute(select(Location).where(Location.id == data.location_id))
        target_location = loc_res.scalar_one_or_none()
        if target_location:
            target_location.identifier = data.tag_uuid
            logger.info(f"Updated location {data.location_id} with identifier {data.tag_uuid}")
        else:
            write_result["status"] = "error"
            write_result["error_message"] = "Target location not found"

    # Update spool weight if provided (e.g., when writing tag to new spool)
    if data.remaining_weight_g is not None:
        spool_to_update = None
        
        # Priority: 1. target_spool (already found above), 2. find by tag_uuid, 3. find by spool_id
        if target_spool:
            spool_to_update = target_spool
        elif data.tag_uuid:
            # Try to find spool by tag_uuid (might have been assigned above or already existed)
            spool_res = await db.execute(
                select(Spool).where(Spool.rfid_uid == data.tag_uuid)
            )
            spool_to_update = spool_res.scalar_one_or_none()
        
        if not spool_to_update and data.spool_id:
            spool_res = await db.execute(
                select(Spool).where(Spool.id == data.spool_id)
            )
            spool_to_update = spool_res.scalar_one_or_none()
        
        if spool_to_update:
            spool_to_update.remaining_weight_g = data.remaining_weight_g
            logger.info(f"Updated spool {spool_to_update.id} remaining weight to {data.remaining_weight_g}g")
        else:
            logger.warning(f"Could not find spool to update weight for tag_uuid {data.tag_uuid}, spool_id {data.spool_id}")

    # Save result to device status
    if device.custom_fields is None: device.custom_fields = {}
    new_cf = dict(device.custom_fields)
    new_cf["last_write_result"] = write_result
    device.custom_fields = new_cf
    
    await db.commit()
    return RfidResultResponse(status="ok", message="Processed successfully")


@router.post("/scale/weight", response_model=WeighResponse)
async def weigh_spool(
    data: WeighRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    service = SpoolService(db)
    
    # Find Spool: UUID has priority over ID (backward compatible)
    spool = None
    
    if data.tag_uuid:
        # Normalize UUID to lowercase for case-insensitive comparison
        normalized_uuid = data.tag_uuid.lower()
        logger.info(f"Searching for spool with tag_uuid: '{data.tag_uuid}' (normalized: '{normalized_uuid}')")
        spool = await service.get_spool_by_identifier(rfid_uid=normalized_uuid, external_id=None)
        logger.info(f"Found spool: {spool.id if spool else 'NONE'}")
    
    if not spool and data.spool_id:
        spool = await service.get_spool(data.spool_id)
        
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    # Record Measurement
    principal = Principal(auth_type="device", device_id=device.id, scopes=device.scopes)
    
    event, remaining = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=datetime.utcnow(),
        principal=principal,
        source="device",
        note=f"Recorded by device {device.name}",
    )
    
    return WeighResponse(
        remaining_weight_g=remaining if remaining is not None else 0.0,
        spool_id=spool.id,
        filament_name=spool.filament.designation if spool.filament else None
    )


@router.post("/scale/locate", response_model=LocateResponse)
async def locate_spool(
    data: LocateRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    service = SpoolService(db)
    
    # Find Spool: UUID has priority over ID (backward compatible)
    spool = None
    if data.spool_tag_uuid:
        spool = await service.get_spool_by_identifier(rfid_uid=data.spool_tag_uuid, external_id=None)
    if not spool and data.spool_id:
        spool = await service.get_spool(data.spool_id)
        
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    # Find Location: UUID has priority over ID (backward compatible)
    location = None
    if data.location_tag_uuid:
        result = await db.execute(select(Location).where(Location.identifier == data.location_tag_uuid))
        location = result.scalar_one_or_none()
    if not location and data.location_id:
        result = await db.execute(select(Location).where(Location.id == data.location_id))
        location = result.scalar_one_or_none()

    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Location not found"},
        )
        
    # Move Spool
    principal = Principal(auth_type="device", device_id=device.id, scopes=device.scopes)
    
    await service.move_location(
        spool=spool,
        to_location_id=location.id,
        event_at=datetime.utcnow(),
        principal=principal,
        source="device",
        note=f"Located by device {device.name}"
    )
    
    return LocateResponse(
        success=True,
        spool_id=spool.id,
        location_id=location.id,
        location_name=location.name
    )
