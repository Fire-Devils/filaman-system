import pytest
from sqlalchemy import select

from app.models import Filament, Location, Manufacturer, Spool, SpoolStatus


async def _create_manufacturer(db_session, name: str = "Test Manufacturer") -> Manufacturer:
    manufacturer = Manufacturer(name=name)
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)
    return manufacturer


async def _create_filament(
    db_session,
    manufacturer_id: int,
    designation: str = "Test PLA",
    material_type: str = "PLA",
    diameter_mm: float = 1.75,
    default_spool_weight_g: float = 250.0,
    spool_outer_diameter_mm: float | None = None,
    spool_width_mm: float | None = None,
    spool_material: str | None = None,
) -> Filament:
    filament = Filament(
        manufacturer_id=manufacturer_id,
        designation=designation,
        material_type=material_type,
        diameter_mm=diameter_mm,
        default_spool_weight_g=default_spool_weight_g,
        spool_outer_diameter_mm=spool_outer_diameter_mm,
        spool_width_mm=spool_width_mm,
        spool_material=spool_material,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)
    return filament


async def _get_status(db_session, key: str) -> SpoolStatus:
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == key))
    return result.scalar_one()


async def _create_location(
    db_session,
    name: str = "Shelf A",
    identifier: str | None = None,
) -> Location:
    location = Location(name=name, identifier=identifier)
    db_session.add(location)
    await db_session.commit()
    await db_session.refresh(location)
    return location


