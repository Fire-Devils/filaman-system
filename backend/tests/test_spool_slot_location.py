"""Moving a spool onto a printer-slot location triggers the driver assignment."""

import pytest
from unittest.mock import AsyncMock, patch

from app.models import Filament, Location, Manufacturer, Printer, Spool, SpoolStatus
from app.services.printer_slot_location import (
    SlotLocationRef,
    build_slot_filament_data,
    resolve_slot_location,
)
from sqlalchemy import select


class _FakeDriver:
    """Mirrors the BambuLab/Bambuddy signature (no spool_id parameter)."""

    def __init__(self):
        self.calls = []

    def send_filament_to_tray(
        self, ams_id: int, tray_id: int, filament_data: dict
    ) -> None:
        self.calls.append(
            {"ams_id": ams_id, "tray_id": tray_id, "filament_data": filament_data}
        )


@pytest.fixture
def fake_driver():
    """Register a driver on the primary worker and pass filament_data through."""
    driver = _FakeDriver()

    async def _passthrough(spool_id, printer_id, filament_data):
        return filament_data

    with (
        patch("app.api.v1.printers._is_primary_worker", return_value=True),
        patch("app.api.v1.printers.plugin_manager") as printers_pm,
        patch("app.services.printer_slot_location.plugin_manager") as service_pm,
    ):
        printers_pm.drivers = {}
        printers_pm.enrich_filament_data = AsyncMock(side_effect=_passthrough)
        service_pm.enrich_filament_data = AsyncMock(side_effect=_passthrough)
        driver.registry = printers_pm.drivers
        yield driver


async def _create_printer(db_session, name: str = "Bambu P1S") -> Printer:
    printer = Printer(name=name, driver_key="bambulab")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


async def _create_location(
    db_session,
    name: str = "Shelf A",
    identifier: str | None = None,
    custom_fields: dict | None = None,
) -> Location:
    location = Location(name=name, identifier=identifier, custom_fields=custom_fields)
    db_session.add(location)
    await db_session.commit()
    await db_session.refresh(location)
    return location


async def _create_slot_location(db_session, printer_id: int, ams_id=0, tray_id=1):
    return await _create_location(
        db_session,
        name=f"Bambu P1S - AMS A{ams_id + 1}",
        identifier=f"bambulab_{printer_id}_{ams_id}_{tray_id}",
        custom_fields={"managed_by": "bambulab_plugin", "printer_id": printer_id},
    )


async def _create_spool(db_session) -> Spool:
    manufacturer = Manufacturer(name="Test Manufacturer")
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)

    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Test PLA",
        material_type="PETG",
        diameter_mm=1.75,
        default_spool_weight_g=250.0,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)

    result = await db_session.execute(
        select(SpoolStatus).where(SpoolStatus.key == "new")
    )
    status = result.scalar_one()

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
    return spool


class TestResolveSlotLocation:
    @pytest.mark.asyncio
    async def test_tagged_location_resolves_to_slot(self, db_session):
        printer = await _create_printer(db_session)
        location = await _create_slot_location(db_session, printer.id, ams_id=2, tray_id=3)

        ref = await resolve_slot_location(db_session, location.id)

        assert ref == SlotLocationRef(printer_id=printer.id, ams_id=2, tray_id=3)

    @pytest.mark.asyncio
    async def test_none_location_returns_none(self, db_session):
        assert await resolve_slot_location(db_session, None) is None

    @pytest.mark.asyncio
    async def test_plain_location_returns_none(self, db_session):
        location = await _create_location(db_session, name="Shelf A")

        assert await resolve_slot_location(db_session, location.id) is None

    @pytest.mark.asyncio
    async def test_rfid_tag_identifier_returns_none(self, db_session):
        """Location.identifier doubles as the RFID tag UUID — must not match."""
        location = await _create_location(
            db_session, name="Shelf A", identifier="04A1B2C3D4E5F6"
        )

        assert await resolve_slot_location(db_session, location.id) is None

    @pytest.mark.asyncio
    async def test_missing_managed_by_returns_none(self, db_session):
        printer = await _create_printer(db_session)
        location = await _create_location(
            db_session,
            name="Bambu P1S - AMS A1",
            identifier=f"bambulab_{printer.id}_0_0",
            custom_fields={"printer_id": printer.id},
        )

        assert await resolve_slot_location(db_session, location.id) is None

    @pytest.mark.asyncio
    async def test_printer_id_mismatch_returns_none(self, db_session):
        printer = await _create_printer(db_session)
        location = await _create_location(
            db_session,
            name="Bambu P1S - AMS A1",
            identifier=f"bambulab_{printer.id}_0_0",
            custom_fields={
                "managed_by": "bambulab_plugin",
                "printer_id": printer.id + 99,
            },
        )

        assert await resolve_slot_location(db_session, location.id) is None


