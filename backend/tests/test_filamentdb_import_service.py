from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy import delete, select

import pytest

from app.core.cache import response_cache
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.filamentdb_import_service import (
    SYNC_CACHE_KEY,
    FilamentDBImportService,
    SyncSnapshot,
)


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