async def _create_spool(
    db_session,
    filament_id: int,
    status_id: int,
    **kwargs,
) -> Spool:
    spool = Spool(
        filament_id=filament_id,
        status_id=status_id,
        initial_total_weight_g=kwargs.pop("initial_total_weight_g", 1000.0),
        empty_spool_weight_g=kwargs.pop("empty_spool_weight_g", 250.0),
        remaining_weight_g=kwargs.pop("remaining_weight_g", 750.0),
        **kwargs,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


class TestLocationCRUD:
    @pytest.mark.asyncio
    async def test_create_location(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/locations",
            json={"name": "Main Shelf", "identifier": "main-shelf"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Main Shelf"
        assert data["identifier"] == "main-shelf"

    @pytest.mark.asyncio
    async def test_list_locations_paginated(self, auth_client, db_session):
        client, _ = auth_client

        await _create_location(db_session, name="Shelf A")
        await _create_location(db_session, name="Shelf B")

        response = await client.get("/api/v1/locations?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        names = {item["name"] for item in data["items"]}
        assert {"Shelf A", "Shelf B"}.issubset(names)

    @pytest.mark.asyncio
    async def test_get_location(self, auth_client, db_session):
        client, _ = auth_client

        location = await _create_location(db_session, name="Shelf Get")

        response = await client.get(f"/api/v1/locations/{location.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == location.id
        assert data["name"] == "Shelf Get"

    @pytest.mark.asyncio
    async def test_update_location(self, auth_client, db_session):
        client, csrf_token = auth_client

        location = await _create_location(db_session, name="Shelf Old")

        response = await client.patch(
            f"/api/v1/locations/{location.id}",
            json={"name": "Shelf New"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Shelf New"

    @pytest.mark.asyncio
    async def test_delete_location(self, auth_client, db_session):
        client, csrf_token = auth_client

        location = await _create_location(db_session, name="Shelf Delete")

        response = await client.delete(
            f"/api/v1/locations/{location.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Location).where(Location.id == location.id))
        assert result.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_delete_location_with_spools_conflict(self, auth_client, db_session):
        client, csrf_token = auth_client

        location = await _create_location(db_session, name="Shelf Conflict")
        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament.id, status.id, location_id=location.id)

        response = await client.delete(
            f"/api/v1/locations/{location.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"


class TestSpoolCRUD:
    @pytest.mark.asyncio
    async def test_list_spool_statuses(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/spools/statuses")

        assert response.status_code == 200
        data = response.json()
        keys = {item["key"] for item in data}
        assert {"new", "opened", "empty", "archived"}.issubset(keys)

    @pytest.mark.asyncio
    async def test_create_spool_minimal(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(
            db_session,
            manufacturer.id,
            default_spool_weight_g=275.0,
            spool_outer_diameter_mm=210.0,
            spool_width_mm=70.0,
            spool_material="Cardboard",
        )
        status = await _get_status(db_session, "new")

        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": filament.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["filament_id"] == filament.id
        assert data["status_id"] == status.id
        assert data["empty_spool_weight_g"] == 275.0
        assert data["spool_outer_diameter_mm"] == 210.0
        assert data["spool_width_mm"] == 70.0
        assert data["spool_material"] == "Cardboard"

    @pytest.mark.asyncio
    async def test_create_spool_invalid_filament(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": 999999},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "validation_error"

    @pytest.mark.asyncio
    async def test_list_spools_paginated(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament.id, status.id)

        response = await client.get("/api/v1/spools?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        assert data["total"] >= 1

    @pytest.mark.asyncio
    async def test_list_spools_filter_by_filament(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament_one = await _create_filament(db_session, manufacturer.id, designation="PLA A")
        filament_two = await _create_filament(db_session, manufacturer.id, designation="PLA B")
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament_one.id, status.id)
        await _create_spool(db_session, filament_two.id, status.id)

        response = await client.get(f"/api/v1/spools?filament_id={filament_one.id}")

        assert response.status_code == 200
        data = response.json()
        assert all(item["filament_id"] == filament_one.id for item in data["items"])

    @pytest.mark.asyncio
    async def test_get_spool_with_filament(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.get(f"/api/v1/spools/{spool.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == spool.id
        assert data["filament"]["id"] == filament.id
        assert data["filament"]["manufacturer"]["id"] == manufacturer.id

    @pytest.mark.asyncio
    async def test_update_spool(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.patch(
            f"/api/v1/spools/{spool.id}",
            json={"lot_number": "LOT-123", "purchase_price": 19.99},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["lot_number"] == "LOT-123"
        assert data["purchase_price"] == 19.99

    @pytest.mark.asyncio
    async def test_get_spool_not_found(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/spools/999999")

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_delete_spool_archives(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.delete(
            f"/api/v1/spools/{spool.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        archived_status = await _get_status(db_session, "archived")
        await db_session.refresh(spool)
        assert spool.status_id == archived_status.id

    @pytest.mark.asyncio
    async def test_permanent_delete_spool(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.delete(
            f"/api/v1/spools/{spool.id}/permanent",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Spool).where(Spool.id == spool.id))
        assert result.scalar_one_or_none() is None


class TestSpoolBulkOperations:
    @pytest.mark.asyncio
    async def test_bulk_create_spools(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)

        response = await client.post(
            "/api/v1/spools/bulk",
            json={
                "filament_id": filament.id,
                "quantity": 3,
                "rfid_uid": "rfid-1",
                "external_id": "ext-1",
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert len(data) == 3
        assert all(item["rfid_uid"] is None for item in data)
        assert all(item["external_id"] is None for item in data)

    @pytest.mark.asyncio
    async def test_bulk_update_spools(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool_one = await _create_spool(db_session, filament.id, status.id)
        spool_two = await _create_spool(db_session, filament.id, status.id)
        location = await _create_location(db_session, name="Bulk Shelf")

        response = await client.patch(
            "/api/v1/spools/bulk",
            json={
                "spool_ids": [spool_one.id, spool_two.id],
                "location_id": location.id,
                "low_weight_threshold_g": 42,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["count"] == 2

        await db_session.refresh(spool_one)
        await db_session.refresh(spool_two)
        assert spool_one.location_id == location.id
        assert spool_two.location_id == location.id
        assert spool_one.low_weight_threshold_g == 42
        assert spool_two.low_weight_threshold_g == 42

    @pytest.mark.asyncio
    async def test_bulk_delete_spools_archive(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool_one = await _create_spool(db_session, filament.id, status.id)
        spool_two = await _create_spool(db_session, filament.id, status.id)

        response = await client.request(
            "DELETE",
            "/api/v1/spools/bulk",
            json={"spool_ids": [spool_one.id, spool_two.id], "permanent": False},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["count"] == 2

        archived_status = await _get_status(db_session, "archived")
        await db_session.refresh(spool_one)
        await db_session.refresh(spool_two)
        assert spool_one.status_id == archived_status.id
        assert spool_two.status_id == archived_status.id

    @pytest.mark.asyncio
    async def test_bulk_delete_spools_permanent(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool_one = await _create_spool(db_session, filament.id, status.id)
        spool_two = await _create_spool(db_session, filament.id, status.id)

        response = await client.request(
            "DELETE",
            "/api/v1/spools/bulk",
            json={"spool_ids": [spool_one.id, spool_two.id], "permanent": True},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        result = await db_session.execute(select(Spool).where(Spool.id.in_([spool_one.id, spool_two.id])))
        assert result.scalars().all() == []


class TestSpoolEvents:
    @pytest.mark.asyncio
    async def test_record_measurement(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(
            db_session,
            filament.id,
            status.id,
            empty_spool_weight_g=200.0,
            remaining_weight_g=600.0,
        )

        response = await client.post(
            f"/api/v1/spools/{spool.id}/measurements",
            json={"measured_weight_g": 650.0},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["event_type"] == "measurement"
        assert data["measured_weight_g"] == 650.0

        await db_session.refresh(spool)
        assert spool.remaining_weight_g == 450.0

    @pytest.mark.asyncio
    async def test_record_consumption(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(
            db_session,
            filament.id,
            status.id,
            remaining_weight_g=700.0,
        )

        response = await client.post(
            f"/api/v1/spools/{spool.id}/consumptions",
            json={"delta_weight_g": 100.0},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["event_type"] == "print_consumption"
        assert data["delta_weight_g"] == -100.0

        await db_session.refresh(spool)
        assert spool.remaining_weight_g == 600.0

    @pytest.mark.asyncio
    async def test_change_status(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        new_status = await _get_status(db_session, "new")
        opened_status = await _get_status(db_session, "opened")
        spool = await _create_spool(db_session, filament.id, new_status.id)

        response = await client.post(
            f"/api/v1/spools/{spool.id}/status",
            json={"status": "opened"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["event_type"] == "opened"

        await db_session.refresh(spool)
        assert spool.status_id == opened_status.id

    @pytest.mark.asyncio
    async def test_move_location(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)
        location = await _create_location(db_session, name="Move Shelf")

        response = await client.post(
            f"/api/v1/spools/{spool.id}/move",
            json={"location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["event_type"] == "move_location"
        assert data["to_location_id"] == location.id

        await db_session.refresh(spool)
        assert spool.location_id == location.id

    @pytest.mark.asyncio
    async def test_list_spool_events(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id, empty_spool_weight_g=200.0)

        await client.post(
            f"/api/v1/spools/{spool.id}/measurements",
            json={"measured_weight_g": 500.0},
            headers={"X-CSRF-Token": csrf_token},
        )

        response = await client.get(f"/api/v1/spools/{spool.id}/events?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        assert data["total"] >= 1
        assert all(item["spool_id"] == spool.id for item in data["items"])


class TestDeviceMeasurement:
    @pytest.mark.asyncio
    async def test_device_measurement_by_rfid(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(
            db_session,
            filament.id,
            status.id,
            rfid_uid="rfid-123",
            empty_spool_weight_g=200.0,
        )

        response = await client.post(
            "/api/v1/spool-measurements",
            json={"rfid_uid": "rfid-123", "measured_weight_g": 600.0},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["event_type"] == "measurement"
        assert data["source"] == "device"

        await db_session.refresh(spool)
        assert spool.remaining_weight_g == 400.0
