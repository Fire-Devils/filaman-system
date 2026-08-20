import logging

import httpx
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Header, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession
from app.utils.colors import visible_rgb_hex_or_legacy

logger = logging.getLogger(__name__)


def _is_primary_worker() -> bool:
    """Resolve primary worker state lazily to avoid import cycles."""
    try:
        from app import main as app_main
        return bool(getattr(app_main, "_is_primary", False))
    except Exception:
        return False


from app.api.v1.schemas_device import HeartbeatRequest, LocateRequest, LocateResponse, WeighRequest, WeighResponse, WriteTagRequest, WriteTagResponse, RfidResultRequest, RfidResultResponse, WriteStatusResponse, TagDataRequest, TagScanStatusResponse
from app.core.security import Principal, generate_token_secret, hash_token
from app.models import AppSettings, Device, Location, Spool, SpoolStatus
from app.models.filament import Color, FilamentColor, Manufacturer
from app.services.spool_service import SpoolService

_MATERIAL_TEMP_DEFAULTS: dict[str, tuple[int, int]] = {
    "PLA": (180, 230),
    "PETG": (220, 250),
    "ABS": (230, 270),
    "ASA": (240, 270),
    "TPU": (220, 250),
    "TPE": (220, 250),
    "NYLON": (240, 280),
    "PA": (240, 280),
    "PC": (260, 300),
    "HIPS": (220, 250),
    "PVA": (170, 200),
    "PLA+": (180, 230),
}
_DEFAULT_TEMP = (190, 230)


async def _build_extended_data(db: DBSession, spool: Spool, protocol: str) -> dict:
    """Baut das Extended-Data-Dict für RFID-Tags aus den Spulen-/Filamentdaten."""
    filament = spool.filament
    material_type = filament.material_type if filament else "PLA"

    # Farbe (erste Farbe des Filaments)
    color_hex = "FFFFFF"
    if filament:
        fc_result = await db.execute(
            select(Color.hex_code)
            .join(FilamentColor, FilamentColor.color_id == Color.id)
            .where(FilamentColor.filament_id == filament.id)
            .order_by(FilamentColor.position)
            .limit(1)
        )
        raw_hex = fc_result.scalar_one_or_none()
        if raw_hex:
            color_hex = visible_rgb_hex_or_legacy(raw_hex).replace("#", "")

    # Hersteller
    brand = "Generic"
    if filament and filament.manufacturer_id:
        mfr_result = await db.execute(
            select(Manufacturer.name).where(Manufacturer.id == filament.manufacturer_id)
        )
        mfr_name = mfr_result.scalar_one_or_none()
        if mfr_name:
            brand = mfr_name

    # Temperaturen: aus SpoolPrinterParam / FilamentPrinterParam (bambu_nozzle_temp_min/max)
    min_temp, max_temp = _MATERIAL_TEMP_DEFAULTS.get(material_type.upper(), _DEFAULT_TEMP)
    if filament:
        from app.models.printer_params import FilamentPrinterParam
        param_result = await db.execute(
            select(FilamentPrinterParam.param_key, FilamentPrinterParam.param_value)
            .where(
                FilamentPrinterParam.filament_id == filament.id,
                FilamentPrinterParam.param_key.in_(["bambu_nozzle_temp_min", "bambu_nozzle_temp_max"]),
            )
        )
        params = {row.param_key: row.param_value for row in param_result.all()}
        if "bambu_nozzle_temp_min" in params and params["bambu_nozzle_temp_min"]:
            try:
                min_temp = int(params["bambu_nozzle_temp_min"])
            except ValueError:
                pass
        if "bambu_nozzle_temp_max" in params and params["bambu_nozzle_temp_max"]:
            try:
                max_temp = int(params["bambu_nozzle_temp_max"])
            except ValueError:
                pass

    return {
        "protocol": protocol,
        "version": "1.0",
        "type": material_type,
        "color_hex": color_hex,
        "brand": brand,
        "min_temp": str(min_temp),
        "max_temp": str(max_temp),
    }

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
    device.last_used_at = datetime.now(timezone.utc)
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
    device.token_hash = hash_token(secret)
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
    device.last_seen_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok"}


