import pytest
from datetime import datetime
from httpx import AsyncClient

from app.core.security import hash_password, generate_token_secret
from app.models import (
    User, Filament, Manufacturer, Spool, SpoolStatus,
    Printer, PrinterAmsUnit, PrinterSlot, PrinterSlotAssignment,
    Device
)
from app.services.ams_slots_service import AmsSlotsService
from sqlalchemy import select


@pytest.fixture
async def test_printer(db_session):
    printer = Printer(
        name="Test Printer",
        driver_key="dummy",
    )
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


@pytest.fixture
async def test_ams_unit(db_session, test_printer):
    ams_unit = PrinterAmsUnit(
        printer_id=test_printer.id,
        ams_unit_no=0,
        name="AMS 1",
        slots_total=4,
    )
    db_session.add(ams_unit)
    await db_session.commit()
    await db_session.refresh(ams_unit)
    
    for i in range(4):
        slot = PrinterSlot(
            printer_id=test_printer.id,
            is_ams_slot=True,
            ams_unit_id=ams_unit.id,
            slot_no=i,
        )
        db_session.add(slot)
    
    await db_session.commit()
    
    return ams_unit


@pytest.fixture
async def test_filament(db_session):
    mfr = Manufacturer(name="Test Manufacturer")
    db_session.add(mfr)
    await db_session.commit()
    await db_session.refresh(mfr)
    
    filament = Filament(
        manufacturer_id=mfr.id,
        designation="Test PLA",
        type="PLA",
        diameter_mm=1.75,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)
    
    return filament


@pytest.fixture
async def test_spool(db_session, test_filament):
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == "new"))
    status = result.scalar_one_or_none()
    if not status:
        status = SpoolStatus(key="new", label="New")
        db_session.add(status)
        await db_session.commit()
        await db_session.refresh(status)
    
    spool = Spool(
        filament_id=test_filament.id,
        status_id=status.id,
        rfid_uid="TEST-RFID-001",
        external_id="TEST-EXT-001",
        remaining_weight_g=750.0,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


class TestAmsSlotsService:
    @pytest.mark.asyncio
    async def test_upsert_ams_unit(self, db_session, test_printer):
        service = AmsSlotsService(db_session)
        
        await service.upsert_ams_unit(
            printer_id=test_printer.id,
            ams_unit_no=1,
            slots_total=4,
            name="New AMS",
        )
        
        result = await db_session.execute(
            select(PrinterAmsUnit).where(
                PrinterAmsUnit.printer_id == test_printer.id,
                PrinterAmsUnit.ams_unit_no == 1,
            )
        )
        ams_unit = result.scalar_one_or_none()
        
        assert ams_unit is not None
        assert ams_unit.name == "New AMS"
        assert ams_unit.slots_total == 4

    @pytest.mark.asyncio
    async def test_upsert_slot(self, db_session, test_ams_unit, test_printer):
        service = AmsSlotsService(db_session)
        
        result = await db_session.execute(
            select(PrinterSlot).where(PrinterSlot.ams_unit_id == test_ams_unit.id)
        )
        slots = result.scalars().all()
        
        assert len(slots) == 4

    @pytest.mark.asyncio
    async def test_assign_spool_to_slot(
        self, db_session, test_ams_unit, test_spool, test_printer
    ):
        service = AmsSlotsService(db_session)
        
        result = await db_session.execute(
            select(PrinterSlot).where(
                PrinterSlot.ams_unit_id == test_ams_unit.id,
                PrinterSlot.slot_no == 0,
            )
        )
        slot = result.scalar_one()
        
        await service.update_assignment(
            slot_id=slot.id,
            spool_id=test_spool.id,
            present=True,
            rfid_uid=test_spool.rfid_uid,
        )
        
        await db_session.refresh(slot)
        assert slot.assignment is not None
        assert slot.assignment.spool_id == test_spool.id
        assert slot.assignment.present is True

    @pytest.mark.asyncio
    async def test_spool_removed_clears_identifiers(
        self, db_session, test_ams_unit, test_spool, test_printer
    ):
        service = AmsSlotsService(db_session)
        
        result = await db_session.execute(
            select(PrinterSlot).where(
                PrinterSlot.ams_unit_id == test_ams_unit.id,
                PrinterSlot.slot_no == 0,
            )
        )
        slot = result.scalar_one()
        
        await service.update_assignment(
            slot_id=slot.id,
            spool_id=test_spool.id,
            present=True,
            rfid_uid=test_spool.rfid_uid,
        )
        
        await service.update_assignment(
            slot_id=slot.id,
            spool_id=None,
            present=False,
        )
        
        await db_session.refresh(slot)
        assert slot.assignment.spool_id is None
        assert slot.assignment.present is False

    @pytest.mark.asyncio
    async def test_apply_event_spool_inserted(
        self, db_session, test_ams_unit, test_spool, test_printer
    ):
        service = AmsSlotsService(db_session)
        
        result = await db_session.execute(
            select(PrinterSlot).where(
                PrinterSlot.ams_unit_id == test_ams_unit.id,
                PrinterSlot.slot_no == 0,
            )
        )
        slot = result.scalar_one()
        
        event = {
            "printer_id": test_printer.id,
            "ams_unit_no": test_ams_unit.ams_unit_no,
            "slot_no": 0,
            "event_type": "spool_inserted",
            "rfid_uid": test_spool.rfid_uid,
            "event_at": datetime.utcnow().isoformat(),
        }
        
        await service.apply_event(event)
        
        await db_session.refresh(slot)
        assert slot.assignment is not None
        assert slot.assignment.spool_id == test_spool.id

    @pytest.mark.asyncio
    async def test_apply_event_spool_removed(
        self, db_session, test_ams_unit, test_spool, test_printer
    ):
        service = AmsSlotsService(db_session)
        
        result = await db_session.execute(
            select(PrinterSlot).where(
                PrinterSlot.ams_unit_id == test_ams_unit.id,
                PrinterSlot.slot_no == 0,
            )
        )
        slot = result.scalar_one()
        
        await service.update_assignment(
            slot_id=slot.id,
            spool_id=test_spool.id,
            present=True,
            rfid_uid=test_spool.rfid_uid,
        )
        
        event = {
            "printer_id": test_printer.id,
            "ams_unit_no": test_ams_unit.ams_unit_no,
            "slot_no": 0,
            "event_type": "spool_removed",
            "event_at": datetime.utcnow().isoformat(),
        }
        
        await service.apply_event(event)
        
        await db_session.refresh(slot)
        assert slot.assignment.spool_id is None
        assert slot.assignment.present is False
