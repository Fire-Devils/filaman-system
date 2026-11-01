import copy
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.core.cache import response_cache
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.filamentdb_import_service import (
    SYNC_CACHE_KEY,
    FilamentDBImportService,
    ImportResult,
    SyncSnapshot,
    _material_type_from_fdb,
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


@pytest.mark.asyncio
@pytest.mark.parametrize('target', ['filament', 'both', 'spool'])
async def test_import_retains_filament_spool_image_for_every_packaging_target(db_session, target):
    manufacturer = Manufacturer(name='Photo Brand')
    db_session.add(manufacturer)
    await db_session.flush()
    service = FilamentDBImportService(db_session)
    record = {'id': 71, 'manufacturer_id': 5, 'material_id': 6, 'designation': 'PLA', 'spool_profile_id': 735}
    await service._import_filaments([record], {6: 'PLA'}, {5: manufacturer.id}, {}, {735: {'id': 735, 'image_file': '735.png', 'empty_weight_g': 170}}, target, ImportResult())
    filament = await db_session.scalar(select(Filament))
    assert filament.filamentdb_spool_image_file == '735.png'
    await service._import_filaments([record], {6: 'PLA'}, {5: manufacturer.id}, {}, {735: {'id': 735, 'image_file': None}}, target, ImportResult(), update_filament_ids=[71])
    await db_session.refresh(filament)
    assert filament.filamentdb_spool_image_file is None


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
async def test_catalog_consumers_copy_only_returned_rows_and_isolate_nested_data(
    db_session, monkeypatch
):
    payload = _make_sync_payload()
    payload["manufacturers"] = [{"id": 1, "name": "Brand", "metadata": {"tags": []}}]
    payload["materials"] = [{"id": 2, "key": "PLA", "metadata": {"tags": []}}]
    payload["spool_profiles"] = [{"id": 3, "metadata": {"tags": []}}]
    payload["filaments"] = [
        {
            "id": index,
            "manufacturer_id": 1 if index == 1 else 99,
            "designation": f"PLA {index}",
            "material_id": 2,
            "ams_compatible": ["ams"],
            "colors": [{"hex_code": "#ff0000", "color_name": "Red"}],
            "spool_profile": {"id": 3, "metadata": {"tags": []}},
        }
        for index in range(1, 101)
    ]
    manufacturer = Manufacturer(name="Brand")
    db_session.add(manufacturer)
    await db_session.flush()
    db_session.add(
        Filament(
            manufacturer_id=manufacturer.id,
            designation="PLA 1",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"filamentdb_id": 1},
        )
    )
    await db_session.flush()
    original = copy.deepcopy(payload)
    response_cache.set(SYNC_CACHE_KEY, {"snapshot_id": "catalog", "data": payload})
    copied = []
    copied_filaments = []
    filament_objects = {id(row) for row in payload["filaments"]}
    deepcopy = copy.deepcopy

    def count_filaments(value):
        if id(value) in filament_objects:
            copied_filaments.append(value)
        elif isinstance(value, dict):
            for child in value.values():
                count_filaments(child)
        elif isinstance(value, list):
            for child in value:
                count_filaments(child)

    def record_copy(value):
        copied.append(value)
        count_filaments(value)
        return deepcopy(value)

    monkeypatch.setattr(
        "app.services.filamentdb_import_service.copy.deepcopy", record_copy
    )
    service = FilamentDBImportService(db_session)
    manufacturers = await service.preview_manufacturers(snapshot_id="catalog")
    selected = await service.fetch_filaments([1], snapshot_id="catalog")
    diff = await service.diff_filaments([1], snapshot_id="catalog")
    compatibility = next(
        change
        for change in diff.results[0]["changes"]
        if change["field"] == "ams_compatibility"
    )
    compatibility["new"].append("changed")
    assert manufacturers.total_filaments == 100
    assert manufacturers.manufacturers[0]["_filament_count"] == 1
    assert len(selected.filaments) == 1
    assert selected.filaments[0]["_material_key"] == "PLA"
    assert not any(
        value is payload or value is payload["filaments"] for value in copied
    )
    assert len(copied_filaments) == 1
    assert copied_filaments[0] is payload["filaments"][0]
    assert payload == original

    manufacturers.manufacturers[0]["metadata"]["tags"].append("changed")
    manufacturers.materials[0]["metadata"]["tags"].append("changed")
    selected.filaments[0]["colors"][0]["color_name"] = "changed"
    selected.filaments[0]["spool_profile"]["metadata"]["tags"].append("changed")
    preview = await service.preview(snapshot_id="catalog")
    assert preview.manufacturers[0]["metadata"]["tags"] == []
    assert preview.filaments[0]["colors"][0]["color_name"] == "Red"
    preview.manufacturers[0]["metadata"]["tags"].append("changed")
    preview.materials[0]["metadata"]["tags"].append("changed")
    preview.filaments[0]["colors"][0]["color_name"] = "changed"
    preview.spool_profiles[0]["metadata"]["tags"].append("changed")
    assert payload == original
    again = await service.fetch_filaments([1], snapshot_id="catalog")
    assert again.filaments[0]["colors"][0]["color_name"] == "Red"


