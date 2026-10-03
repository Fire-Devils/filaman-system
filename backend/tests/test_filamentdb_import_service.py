from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.core.cache import response_cache
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.filamentdb_import_service import (
    FilamentDBImportService,
    ImportResult,
    SyncSnapshot,
)
from sqlalchemy import delete, select

# ------------------------------------------------------------------ #
#  Fixtures
# ------------------------------------------------------------------ #


def _make_sync_payload() -> dict:
    """Minimal valid sync payload from FilamentDB."""
    return {
        "synced_at": "2026-01-01T00:00:00Z",
        "manufacturers": [],
        "filaments": [],
        "materials": [],
        "spool_profiles": [],
        "colors": [],
    }


def _mock_httpx_response(payload: dict):
    """Create a mock httpx response that returns *payload* as JSON."""
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = payload
    return resp


@pytest.fixture(autouse=True)
def _clear_cache():
    """Ensure the global response_cache is clean before and after each test."""
    response_cache.clear()
    yield
    response_cache.clear()


# ------------------------------------------------------------------ #
#  Snapshot caching tests
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_fetch_sync_data_caches_snapshot(db_session):
    """After one fetch the snapshot should be cached; a second call with the
    same snapshot_id must NOT trigger another HTTP request."""
    service = FilamentDBImportService(db_session)
    payload = _make_sync_payload()

    mock_resp = _mock_httpx_response(payload)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.filamentdb_import_service.httpx.AsyncClient",
        return_value=mock_client,
    ):
        # First call — should hit the network
        snap1 = await service._fetch_sync_data()
        assert snap1.snapshot_id
        assert mock_client.get.call_count == 1

        # Second call with same snapshot_id — should use cache
        snap2 = await service._fetch_sync_data(snapshot_id=snap1.snapshot_id)
        assert snap2.snapshot_id == snap1.snapshot_id
        assert mock_client.get.call_count == 1  # No additional HTTP call


@pytest.mark.asyncio
async def test_fetch_sync_data_force_refresh_bypasses_cache(db_session):
    """force_refresh=True must always fetch fresh data from the API,
    even if a cached snapshot exists."""
    service = FilamentDBImportService(db_session)
    payload = _make_sync_payload()

    mock_resp = _mock_httpx_response(payload)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.filamentdb_import_service.httpx.AsyncClient",
        return_value=mock_client,
    ):
        snap1 = await service._fetch_sync_data()
        assert mock_client.get.call_count == 1

        # force_refresh — should hit the network again
        snap2 = await service._fetch_sync_data(force_refresh=True)
        assert mock_client.get.call_count == 2
        # New snapshot gets a different ID
        assert snap2.snapshot_id != snap1.snapshot_id


@pytest.mark.asyncio
async def test_fetch_sync_data_cache_miss_on_unknown_snapshot_id(db_session):
    """Requesting a snapshot_id that is not in the cache must fetch fresh data."""
    service = FilamentDBImportService(db_session)
    payload = _make_sync_payload()

    mock_resp = _mock_httpx_response(payload)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.filamentdb_import_service.httpx.AsyncClient",
        return_value=mock_client,
    ):
        snap1 = await service._fetch_sync_data()
        assert mock_client.get.call_count == 1

        # Request with a wrong snapshot_id
        snap2 = await service._fetch_sync_data(snapshot_id="nonexistent-id")
        assert mock_client.get.call_count == 2
        assert snap2.snapshot_id != snap1.snapshot_id


@pytest.mark.asyncio
async def test_fetch_sync_data_no_snapshot_id_returns_cached(db_session):
    """Calling without snapshot_id should return the cached snapshot
    (if one exists) — no network hit."""
    service = FilamentDBImportService(db_session)
    payload = _make_sync_payload()

    mock_resp = _mock_httpx_response(payload)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.filamentdb_import_service.httpx.AsyncClient",
        return_value=mock_client,
    ):
        snap1 = await service._fetch_sync_data()
        assert mock_client.get.call_count == 1

        # No snapshot_id given — should still return cached
        snap2 = await service._fetch_sync_data()
        assert snap2.snapshot_id == snap1.snapshot_id
        assert mock_client.get.call_count == 1


