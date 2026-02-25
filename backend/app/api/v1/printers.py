import logging

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.models import Location, Printer, PrinterSlot
from app.plugins.manager import plugin_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/printers", tags=["printers"])


class PrinterCreate(BaseModel):
    name: str
    location_id: int | None = None
    driver_key: str
    driver_config: dict | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    location_id: int | None = None
    is_active: bool | None = None
    driver_key: str | None = None
    driver_config: dict | None = None



class SlotResponse(BaseModel):
    id: int
    printer_id: int
    slot_no: int
    name: str | None
    is_active: bool

    class Config:
        from_attributes = True


class PrinterResponse(BaseModel):
    id: int
    name: str
    location_id: int | None
    is_active: bool
    driver_key: str
    custom_fields: dict | None = None

    class Config:
        from_attributes = True


class PrinterDetailResponse(PrinterResponse):
    driver_config: dict | None = None
    slots: list[SlotResponse] = []


@router.get("", response_model=PaginatedResponse[PrinterResponse])
async def list_printers(
    db: DBSession,
    principal: PrincipalDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    query = select(Printer).where(Printer.deleted_at.is_(None)).order_by(Printer.name)
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    items = result.scalars().all()

    count_query = select(func.count()).select_from(Printer).where(Printer.deleted_at.is_(None))
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return PaginatedResponse(items=items, page=page, page_size=page_size, total=total)


@router.post("", response_model=PrinterResponse, status_code=status.HTTP_201_CREATED)
async def create_printer(
    data: PrinterCreate,
    db: DBSession,
    principal = RequirePermission("printers:create"),
):
    if data.location_id:
        result = await db.execute(select(Location).where(Location.id == data.location_id))
        if not result.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "validation_error", "message": "Location not found"},
            )

    printer = Printer(**data.model_dump())
    db.add(printer)
    await db.commit()
    await db.refresh(printer)

    # Auto-start driver if printer is active (default)
    if printer.is_active and printer.driver_key:
        started = await plugin_manager.start_printer(printer)
        if not started:
            logger.warning(f"Driver {printer.driver_key} could not be started for new printer {printer.id}")

    return printer


@router.get("/{printer_id}", response_model=PrinterDetailResponse)
async def get_printer(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(Printer)
        .where(Printer.id == printer_id, Printer.deleted_at.is_(None))
        .options(selectinload(Printer.slots))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    return printer


@router.patch("/{printer_id}", response_model=PrinterResponse)
async def update_printer(
    printer_id: int,
    data: PrinterUpdate,
    db: DBSession,
    principal = RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    updates = data.model_dump(exclude_unset=True)
    driver_changed = "driver_key" in updates or "driver_config" in updates
    active_changed = "is_active" in updates and updates["is_active"] != printer.is_active

    for key, value in updates.items():
        setattr(printer, key, value)

    await db.commit()
    await db.refresh(printer)

    # Handle driver lifecycle on relevant changes
    if active_changed and not printer.is_active:
        # Deactivated → stop driver
        await plugin_manager.stop_printer(printer_id)
    elif active_changed and printer.is_active:
        # Activated → start driver
        await plugin_manager.start_printer(printer)
    elif driver_changed and printer.is_active:
        # Config/key changed while active → restart
        await plugin_manager.stop_printer(printer_id)
        await plugin_manager.start_printer(printer)

    return printer


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_printer(
    printer_id: int,
    db: DBSession,
    principal = RequirePermission("printers:delete"),
):
    from datetime import datetime

    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    # Stop driver before soft-delete
    await plugin_manager.stop_printer(printer_id)

    printer.deleted_at = datetime.utcnow()
    await db.commit()



@router.get("/{printer_id}/slots", response_model=list[SlotResponse])
async def list_slots(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(PrinterSlot).where(PrinterSlot.printer_id == printer_id).order_by(PrinterSlot.slot_no)
    )
    return result.scalars().all()



class DriverActionRequest(BaseModel):
    action: str
    params: dict = {}


class DriverActionResponse(BaseModel):
    success: bool
    message: str | None = None
    data: dict | None = None


@router.post("/{printer_id}/driver/action", response_model=DriverActionResponse)
async def driver_action(
    printer_id: int,
    data: DriverActionRequest,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "driver_not_running", "message": "Driver is not running for this printer"},
        )

    method = getattr(driver, data.action, None)
    if not method or data.action.startswith("_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_action", "message": f"Action '{data.action}' not available"},
        )

    try:
        if callable(method):
            import asyncio
            if asyncio.iscoroutinefunction(method):
                await method(**data.params)
            else:
                method(**data.params)
        return DriverActionResponse(success=True, message=f"Action '{data.action}' executed")
    except TypeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_params", "message": str(e)},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "action_failed", "message": str(e)},
        )


@router.get("/{printer_id}/driver/health")
async def driver_health(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        return {"running": False, "connected": False}
    return driver.health()


@router.get("/{printer_id}/driver/debug")
async def driver_debug_log(
    printer_id: int,
    since: str | None = Query(None),
    db: DBSession = None,
    principal: PrincipalDep = None,
):
    driver = plugin_manager.drivers.get(printer_id)
    if not driver:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "driver_not_running", "message": "Driver is not running for this printer"},
        )
    return driver.get_debug_log(since_ts=since)


@router.post("/{printer_id}/driver/start", response_model=DriverActionResponse)
async def start_driver(
    printer_id: int,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    if printer_id in plugin_manager.drivers:
        return DriverActionResponse(success=True, message="Driver already running")

    started = await plugin_manager.start_printer(printer)
    if not started:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "start_failed", "message": "Driver could not be started"},
        )

    return DriverActionResponse(success=True, message="Driver started")


@router.post("/{printer_id}/driver/stop", response_model=DriverActionResponse)
async def stop_driver(
    printer_id: int,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    if printer_id not in plugin_manager.drivers:
        return DriverActionResponse(success=True, message="Driver not running")

    await plugin_manager.stop_printer(printer_id)
    return DriverActionResponse(success=True, message="Driver stopped")