# ------------------------------------------------------------------ #
#  Regression: stale filament_colors rows
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("currency", "expected"),
    [("usd", "USD"), (" eUr ", "EUR"), ("EURO", None), (123, None)],
    ids=["lowercase", "whitespace", "invalid-code", "invalid-type"],
)
async def test_catalog_currency_import_and_update_remain_readable(
    db_session, auth_client, currency, expected
):
    client, _ = auth_client
    manufacturer = Manufacturer(name="Currency Manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    service = FilamentDBImportService(db_session)
    record = {"id": 71, "manufacturer_id": 5, "material_id": 6,
              "designation": "Currency PLA", "currency": currency}
    args = ([record], {6: "PLA"}, {5: manufacturer.id}, {}, {}, "filament")
    await service._import_filaments(*args, ImportResult())
    await db_session.commit()
    filament = await db_session.scalar(select(Filament))
    response = await client.get(f"/api/v1/filaments/{filament.id}")
    assert response.status_code == 200
    assert response.json()["price_currency"] == expected
    if expected is None:
        assert response.json()["custom_fields"]["currency"] == currency
    filament.price_currency = "GBP"
    await db_session.commit()
    await service._import_filaments(*args, ImportResult(), update_filament_ids=[71])
    await db_session.commit()
    response = await client.get(f"/api/v1/filaments/{filament.id}")
    assert response.status_code == 200
    assert response.json()["price_currency"] == (expected or "GBP")
    if expected is None:
        assert response.json()["custom_fields"]["currency"] == currency
    else:
        assert "currency" not in response.json()["custom_fields"]


@pytest.mark.asyncio
@pytest.mark.parametrize("currency", ["USD", "EURO"], ids=["native", "unsupported"])
async def test_catalog_update_preserves_unrelated_custom_fields(db_session, currency):
    manufacturer = Manufacturer(name="Custom field owner")
    db_session.add(manufacturer)
    await db_session.flush()
    custom = {
        "filamentdb_id": 71, "currency": False, "datasheet_url": "Internal note",
        "temp_nozzle_min": "Lab minimum", "temp_nozzle_max": "Lab maximum",
        "temp_bed": False, "fan_speed_min": False, "fan_speed_max": True,
    }
    definitions = {
        "currency": {"label": "Payment verified", "field_type": "checkbox"},
        "datasheet_url": {"label": "Internal reference", "field_type": "text"},
        "temp_nozzle_min": {"label": "Lab note", "field_type": "text"},
        "fan_speed_min": {"label": "Fan verified", "field_type": "checkbox"},
    }
    native = currency == "USD"
    filament = Filament(
        manufacturer_id=manufacturer.id, designation="Custom PLA", material_type="PLA",
        diameter_mm=1.75, price_currency="GBP", custom_fields=custom, custom_field_definitions=definitions,
    )
    db_session.add(filament)
    await db_session.commit()
    await FilamentDBImportService(db_session)._import_filaments(
        [{"id": 71, "manufacturer_id": 5, "material_id": 6,
          "designation": "Custom PLA", "currency": currency,
          "datasheet_url": "https://example.test/catalog.pdf",
          "temp_nozzle_min": 190 if native else "Unavailable", "temp_nozzle_max": 220,
          "temp_bed": 60 if native else "Unavailable",
          "fan_speed_min": 20 if native else False, "fan_speed_max": 80}],
        {6: "PLA"}, {5: manufacturer.id}, {}, {}, "filament", ImportResult(),
        update_filament_ids=[71],
    )
    await db_session.commit()
    await db_session.refresh(filament)
    assert filament.price_currency == ("USD" if currency == "USD" else "GBP")
    assert filament.datasheet_url == "https://example.test/catalog.pdf"
    assert filament.extruder_temp_range_c == ({"min": 190, "max": 220} if native else None)
    assert filament.bed_temp_range_c == ({"min": 60, "max": 60} if native else None)
    assert filament.cooling_fan_range_percent == ({"min": 20, "max": 80} if native else None)
    assert filament.custom_fields == custom
    assert filament.custom_field_definitions == definitions


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
    # Reintroduced record extras are not proof of catalog ownership.
    assert filament.custom_fields == {
        "filamentdb_id": 71, "temp_nozzle_min": 190, "temp_nozzle_max": 230, "temp_bed": 60,
    }


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
                "spool_profiles": [{"id": 735, "image_file": "735.png"}],
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
                        "spool_profile_id": 735,
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
        "filamentdb_spool_image_file",
        "filamentdb_spool_profile_id",
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


@pytest.mark.parametrize(
    ("material", "expected"),
    [
        ({"id": 31, "key": "pla-plus", "name": "PLA+/Pro"}, "PLA+/Pro"),
        ({"id": 1, "key": "pla", "name": "PLA"}, "PLA"),
        ({"id": 2, "key": "petg"}, "PETG"),
        ({"id": 3}, "PLA"),
    ],
)
def test_material_type_prefers_display_name_over_key(material, expected):
    assert _material_type_from_fdb(material) == expected


async def _legacy_material_catalog(db_session, *, catalog_id=71, material="PLA-PLUS", designation="Legacy PLA"):
    from app.models.spool import Spool, SpoolStatus

    manufacturer = Manufacturer(name="Catalog Match Fixture")
    db_session.add(manufacturer)
    await db_session.flush()
    custom = {"notes": "keep"}
    if catalog_id is not None:
        custom["filamentdb_id"] = catalog_id
    filament = Filament(
        manufacturer_id=manufacturer.id, designation=designation,
        material_type=material, diameter_mm=1.75,
        raw_material_weight_g=1000, color_mode="single", custom_fields=custom,
    )
    db_session.add(filament)
    await db_session.flush()
    status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "new"))
    spool = Spool(filament_id=filament.id, status_id=status.id)
    db_session.add(spool)
    await db_session.commit()
    payload = _make_sync_payload()
    payload.update(
        manufacturers=[{"id": 5, "name": manufacturer.name}],
        materials=[{"id": 6, "key": "pla-plus", "name": "PLA+/Pro"}],
        filaments=[{"id": 71, "manufacturer_id": 5, "material_id": 6,
                    "designation": "Legacy PLA", "diameter_mm": 1.75,
                    "nominal_weight_g": 1000, "color_mode": "single"}],
    )
    response_cache.set(SYNC_CACHE_KEY, {"snapshot_id": "material-match", "data": payload})
    return FilamentDBImportService(db_session), filament, spool, payload


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_id,material", [
    (71, "PLA-PLUS"), ("71", "PLA-PLUS"), (None, "PLA-PLUS"), (None, "PLA+/Pro"),
])
@pytest.mark.parametrize("update", [False, True])
async def test_material_name_change_matches_existing_records_through_import(
    db_session, catalog_id, material, update,
):
    service, filament, spool, _ = await _legacy_material_catalog(
        db_session, catalog_id=catalog_id, material=material,
    )
    original_id = filament.id
    preview = await service.preview(snapshot_id="material-match")
    assert preview.filaments[0]["_exists"] is True
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_exists"] is True
    diff = await service.diff_filaments([71], snapshot_id="material-match")
    expected = [] if material == "PLA+/Pro" else [
        {"field": "material_type", "old": "PLA-PLUS", "new": "PLA+/Pro"},
    ]
    assert diff.results[0]["changes"] == expected
    assert filament.material_type == material
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71] if update else [],
        snapshot_id="material-match",
    )
    assert result.filaments_created == 0
    assert result.filaments_updated == int(update)
    assert result.filaments_skipped == int(not update)
    assert list(await db_session.scalars(select(Filament.id))) == [original_id]
    await db_session.refresh(filament)
    await db_session.refresh(spool)
    assert spool.filament_id == original_id
    assert filament.material_type == ("PLA+/Pro" if update else material)
    assert filament.custom_fields["notes"] == "keep"
    if update:
        assert filament.custom_fields["filamentdb_id"] == 71


