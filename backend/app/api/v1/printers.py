from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DBSession, PrincipalDep, RequirePermission
from app.api.v1.schemas import PaginatedResponse
from app.models import Location, Printer, PrinterAmsUnit, PrinterSlot

router = APIRouter(prefix="/printers", tags=["printers"])


class PrinterCreate(BaseModel):
    name: str
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    location_id: int | None = None
    driver_key: str
    driver_config: dict | None = None


class PrinterUpdate(BaseModel):
    name: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    location_id: int | None = None
    is_active: bool | None = None
    driver_key: str | None = None
    driver_config: dict | None = None


class AmsUnitResponse(BaseModel):
    id: int
    printer_id: int
    ams_unit_no: int
    name: str | None
    slots_total: int
    is_active: bool

    class Config:
        from_attributes = True


class SlotResponse(BaseModel):
    id: int
    printer_id: int
    is_ams_slot: bool
    ams_unit_id: int | None
    slot_no: int
    name: str | None
    is_active: bool

    class Config:
        from_attributes = True


class PrinterResponse(BaseModel):
    id: int
    name: str
    manufacturer: str | None
    model: str | None
    serial_number: str | None
    location_id: int | None
    is_active: bool
    driver_key: str

    class Config:
        from_attributes = True


class PrinterDetailResponse(PrinterResponse):
    driver_config: dict | None = None
    ams_units: list[AmsUnitResponse] = []
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
        .options(selectinload(Printer.ams_units), selectinload(Printer.slots))
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

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(printer, key, value)

    await db.commit()
    await db.refresh(printer)
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

    printer.deleted_at = datetime.utcnow()
    await db.commit()


@router.post("/{printer_id}/ams-units", response_model=AmsUnitResponse, status_code=status.HTTP_201_CREATED)
async def create_ams_unit(
    printer_id: int,
    ams_unit_no: int,
    slots_total: int,
    name: str | None = None,
    db: DBSession = None,
    principal = RequirePermission("printers:update"),
):
    result = await db.execute(
        select(Printer).where(Printer.id == printer_id, Printer.deleted_at.is_(None))
    )
    if not result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Printer not found"},
        )

    ams_unit = PrinterAmsUnit(
        printer_id=printer_id,
        ams_unit_no=ams_unit_no,
        name=name,
        slots_total=slots_total,
    )
    db.add(ams_unit)
    await db.commit()
    await db.refresh(ams_unit)
    return ams_unit


@router.get("/{printer_id}/ams-units", response_model=list[AmsUnitResponse])
async def list_ams_units(
    printer_id: int,
    db: DBSession,
    principal: PrincipalDep,
):
    result = await db.execute(
        select(PrinterAmsUnit).where(PrinterAmsUnit.printer_id == printer_id).order_by(PrinterAmsUnit.ams_unit_no)
    )
    return result.scalars().all()


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
