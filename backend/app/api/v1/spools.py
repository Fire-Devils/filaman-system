from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload, joinedload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.core.cache import response_cache
from app.core.db_utils import get_next_available_id, get_next_available_ids
from app.api.v1.schemas import PaginatedResponse
from app.api.v1.schemas_spool import (
    AdjustmentRequest,
    BulkSpoolDeleteRequest,
    BulkSpoolUpdateRequest,
    BulkStatusChangeRequest,
    ConsumptionRequest,
    DeviceMeasurementRequest,
    LocationCreate,
    LocationResponse,
    LocationUpdate,
    MeasurementRequest,
    MoveLocationRequest,
    SpoolBulkCreate,
    SpoolCreate,
    SpoolEventResponse,
    SpoolResponse,
    SpoolStatusResponse,
    SpoolUpdate,
    StatusChangeRequest,
)
from app.core.event_bus import event_bus
from app.models import (
    Filament,
    FilamentColor,
    Location,
    Manufacturer,
    Spool,
    SpoolEvent,
    SpoolStatus,
)
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
        .outerjoin(
            Spool,
            (Spool.location_id == Location.id)
            & (
                Spool.status_id
                != select(SpoolStatus.id)
                .where(SpoolStatus.key == "archived")
                .scalar_subquery()
            ),
        )
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


@router_locations.post(
    "", response_model=LocationResponse, status_code=status.HTTP_201_CREATED
)
async def create_location(
    data: LocationCreate,
    db: DBSession,
    principal=RequirePermission("locations:create"),
):
    location = Location(**data.model_dump())
    db.add(location)
    await db.commit()
    await db.refresh(location)
    await event_bus.publish({"event": "locations_changed"})
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
    principal=RequirePermission("locations:update"),
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
    await event_bus.publish({"event": "locations_changed"})
    return location


@router_locations.delete("/{location_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_location(
    location_id: int,
    db: DBSession,
    principal=RequirePermission("locations:delete"),
):
    result = await db.execute(select(Location).where(Location.id == location_id))
    location = result.scalar_one_or_none()
    if not location:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Location not found"},
        )

    result = await db.execute(
        select(Spool).where(Spool.location_id == location_id).limit(1)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "conflict",
                "message": "Location has spools, cannot delete",
            },
        )

    await db.delete(location)
    await db.commit()
    await event_bus.publish({"event": "locations_changed"})


router_spools = APIRouter(prefix="/spools", tags=["spools"])