@router.get("/active", response_model=list[dict])
async def list_active_devices(
    db: DBSession,
):
    # Find active devices (last seen < 3 min)
    now = datetime.now(timezone.utc)
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

    # Extended Data: nur wenn Spool und Setting aktiv
    if data.spool_id:
        settings_result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
        app_settings = settings_result.scalar_one_or_none()
        if app_settings and app_settings.rfid_extended_data_enabled:
            spool_result = await db.execute(
                select(Spool)
                .options(selectinload(Spool.filament))
                .where(Spool.id == data.spool_id)
            )
            spool_obj = spool_result.scalar_one_or_none()
            if spool_obj:
                payload.update(await _build_extended_data(
                    db, spool_obj, app_settings.rfid_protocol
                ))

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
        "timestamp": datetime.now(timezone.utc).isoformat()
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
        "timestamp": datetime.now(timezone.utc).isoformat(),
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

    # Duplicate check and cleanup - clear rfid_uid from ALL spools (incl. archived)
    # to prevent UNIQUE constraint violation on spools.rfid_uid.
    # Case-insensitive: the weigh lookup matches UIDs via lower(), so a UID stored
    # with different casing would otherwise survive cleanup and later cause
    # MultipleResultsFound on weigh.
    removed_info = []
    
    # Check spools - all spools regardless of status
    spool_query = (
        select(Spool)
        .where(func.lower(Spool.rfid_uid) == data.tag_uuid.lower())
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
    request: Request,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    # Drivers only live on the primary Gunicorn worker. Proxy the whole request
    # there so auto-assign can reach them; the primary handles measurement too.
    if device.auto_assign_enabled and not _is_primary_worker():
        from app.api.v1.printers import _PRIMARY_PROXY_HEADER, _proxy_to_primary

        hop = int(request.headers.get(_PRIMARY_PROXY_HEADER, "0") or "0")
        if hop > 0:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "primary_worker_required",
                    "message": "Auto-assign requires the primary worker; retrying.",
                },
            )

        payload = await _proxy_to_primary(
            request,
            method="POST",
            path="/api/v1/devices/scale/weight",
            json_body=data.model_dump(),
        )
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "primary_proxy_failed",
                    "message": "Primary worker did not return a valid weigh response.",
                },
            )
        return WeighResponse.model_validate(payload)

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

    # Cache filament data BEFORE record_measurement() commits the session
    # (after commit, lazy-loaded relationships are expired in async SQLAlchemy)
    filament = spool.filament
    filament_material_type = filament.material_type if filament else "PLA"
    filament_designation = filament.designation if filament else None
    base_color = "FFFFFF"
    if filament:
        # Direct query to avoid async lazy-load issues with filament.colors relationship
        from app.models.filament import FilamentColor, Color
        fc_result = await db.execute(
            select(Color.hex_code)
            .join(FilamentColor, FilamentColor.color_id == Color.id)
            .where(FilamentColor.filament_id == filament.id)
            .order_by(FilamentColor.position)
            .limit(1)
        )
        hex_code = fc_result.scalar_one_or_none()
        if hex_code:
            base_color = visible_rgb_hex_or_legacy(hex_code).replace("#", "")
    # Record Measurement
    principal = Principal(auth_type="device", device_id=device.id, scopes=device.scopes)
    
    event, remaining = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=datetime.now(timezone.utc),
        principal=principal,
        source="device",
        note=f"Recorded by device {device.name}",
    )
    # Auto-assign: if device has auto_assign_enabled, notify all running drivers.
    # Drivers only live on the primary Gunicorn worker; proxy if we're not it.
    logger.debug(f"Auto-assign check: device={device.name} (id={device.id}), auto_assign_enabled={device.auto_assign_enabled}")
    if device.auto_assign_enabled:
        try:
            from app.plugins.manager import plugin_manager
            logger.debug(f"Auto-assign: plugin_manager has {len(plugin_manager.drivers)} active drivers: {list(plugin_manager.drivers.keys())}")

            base_filament_data = {
                "tray_info_idx": "GFL99",
                "nozzle_temp_min": 190,
                "nozzle_temp_max": 230,
                "material_type": filament_material_type,
                "color": base_color,
            }

            timeout = device.auto_assign_timeout or 60

            for printer_id, driver in plugin_manager.drivers.items():
                if not hasattr(driver, "assign_pending_spool"):
                    continue
                try:
                    # Enrich filament data with printer-specific params
                    enriched_data = await plugin_manager.enrich_filament_data(
                        spool_id=spool.id,
                        printer_id=printer_id,
                        filament_data={**base_filament_data},
                    )
                    await driver.assign_pending_spool(
                        spool_id=spool.id,
                        filament_data=enriched_data,
                        timeout_seconds=timeout,
                    )
                    logger.info(f"Auto-assign: pending spool {spool.id} on printer {printer_id} (timeout: {timeout}s)")
                except Exception as e:
                    logger.error(f"Auto-assign failed for printer {printer_id}: {e}")
        except Exception as e:
            logger.error(f"Auto-assign error: {e}")
    else:
        logger.debug(f"Auto-assign SKIPPED: device '{device.name}' (id={device.id}) has auto_assign_enabled=False")

    return WeighResponse(
        remaining_weight_g=remaining if remaining is not None else 0.0,
        spool_id=spool.id,
        filament_name=filament_designation
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
        event_at=datetime.now(timezone.utc),
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


@router.post("/{device_id}/request-tag-scan", response_model=dict)
async def request_tag_scan(
    device_id: int,
    db: DBSession,
):
    """Fordert das Gerät auf, den nächsten NFC-Tag zu lesen und die Daten zurückzusenden."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()

    if not device or not device.is_active or device.deleted_at or not device.ip_address:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found, inactive or has no IP address"},
        )

    # Status auf pending setzen
    if device.custom_fields is None:
        device.custom_fields = {}
    new_cf = dict(device.custom_fields)
    new_cf["last_tag_scan"] = {
        "status": "pending",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    device.custom_fields = new_cf
    await db.commit()

    # Scan-Request ans Gerät senden und Ergebnis prüfen
    device_url = f"http://{device.ip_address}/api/v1/rfid/scan-request"
    request_error: str | None = None
    try:
        async with httpx.AsyncClient(timeout=5.0, http2=False, follow_redirects=True) as client:
            response = await client.post(device_url, json={})

        if response.status_code >= 400:
            if response.status_code == status.HTTP_404_NOT_FOUND:
                request_error = "Geraete-Firmware unterstuetzt '/api/v1/rfid/scan-request' nicht."
            else:
                request_error = f"Geraet antwortete mit HTTP {response.status_code}."
    except Exception as e:
        request_error = f"Geraet nicht erreichbar: {e}"

    if request_error:
        logger.warning(
            "Tag scan request failed for device %s (%s): %s",
            device_id,
            device_url,
            request_error,
        )

        new_cf = dict(device.custom_fields or {})
        new_cf["last_tag_scan"] = {
            "status": "error",
            "error_message": request_error,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        device.custom_fields = new_cf
        await db.commit()

        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "device_scan_request_failed",
                "message": "Tag-Scan konnte auf dem Geraet nicht gestartet werden. Bitte Firmware/Verbindung pruefen.",
            },
        )

    return {"success": True, "message": "Scan-Request gesendet"}


@router.post("/tag-data", response_model=dict)
async def receive_tag_data(
    data: TagDataRequest,
    db: DBSession,
    device: Device = Depends(get_current_device),
):
    """Empfängt Tag-Daten vom Gerät und speichert sie für den Frontend-Polling-Mechanismus."""
    import json as _json

    logger.info(f"Received tag data from device {device.id}: {data.tag_json[:100]}...")

    parse_ok = True
    try:
        tag_data = _json.loads(data.tag_json)
    except Exception:
        parse_ok = False
        tag_data = {"raw": data.tag_json}

    scan_status = "success"
    scan_error_message: str | None = None

    if not parse_ok:
        scan_status = "error"
        scan_error_message = "Ungueltige Tag-Daten vom Geraet empfangen"
    elif isinstance(tag_data, dict):
        status_hint = str(tag_data.get("scan_status") or tag_data.get("status") or "").strip().lower()
        if status_hint in {"error", "timeout", "failed", "failure"}:
            scan_status = "error"
            scan_error_message = str(tag_data.get("error_message") or "Tag-Scan fehlgeschlagen")

    if scan_status == "error":
        logger.warning(
            "Received tag scan error from device %s: %s",
            device.id,
            scan_error_message,
        )

    if device.custom_fields is None:
        device.custom_fields = {}
    new_cf = dict(device.custom_fields)
    new_cf["last_tag_scan"] = {
        "status": scan_status,
        "tag_data": tag_data if scan_status == "success" else None,
        "error_message": scan_error_message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    device.custom_fields = new_cf
    await db.commit()

    return {"status": "ok"}


@router.get("/{device_id}/tag-scan-result", response_model=TagScanStatusResponse)
async def get_tag_scan_result(
    device_id: int,
    db: DBSession,
):
    """Gibt den Status und das Ergebnis des letzten Tag-Scans zurück."""
    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()

    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Device not found"},
        )

    last_scan = (device.custom_fields or {}).get("last_tag_scan")
    if not last_scan:
        return TagScanStatusResponse(status="none")

    return TagScanStatusResponse(**last_scan)