@pytest.mark.asyncio
async def test_fetch_sync_data_returns_deepcopy(db_session):
    """Each call must return a deep copy so mutations in one step
    don't corrupt data for subsequent steps."""
    service = FilamentDBImportService(db_session)
    payload = _make_sync_payload()
    payload["manufacturers"] = [{"id": 1, "name": "TestMfr"}]

    mock_resp = _mock_httpx_response(payload)
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.filamentdb_import_service.httpx.AsyncClient",
        return_value=mock_client,
    ):
        snap1 = await service._fetch_sync_data()
        # Mutate the returned data
        snap1.data["manufacturers"][0]["_exists"] = True
        snap1.data["manufacturers"].append({"id": 99, "name": "Injected"})

        # Second read must NOT see the mutations
        snap2 = await service._fetch_sync_data(snapshot_id=snap1.snapshot_id)
        assert len(snap2.data["manufacturers"]) == 1
        assert "_exists" not in snap2.data["manufacturers"][0]


# ------------------------------------------------------------------ #
#  Regression: stale filament_colors rows
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_import_and_update_use_standard_temperature_ranges(db_session):
    manufacturer = Manufacturer(name="Temperature Manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    service = FilamentDBImportService(db_session)
    base = {
        "id": 71,
        "manufacturer_id": 5,
        "material_id": 6,
        "designation": "Temperature PLA",
        "temp_nozzle_min": 190,
        "temp_nozzle_max": 230,
        "temp_bed": 60,
        "sku": "PLA-42",
        "datasheet_url": "https://example.com/pla.pdf",
        "discontinued": True,
        "dry_temp": 55,
        "dry_time_hours": 6,
        "softening_temp": 65,
        "fan_speed_min": 40,
        "fan_speed_max": 80,
        "chamber_temp": 35,
        "max_volumetric_speed": 18,
        "flow_ratio": 0.97,
        "k_value": 0.025,
        "ams_compatible": "ams,ams-2-pro",
        "build_plates": "pei,textured-pei",
        "currency": "EUR",
        "shop_url": "https://example.com/pla",
    }

    await service._import_filaments(
        [base],
        {6: "PLA"},
        {5: manufacturer.id},
        {},
        {},
        "filament",
        ImportResult(),
    )
    filament = await db_session.scalar(select(Filament))
    assert filament is not None
    assert filament.extruder_temp_range_c == {"min": 190, "max": 230}
    assert filament.bed_temp_range_c == {"min": 60, "max": 60}
    assert filament.manufacturer_sku == "PLA-42"
    assert filament.datasheet_url == "https://example.com/pla.pdf"
    assert filament.is_discontinued is True
    assert filament.drying_temp_c == 55
    assert filament.drying_time_hours == 6
    assert filament.softening_temp_c == 65
    assert filament.cooling_fan_range_percent == {"min": 40, "max": 80}
    assert filament.chamber_temp_c == 35
    assert filament.max_volumetric_speed_mm3_s == 18
    assert filament.flow_ratio == 0.97
    assert filament.pressure_advance_k == 0.025
    assert filament.ams_compatibility == ["ams", "ams-2-pro"]
    assert filament.build_plate_compatibility == ["pei", "textured-pei"]
    assert filament.price_currency == "EUR"
    assert filament.shop_url == "https://example.com/pla"
    for key in (
        "sku",
        "dry_temp",
        "dry_time_hours",
        "softening_temp",
        "fan_speed_min",
        "fan_speed_max",
        "chamber_temp",
        "max_volumetric_speed",
        "flow_ratio",
        "k_value",
    ):
        assert key not in filament.custom_fields
    assert "temp_nozzle_min" not in filament.custom_fields
    assert "temp_nozzle_max" not in filament.custom_fields
    assert "temp_bed" not in filament.custom_fields

    filament.custom_fields = {
        **filament.custom_fields,
        "temp_nozzle_min": 190,
        "temp_nozzle_max": 230,
        "temp_bed": 60,
    }
    await db_session.commit()

    await service._import_filaments(
        [
            {
                **base,
                "temp_nozzle_min": 200,
                "temp_nozzle_max": 240,
                "temp_bed": 70,
                "shop_url": "https://example.com/pla-v2",
            }
        ],
        {6: "PLA"},
        {5: manufacturer.id},
        {},
        {},
        "filament",
        ImportResult(),
        update_filament_ids=[71],
    )
    await db_session.refresh(filament)
    assert filament.extruder_temp_range_c == {"min": 200, "max": 240}
    assert filament.bed_temp_range_c == {"min": 70, "max": 70}
    assert filament.shop_url == "https://example.com/pla-v2"
    assert "temp_nozzle_min" not in filament.custom_fields
    assert "temp_nozzle_max" not in filament.custom_fields
    assert "temp_bed" not in filament.custom_fields


@pytest.mark.asyncio
async def test_diff_offers_standard_field_backfill_for_linked_filament(db_session):
    manufacturer = Manufacturer(name="Temperature Manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    db_session.add(
        Filament(
            manufacturer_id=manufacturer.id,
            designation="Temperature PLA",
            material_type="PLA",
            diameter_mm=1.75,
            color_mode="single",
            custom_fields={"filamentdb_id": 71},
        )
    )
    await db_session.flush()

    service = FilamentDBImportService(db_session)
    service._fetch_sync_data = AsyncMock(
        return_value=SyncSnapshot(
            snapshot_id="temperatures",
            synced_at=None,
            data={
                "manufacturers": [{"id": 5, "name": manufacturer.name}],
                "materials": [{"id": 6, "key": "PLA"}],
                "spool_profiles": [],
                "filaments": [
                    {
                        "id": 71,
                        "manufacturer_id": 5,
                        "material_id": 6,
                        "designation": "Temperature PLA",
                        "diameter_mm": 1.75,
                        "color_mode": "single",
                        "temp_nozzle_min": 190,
                        "temp_nozzle_max": 230,
                        "temp_bed": 60,
                        "sku": "TEMP-PLA",
                        "dry_temp": 55,
                        "fan_speed_min": 40,
                        "fan_speed_max": 80,
                        "ams_compatible": ["ams"],
                        "shop_url": "https://example.com/temperature-pla",
                    }
                ],
            },
        )
    )

    [result] = (await service.diff_filaments([71])).results
    assert {change["field"] for change in result["changes"]} == {
        "extruder_temp_range_c",
        "bed_temp_range_c",
        "manufacturer_sku",
        "drying_temp_c",
        "cooling_fan_range_percent",
        "ams_compatibility",
        "shop_url",
    }


@pytest.mark.asyncio
async def test_create_filament_colors_replaces_stale_rows_for_reused_filament_ids(
    db_session,
):
    """Regression: stale filament_colors rows from a deleted filament must not
    collide with new color assignments when SQLite reuses the same filament ID."""
    manufacturer = Manufacturer(name="Test Manufacturer")
    old_color = Color(name="Legacy Red", hex_code="#ff0000")
    new_color = Color(name="Silk Blue", hex_code="#0000ff")
    db_session.add_all([manufacturer, old_color, new_color])
    await db_session.flush()

    original_filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Original",
        material_type="pla",
        diameter_mm=1.75,
        color_mode="single",
    )
    db_session.add(original_filament)
    await db_session.flush()

    reused_filament_id = original_filament.id
    db_session.add(
        FilamentColor(
            filament_id=reused_filament_id,
            color_id=old_color.id,
            position=1,
            display_name_override="Legacy Red",
        )
    )
    await db_session.commit()

    # Delete the filament but leave the filament_colors row behind
    # (simulates missing CASCADE enforcement in older SQLite DBs)
    await db_session.execute(delete(Filament).where(Filament.id == reused_filament_id))
    await db_session.commit()

    # Create a replacement filament that reuses the same ID
    replacement_filament = Filament(
        id=reused_filament_id,
        manufacturer_id=manufacturer.id,
        designation="Replacement",
        material_type="pla",
        diameter_mm=1.75,
        color_mode="multi",
    )
    db_session.add(replacement_filament)
    await db_session.flush()

    # This must NOT raise IntegrityError even though stale rows exist
    service = FilamentDBImportService(db_session)
    await service._create_filament_colors(
        replacement_filament.id,
        {
            "colors": [
                {
                    "hex_code": "#0000ff",
                    "position": 1,
                    "color_name": "Silk Blue",
                }
            ]
        },
        {"#0000ff": new_color.id},
    )
    await db_session.commit()

    result = await db_session.execute(
        select(FilamentColor)
        .where(FilamentColor.filament_id == replacement_filament.id)
        .order_by(FilamentColor.position)
    )
    colors = result.scalars().all()

    assert len(colors) == 1
    assert colors[0].color_id == new_color.id
    assert colors[0].position == 1
    assert colors[0].display_name_override == "Silk Blue"