@router_spools.get("/statuses", response_model=list[SpoolStatusResponse])
async def list_spool_statuses(
    db: DBSession,
    principal: PrincipalDep,
):
    cached = response_cache.get("spool_statuses")
    if cached is not None:
        return cached

    result = await db.execute(select(SpoolStatus).order_by(SpoolStatus.sort_order))
    items = result.scalars().all()

    serialized = [SpoolStatusResponse.model_validate(s) for s in items]
    response_cache.set("spool_statuses", serialized, ttl=600)
    return serialized


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
    type: str | None = None,
    include_archived: bool = Query(False),
    search: str | None = Query(None, max_length=200),
    sort_by: str = Query(
        "id",
        pattern="^(id|filament_id|status_id|location_id|remaining_weight_g|purchase_date|purchase_price|last_used_at|created_at|lot_number|initial_total_weight_g|empty_spool_weight_g|manufacturer|material|mfr_color)$",
    ),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
):
    # -- Build filter conditions (shared between data query and count query) --
    conditions = []
    needs_filament_join = False
    needs_status_join = False
    needs_manufacturer_join = False

    if manufacturer_id:
        conditions.append(Filament.manufacturer_id == manufacturer_id)
        needs_filament_join = True
    if filament_id:
        conditions.append(Spool.filament_id == filament_id)
    if type:
        conditions.append(Filament.material_type == type)
        needs_filament_join = True

    if include_archived:
        if status_id:
            conditions.append(Spool.status_id == status_id)
        # else: no filter — include all spools (archived + non-archived)
    elif status_id:
        conditions.append(Spool.status_id == status_id)
    else:
        conditions.append(SpoolStatus.key != "archived")
        needs_status_join = True

    if location_id:
        conditions.append(Spool.location_id == location_id)

    if search:
        search_term = f"%{search}%"
        conditions.append(
            or_(
                Filament.designation.ilike(search_term),
                Filament.material_type.ilike(search_term),
                Filament.manufacturer_color_name.ilike(search_term),
                Manufacturer.name.ilike(search_term),
                Spool.lot_number.ilike(search_term),
                Spool.rfid_uid.ilike(search_term),
            )
        )
        needs_filament_join = True
        needs_manufacturer_join = True

    # -- Data query --
    query = select(Spool)
    if needs_filament_join or needs_manufacturer_join:
        query = query.join(Filament, Spool.filament_id == Filament.id)
    if needs_manufacturer_join:
        query = query.join(
            Manufacturer, Filament.manufacturer_id == Manufacturer.id, isouter=True
        )
    if needs_status_join:
        query = query.join(SpoolStatus, Spool.status_id == SpoolStatus.id)

    for cond in conditions:
        query = query.where(cond)

    # Sorting — resolve virtual sort keys to joined columns
    if sort_by == "manufacturer":
        sort_column = Manufacturer.name
        needs_filament_join = True
        needs_manufacturer_join = True
    elif sort_by == "material":
        sort_column = Filament.material_type
        needs_filament_join = True
    elif sort_by == "mfr_color":
        sort_column = Filament.manufacturer_color_name
        needs_filament_join = True
    else:
        sort_column = getattr(Spool, sort_by, Spool.id)
    order = sort_column.asc() if sort_order == "asc" else sort_column.desc()

    query = (
        query.options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
        .order_by(order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    result = await db.execute(query)
    items = list(result.scalars().unique().all())

    # -- Count query (same filters, no eager loading / pagination) --
    count_query = select(func.count()).select_from(Spool)
    if needs_filament_join or needs_manufacturer_join:
        count_query = count_query.join(Filament, Spool.filament_id == Filament.id)
    if needs_manufacturer_join:
        count_query = count_query.join(
            Manufacturer, Filament.manufacturer_id == Manufacturer.id, isouter=True
        )
    if needs_status_join:
        count_query = count_query.join(SpoolStatus, Spool.status_id == SpoolStatus.id)

    for cond in conditions:
        count_query = count_query.where(cond)

    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_spools.post(
    "", response_model=SpoolResponse, status_code=status.HTTP_201_CREATED
)
async def create_spool(
    data: SpoolCreate,
    db: DBSession,
    principal=RequirePermission("spools:create"),
):
    result = await db.execute(select(Filament).where(Filament.id == data.filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Filament not found"},
        )

    if data.status_id:
        result = await db.execute(
            select(SpoolStatus).where(SpoolStatus.id == data.status_id)
        )
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
        spool_data["empty_spool_weight_g"] = (
            filament.default_spool_weight_g
            if filament.default_spool_weight_g is not None
            else 250
        )

    if spool_data.get("spool_outer_diameter_mm") is None:
        spool_data["spool_outer_diameter_mm"] = (
            filament.spool_outer_diameter_mm
            if filament.spool_outer_diameter_mm is not None
            else 200
        )

    if spool_data.get("spool_width_mm") is None:
        spool_data["spool_width_mm"] = (
            filament.spool_width_mm if filament.spool_width_mm is not None else 65
        )

    if spool_data.get("spool_material") is None:
        spool_data["spool_material"] = filament.spool_material

    # Calculate remaining_weight_g from initial_total_weight_g - empty_spool_weight_g
    # when no explicit value was provided (new spool with no usage yet)
    if spool_data.get("remaining_weight_g") is None:
        itw = spool_data.get("initial_total_weight_g")
        esw = spool_data.get("empty_spool_weight_g")
        if itw is not None and esw is not None:
            spool_data["remaining_weight_g"] = max(itw - esw, 0)

    if "status_id" not in spool_data or spool_data["status_id"] is None:
        spool_data["status_id"] = status_obj.id

    # Clear rfid_uid from other spools to prevent UNIQUE constraint violation
    new_rfid = spool_data.get("rfid_uid")
    if new_rfid:
        dup_result = await db.execute(select(Spool).where(Spool.rfid_uid == new_rfid))
        for dup in dup_result.scalars().all():
            dup.rfid_uid = None

    next_id = await get_next_available_id(db, Spool)
    spool = Spool(id=next_id, **spool_data)
    db.add(spool)
    await db.commit()
    await event_bus.publish({"event": "spools_changed"})

    # Reload with relationships for schema validation
    result = await db.execute(
        select(Spool)
        .where(Spool.id == spool.id)
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
    )
    return result.scalar_one()


@router_spools.post(
    "/bulk", response_model=list[SpoolResponse], status_code=status.HTTP_201_CREATED
)
async def create_spools_bulk(
    data: SpoolBulkCreate,
    db: DBSession,
    principal=RequirePermission("spools:create"),
):
    result = await db.execute(select(Filament).where(Filament.id == data.filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Filament not found"},
        )

    if data.status_id:
        result = await db.execute(
            select(SpoolStatus).where(SpoolStatus.id == data.status_id)
        )
    else:
        result = await db.execute(select(SpoolStatus).where(SpoolStatus.key == "new"))
    status_obj = result.scalar_one_or_none()
    if not status_obj:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "validation_error", "message": "Status not found"},
        )

    spool_data = data.model_dump(exclude={"quantity"})

    # Cascade fields from Filament if not provided
    if spool_data.get("empty_spool_weight_g") is None:
        spool_data["empty_spool_weight_g"] = (
            filament.default_spool_weight_g
            if filament.default_spool_weight_g is not None
            else 250
        )
    if spool_data.get("spool_outer_diameter_mm") is None:
        spool_data["spool_outer_diameter_mm"] = (
            filament.spool_outer_diameter_mm
            if filament.spool_outer_diameter_mm is not None
            else 200
        )
    if spool_data.get("spool_width_mm") is None:
        spool_data["spool_width_mm"] = (
            filament.spool_width_mm if filament.spool_width_mm is not None else 65
        )
    if spool_data.get("spool_material") is None:
        spool_data["spool_material"] = filament.spool_material

    # Calculate remaining_weight_g from initial_total_weight_g - empty_spool_weight_g
    # when no explicit value was provided (new spool with no usage yet)
    if spool_data.get("remaining_weight_g") is None:
        itw = spool_data.get("initial_total_weight_g")
        esw = spool_data.get("empty_spool_weight_g")
        if itw is not None and esw is not None:
            spool_data["remaining_weight_g"] = max(itw - esw, 0)

    if "status_id" not in spool_data or spool_data["status_id"] is None:
        spool_data["status_id"] = status_obj.id

    # Unique fields cannot be duplicated across multiple spools
    if data.quantity > 1:
        spool_data["rfid_uid"] = None
        spool_data["external_id"] = None

    # Clear rfid_uid from other spools to prevent UNIQUE constraint violation
    new_rfid = spool_data.get("rfid_uid")
    if new_rfid:
        dup_result = await db.execute(select(Spool).where(Spool.rfid_uid == new_rfid))
        for dup in dup_result.scalars().all():
            dup.rfid_uid = None

    next_ids = await get_next_available_ids(db, Spool, data.quantity)
    spool_ids = []
    try:
        for i in range(data.quantity):
            spool = Spool(id=next_ids[i], **spool_data.copy())
            db.add(spool)
            spool_ids.append(next_ids[i])

        await db.flush()
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "bulk_create_error", "message": str(e)},
        )
    await event_bus.publish({"event": "spools_changed"})

    # Reload all spools with relationships
    result = await db.execute(
        select(Spool)
        .where(Spool.id.in_(spool_ids))
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
    )
    return result.scalars().all()


