import pytest
from datetime import datetime
from httpx import AsyncClient

from app.core.security import hash_password, generate_token_secret
from app.models import (
    User, Filament, Manufacturer, Spool, SpoolStatus, SpoolEvent,
    UserSession, Location
)
from sqlalchemy import select


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
async def test_status(db_session):
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == "new"))
    status = result.scalar_one_or_none()
    if not status:
        status = SpoolStatus(key="new", label="New")
        db_session.add(status)
        await db_session.commit()
        await db_session.refresh(status)
    return status


@pytest.fixture
async def test_spool(db_session, test_filament, test_status):
    spool = Spool(
        filament_id=test_filament.id,
        status_id=test_status.id,
        initial_total_weight_g=1000.0,
        empty_spool_weight_g=250.0,
        remaining_weight_g=750.0,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


class TestSpoolMeasurementPolicies:
    @pytest.mark.asyncio
    async def test_measurement_updates_remaining(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/measurements",
            json={"measured_weight_g": 500.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["measured_weight_g"] == 500.0
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 500.0

    @pytest.mark.asyncio
    async def test_measurement_without_tara_stores_event_only(
        self, auth_client, db_session, test_filament, test_status
    ):
        client, csrf_token = auth_client
        
        spool = Spool(
            filament_id=test_filament.id,
            status_id=test_status.id,
            initial_total_weight_g=None,
            empty_spool_weight_g=None,
            remaining_weight_g=None,
        )
        db_session.add(spool)
        await db_session.commit()
        await db_session.refresh(spool)
        
        response = await client.post(
            f"/api/v1/spools/{spool.id}/measurements",
            json={"measured_weight_g": 500.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(spool)
        assert spool.remaining_weight_g is None

    @pytest.mark.asyncio
    async def test_measurement_clamps_to_zero(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/measurements",
            json={"measured_weight_g": 100.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 100.0

    @pytest.mark.asyncio
    async def test_measurement_zero_sets_empty_status(
        self, auth_client, db_session, test_spool, test_filament
    ):
        client, csrf_token = auth_client
        
        empty_status = SpoolStatus(key="empty", label="Empty")
        db_session.add(empty_status)
        await db_session.commit()
        await db_session.refresh(empty_status)
        
        test_spool.empty_spool_weight_g = 250.0
        await db_session.commit()
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/measurements",
            json={"measured_weight_g": 250.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 0.0


class TestSpoolAdjustmentPolicies:
    @pytest.mark.asyncio
    async def test_relative_adjustment(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/adjustments",
            json={
                "adjustment_type": "relative",
                "delta_weight_g": -50.0,
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 700.0

    @pytest.mark.asyncio
    async def test_absolute_adjustment(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/adjustments",
            json={
                "adjustment_type": "absolute",
                "measured_weight_g": 600.0,
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 600.0

    @pytest.mark.asyncio
    async def test_tara_adjustment(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/adjustments",
            json={
                "adjustment_type": "tare",
                "measured_weight_g": 250.0,
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.empty_spool_weight_g == 250.0


class TestSpoolConsumption:
    @pytest.mark.asyncio
    async def test_consumption_reduces_remaining(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/consumptions",
            json={"delta_weight_g": 100.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 650.0

    @pytest.mark.asyncio
    async def test_consumption_clamps_at_zero(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/consumptions",
            json={"delta_weight_g": 800.0},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.remaining_weight_g == 0.0


class TestSpoolStatusChange:
    @pytest.mark.asyncio
    async def test_status_change(self, auth_client, db_session, test_spool):
        client, csrf_token = auth_client
        
        opened_status = SpoolStatus(key="opened", label="Opened")
        db_session.add(opened_status)
        await db_session.commit()
        await db_session.refresh(opened_status)
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/status",
            json={"status": "opened"},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.status_id == opened_status.id


class TestSpoolMove:
    @pytest.mark.asyncio
    async def test_move_to_location(
        self, auth_client, db_session, test_spool
    ):
        client, csrf_token = auth_client
        
        location = Location(name="Shelf A")
        db_session.add(location)
        await db_session.commit()
        await db_session.refresh(location)
        
        response = await client.post(
            f"/api/v1/spools/{test_spool.id}/move",
            json={"location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )
        
        assert response.status_code == 200
        
        await db_session.refresh(test_spool)
        assert test_spool.location_id == location.id
