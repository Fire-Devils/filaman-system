from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Header, status
from sqlalchemy import select

from app.api.deps import DBSession
from app.api.v1.schemas_device import HeartbeatRequest, LocateRequest, LocateResponse, WeighRequest, WeighResponse
from app.core.security import Principal, generate_token_secret, hash_password_async
from app.models import Device, Location
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


@router.post("/scale/weight", response_model=WeighResponse)
async def weigh_spool(
    data: WeighRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    service = SpoolService(db)
    
    # Find Spool
    spool = await service.get_spool_by_identifier(rfid_uid=data.tag_uuid, external_id=None)
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
    
    # Find Spool
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

    # Find Location
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