class TestBuildSlotFilamentData:
    @pytest.mark.asyncio
    async def test_defaults_from_spool(self, db_session, fake_driver):
        spool = await _create_spool(db_session)

        data = await build_slot_filament_data(db_session, spool.id, printer_id=1)

        assert data["material_type"] == "PETG"
        assert data["color"] == "FFFFFF"
        assert data["tray_info_idx"] == "GFL99"
        assert data["nozzle_temp_min"] == 190
        assert data["nozzle_temp_max"] == 230

    @pytest.mark.asyncio
    async def test_printer_params_are_mapped_onto_driver_fields(self, db_session):
        """enrich_filament_data() copies bambu_* verbatim; the mapping is ours."""
        spool = await _create_spool(db_session)

        async def _enrich(spool_id, printer_id, filament_data):
            return {
                **filament_data,
                "bambu_idx": "GFA00",
                "bambu_nozzle_temp_min": "210",
                "bambu_nozzle_temp_max": "240",
            }

        with patch("app.services.printer_slot_location.plugin_manager") as pm:
            pm.enrich_filament_data = AsyncMock(side_effect=_enrich)
            data = await build_slot_filament_data(db_session, spool.id, printer_id=1)

        assert data["tray_info_idx"] == "GFA00"
        assert data["nozzle_temp_min"] == 210
        assert data["nozzle_temp_max"] == 240


class TestMoveTriggersSlotAssignment:
    @pytest.mark.asyncio
    async def test_plain_location_does_not_touch_driver(
        self, auth_client, db_session, fake_driver
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session)
        fake_driver.registry[printer.id] = fake_driver
        spool = await _create_spool(db_session)
        location = await _create_location(db_session, name="Shelf A")

        response = await client.post(
            f"/api/v1/spools/{spool.id}/move",
            json={"location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert fake_driver.calls == []
        await db_session.refresh(spool)
        assert spool.location_id == location.id

    @pytest.mark.asyncio
    async def test_slot_location_assigns_and_moves(
        self, auth_client, db_session, fake_driver
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session)
        fake_driver.registry[printer.id] = fake_driver
        spool = await _create_spool(db_session)
        location = await _create_slot_location(
            db_session, printer.id, ams_id=0, tray_id=1
        )

        response = await client.post(
            f"/api/v1/spools/{spool.id}/move",
            json={"location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert response.json()["event_type"] == "move_location"

        assert len(fake_driver.calls) == 1
        call = fake_driver.calls[0]
        assert call["ams_id"] == 0
        assert call["tray_id"] == 1
        assert call["filament_data"]["material_type"] == "PETG"

        await db_session.refresh(spool)
        assert spool.location_id == location.id

    @pytest.mark.asyncio
    async def test_driver_not_running_aborts_the_whole_move(
        self, auth_client, db_session, fake_driver
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session)
        # Driver deliberately not registered
        spool = await _create_spool(db_session)
        location = await _create_slot_location(db_session, printer.id)

        response = await client.post(
            f"/api/v1/spools/{spool.id}/move",
            json={"location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "driver_not_running"

        await db_session.refresh(spool)
        assert spool.location_id is None

    @pytest.mark.asyncio
    async def test_service_move_from_driver_does_not_feed_back(
        self, db_session, fake_driver
    ):
        """Plugins call move_location(source="driver") themselves — no loop."""
        from datetime import datetime, timezone

        from app.services.spool_service import SpoolService

        printer = await _create_printer(db_session)
        fake_driver.registry[printer.id] = fake_driver
        spool = await _create_spool(db_session)
        location = await _create_slot_location(db_session, printer.id)

        await SpoolService(db_session).move_location(
            spool,
            location.id,
            datetime.now(timezone.utc),
            source="driver",
        )

        assert fake_driver.calls == []
