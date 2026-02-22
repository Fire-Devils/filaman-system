from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.api.v1.schemas_spool import (
    AdjustmentRequest,
    ConsumptionRequest,
    DeviceMeasurementRequest,
    LocationCreate,
    LocationResponse,
    LocationUpdate,
    MeasurementRequest,
    MoveLocationRequest,
    SpoolCreate,
    SpoolEventResponse,
    SpoolResponse,
    SpoolStatusResponse,
    SpoolUpdate,
    StatusChangeRequest,
    BulkStatusChangeRequest,
)
from app.models import Filament, Location, Spool, SpoolEvent, SpoolStatus
from app.services.spool_service import SpoolService

router_locations = APIRouter(prefix="/locations", tags=["locations"])


@router_locations.get("", response_model=PaginatedResponse[LocationResponse])
async def list_locations(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    # Query Locations with Spool Count
    stmt = (
        select(Location, func.count(Spool.id).label("spool_count"))
        .outerjoin(Spool, (Spool.location_id == Location.id) & (Spool.deleted_at.is_(None)))
        .group_by(Location.id)
        .order_by(Location.name)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(stmt)
    rows = result.all()

    # Convert to response objects
    items = []
    for loc, count in rows:
        # Dynamically attach count to location object so Pydantic can read it
        # or construct dict
        loc_dict = {
            "id": loc.id,
            "name": loc.name,
            "identifier": loc.identifier,
            "custom_fields": loc.custom_fields,
            "spool_count": count,
        }
        items.append(LocationResponse(**loc_dict))

    count_result = await db.execute(select(func.count()).select_from(Location))
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_locations.post("", response_model=LocationResponse, status_code=status.HTTP_201_CREATED)
async def create_location(
    data: LocationCreate,
    db: DBSession,
    principal = RequirePermission("locations:create"),
):
    location = Location(**data.model_dump())
    db.add(location)
    await db.commit()
    await db.refresh(location)
    return location


@router_locations.get("/{location_id}", response_model=LocationResponse)
async def get_location(location_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(select(Location).where(Location.id == location_id))
    location = result.scalar_one_or_none()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Location not found"},
        )
    return location


@router_locations.patch("/{location_id}", response_model=LocationResponse)
async def update_location(
    location_id: int,
    data: LocationUpdate,
    db: DBSession,
    principal = RequirePermission("locations:update"),
):
    result = await db.execute(select(Location).where(Location.id == location_id))
    location = result.scalar_one_or_none()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Location not found"},
        )

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(location, key, value)

    await db.commit()
    await db.refresh(location)
    return location


@router_locations.delete("/{location_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_location(
    location_id: int,
    db: DBSession,
    principal = RequirePermission("locations:delete"),
):
    result = await db.execute(select(Location).where(Location.id == location_id))
    location = result.scalar_one_or_none()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Location not found"},
        )

    result = await db.execute(select(Spool).where(Spool.location_id == location_id).limit(1))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "conflict", "message": "Location has spools, cannot delete"},
        )

    await db.delete(location)
    await db.commit()


router_spools = APIRouter(prefix="/spools", tags=["spools"])


@router_spools.get("/statuses", response_model=list[SpoolStatusResponse])
async def list_spool_statuses(
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(SpoolStatus).order_by(SpoolStatus.sort_order)
    )
    return result.scalars().all()


@router_spools.get("", response_model=PaginatedResponse[SpoolResponse])
async def list_spools(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    filament_id: int | None = None,
    status_id: int | None = None,
    location_id: int | None = None,
    manufacturer_id: int | None = None,
):
    query = select(Spool).where(Spool.deleted_at.is_(None))

    if manufacturer_id:
        query = query.join(Filament).where(Filament.manufacturer_id == manufacturer_id)
    if filament_id:
        query = query.where(Spool.filament_id == filament_id)
    
    if status_id:
        query = query.where(Spool.status_id == status_id)
    else:
        # Exclude archived spools by default
        query = query.join(SpoolStatus).where(SpoolStatus.key != "archived")

    if location_id:
        query = query.where(Spool.location_id == location_id)

    query = query.order_by(Spool.id.desc()).offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().all()

    count_query = select(func.count()).select_from(Spool).where(Spool.deleted_at.is_(None))
    if manufacturer_id:
        count_query = count_query.join(Filament).where(Filament.manufacturer_id == manufacturer_id)
    if filament_id:
        count_query = count_query.where(Spool.filament_id == filament_id)
    
    if status_id:
        count_query = count_query.where(Spool.status_id == status_id)
    else:
        # Exclude archived spools by default
        count_query = count_query.join(SpoolStatus).where(SpoolStatus.key != "archived")

    if location_id:
        count_query = count_query.where(Spool.location_id == location_id)

    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_spools.post("", response_model=SpoolResponse, status_code=status.HTTP_201_CREATED)