@pytest.mark.asyncio
async def test_saved_catalog_id_wins_over_renamed_fields_and_unlinked_lookalike(db_session):
    service, filament, spool, _ = await _legacy_material_catalog(
        db_session, material="My material", designation="My renamed product",
    )
    lookalike = Filament(
        manufacturer_id=filament.manufacturer_id, designation="Legacy PLA",
        material_type="PLA+/Pro", diameter_mm=1.75,
    )
    db_session.add(lookalike)
    await db_session.commit()
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71], snapshot_id="material-match",
    )
    assert result.filaments_created == 0
    assert result.filaments_updated == 1
    await db_session.refresh(filament)
    await db_session.refresh(lookalike)
    assert filament.designation == "Legacy PLA"
    assert filament.material_type == "PLA+/Pro"
    assert filament.custom_fields["notes"] == "keep"
    assert lookalike.raw_material_weight_g is None
    assert spool.filament_id == filament.id


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_id", [71, "71"])
async def test_comparison_and_update_use_the_same_manufacturer_for_all_fields(db_session, catalog_id):
    service, target, spool, payload = await _legacy_material_catalog(db_session, catalog_id=None)
    changes = {
        "material_type": ("PLA-PLUS", "PLA+/Pro"),
        "designation": ("Legacy PLA", "Legacy PLA Pro"),
        "material_subgroup": ("Basic", "Plus"),
        "diameter_mm": (2.85, 1.75),
        "manufacturer_color_name": ("Old red", "New red"),
        "raw_material_weight_g": (750, 1000),
        "price": (20, 30),
        "density_g_cm3": (1.24, 1.3),
        "color_mode": ("single", "multi"),
        "default_spool_weight_g": (210, 220),
        "spool_outer_diameter_mm": (197, 200),
        "spool_width_mm": (65, 70),
        "spool_material": ("cardboard", "plastic"),
        "filamentdb_spool_profile_id": (None, 9),
    }
    for field, (old, _) in changes.items():
        setattr(target, field, old)
    other_manufacturer = Manufacturer(name="Customized manufacturer")
    db_session.add(other_manufacturer)
    await db_session.flush()
    other = Filament(
        manufacturer_id=other_manufacturer.id, designation="Unrelated product",
        material_type="ABS", diameter_mm=3, price=10,
        custom_fields={"filamentdb_id": catalog_id, "notes": "other"},
    )
    db_session.add(other)
    await db_session.commit()
    payload["filaments"][0].update({
        "designation": "Legacy PLA Pro", "material_subtype": "Plus",
        "color_name": "New red", "price": 30, "density_g_cm3": 1.3,
        "color_mode": "multi", "spool_profile_id": 9,
    })
    payload["spool_profiles"] = [{
        "id": 9, "empty_weight_g": 220, "outer_diameter_mm": 200,
        "width_mm": 70, "spool_material": "plastic",
    }]
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_matched_name"] == "Legacy PLA"
    diff = await service.diff_filaments([71], snapshot_id="material-match")
    assert {c["field"]: (c["old"], c["new"]) for c in diff.results[0]["changes"]} == changes
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71], snapshot_id="material-match",
    )
    assert result.filaments_updated == 1
    assert result.filaments_created == 0
    await db_session.refresh(target)
    await db_session.refresh(other)
    await db_session.refresh(spool)
    for field, (_, new) in changes.items():
        assert getattr(target, field) == new
    assert (other.designation, other.material_type, other.diameter_mm, other.price) == (
        "Unrelated product", "ABS", 3, 10,
    )
    assert other.custom_fields == {"filamentdb_id": catalog_id, "notes": "other"}
    assert spool.filament_id == target.id


