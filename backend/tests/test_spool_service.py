import pytest
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.security import Principal
from app.models import Filament, Location, Manufacturer, Spool, SpoolEvent, SpoolStatus
from app.services.spool_service import SpoolService


async def _get_status(db_session, key: str) -> SpoolStatus:
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == key))
    return result.scalar_one()


async def _create_test_spool(
    db_session,
    status_key: str = "new",
    remaining_weight_g: float | None = 750.0,
    empty_spool_weight_g: float | None = None,
    filament_default_spool_weight_g: float | None = 250.0,
    rfid_uid: str | None = None,
    external_id: str | None = None,
) -> Spool:
    mfr = Manufacturer(name=f"TestMfr-{id(db_session)}-{datetime.now(timezone.utc).timestamp()}")
    db_session.add(mfr)
    await db_session.flush()

    filament = Filament(
        manufacturer_id=mfr.id,
        designation="Test PLA",
        material_type="PLA",
        diameter_mm=1.75,
        default_spool_weight_g=filament_default_spool_weight_g,
    )
    db_session.add(filament)
    await db_session.flush()

    status = await _get_status(db_session, status_key)

    spool = Spool(
        filament_id=filament.id,
        status_id=status.id,
        remaining_weight_g=remaining_weight_g,
        empty_spool_weight_g=empty_spool_weight_g,
        rfid_uid=rfid_uid,
        external_id=external_id,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)

    result = await db_session.execute(
        select(Spool)
        .where(Spool.id == spool.id)
        .options(
            selectinload(Spool.filament).selectinload(Filament.manufacturer),
            selectinload(Spool.status),
        )
    )
    return result.scalar_one()


class TestSpoolServiceGetSpool:
    @pytest.mark.asyncio
    async def test_get_spool_found(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session)

        result = await service.get_spool(spool.id)

        assert result is not None
        assert result.id == spool.id
        assert result.filament is not None
        assert result.filament.manufacturer is not None
        assert result.status is not None

    @pytest.mark.asyncio
    async def test_get_spool_not_found(self, db_session):
        service = SpoolService(db_session)

        result = await service.get_spool(999999)

        assert result is None


class TestSpoolServiceGetByIdentifier:
    @pytest.mark.asyncio
    async def test_get_by_rfid_uid(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, rfid_uid="ABC123")

        result = await service.get_spool_by_identifier(rfid_uid="ABC123", external_id=None)

        assert result is not None
        assert result.id == spool.id

    @pytest.mark.asyncio
    async def test_get_by_rfid_uid_case_insensitive(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, rfid_uid="ABC123")

        result = await service.get_spool_by_identifier(rfid_uid="abc123", external_id=None)

        assert result is not None
        assert result.id == spool.id

    @pytest.mark.asyncio
    async def test_get_by_external_id(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, external_id="EXT-42")

        result = await service.get_spool_by_identifier(rfid_uid=None, external_id="EXT-42")

        assert result is not None
        assert result.id == spool.id

    @pytest.mark.asyncio
    async def test_get_by_identifier_not_found(self, db_session):
        service = SpoolService(db_session)

        result = await service.get_spool_by_identifier(rfid_uid=None, external_id=None)

        assert result is None


class TestSpoolServiceGetTara:
    @pytest.mark.asyncio
    async def test_tara_from_spool(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=200.0)

        tara = service._get_tara(spool)

        assert tara == 200.0

    @pytest.mark.asyncio
    async def test_tara_from_filament(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=None, filament_default_spool_weight_g=250.0)

        tara = service._get_tara(spool)

        assert tara == 250.0

    @pytest.mark.asyncio
    async def test_tara_missing(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=None, filament_default_spool_weight_g=None)

        tara = service._get_tara(spool)

        assert tara is None


class TestSpoolServiceRecordMeasurement:
    @pytest.mark.asyncio
    async def test_measurement_basic(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0)
        principal = Principal(auth_type="user", user_id=1, scopes=None)
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_measurement(spool, 500.0, event_at, principal=principal)

        assert remaining == 250.0
        assert event.event_type == "measurement"
        result = await db_session.execute(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))
        events = result.scalars().all()
        assert any(e.event_type == "measurement" for e in events)

    @pytest.mark.asyncio
    async def test_measurement_clamped_to_zero(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_measurement(spool, 100.0, event_at)

        assert remaining == 0
        assert (event.meta or {})["clamped_to_zero"] is True
        result = await db_session.execute(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))
        events = result.scalars().all()
        assert any(e.event_type == "measurement" for e in events)

    @pytest.mark.asyncio
    async def test_measurement_exact_zero(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_measurement(spool, 250.0, event_at)

        assert remaining == 0
        assert event.meta is None or "clamped_to_zero" not in event.meta
        empty_status = await _get_status(db_session, "empty")
        await db_session.refresh(spool)
        assert spool.status_id == empty_status.id

    @pytest.mark.asyncio
    async def test_measurement_tara_missing(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=None, filament_default_spool_weight_g=None)
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_measurement(spool, 500.0, event_at)

        assert remaining == spool.remaining_weight_g
        assert (event.meta or {})["tara_missing"] is True

    @pytest.mark.asyncio
    async def test_measurement_auto_opens_new_spool(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0, status_key="new")
        event_at = datetime.now(timezone.utc)

        await service.record_measurement(spool, 600.0, event_at)

        opened_status = await _get_status(db_session, "opened")
        await db_session.refresh(spool)
        assert spool.status_id == opened_status.id
        result = await db_session.execute(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))
        events = result.scalars().all()
        assert any(e.event_type == "opened" for e in events)