async def create_spool(
    data: SpoolCreate,
    db: DBSession,
    principal = RequirePermission("spools:create"),
):
    result = await db.execute(select(Filament).where(Filament.id == data.filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Filament not found"},
        )

    if data.status_id:
        result = await db.execute(select(SpoolStatus).where(SpoolStatus.id == data.status_id))
    else:
        result = await db.execute(select(SpoolStatus).where(SpoolStatus.key == "new"))
    status_obj = result.scalar_one_or_none()
    if not status_obj:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Status not found"},
        )

    spool_data = data.model_dump()
    
    # Cascade fields from Filament if not provided
    if spool_data.get("empty_spool_weight_g") is None:
        spool_data["empty_spool_weight_g"] = filament.default_spool_weight_g if filament.default_spool_weight_g is not None else 250
        
    if spool_data.get("spool_outer_diameter_mm") is None:
        spool_data["spool_outer_diameter_mm"] = filament.spool_outer_diameter_mm if filament.spool_outer_diameter_mm is not None else 200
        
    if spool_data.get("spool_width_mm") is None:
        spool_data["spool_width_mm"] = filament.spool_width_mm if filament.spool_width_mm is not None else 65
        
    if spool_data.get("spool_material") is None:
        spool_data["spool_material"] = filament.spool_material
    
    if "status_id" not in spool_data or spool_data["status_id"] is None:
        spool_data["status_id"] = status_obj.id

    spool = Spool(**spool_data)
    db.add(spool)
    await db.commit()
    await db.refresh(spool)
    return spool


@router_spools.get("/{spool_id}", response_model=SpoolResponse)
async def get_spool(spool_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(
        select(Spool)
        .where(Spool.id == spool_id, Spool.deleted_at.is_(None))
        .options(selectinload(Spool.filament))
    )
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )
    return spool


@router_spools.patch("/{spool_id}", response_model=SpoolResponse)
async def update_spool(
    spool_id: int,
    data: SpoolUpdate,
    db: DBSession,
    principal = RequirePermission("spools:update"),
):
    result = await db.execute(
        select(Spool).where(Spool.id == spool_id, Spool.deleted_at.is_(None))
    )
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(spool, key, value)

    await db.commit()
    await db.refresh(spool)
    return spool


@router_spools.delete("/{spool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_spool(
    spool_id: int,
    db: DBSession,
    principal = RequirePermission("spools:delete"),
):
    result = await db.execute(
        select(Spool).where(Spool.id == spool_id, Spool.deleted_at.is_(None))
    )
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    spool.deleted_at = datetime.utcnow()
    await db.commit()


@router_spools.post("/bulk/status", status_code=status.HTTP_200_OK)
async def change_statuses_bulk(
    data: BulkStatusChangeRequest,
    db: DBSession,
    principal: PrincipalDep,
):
    """Change status for multiple spools (e.g. bulk archiving)."""
    service = SpoolService(db)
    # Check permission (using a general update permission for now, or create a specific one if needed)
    RequirePermission("spools:update")
    
    count = await service.change_statuses_bulk(
        spool_ids=data.spool_ids,
        status_key=data.status,
        principal=principal,
        note=data.note,
    )
    return {"success": True, "count": count}


@router_spools.post("/{spool_id}/measurements", response_model=SpoolEventResponse)
async def record_measurement(
    spool_id: int,
    data: MeasurementRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_measurement"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.utcnow()
    event, _ = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    return event


@router_spools.post("/{spool_id}/adjustments", response_model=SpoolEventResponse)
async def record_adjustment(
    spool_id: int,
    data: AdjustmentRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_adjustment"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.utcnow()
    event, _ = await service.record_adjustment(
        spool=spool,
        adjustment_type=data.adjustment_type,
        event_at=event_at,
        delta_weight_g=data.delta_weight_g,
        measured_weight_g=data.measured_weight_g,
        principal=principal,
        note=data.note,
    )
    return event


@router_spools.post("/{spool_id}/consumptions", response_model=SpoolEventResponse)
async def record_consumption(
    spool_id: int,
    data: ConsumptionRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_consumption"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.utcnow()
    event, _ = await service.record_consumption(
        spool=spool,
        delta_weight_g=data.delta_weight_g,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    return event


@router_spools.post("/{spool_id}/status", response_model=SpoolEventResponse)
async def change_status(
    spool_id: int,
    data: StatusChangeRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_status"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.utcnow()
    event = await service.change_status(
        spool=spool,
        status_key=data.status,
        event_at=event_at,
        principal=principal,
        note=data.note,
        meta=data.meta,
    )
    return event


@router_spools.post("/{spool_id}/move", response_model=SpoolEventResponse)
async def move_location(
    spool_id: int,
    data: MoveLocationRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_move_location"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.utcnow()
    event = await service.move_location(
        spool=spool,
        to_location_id=data.location_id,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    return event


@router_spools.get("/{spool_id}/events", response_model=PaginatedResponse[SpoolEventResponse])
async def list_spool_events(
    spool_id: int,
    db: DBSession,
    principal = RequirePermission("spool_events:read"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    result = await db.execute(
        select(SpoolEvent)
        .where(SpoolEvent.spool_id == spool_id)
        .order_by(SpoolEvent.event_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = result.scalars().all()

    count_result = await db.execute(
        select(func.count()).select_from(SpoolEvent).where(SpoolEvent.spool_id == spool_id)
    )
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


router_spool_measurements = APIRouter(tags=["spool-measurements"])


@router_spool_measurements.post("/spool-measurements", response_model=SpoolEventResponse)
async def device_measurement(
    data: DeviceMeasurementRequest,
    db: DBSession,
    principal = RequirePermission("spool_events:create_measurement"),
):
    if not data.rfid_uid and not data.external_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "rfid_uid or external_id required"},
        )

    service = SpoolService(db)
    spool = await service.get_spool_by_identifier(data.rfid_uid, data.external_id)

    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found by identifier"},
        )

    event_at = data.event_at or datetime.utcnow()
    event, _ = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=event_at,
        principal=principal,
        source="device",
    )
    return event