@pytest.mark.asyncio
@pytest.mark.parametrize("update", [False, True])
async def test_existing_catalog_link_persists_approved_metadata_updates(db_session, update):
    service, filament, _, payload = await _legacy_material_catalog(
        db_session, catalog_id="71", material="PLA+/Pro",
    )
    original = {"filamentdb_id": "71", "notes": "keep", "sku": "OLD", "temp_bed": 50}
    filament.custom_fields = original.copy()
    await db_session.commit()
    metadata = {
        "sku": "NEW", "temp_nozzle_min": 205, "temp_nozzle_max": 225,
        "temp_bed": 60, "fan_speed_min": 0, "fan_speed_max": 100,
        "chamber_temp": 35, "max_volumetric_speed": 20, "flow_ratio": 0.98,
        "k_value": 0.025, "dry_temp": 55, "dry_time_hours": 6, "softening_temp": 65,
    }
    payload["filaments"][0].update(metadata)
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71] if update else [],
        snapshot_id="material-match",
    )
    assert result.filaments_updated == int(update)
    await db_session.refresh(filament)
    # Native catalog values and the normalized link must survive the colors flush.
    assert filament.custom_fields == (original | {"filamentdb_id": 71} if update else original)
    expected_native = {
        "manufacturer_sku": "NEW",
        "extruder_temp_range_c": {"min": 205, "max": 225},
        "bed_temp_range_c": {"min": 60, "max": 60},
        "cooling_fan_range_percent": {"min": 0, "max": 100},
        "chamber_temp_c": 35,
        "max_volumetric_speed_mm3_s": 20,
        "flow_ratio": 0.98,
        "pressure_advance_k": 0.025,
        "drying_temp_c": 55,
        "drying_time_hours": 6,
        "softening_temp_c": 65,
    }
    for field, value in expected_native.items():
        assert getattr(filament, field) == (value if update else None)