@router_spools.patch("/bulk", status_code=status.HTTP_200_OK)
async def update_spools_bulk(
    data: BulkSpoolUpdateRequest,
    db: DBSession,
    principal=RequirePermission("spools:update"),
):
    """Bulk update fields on multiple spools (location, threshold, empty weight, price)."""
    result = await db.execute(select(Spool).where(Spool.id.in_(data.spool_ids)))
    spools = result.scalars().all()

    count = 0
    for spool in spools:
        if data.clear_location:
            spool.location_id = None
        elif data.location_id is not None:
            spool.location_id = data.location_id
        if data.status_id is not None:
            spool.status_id = data.status_id
        if data.low_weight_threshold_g is not None:
            spool.low_weight_threshold_g = data.low_weight_threshold_g
        if data.empty_spool_weight_g is not None:
            spool.empty_spool_weight_g = data.empty_spool_weight_g
        if data.purchase_price is not None:
            spool.purchase_price = data.purchase_price
        count += 1

    await db.commit()
    await event_bus.publish({"event": "spools_changed"})
    return {"success": True, "count": count}


@router_spools.delete("/bulk", status_code=status.HTTP_200_OK)
async def delete_spools_bulk(
    data: BulkSpoolDeleteRequest,
    db: DBSession,
    principal=RequirePermission("spools:delete"),
):
    """Bulk archive or permanently delete multiple spools."""
    if data.permanent:
        result = await db.execute(delete(Spool).where(Spool.id.in_(data.spool_ids)))
        count = result.rowcount
    else:
        archived_result = await db.execute(
            select(SpoolStatus).where(SpoolStatus.key == "archived")
        )
        archived_status = archived_result.scalar_one_or_none()
        if not archived_status:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"code": "config_error", "message": "Archived status not found"},
            )
        result = await db.execute(
            update(Spool)
            .where(Spool.id.in_(data.spool_ids))
            .values(status_id=archived_status.id)
        )
        count = result.rowcount

    await db.commit()
    await event_bus.publish({"event": "spools_changed"})
    return {"success": True, "count": count}