class TestSpoolServiceRecordAdjustment:
    @pytest.mark.asyncio
    async def test_adjustment_relative(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, remaining_weight_g=750.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_adjustment(
            spool,
            "relative",
            event_at,
            delta_weight_g=-100.0,
        )

        assert remaining == 650.0
        assert event.event_type == "manual_adjust"

    @pytest.mark.asyncio
    async def test_adjustment_relative_clamp_zero(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, remaining_weight_g=50.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_adjustment(
            spool,
            "relative",
            event_at,
            delta_weight_g=-100.0,
        )

        assert remaining == 0
        assert (event.meta or {})["clamped_to_zero"] is True

    @pytest.mark.asyncio
    async def test_adjustment_absolute(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_adjustment(
            spool,
            "absolute",
            event_at,
            measured_weight_g=600.0,
        )

        assert remaining == 350.0
        assert event.event_type == "manual_adjust"

    @pytest.mark.asyncio
    async def test_adjustment_invalid_type(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session)
        event_at = datetime.now(timezone.utc)

        with pytest.raises(ValueError):
            await service.record_adjustment(spool, "bogus", event_at)


class TestSpoolServiceRecordConsumption:
    @pytest.mark.asyncio
    async def test_consumption_basic(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, remaining_weight_g=750.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_consumption(spool, 50.0, event_at)

        assert remaining == 700.0
        assert event.event_type == "print_consumption"

    @pytest.mark.asyncio
    async def test_consumption_clamp_zero(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, remaining_weight_g=30.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        event, remaining = await service.record_consumption(spool, -100.0, event_at)

        assert remaining == 0
        assert (event.meta or {})["clamped_to_zero"] is True

    @pytest.mark.asyncio
    async def test_consumption_updates_last_used(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, remaining_weight_g=750.0, status_key="opened")
        event_at = datetime.now(timezone.utc)

        await service.record_consumption(spool, -50.0, event_at)

        refreshed = await service.get_spool(spool.id)
        assert refreshed is not None
        assert refreshed.last_used_at == event_at


class TestSpoolServiceChangeStatus:
    @pytest.mark.asyncio
    async def test_change_status(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, status_key="new")
        event_at = datetime.now(timezone.utc)

        event = await service.change_status(spool, "opened", event_at)

        assert event.event_type == "opened"
        opened_status = await _get_status(db_session, "opened")
        await db_session.refresh(spool)
        assert spool.status_id == opened_status.id
        result = await db_session.execute(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))
        events = result.scalars().all()
        assert any(e.event_type == "opened" for e in events)

    @pytest.mark.asyncio
    async def test_change_status_invalid(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session)
        event_at = datetime.now(timezone.utc)

        with pytest.raises(ValueError):
            await service.change_status(spool, "nonexistent", event_at)


class TestSpoolServiceMoveLocation:
    @pytest.mark.asyncio
    async def test_move_location(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session)
        location = Location(name="Shelf A")
        db_session.add(location)
        await db_session.commit()
        await db_session.refresh(location)
        event_at = datetime.now(timezone.utc)

        event = await service.move_location(spool, location.id, event_at)

        assert event.event_type == "move_location"
        refreshed = await service.get_spool(spool.id)
        assert refreshed is not None
        assert refreshed.location_id == location.id
        result = await db_session.execute(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))
        events = result.scalars().all()
        assert any(e.event_type == "move_location" for e in events)

    @pytest.mark.asyncio
    async def test_move_location_to_none(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session)
        location = Location(name="Shelf B")
        db_session.add(location)
        await db_session.commit()
        await db_session.refresh(location)
        spool.location_id = location.id
        await db_session.commit()
        event_at = datetime.now(timezone.utc)

        await service.move_location(spool, None, event_at)

        refreshed = await service.get_spool(spool.id)
        assert refreshed is not None
        assert refreshed.location_id is None


class TestSpoolServiceChangeStatusesBulk:
    @pytest.mark.asyncio
    async def test_bulk_status_change(self, db_session):
        service = SpoolService(db_session)
        spool_a = await _create_test_spool(db_session, status_key="new")
        spool_b = await _create_test_spool(db_session, status_key="opened")
        spool_c = await _create_test_spool(db_session, status_key="empty")

        count = await service.change_statuses_bulk(
            [spool_a.id, spool_b.id, spool_c.id],
            "archived",
        )

        assert count == 3
        archived_status = await _get_status(db_session, "archived")
        await db_session.refresh(spool_a)
        await db_session.refresh(spool_b)
        await db_session.refresh(spool_c)
        assert spool_a.status_id == archived_status.id
        assert spool_b.status_id == archived_status.id
        assert spool_c.status_id == archived_status.id


class TestSpoolServiceRebuildRemainingWeight:
    @pytest.mark.asyncio
    async def test_rebuild_remaining_weight(self, db_session):
        service = SpoolService(db_session)
        spool = await _create_test_spool(db_session, empty_spool_weight_g=250.0, status_key="opened")
        principal = Principal(auth_type="user", user_id=1, scopes=None)
        event_at_1 = datetime.now(timezone.utc)
        event_at_2 = event_at_1.replace(microsecond=event_at_1.microsecond + 1)

        await service.record_measurement(spool, 600.0, event_at_1, principal=principal)
        await service.record_consumption(spool, 50.0, event_at_2, principal=principal)

        spool.remaining_weight_g = 999.0
        await db_session.commit()

        remaining = await service.rebuild_remaining_weight(spool)

        assert remaining == 300.0
        refreshed = await service.get_spool(spool.id)
        assert refreshed is not None
        assert refreshed.remaining_weight_g == 300.0
