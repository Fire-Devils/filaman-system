import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models import Filament, Manufacturer, Printer, Spool, SpoolStatus
from app.models.printer import PrinterSlot, PrinterSlotAssignment
from app.plugins.manager import PluginManager


@pytest_asyncio.fixture
async def slots_env(db_session, monkeypatch):
    """Point the plugin manager at the test session and seed a printer + two spools."""

    class _SessionContext:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(
        "app.plugins.manager.async_session_maker", lambda: _SessionContext()
    )

    printer = Printer(name="Voron 2T", driver_key="moonraker_filaman")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    manufacturer = Manufacturer(name="Test Manufacturer")
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)

    status = (
        await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == "active"))
    ).scalar_one()

    spools = []
    for designation, material in (("Red PLA", "PLA"), ("Blue PETG", "PETG")):
        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation=designation,
            material_type=material,
            diameter_mm=1.75,
            default_spool_weight_g=250.0,
        )
        db_session.add(filament)
        await db_session.commit()
        await db_session.refresh(filament)

        spool = Spool(
            filament_id=filament.id,
            status_id=status.id,
            initial_total_weight_g=1000.0,
            empty_spool_weight_g=250.0,
            remaining_weight_g=750.0,
        )
        db_session.add(spool)
        await db_session.commit()
        await db_session.refresh(spool)
        spools.append(spool)

    return printer, spools


def _toolhead(slot_index: str, name: str, **extra) -> dict:
    return {
        "slot_index": slot_index,
        "slot_name": name,
        "slot_kind": "toolhead",
        "present": False,
        **extra,
    }


def _tray(slot_index: str, name: str, **extra) -> dict:
    return {
        "slot_index": slot_index,
        "slot_name": name,
        "slot_kind": "tray",
        "present": False,
        **extra,
    }


async def _assignments_by_slot_index(db_session, printer_id: int) -> dict[str, int | None]:
    result = await db_session.execute(
        select(PrinterSlot, PrinterSlotAssignment)
        .join(PrinterSlotAssignment, PrinterSlotAssignment.slot_id == PrinterSlot.id)
        .where(PrinterSlot.printer_id == printer_id)
    )
    return {
        (slot.custom_fields or {}).get("slot_index"): assignment.spool_id
        for slot, assignment in result.all()
    }


class TestPerSlotSpoolAssignment:
    @pytest.mark.asyncio
    async def test_spool_lands_on_reporting_toolhead(self, db_session, slots_env):
        """A spool reported for toolhead 2 must not be recorded on toolhead 1."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[1].id, present=True),
            ],
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_per_slot_report_overrides_printer_wide_active_spool(
        self, db_session, slots_env
    ):
        """The printer-wide active spool must not pull the assignment onto slot 0-0."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[1].id, present=True),
            ],
            active_spool_id_raw=spools[1].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_moving_spool_between_toolheads_clears_the_old_one(
        self, db_session, slots_env
    ):
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=spools[0].id, present=True),
                _toolhead("0-1", "Toolhead 2", spool_id=None),
            ],
        )
        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[0].id, present=True),
            ],
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[0].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_single_toolhead_driver_still_uses_active_spool_fallback(
        self, db_session, slots_env
    ):
        """Drivers that report no per-slot spool keep the previous behaviour."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [_toolhead("0-0", "Toolhead 1")],
            active_spool_id_raw=spools[0].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id

    @pytest.mark.asyncio
    async def test_single_slot_fallback_also_works_without_slot_data(
        self, db_session, slots_env
    ):
        """The refresh path passes no slots; on a single-slot printer it still syncs."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(printer.id, [_toolhead("0-0", "Toolhead 1")])
        await manager._handle_slots_update(
            printer.id, [], None, spools[0].id
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id


class TestActiveSpoolFallbackOnMultiSlotPrinters:
    """Regression cover for #127.

    driver_health(?refresh=1) and driver startup call _handle_slots_update with an
    empty slot list, so per_slot_spools stays False there no matter what the driver
    reports. On a tray printer the fallback then stamped the active spool into 0-0
    on every poll, overwriting the real map.
    """

    async def _seed_tray_map(self, manager, printer, spools):
        await manager._handle_slots_update(
            printer.id,
            [
                _tray("0-0", "Tray 1", spool_id=spools[0].id, present=True),
                _tray("0-1", "Tray 2", spool_id=spools[1].id, present=True),
                _tray("0-2", "Tray 3", spool_id=None),
                _tray("0-3", "Tray 4", spool_id=None),
            ],
        )

    @pytest.mark.asyncio
    async def test_refresh_path_leaves_the_tray_map_alone(self, db_session, slots_env):
        printer, spools = slots_env
        manager = PluginManager()
        await self._seed_tray_map(manager, printer, spools)

        # Exactly what api/v1/printers.py::driver_health does on ?refresh=1:
        # the spool loaded in the toolhead sits in tray 1, not tray 0.
        await manager._handle_slots_update(printer.id, [], None, spools[1].id)

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-2"] is None
        assert assignments["0-3"] is None

    @pytest.mark.asyncio
    async def test_repeated_polls_do_not_drift(self, db_session, slots_env):
        """The UI polls every few seconds, so the skip has to hold indefinitely."""
        printer, spools = slots_env
        manager = PluginManager()
        await self._seed_tray_map(manager, printer, spools)

        for _ in range(5):
            await manager._handle_slots_update(printer.id, [], None, spools[1].id)

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id
        assert assignments["0-1"] == spools[1].id

    @pytest.mark.asyncio
    async def test_unassigned_multi_slot_printer_is_not_stamped_either(
        self, db_session, slots_env
    ):
        """Drivers that report no spool_id at all must not get slot 0-0 filled in."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [_tray("0-0", "Tray 1"), _tray("0-1", "Tray 2")],
            None,
            spools[0].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] is None
        assert assignments["0-1"] is None