@pytest.mark.asyncio
async def test_unlinked_different_material_is_not_merged(db_session):
    service, filament, _, _ = await _legacy_material_catalog(
        db_session, catalog_id=None, material="ABS",
    )
    preview = await service.preview(snapshot_id="material-match")
    assert preview.filaments[0]["_exists"] is False
    result = await service.execute(filament_ids=[71], snapshot_id="material-match")
    assert result.filaments_created == 1
    assert result.filaments_updated == 0
    await db_session.refresh(filament)
    assert filament.material_type == "ABS"


@pytest.mark.asyncio
@pytest.mark.parametrize("catalog_id", [72, "72"])
@pytest.mark.parametrize("designation", ["Legacy PLA", "Legacy-PLA"])
@pytest.mark.parametrize("update", [False, True])
async def test_name_matching_never_relinks_another_catalog_product(
    db_session, catalog_id, designation, update,
):
    service, filament, spool, _ = await _legacy_material_catalog(
        db_session, catalog_id=catalog_id, designation=designation,
    )
    filament.diameter_mm = 2.85
    await db_session.commit()
    preview = await service.preview(snapshot_id="material-match")
    assert preview.filaments[0]["_exists"] is False
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_exists"] is False
    diff = await service.diff_filaments([71], snapshot_id="material-match")
    assert diff.results[0]["not_found"] is True

    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71] if update else [],
        snapshot_id="material-match",
    )
    assert result.filaments_created == 1
    assert result.filaments_updated == result.filaments_skipped == 0
    await db_session.refresh(filament)
    await db_session.refresh(spool)
    assert filament.custom_fields == {"filamentdb_id": catalog_id, "notes": "keep"}
    assert (filament.designation, filament.material_type, filament.diameter_mm) == (
        designation, "PLA-PLUS", 2.85,
    )
    assert spool.filament_id == filament.id
    imported = await db_session.scalar(select(Filament).where(Filament.id != filament.id))
    assert imported.custom_fields["filamentdb_id"] == 71
    assert imported.diameter_mm == 1.75


