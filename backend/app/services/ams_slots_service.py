from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Printer, PrinterAmsUnit, PrinterSlot, PrinterSlotAssignment, PrinterSlotEvent, Spool


class AmsSlotsService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_printer(self, printer_id: int) -> Printer | None:
        result = await self.db.execute(select(Printer).where(Printer.id == printer_id))
        return result.scalar_one_or_none()

    async def get_or_create_ams_unit(
        self,
        printer_id: int,
        ams_unit_no: int,
        slots_total: int = 4,
        name: str | None = None,
    ) -> PrinterAmsUnit:
        result = await self.db.execute(
            select(PrinterAmsUnit).where(
                PrinterAmsUnit.printer_id == printer_id,
                PrinterAmsUnit.ams_unit_no == ams_unit_no,
            )
        )
        unit = result.scalar_one_or_none()

        if unit:
            if unit.slots_total != slots_total:
                unit.slots_total = slots_total
            if name:
                unit.name = name
            return unit

        unit = PrinterAmsUnit(
            printer_id=printer_id,
            ams_unit_no=ams_unit_no,
            slots_total=slots_total,
            name=name,
        )
        self.db.add(unit)
        await self.db.flush()
        return unit

    async def get_or_create_slot(
        self,
        printer_id: int,
        slot_no: int,
        is_ams_slot: bool = True,
        ams_unit_id: int | None = None,
        name: str | None = None,
    ) -> PrinterSlot:
        result = await self.db.execute(
            select(PrinterSlot).where(
                PrinterSlot.printer_id == printer_id,
                PrinterSlot.is_ams_slot == is_ams_slot,
                PrinterSlot.ams_unit_id == ams_unit_id if is_ams_slot else None,
                PrinterSlot.slot_no == slot_no,
            )
        )
        slot = result.scalar_one_or_none()

        if slot:
            if name:
                slot.name = name
            return slot

        slot = PrinterSlot(
            printer_id=printer_id,
            is_ams_slot=is_ams_slot,
            ams_unit_id=ams_unit_id,
            slot_no=slot_no,
            name=name,
        )
        self.db.add(slot)
        await self.db.flush()

        assignment = PrinterSlotAssignment(slot_id=slot.id, present=False)
        self.db.add(assignment)
        await self.db.flush()

        return slot

    async def _find_spool_by_identifier(
        self,
        rfid_uid: str | None,
        external_id: str | None,
    ) -> Spool | None:
        if rfid_uid:
            result = await self.db.execute(
                select(Spool).where(Spool.rfid_uid == rfid_uid, Spool.deleted_at.is_(None))
            )
            spool = result.scalar_one_or_none()
            if spool:
                return spool

        if external_id:
            result = await self.db.execute(
                select(Spool).where(Spool.external_id == external_id, Spool.deleted_at.is_(None))
            )
            return result.scalar_one_or_none()

        return None

    async def _create_slot_event(
        self,
        printer_id: int,
        slot_id: int,
        event_type: str,
        event_at: datetime,
        spool_id: int | None = None,
        rfid_uid: str | None = None,
        external_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> PrinterSlotEvent:
        event = PrinterSlotEvent(
            printer_id=printer_id,
            slot_id=slot_id,
            event_type=event_type,
            event_at=event_at,
            spool_id=spool_id,
            rfid_uid=rfid_uid,
            external_id=external_id,
            meta=meta,
        )
        self.db.add(event)
        await self.db.flush()
        return event

    async def apply_spool_inserted(
        self,
        printer_id: int,
        slot_no: int,
        event_at: datetime,
        rfid_uid: str | None = None,
        external_id: str | None = None,
        ams_unit_no: int | None = None,
        meta: dict[str, Any] | None = None,
    ) -> tuple[PrinterSlot, PrinterSlotEvent]:
        is_ams_slot = ams_unit_no is not None
        ams_unit_id = None

        if is_ams_slot:
            ams_unit = await self.get_or_create_ams_unit(printer_id, ams_unit_no)
            ams_unit_id = ams_unit.id

        slot = await self.get_or_create_slot(
            printer_id=printer_id,
            slot_no=slot_no,
            is_ams_slot=is_ams_slot,
            ams_unit_id=ams_unit_id,
        )

        spool = await self._find_spool_by_identifier(rfid_uid, external_id)

        assignment = await self.db.execute(
            select(PrinterSlotAssignment).where(PrinterSlotAssignment.slot_id == slot.id)
        )
        assignment = assignment.scalar_one_or_none()

        if not assignment:
            assignment = PrinterSlotAssignment(slot_id=slot.id)
            self.db.add(assignment)

        assignment.present = True
        assignment.spool_id = spool.id if spool else None
        assignment.rfid_uid = rfid_uid
        assignment.external_id = external_id
        assignment.inserted_at = event_at
        assignment.updated_at = event_at

        event = await self._create_slot_event(
            printer_id=printer_id,
            slot_id=slot.id,
            event_type="spool_inserted",
            event_at=event_at,
            spool_id=spool.id if spool else None,
            rfid_uid=rfid_uid,
            external_id=external_id,
            meta=meta,
        )

        await self.db.commit()
        return slot, event

    async def apply_spool_removed(
        self,
        printer_id: int,
        slot_no: int,
        event_at: datetime,
        ams_unit_no: int | None = None,
        meta: dict[str, Any] | None = None,
    ) -> tuple[PrinterSlot, PrinterSlotEvent] | None:
        is_ams_slot = ams_unit_no is not None
        ams_unit_id = None

        if is_ams_slot:
            result = await self.db.execute(
                select(PrinterAmsUnit).where(
                    PrinterAmsUnit.printer_id == printer_id,
                    PrinterAmsUnit.ams_unit_no == ams_unit_no,
                )
            )
            unit = result.scalar_one_or_none()
            if unit:
                ams_unit_id = unit.id

        result = await self.db.execute(
            select(PrinterSlot).where(
                PrinterSlot.printer_id == printer_id,
                PrinterSlot.is_ams_slot == is_ams_slot,
                PrinterSlot.ams_unit_id == ams_unit_id,
                PrinterSlot.slot_no == slot_no,
            )
        )
        slot = result.scalar_one_or_none()

        if not slot:
            return None

        result = await self.db.execute(
            select(PrinterSlotAssignment).where(PrinterSlotAssignment.slot_id == slot.id)
        )
        assignment = result.scalar_one_or_none()

        if assignment:
            assignment.present = False
            assignment.spool_id = None
            assignment.rfid_uid = None
            assignment.external_id = None
            assignment.inserted_at = None
            assignment.updated_at = event_at

        event = await self._create_slot_event(
            printer_id=printer_id,
            slot_id=slot.id,
            event_type="spool_removed",
            event_at=event_at,
            meta=meta,
        )

        await self.db.commit()
        return slot, event

    async def apply_unknown_spool_detected(
        self,
        printer_id: int,
        slot_no: int,
        event_at: datetime,
        rfid_uid: str | None = None,
        external_id: str | None = None,
        ams_unit_no: int | None = None,
        meta: dict[str, Any] | None = None,
    ) -> tuple[PrinterSlot, PrinterSlotEvent]:
        is_ams_slot = ams_unit_no is not None
        ams_unit_id = None

        if is_ams_slot:
            ams_unit = await self.get_or_create_ams_unit(printer_id, ams_unit_no)
            ams_unit_id = ams_unit.id

        slot = await self.get_or_create_slot(
            printer_id=printer_id,
            slot_no=slot_no,
            is_ams_slot=is_ams_slot,
            ams_unit_id=ams_unit_id,
        )

        result = await self.db.execute(
            select(PrinterSlotAssignment).where(PrinterSlotAssignment.slot_id == slot.id)
        )
        assignment = result.scalar_one_or_none()

        if not assignment:
            assignment = PrinterSlotAssignment(slot_id=slot.id)
            self.db.add(assignment)

        assignment.present = True
        assignment.spool_id = None
        assignment.rfid_uid = rfid_uid
        assignment.external_id = external_id
        assignment.inserted_at = event_at
        assignment.updated_at = event_at

        event = await self._create_slot_event(
            printer_id=printer_id,
            slot_id=slot.id,
            event_type="unknown_spool_detected",
            event_at=event_at,
            rfid_uid=rfid_uid,
            external_id=external_id,
            meta=meta,
        )

        await self.db.commit()
        return slot, event

    async def apply_ams_state(
        self,
        printer_id: int,
        state: list[dict[str, Any]],
        event_at: datetime,
    ) -> list[PrinterSlotEvent]:
        events = []

        for unit_data in state:
            ams_unit_no = unit_data.get("ams_unit_no")
            slots = unit_data.get("slots", [])

            for slot_data in slots:
                slot_no = slot_data.get("slot_no")
                rfid_uid = slot_data.get("rfid_uid")
                external_id = slot_data.get("external_id")
                present = slot_data.get("present", False)

                if present:
                    slot, event = await self.apply_spool_inserted(
                        printer_id=printer_id,
                        slot_no=slot_no,
                        event_at=event_at,
                        rfid_uid=rfid_uid,
                        external_id=external_id,
                        ams_unit_no=ams_unit_no,
                        meta={"source": "ams_state"},
                    )
                    events.append(event)
                else:
                    result = await self.apply_spool_removed(
                        printer_id=printer_id,
                        slot_no=slot_no,
                        event_at=event_at,
                        ams_unit_no=ams_unit_no,
                        meta={"source": "ams_state"},
                    )
                    if result:
                        events.append(result[1])

        return events
