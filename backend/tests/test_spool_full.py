import pytest
from sqlalchemy import select

from app.models import AppSettings, Filament, SpoolEvent
from app.services.spool_service import SpoolService
from tests.test_devices import (
    _create_device,
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _device_headers,
    _get_status,
    _register_device,
)

URL = "/api/v1/devices/scale/spool-full"


async def _setup(auth_client, db_session, *, nominal=1000.0, tara=None, **spool_kwargs):
    client, csrf = auth_client
    await _create_device(db_session, device_code="ABC123")
    token, _ = await _register_device(client, "ABC123", csrf)
    manufacturer = await _create_manufacturer(db_session)
    filament = await _create_filament(db_session, manufacturer.id)
    filament.raw_material_weight_g = nominal
    await db_session.commit()
    status = await _get_status(db_session, "new")
    spool = await _create_spool(
        db_session, filament.id, status.id, empty_spool_weight_g=tara, **spool_kwargs
    )
    headers = {**_device_headers(token), "X-CSRF-Token": csrf}
    return client, csrf, headers, spool


async def _events(db_session, spool_id, event_type):
    result = await db_session.execute(
        select(SpoolEvent)
        .where(SpoolEvent.spool_id == spool_id, SpoolEvent.event_type == event_type)
        .order_by(SpoolEvent.id)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_spool_full_success_without_existing_tara(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session)
    resp = await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1230.0}, headers=headers
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["spool_id"] == spool.id
    assert data["old_tara_g"] is None
    assert data["new_tara_g"] == 230.0
    assert data["remaining_weight_g"] == 1000.0
    assert data["filament_name"] == "Test PLA"

    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 230.0
    assert spool.remaining_weight_g == 1000.0
    (event,) = await _events(db_session, spool.id, "spool_full")
    assert event.source == "device"
    assert event.device_id is not None
    assert event.measured_weight_g == 1230.0
    assert event.meta["old_tara_g"] is None
    assert event.meta["new_tara_g"] == 230.0
    assert event.meta["old_remaining_g"] == 750.0
    assert event.meta["new_remaining_g"] == 1000.0
    assert event.meta["nominal_g"] == 1000.0
    assert event.meta["core_g"] == 0.0


@pytest.mark.asyncio
async def test_spool_full_subtracts_core_and_finds_by_tag(auth_client, db_session):
    client, _, headers, spool = await _setup(
        auth_client, db_session, spool_core_weight_g=20.0, rfid_uid="aabbccdd"
    )
    resp = await client.post(
        URL, json={"tag_uuid": "AABBCCDD", "measured_weight_g": 1250.0}, headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["new_tara_g"] == 230.0
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 230.0


@pytest.mark.asyncio
async def test_spool_full_nominal_from_filament_vs_default(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session, nominal=750.0)
    resp = await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1000.0}, headers=headers
    )
    assert resp.json()["new_tara_g"] == 250.0
    assert resp.json()["remaining_weight_g"] == 750.0

    # No filament nominal weight: AppSetting default applies.
    filament = await db_session.get(Filament, spool.filament_id)
    filament.raw_material_weight_g = None
    db_session.add(AppSettings(id=1, spool_full_nominal_weight_g=500.0))
    await db_session.commit()
    resp = await client.post(
        URL,
        json={"spool_id": spool.id, "measured_weight_g": 750.0, "confirm_overwrite": True},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["new_tara_g"] == 250.0
    assert resp.json()["remaining_weight_g"] == 500.0


@pytest.mark.asyncio
async def test_spool_full_default_nominal_is_1000(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session, nominal=None)
    resp = await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1200.0}, headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["remaining_weight_g"] == 1000.0
    assert resp.json()["new_tara_g"] == 200.0


@pytest.mark.asyncio
@pytest.mark.parametrize("measured", [1050.0, 1400.0])
async def test_spool_full_tara_out_of_range(auth_client, db_session, measured):
    client, _, headers, spool = await _setup(auth_client, db_session)
    resp = await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": measured}, headers=headers
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "tara_out_of_range"
    assert detail["new_tara_g"] == measured - 1000.0
    assert detail["min_g"] == 100.0
    assert detail["max_g"] == 350.0
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g is None
    assert spool.remaining_weight_g == 750.0
    assert await _events(db_session, spool.id, "spool_full") == []