@pytest.mark.asyncio
async def test_legacy_material_matches_when_catalog_material_is_nested_only(db_session):
    service, filament, _, payload = await _legacy_material_catalog(db_session, catalog_id=None)
    payload["filaments"][0]["material"] = payload["materials"].pop()
    payload["filaments"][0].pop("material_id")
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_exists"] is True
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71], snapshot_id="material-match",
    )
    assert result.filaments_created == 0
    assert result.filaments_updated == 1
    await db_session.refresh(filament)
    assert filament.material_type == "PLA+/Pro"


@pytest.mark.asyncio
@pytest.mark.parametrize("reject", [False, True])
async def test_legacy_material_fuzzy_match_honors_explicit_rejection(db_session, reject):
    service, filament, _, _ = await _legacy_material_catalog(
        db_session, catalog_id=None, designation="Legacy-PLA",
    )
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_exists"] is True
    assert selected.filaments[0]["_match_type"] == "fuzzy"
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71],
        skip_fuzzy_ids=[71] if reject else [], snapshot_id="material-match",
    )
    assert result.filaments_created == int(reject)
    assert result.filaments_updated == int(not reject)
    await db_session.refresh(filament)
    assert filament.material_type == ("PLA-PLUS" if reject else "PLA+/Pro")


@pytest.mark.asyncio
@pytest.mark.parametrize("linked", [False, True])
async def test_existing_legacy_current_duplicate_pair_is_skipped_safely(db_session, linked):
    service, filament, _, _ = await _legacy_material_catalog(
        db_session, catalog_id=71 if linked else None,
    )
    duplicate = Filament(
        manufacturer_id=filament.manufacturer_id, designation=filament.designation,
        material_type="PLA+/Pro", diameter_mm=1.75,
        custom_fields={"filamentdb_id": 71} if linked else None,
    )
    db_session.add(duplicate)
    await db_session.commit()
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71], snapshot_id="material-match",
    )
    assert result.filaments_created == result.filaments_updated == 0
    assert result.filaments_skipped == 1
    assert len(result.warnings) == 1
    await db_session.refresh(filament)
    await db_session.refresh(duplicate)
    assert (filament.material_type, duplicate.material_type) == ("PLA-PLUS", "PLA+/Pro")


@pytest.mark.asyncio
async def test_fuzzy_update_changes_the_same_record_shown_in_the_diff(db_session):
    service, legacy, _, payload = await _legacy_material_catalog(
        db_session, catalog_id=None, designation="Legacy-PLA",
    )
    legacy.price = 10
    current = Filament(
        manufacturer_id=legacy.manufacturer_id, designation="Legacy_PLA",
        material_type="PLA+/Pro", diameter_mm=1.75, price=20,
    )
    db_session.add(current)
    await db_session.commit()
    payload["filaments"][0]["price"] = 30
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert selected.filaments[0]["_matched_name"] == "Legacy_PLA"
    diff = await service.diff_filaments([71], snapshot_id="material-match")
    assert {"field": "price", "old": 20, "new": 30} in diff.results[0]["changes"]
    result = await service.execute(
        filament_ids=[71], update_filament_ids=[71], snapshot_id="material-match",
    )
    assert result.filaments_updated == 1
    await db_session.refresh(legacy)
    await db_session.refresh(current)
    assert legacy.price == 10
    assert current.price == 30


