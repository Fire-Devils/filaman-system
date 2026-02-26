import logging

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.models import Location, Printer, PrinterSlot, PrinterSlotAssignment, Spool, Filament, FilamentColor
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



class SlotAssignmentResponse(BaseModel):
    present: bool = False
    spool_id: int | None = None
    spool_name: str | None = None
    filament_name: str | None = None
    manufacturer_name: str | None = None
    material_type: str | None = None
    color_hex: str | None = None
    color_name: str | None = None
    tray_color: str | None = None
    tray_type: str | None = None
    tray_info_idx: str | None = None
    nozzle_temp_min: int | None = None
    nozzle_temp_max: int | None = None
    setting_id: str | None = None
    cali_idx: int | None = None

    class Config:
        from_attributes = True


class SlotResponse(BaseModel):
    id: int
    printer_id: int
    slot_no: int
    name: str | None
    is_active: bool
    assignment: SlotAssignmentResponse | None = None

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
        .options(
            selectinload(Printer.slots)
            .selectinload(PrinterSlot.assignment)
            .selectinload(PrinterSlotAssignment.spool)
            .selectinload(Spool.filament)
            .options(
                selectinload(Filament.manufacturer),
                selectinload(Filament.filament_colors).selectinload(FilamentColor.color),
            )
        )
    )
    printer = result.scalar_one_or_none()

    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    # Build slot responses with flattened assignment info
    slot_responses = []
    for slot in sorted(printer.slots, key=lambda s: s.slot_no):
        assignment_data = None
        if slot.assignment:
            a = slot.assignment
            spool = a.spool
            spool_name = None
            filament_name = None
            manufacturer_name = None
            material_type = None
            color_hex = None
            color_name = None
            if spool:
                filament = spool.filament
                spool_name = f"#{spool.id}"
                if filament:
                    filament_name = filament.designation
                    material_type = filament.material_type
                    if filament.manufacturer:
                        manufacturer_name = filament.manufacturer.name
                        spool_name = f"{filament.manufacturer.name} {filament.designation}"
                    else:
                        spool_name = filament.designation
                    if filament.filament_colors:
                        first_color = filament.filament_colors[0].color
                        color_hex = first_color.hex_code
                        color_name = first_color.name
            meta = a.meta or {}
            tray_color = meta.get("tray_color")
            tray_type = meta.get("tray_type")
            tray_info_idx = meta.get("tray_info_idx")
            nozzle_temp_min = meta.get("nozzle_temp_min")
            nozzle_temp_max = meta.get("nozzle_temp_max")
            setting_id = meta.get("setting_id")
            cali_idx = meta.get("cali_idx")
            assignment_data = SlotAssignmentResponse(
                present=a.present,
                spool_id=a.spool_id,
                spool_name=spool_name,
                filament_name=filament_name,
                manufacturer_name=manufacturer_name,
                material_type=material_type,
                color_hex=color_hex,
                color_name=color_name,
                tray_color=tray_color,
                tray_type=tray_type,
                tray_info_idx=tray_info_idx,
                nozzle_temp_min=nozzle_temp_min,
                nozzle_temp_max=nozzle_temp_max,
                setting_id=setting_id,
                cali_idx=cali_idx,
            )
        slot_responses.append(SlotResponse(
            id=slot.id,
            printer_id=slot.printer_id,
            slot_no=slot.slot_no,
            name=slot.name,
            is_active=slot.is_active,
            assignment=assignment_data,
        ))

    return PrinterDetailResponse(
        id=printer.id,
        name=printer.name,
        location_id=printer.location_id,
        is_active=printer.is_active,
        driver_key=printer.driver_key,
        custom_fields=printer.custom_fields,
        driver_config=printer.driver_config,
        slots=slot_responses,
    )


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
    delete_params: bool = Query(False, description="Also hard-delete printer_params for this printer"),
):
    from datetime import datetime

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

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

    # Optionally hard-delete calibration data
    if delete_params:
        await db.execute(sa_delete(FilamentPrinterParam).where(FilamentPrinterParam.printer_id == printer_id))
        await db.execute(sa_delete(SpoolPrinterParam).where(SpoolPrinterParam.printer_id == printer_id))
        logger.info(f"Deleted printer_params for printer {printer_id}")

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


# ─── Printer Params Import/Export ─────────────────────────────────────────────


class PrinterParamExportItem(BaseModel):
    param_key: str
    param_value: str | None = None


class PrinterParamsExportData(BaseModel):
    printer_id: int
    printer_name: str
    driver_key: str
    filament_params: dict[int, list[PrinterParamExportItem]]  # filament_id -> params
    spool_params: dict[int, list[PrinterParamExportItem]]  # spool_id -> params


class PrinterParamsImportData(BaseModel):
    filament_params: dict[int, list[PrinterParamExportItem]] = {}
    spool_params: dict[int, list[PrinterParamExportItem]] = {}


@router.get("/{printer_id}/params/export")
async def export_printer_params(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    """Export all printer-specific params for this printer as JSON."""
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

    # Filament params grouped by filament_id
    result = await db.execute(
        select(FilamentPrinterParam).where(FilamentPrinterParam.printer_id == printer_id)
    )
    filament_params: dict[int, list[dict]] = {}
    for p in result.scalars().all():
        filament_params.setdefault(p.filament_id, []).append(
            {"param_key": p.param_key, "param_value": p.param_value}
        )

    # Spool params grouped by spool_id
    result = await db.execute(
        select(SpoolPrinterParam).where(SpoolPrinterParam.printer_id == printer_id)
    )
    spool_params: dict[int, list[dict]] = {}
    for p in result.scalars().all():
        spool_params.setdefault(p.spool_id, []).append(
            {"param_key": p.param_key, "param_value": p.param_value}
        )

    return {
        "printer_id": printer.id,
        "printer_name": printer.name,
        "driver_key": printer.driver_key,
        "filament_params": filament_params,
        "spool_params": spool_params,
    }


@router.post("/{printer_id}/params/import")
async def import_printer_params(
    printer_id: int,
    body: PrinterParamsImportData,
    db: DBSession,
    principal=RequirePermission("printers:update"),
):
    """Import printer-specific params from JSON. Upserts all entries."""
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam

    imported_count = 0

    # Import filament params
    for filament_id_str, params in body.filament_params.items():
        filament_id = int(filament_id_str)
        for item in params:
            result = await db.execute(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament_id,
                    FilamentPrinterParam.printer_id == printer_id,
                    FilamentPrinterParam.param_key == item.param_key,
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                existing.param_value = item.param_value
            else:
                db.add(FilamentPrinterParam(
                    filament_id=filament_id,
                    printer_id=printer_id,
                    param_key=item.param_key,
                    param_value=item.param_value,
                ))
            imported_count += 1

    # Import spool params
    for spool_id_str, params in body.spool_params.items():
        spool_id = int(spool_id_str)
        for item in params:
            result = await db.execute(
                select(SpoolPrinterParam).where(
                    SpoolPrinterParam.spool_id == spool_id,
                    SpoolPrinterParam.printer_id == printer_id,
                    SpoolPrinterParam.param_key == item.param_key,
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                existing.param_value = item.param_value
            else:
                db.add(SpoolPrinterParam(
                    spool_id=spool_id,
                    printer_id=printer_id,
                    param_key=item.param_key,
                    param_value=item.param_value,
                ))
            imported_count += 1

    await db.commit()
    return {"imported": imported_count, "message": f"Imported {imported_count} params for printer {printer.name}"}