@pytest.mark.asyncio
async def test_spool_full_not_found(auth_client, db_session):
    client, _, headers, _ = await _setup(auth_client, db_session)
    resp = await client.post(
        URL, json={"spool_id": 99999, "measured_weight_g": 1200.0}, headers=headers
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_spool_full_requires_device_auth(auth_client, db_session):
    client, csrf, _, spool = await _setup(auth_client, db_session)
    resp = await client.post(
        URL,
        json={"spool_id": spool.id, "measured_weight_g": 1200.0},
        headers={"Authorization": "Device nope", "X-CSRF-Token": csrf},
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_spool_full_differs_needs_confirmation(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session, tara=200.0)
    body = {"spool_id": spool.id, "measured_weight_g": 1250.0}
    resp = await client.post(URL, json=body, headers=headers)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail == {"code": "tara_differs", "old_tara_g": 200.0, "new_tara_g": 250.0}
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 200.0
    assert spool.remaining_weight_g == 750.0
    assert await _events(db_session, spool.id, "spool_full") == []

    resp = await client.post(URL, json={**body, "confirm_overwrite": True}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["old_tara_g"] == 200.0
    assert resp.json()["new_tara_g"] == 250.0
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 250.0
    assert spool.remaining_weight_g == 1000.0


@pytest.mark.asyncio
async def test_spool_full_small_difference_needs_no_confirmation(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session, tara=200.0)
    resp = await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1205.0}, headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["new_tara_g"] == 205.0


@pytest.mark.asyncio
async def test_rebuild_applies_spool_full_and_ignores_undone(auth_client, db_session):
    client, _, headers, spool = await _setup(auth_client, db_session)
    await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1200.0}, headers=headers
    )
    service = SpoolService(db_session)
    await db_session.refresh(spool)
    await service.record_adjustment(
        spool, "relative", datetime_now(), delta_weight_g=-100.0, source="ui"
    )
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == 900.0
    spool.remaining_weight_g = 1.0
    await db_session.commit()
    assert await service.rebuild_remaining_weight(spool) == 900.0

    (event,) = await _events(db_session, spool.id, "spool_full")
    event.meta = {**event.meta, "undone": True}
    await db_session.commit()
    # Ignored spool_full: start from initial net weight (1000 - tara 200 = 800)
    # and apply the relative adjustment on top.
    result = await service.rebuild_remaining_weight(spool)
    assert result == 700.0


def datetime_now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_undo_spool_full(auth_client, db_session):
    client, csrf, headers, spool = await _setup(auth_client, db_session, tara=200.0)
    await client.post(
        URL,
        json={"spool_id": spool.id, "measured_weight_g": 1250.0, "confirm_overwrite": True},
        headers=headers,
    )
    (event,) = await _events(db_session, spool.id, "spool_full")
    undo_url = f"/api/v1/spools/{spool.id}/events/{event.id}/undo-spool-full"

    resp = await client.post(undo_url, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200
    assert resp.json()["event_type"] == "spool_full_undone"
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 200.0
    assert spool.remaining_weight_g == 750.0
    await db_session.refresh(event)
    assert event.meta["undone"] is True
    assert event.meta["undone_at"]

    resp = await client.post(undo_url, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_undone"


@pytest.mark.asyncio
async def test_undo_spool_full_restores_missing_tara(auth_client, db_session):
    client, csrf, headers, spool = await _setup(auth_client, db_session)
    await client.post(
        URL, json={"spool_id": spool.id, "measured_weight_g": 1200.0}, headers=headers
    )
    (event,) = await _events(db_session, spool.id, "spool_full")
    resp = await client.post(
        f"/api/v1/spools/{spool.id}/events/{event.id}/undo-spool-full",
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g is None
    assert spool.remaining_weight_g == 750.0


@pytest.mark.asyncio
async def test_undo_rejects_wrong_type_and_non_latest(auth_client, db_session):
    client, csrf, headers, spool = await _setup(auth_client, db_session, tara=200.0)
    filament_id, status_id = spool.filament_id, spool.status_id
    body = {"spool_id": spool.id, "measured_weight_g": 1250.0, "confirm_overwrite": True}
    await client.post(URL, json=body, headers=headers)
    await client.post(URL, json={**body, "measured_weight_g": 1240.0}, headers=headers)
    first, second = await _events(db_session, spool.id, "spool_full")
    # The app shares this session and a rejected undo rolls back, which
    # expires every loaded object. Prepare everything and read ids up front.
    other = await _create_spool(
        db_session, filament_id, status_id, empty_spool_weight_g=None
    )
    await db_session.refresh(other, ["filament"])
    service = SpoolService(db_session)
    measurement, _ = await service.record_measurement(
        other, 500.0, datetime_now(), source="ui"
    )
    other_id, measurement_id = other.id, measurement.id
    spool_id, first_id, second_id = spool.id, first.id, second.id

    resp = await client.post(
        f"/api/v1/spools/{spool_id}/events/{first_id}/undo-spool-full",
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_latest_spool_full"

    resp = await client.post(
        f"/api/v1/spools/{other_id}/events/{measurement_id}/undo-spool-full",
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_spool_full"

    resp = await client.post(
        f"/api/v1/spools/{spool_id}/events/999999/undo-spool-full",
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 404

    resp = await client.post(
        f"/api/v1/spools/{spool_id}/events/{second_id}/undo-spool-full",
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200
    await db_session.refresh(spool)
    assert spool.empty_spool_weight_g == 250.0


@pytest.mark.asyncio
async def test_spool_full_settings_roundtrip_and_validation(auth_client):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    resp = await client.get("/api/v1/admin/app-settings/")
    assert resp.status_code == 200
    assert resp.json()["spool_full_nominal_weight_g"] == 1000.0
    assert resp.json()["spool_full_tara_min_g"] == 100.0
    assert resp.json()["spool_full_tara_max_g"] == 350.0
    assert resp.json()["spool_full_overwrite_threshold_g"] == 5.0

    resp = await client.put(
        "/api/v1/admin/app-settings/",
        json={
            "spool_full_nominal_weight_g": 750,
            "spool_full_tara_min_g": 80,
            "spool_full_tara_max_g": 300,
            "spool_full_overwrite_threshold_g": 10,
        },
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["spool_full_nominal_weight_g"] == 750.0
    assert resp.json()["spool_full_overwrite_threshold_g"] == 10.0

    resp = await client.put(
        "/api/v1/admin/app-settings/",
        json={"spool_full_tara_min_g": 400},
        headers=headers,
    )
    assert resp.status_code == 422