@pytest.mark.asyncio
@pytest.mark.parametrize("material", ["PLA+/Pro", "PLA-PLUS"])
@pytest.mark.parametrize("approve_first", [False, True])
async def test_batch_updates_never_switch_to_an_unreviewed_fuzzy_match(
    db_session, material, approve_first,
):
    from app.models.spool import Spool

    service, reviewed, spool, payload = await _legacy_material_catalog(
        db_session, catalog_id=None, material=material, designation="Legacy_PLA",
    )
    reviewed.price = 10
    unreviewed = Filament(
        manufacturer_id=reviewed.manufacturer_id, designation="Legacy PLA Pro Blue",
        material_type=material, diameter_mm=1.75, price=20,
    )
    db_session.add(unreviewed)
    await db_session.flush()
    other_spool = Spool(filament_id=unreviewed.id, status_id=spool.status_id)
    db_session.add(other_spool)
    await db_session.commit()
    payload["filaments"][0]["price"] = 30
    payload["filaments"].append({
        **payload["filaments"][0], "id": 72,
        "designation": "Legacy PLA Pro Red", "price": 40,
    })
    selected = await service.fetch_filaments([5], snapshot_id="material-match")
    assert [f["_matched_name"] for f in selected.filaments] == ["Legacy_PLA", "Legacy_PLA"]
    diff = await service.diff_filaments([71, 72], snapshot_id="material-match")
    for row, price in zip(diff.results, [30, 40], strict=True):
        assert {"field": "price", "old": 10, "new": price} in row["changes"]

    result = await service.execute(
        filament_ids=[71, 72], update_filament_ids=[71, 72] if approve_first else [72],
        snapshot_id="material-match",
    )
    assert result.filaments_created == 0
    assert result.filaments_updated == result.filaments_skipped == 1
    assert len(result.warnings) == int(approve_first)
    await db_session.refresh(reviewed)
    await db_session.refresh(unreviewed)
    await db_session.refresh(spool)
    await db_session.refresh(other_spool)
    assert (reviewed.price, reviewed.custom_fields["filamentdb_id"]) == (
        (30, 71) if approve_first else (40, 72)
    )
    assert (unreviewed.designation, unreviewed.price, unreviewed.custom_fields) == (
        "Legacy PLA Pro Blue", 20, None,
    )
    assert (spool.filament_id, other_spool.filament_id) == (reviewed.id, unreviewed.id)


async def test_catalog_update_preserves_migrated_label_definition_and_scalar_target(db_session):
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from app.services.spoolman_projection import FilamentCompatibilityView

    from tests.test_filament_temperature_migration import (
        legacy_schema,
        load_migration_module,
    )

    metadata, filaments, _, _ = legacy_schema()
    definitions = {
        key: {'label': label, 'field_type': 'number', 'config': {'unit': '°C', 'decimal_places': 1}}
        for key, label in [('dry_temp', 'Drying temperature'), ('temp_bed', 'Bed temperature')]
    }
    with sa.create_engine('sqlite://').begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {'id': 1, 'custom_fields': {'dry_temp': 55, 'temp_bed': 60}, 'custom_field_definitions': definitions})
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        table = sa.Table('filaments', sa.MetaData(), autoload_with=connection)
        row = dict(connection.execute(sa.select(table)).mappings().one())
    before = copy.deepcopy(row['label_field_aliases'])
    manufacturer = Manufacturer(name='Alias catalog')
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(**row, manufacturer=manufacturer, designation='PLA', material_type='PLA', diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    await FilamentDBImportService(db_session)._update_existing_filament(filament, {'dry_temp': 65, 'temp_bed': 70}, 'PLA', {}, 'filament', {})
    for key in ('dry_temp', 'temp_bed'):
        assert filament.label_field_aliases[key]['target'] == before[key]['target']
        assert filament.label_field_aliases[key]['definition'] == definitions[key]
    assert filament.label_field_aliases['temp_bed']['target'] == 'bed_temp_range_c.min'
    assert FilamentCompatibilityView(filament).custom_fields['dry_temp'] == 65
    assert FilamentCompatibilityView(filament).custom_fields['temp_bed'] == 70
    filament.bed_temp_range_c = {'min': 75, 'max': 85}
    assert FilamentCompatibilityView(filament).custom_fields['temp_bed'] == 75


async def test_catalog_does_not_claim_source_alias_for_another_native_property(db_session):
    from app.services.spoolman_projection import promotion_alias
    manufacturer = Manufacturer(name='Existing aliases')
    db_session.add(manufacturer)
    await db_session.flush()
    aliases = {'dry_temp': promotion_alias('manufacturer_sku', 'DRY-SKU', 'DRY-SKU')}
    filament = Filament(manufacturer=manufacturer, designation='PLA', material_type='PLA', diameter_mm=1.75,
                        manufacturer_sku='DRY-SKU', label_field_aliases=copy.deepcopy(aliases))
    db_session.add(filament)
    await db_session.flush()
    await FilamentDBImportService(db_session)._update_existing_filament(filament, {'dry_temp': 65}, 'PLA', {}, 'filament', {})
    assert filament.label_field_aliases == aliases
    assert filament.drying_temp_c == 65
