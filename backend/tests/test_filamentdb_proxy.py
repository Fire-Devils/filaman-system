import pytest
from app.api.v1 import filamentdb_proxy
from app.services.filamentdb_field_mapping import standard_filamentdb_fields


def test_standard_mapping_preserves_out_of_bounds_fan_as_unmapped():
    assert "cooling_fan_range_percent" not in standard_filamentdb_fields(
        {"fan_speed_min": 30, "fan_speed_max": 120}
    )


def test_prepare_request_accepts_missing_discontinued_value():
    request = filamentdb_proxy.PrepareFilamentRequest(
        manufacturer_name="Example",
        designation="PLA",
        discontinued=None,
    )
    assert request.discontinued is None


@pytest.mark.asyncio
async def test_search_filaments_returns_direct_results_without_fallback(monkeypatch):
    calls: list[tuple[str, dict]] = []
    direct_result = {
        "items": [{"id": 1, "designation": "Matte Marine Blue"}],
        "total": 1,
        "page": 1,
        "page_size": 20,
    }

    async def fake_proxy_get(path, params=None, *, client=None):
        calls.append((path, params or {}))
        return direct_result

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_proxy_get)

    result = await filamentdb_proxy.search_filaments(
        _principal=None,
        search="Matte Marine Blue",
        manufacturer_id=42,
        manufacturer_name=None,
        material_key="PLA",
        page=1,
        page_size=20,
    )

    assert result == direct_result
    assert calls == [
        (
            "/filaments",
            {
                "page": 1,
                "page_size": 20,
                "search": "Matte Marine Blue",
                "manufacturer_id": 42,
                "material_key": "PLA",
            },
        )
    ]


@pytest.mark.asyncio
async def test_search_filaments_fuzzy_fallback_finds_punctuated_match(monkeypatch):
    calls: list[tuple[str, dict]] = []
    candidate = {
        "id": 11600,
        "designation": "Matte - Marine Blue (11600)",
        "material_key": "PLA",
        "manufacturer": {"name": "Example Filaments"},
    }

    async def fake_proxy_get(path, params=None, *, client=None):
        params = params or {}
        calls.append((path, params))
        if params.get("search") in {"marine", "blue"}:
            return {
                "items": [candidate],
                "total": 1,
                "page": 1,
                "page_size": params["page_size"],
            }
        return {
            "items": [],
            "total": 0,
            "page": params.get("page", 1),
            "page_size": params.get("page_size", 20),
        }

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_proxy_get)

    result = await filamentdb_proxy.search_filaments(
        _principal=None,
        search="Matte Marine Blue",
        manufacturer_id=42,
        manufacturer_name=None,
        material_key="PLA",
        page=1,
        page_size=20,
    )

    assert result["items"] == [candidate]
    assert result["total"] == 1
    assert all(call[1].get("manufacturer_id") == 42 for call in calls)
    assert all(call[1].get("material_key") == "PLA" for call in calls)
    assert [call[1]["search"] for call in calls] == [
        "Matte Marine Blue",
        "matte",
        "marine",
        "blue",
    ]


@pytest.mark.asyncio
async def test_search_spool_profiles_fuzzy_fallback_deduplicates(monkeypatch):
    candidate = {"id": 7, "name": "Bambu - Reusable Spool"}

    async def fake_proxy_get(path, params=None, *, client=None):
        params = params or {}
        if params.get("search") in {"bambu", "reusable"}:
            return {
                "items": [candidate],
                "total": 1,
                "page": 1,
                "page_size": params["page_size"],
            }
        return {
            "items": [],
            "total": 0,
            "page": params.get("page", 1),
            "page_size": params.get("page_size", 20),
        }

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_proxy_get)

    result = await filamentdb_proxy.search_spool_profiles(
        _principal=None,
        search="Bambu Reusable",
        page=1,
        page_size=20,
    )

    assert result["items"] == [candidate]
    assert result["total"] == 1