@router_spools.get("/all-events", response_model=PaginatedResponse[SpoolEventResponse])
async def list_all_spool_events(
    db: DBSession,
    principal=RequirePermission("spool_events:read"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    result = await db.execute(
        select(SpoolEvent)
        .order_by(SpoolEvent.event_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = list(result.scalars().all())

    count_result = await db.execute(select(func.count()).select_from(SpoolEvent))
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router_spools.get("/{spool_id}", response_model=SpoolResponse)
async def get_spool(spool_id: int, db: DBSession, principal: PrincipalDep):
    result = await db.execute(
        select(Spool)
        .where(Spool.id == spool_id)
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
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
    principal=RequirePermission("spools:update"),
):
    result = await db.execute(select(Spool).where(Spool.id == spool_id))
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    # Clear rfid_uid from other spools to prevent UNIQUE constraint violation
    update_data = data.model_dump(exclude_unset=True)
    new_rfid = update_data.get("rfid_uid")
    if new_rfid and new_rfid != spool.rfid_uid:
        dup_result = await db.execute(
            select(Spool).where(Spool.rfid_uid == new_rfid, Spool.id != spool_id)
        )
        for dup in dup_result.scalars().all():
            dup.rfid_uid = None

    for key, value in update_data.items():
        setattr(spool, key, value)

    await db.commit()
    await event_bus.publish({"event": "spools_changed"})

    # Reload with relationships
    result = await db.execute(
        select(Spool)
        .where(Spool.id == spool.id)
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.filament)
            .selectinload(Filament.filament_colors)
            .selectinload(FilamentColor.color),
        )
    )
    return result.scalar_one()


@router_spools.delete("/{spool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_spool(
    spool_id: int,
    db: DBSession,
    principal=RequirePermission("spools:delete"),
):
    result = await db.execute(select(Spool).where(Spool.id == spool_id))
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    # Archive the spool by setting status to "archived"
    result = await db.execute(select(SpoolStatus).where(SpoolStatus.key == "archived"))
    archived_status = result.scalar_one_or_none()
    if archived_status:
        spool.status_id = archived_status.id
    await db.commit()
    await event_bus.publish({"event": "spools_changed"})


@router_spools.delete("/{spool_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def permanently_delete_spool(
    spool_id: int,
    db: DBSession,
    principal=RequirePermission("spools:delete"),
):
    """Permanently delete a spool and all its data (including events) from the database."""
    result = await db.execute(select(Spool).where(Spool.id == spool_id))
    spool = result.scalar_one_or_none()
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    await db.delete(spool)
    await db.commit()
    await event_bus.publish({"event": "spools_changed"})


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
    await event_bus.publish({"event": "spools_changed"})
    return {"success": True, "count": count}


@router_spools.post("/{spool_id}/measurements", response_model=SpoolEventResponse)
async def record_measurement(
    spool_id: int,
    data: MeasurementRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_measurement"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event, _ = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    await event_bus.publish({"event": "spools_changed"})
    return event


@router_spools.post("/{spool_id}/adjustments", response_model=SpoolEventResponse)
async def record_adjustment(
    spool_id: int,
    data: AdjustmentRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_adjustment"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event, _ = await service.record_adjustment(
        spool=spool,
        adjustment_type=data.adjustment_type,
        event_at=event_at,
        delta_weight_g=data.delta_weight_g,
        measured_weight_g=data.measured_weight_g,
        principal=principal,
        note=data.note,
    )
    await event_bus.publish({"event": "spools_changed"})
    return event


@router_spools.post("/{spool_id}/consumptions", response_model=SpoolEventResponse)
async def record_consumption(
    spool_id: int,
    data: ConsumptionRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_consumption"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event, _ = await service.record_consumption(
        spool=spool,
        delta_weight_g=data.delta_weight_g,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    await event_bus.publish({"event": "spools_changed"})
    return event


@router_spools.post("/{spool_id}/status", response_model=SpoolEventResponse)
async def change_status(
    spool_id: int,
    data: StatusChangeRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_status"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event = await service.change_status(
        spool=spool,
        status_key=data.status,
        event_at=event_at,
        principal=principal,
        note=data.note,
        meta=data.meta,
    )
    await event_bus.publish({"event": "spools_changed"})
    return event


@router_spools.post("/{spool_id}/move", response_model=SpoolEventResponse)
async def move_location(
    spool_id: int,
    data: MoveLocationRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_move_location"),
):
    service = SpoolService(db)
    spool = await service.get_spool(spool_id)
    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event = await service.move_location(
        spool=spool,
        to_location_id=data.location_id,
        event_at=event_at,
        principal=principal,
        note=data.note,
    )
    await event_bus.publish({"event": "spools_changed"})
    return event


@router_spools.get(
    "/{spool_id}/events", response_model=PaginatedResponse[SpoolEventResponse]
)
async def list_spool_events(
    spool_id: int,
    db: DBSession,
    principal=RequirePermission("spool_events:read"),
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
    items = list(result.scalars().all())

    count_result = await db.execute(
        select(func.count())
        .select_from(SpoolEvent)
        .where(SpoolEvent.spool_id == spool_id)
    )
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


router_spool_measurements = APIRouter(tags=["spool-measurements"])


@router_spool_measurements.post(
    "/spool-measurements", response_model=SpoolEventResponse
)
async def device_measurement(
    data: DeviceMeasurementRequest,
    db: DBSession,
    principal=RequirePermission("spool_events:create_measurement"),
):
    if not data.rfid_uid and not data.external_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "validation_error",
                "message": "rfid_uid or external_id required",
            },
        )

    service = SpoolService(db)
    spool = await service.get_spool_by_identifier(data.rfid_uid, data.external_id)

    if not spool:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Spool not found by identifier"},
        )

    event_at = data.event_at or datetime.now(timezone.utc)
    event, _ = await service.record_measurement(
        spool=spool,
        measured_weight_g=data.measured_weight_g,
        event_at=event_at,
        principal=principal,
        source="device",
    )
    await event_bus.publish({"event": "spools_changed"})
    return event
