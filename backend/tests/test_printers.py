import pytest
from sqlalchemy import event
from sqlalchemy.orm.attributes import set_committed_value
from unittest.mock import AsyncMock, patch

from app.models import Location, Printer, PrinterSlot


@pytest.fixture(autouse=True)
def mock_plugin_manager():
    with patch("app.api.v1.printers.plugin_manager") as mock_pm:
        mock_pm.start_printer = AsyncMock(return_value=True)
        mock_pm.stop_printer = AsyncMock(return_value=None)
        mock_pm.reconnect_all = AsyncMock(return_value={})
        mock_pm.drivers = {}
        yield mock_pm


@pytest.fixture(autouse=True)
def prevent_assignment_lazy_load(db_session):
    def _set_assignment(session, instance):
        if isinstance(instance, PrinterSlot):
            set_committed_value(instance, "assignment", None)

    event.listen(db_session.sync_session, "loaded_as_persistent", _set_assignment)
    yield
    event.remove(db_session.sync_session, "loaded_as_persistent", _set_assignment)


async def _create_printer(db_session, name: str = "Test Printer", driver_key: str = "bambu_mqtt", **kwargs) -> Printer:
    printer = Printer(name=name, driver_key=driver_key, **kwargs)
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


async def _create_slot(db_session, printer_id: int, slot_no: int = 1, **kwargs) -> PrinterSlot:
    slot = PrinterSlot(printer_id=printer_id, slot_no=slot_no, **kwargs)
    db_session.add(slot)
    await db_session.commit()
    await db_session.refresh(slot)
    set_committed_value(slot, "assignment", None)
    return slot


async def _create_location(db_session, name: str = "Shelf A") -> Location:
    location = Location(name=name)
    db_session.add(location)
    await db_session.commit()
    await db_session.refresh(location)
    return location


class TestPrinterCRUD:
    @pytest.mark.asyncio
    async def test_list_printers_paginated(self, auth_client, db_session):
        client, _ = auth_client

        await _create_printer(db_session, name="Printer A")
        await _create_printer(db_session, name="Printer B")

        response = await client.get("/api/v1/printers?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        names = {item["name"] for item in data["items"]}
        assert {"Printer A", "Printer B"}.issubset(names)

    @pytest.mark.asyncio
    async def test_create_printer(self, auth_client, db_session):
        client, csrf_token = auth_client
        location = await _create_location(db_session)

        response = await client.post(
            "/api/v1/printers",
            json={"name": "My Printer", "driver_key": "bambu_mqtt", "location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "My Printer"
        assert data["driver_key"] == "bambu_mqtt"
        assert data["is_active"] is True
        assert data["location_id"] == location.id

    @pytest.mark.asyncio
    async def test_create_printer_with_invalid_location(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/printers",
            json={"name": "Bad Printer", "driver_key": "bambu_mqtt", "location_id": 999999},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "validation_error"

    @pytest.mark.asyncio
    async def test_get_printer_detail(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session, name="Detail Printer")
        await _create_slot(db_session, printer.id, slot_no=1, name="Slot 1")

        response = await client.get(f"/api/v1/printers/{printer.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == printer.id
        assert data["name"] == "Detail Printer"
        assert len(data["slots"]) == 1
        assert data["slots"][0]["slot_no"] == 1

    @pytest.mark.asyncio
    async def test_get_printer_not_found(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/printers/999999")

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_update_printer(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session, name="Old Name")

        response = await client.patch(
            f"/api/v1/printers/{printer.id}",
            json={"name": "New Name"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"

    @pytest.mark.asyncio
    async def test_delete_printer_soft_delete(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session, name="Delete Printer")

        response = await client.delete(
            f"/api/v1/printers/{printer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        await db_session.refresh(printer)
        assert printer.deleted_at is not None

        list_response = await client.get("/api/v1/printers?page=1&page_size=10")
        assert list_response.status_code == 200
        items = list_response.json()["items"]
        assert printer.id not in {item["id"] for item in items}

    @pytest.mark.asyncio
    async def test_delete_printer_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.delete(
            "/api/v1/printers/999999",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"


class TestPrinterSlots:
    @pytest.mark.asyncio
    async def test_list_slots_empty(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session)

        response = await client.get(f"/api/v1/printers/{printer.id}/slots")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_slots_with_slots(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session)
        await _create_slot(db_session, printer.id, slot_no=2, name="Slot 2")
        await _create_slot(db_session, printer.id, slot_no=1, name="Slot 1")

        response = await client.get(f"/api/v1/printers/{printer.id}/slots")

        assert response.status_code == 200
        data = response.json()
        assert [item["slot_no"] for item in data] == [1, 2]

    @pytest.mark.asyncio
    async def test_list_slots_after_soft_delete(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session)
        await _create_slot(db_session, printer.id, slot_no=1)

        response = await client.delete(
            f"/api/v1/printers/{printer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204

        list_response = await client.get(f"/api/v1/printers/{printer.id}/slots")
        assert list_response.status_code == 200
        assert [item["slot_no"] for item in list_response.json()] == [1]

    @pytest.mark.asyncio
    async def test_list_slots_printer_not_found_returns_empty(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/printers/999999/slots")

        assert response.status_code == 200
        assert response.json() == []