@pytest.mark.asyncio
async def test_search_filaments_fuzzy_fallback_rejects_low_overlap(monkeypatch):
    candidate = {
        "id": 99,
        "designation": "Marine Blue",
        "material_key": "PLA",
    }

    async def fake_proxy_get(path, params=None, *, client=None):
        params = params or {}
        if params.get("search") == "marine":
            return {
                "items": [candidate],
                "total": 1,
                "page": 1,
                "page_size": params["page_size"],
            }
        return {
            "items": [],
            "total": 0,
            "page": params.get("page", 1),
            "page_size": params.get("page_size", 20),
        }

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_proxy_get)

    result = await filamentdb_proxy.search_filaments(
        _principal=None,
        search="Marine Crimson Chartreuse",
        manufacturer_id=None,
        manufacturer_name=None,
        material_key=None,
        page=1,
        page_size=20,
    )

    assert result["items"] == []
    assert result["total"] == 0


def test_lookup_text_caps_nested_remote_response_traversal():
    current = {"designation": "Root"}
    root = current
    for index in range(20):
        current["nested"] = {"designation": f"Nested {index}"}
        current = current["nested"]

    text = filamentdb_proxy._lookup_text(
        root,
        filamentdb_proxy._FILAMENT_LOOKUP_TEXT_KEYS,
    )

    assert "Root" in text
    assert "Nested 2" in text
    assert "Nested 3" not in text


@pytest.mark.asyncio
async def test_prepare_filament_returns_standard_temperature_ranges(db_session):
    result = await filamentdb_proxy.prepare_filament(
        filamentdb_proxy.PrepareFilamentRequest(
            manufacturer_name="Temperature Manufacturer",
            designation="Temperature PLA",
            temp_nozzle_min=190,
            temp_nozzle_max=230,
            temp_bed=60,
        ),
        db_session,
        None,
    )

    assert result.prefilled["extruder_temp_range_c"] == {"min": 190, "max": 230}
    assert result.prefilled["bed_temp_range_c"] == {"min": 60, "max": 60}


@pytest.mark.asyncio
async def test_prepare_filament_returns_all_standard_filamentdb_fields(db_session):
    result = await filamentdb_proxy.prepare_filament(
        filamentdb_proxy.PrepareFilamentRequest(
            manufacturer_name="Complete Manufacturer",
            designation="Complete PLA",
            sku="PLA-42",
            datasheet_url="https://example.com/pla.pdf",
            image_url="https://example.com/pla.png",
            discontinued=True,
            dry_temp=55,
            dry_time_hours=6,
            softening_temp=65,
            fan_speed_min=40,
            fan_speed_max=80,
            chamber_temp=35,
            max_volumetric_speed=18,
            flow_ratio=0.97,
            k_value=0.025,
            ams_compatible="ams,ams-2-pro",
            build_plates="pei,textured-pei",
            currency="EUR",
        ),
        db_session,
        None,
    )

    assert result.prefilled == {
        **result.prefilled,
        "manufacturer_sku": "PLA-42",
        "datasheet_url": "https://example.com/pla.pdf",
        "image_url": "https://example.com/pla.png",
        "is_discontinued": True,
        "drying_temp_c": 55,
        "drying_time_hours": 6,
        "softening_temp_c": 65,
        "cooling_fan_range_percent": {"min": 40, "max": 80},
        "chamber_temp_c": 35,
        "max_volumetric_speed_mm3_s": 18,
        "flow_ratio": 0.97,
        "pressure_advance_k": 0.025,
        "ams_compatibility": ["ams", "ams-2-pro"],
        "build_plate_compatibility": ["pei", "textured-pei"],
        "price_currency": "EUR",
    }


@pytest.mark.asyncio
async def test_prepare_filament_ignores_invalid_remote_temperature_range(db_session):
    result = await filamentdb_proxy.prepare_filament(
        filamentdb_proxy.PrepareFilamentRequest(
            manufacturer_name="Invalid Temperature Manufacturer",
            designation="Temperature PLA",
            temp_nozzle_min=240,
            temp_nozzle_max=190,
        ),
        db_session,
        None,
    )

    assert "extruder_temp_range_c" not in result.prefilled
async def test_prepare_filament_preserves_manufacturer_color_name(auth_client):
    client, csrf_token = auth_client

    response = await client.post(
        "/api/v1/filamentdb/prepare-filament",
        json={
            "manufacturer_name": "Example Brand",
            "designation": "Basic",
            "material_key": "PLA",
            "manufacturer_color_name": "Bambu Green",
            "colors": [
                {
                    "hex_code": "#00AE42",
                    "color_name": "Bambu Green",
                    "position": 1,
                }
            ],
        },
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 200
    assert response.json()["prefilled"]["manufacturer_color_name"] == "Bambu Green"
