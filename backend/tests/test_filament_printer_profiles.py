"""Druckprofile pro Filament, Druckermodell am Drucker und FilaMan-DB-Proxy."""

import pytest
import pytest_asyncio

from app.api.v1 import filamentdb_proxy
from app.models import Filament, Manufacturer, Printer
from app.models.plugin import InstalledPlugin
from app.services.print_profile_validation import find_implausible_values
from tests.test_rbac import viewer_auth_client, viewer_user  # noqa: F401


def _h(csrf):
    return {"X-CSRF-Token": csrf}


@pytest_asyncio.fixture
async def entities(db_session):
    manufacturer = Manufacturer(name="Profile manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Profile filament",
        material_type="PLA",
        diameter_mm=1.75,
    )
    printer = Printer(
        name="Profile printer",
        driver_key="contract-driver",
        printer_manufacturer="Bambu Lab",
        printer_model="X1C",
    )
    db_session.add_all([filament, printer])
    await db_session.commit()
    return filament, printer


def test_validation_ranges_are_inclusive_and_null_safe():
    assert find_implausible_values({"nozzle_temp_c": 150, "bed_temp_c": None}) == []
    assert find_implausible_values({"nozzle_temp_c": 500, "z_hop_mm": 5}) == []
    bad = find_implausible_values({"nozzle_temp_c": 149, "pressure_advance_k": 2.1})
    assert {p["field"] for p in bad} == {"nozzle_temp_c", "pressure_advance_k"}
    assert bad[0]["min"] == 150 and bad[0]["max"] == 500


@pytest.mark.asyncio
async def test_profile_crud_roundtrip(auth_client, entities):
    client, csrf = auth_client
    filament, printer = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"

    created = await client.post(
        base,
        json={
            "printer_id": printer.id,
            "profile_name": "Standard",
            "nozzle_diameter_mm": 0.4,
            "nozzle_temp_c": 215,
            "pressure_advance_k": 0.04,
            "z_hop_only_when_retracting": True,
        },
        headers=_h(csrf),
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["printer_name"] == "Profile printer"
    assert body["printer_manufacturer"] == "Bambu Lab"
    assert body["printer_model"] == "X1C"
    assert body["nozzle_temp_c"] == 215
    profile_id = body["id"]

    listed = await client.get(base)
    assert [row["id"] for row in listed.json()] == [profile_id]

    updated = await client.put(
        f"{base}/{profile_id}", json={"bed_temp_c": 60}, headers=_h(csrf)
    )
    assert updated.status_code == 200
    assert updated.json()["bed_temp_c"] == 60
    assert updated.json()["nozzle_temp_c"] == 215  # Teil-Update lässt Rest stehen

    removed = await client.delete(f"{base}/{profile_id}", headers=_h(csrf))
    assert removed.status_code == 204
    assert (await client.get(base)).json() == []
    assert (await client.delete(f"{base}/{profile_id}", headers=_h(csrf))).status_code == 404


@pytest.mark.asyncio
async def test_implausible_values_rejected_on_create_and_update(auth_client, entities):
    client, csrf = auth_client
    filament, printer = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"

    bad = await client.post(
        base,
        json={"printer_id": printer.id, "profile_name": "x", "nozzle_temp_c": 900},
        headers=_h(csrf),
    )
    assert bad.status_code == 422
    detail = bad.json()["detail"]
    assert detail["code"] == "implausible_value"
    assert (detail["field"], detail["min"], detail["max"]) == ("nozzle_temp_c", 150, 500)

    ok = await client.post(
        base, json={"printer_id": printer.id, "profile_name": "ok"}, headers=_h(csrf)
    )
    pid = ok.json()["id"]
    bad_update = await client.put(
        f"{base}/{pid}", json={"retraction_mm": 99}, headers=_h(csrf)
    )
    assert bad_update.status_code == 422
    assert bad_update.json()["detail"]["field"] == "retraction_mm"


@pytest.mark.asyncio
async def test_unknown_printer_or_filament(auth_client, entities):
    client, csrf = auth_client
    filament, printer = entities
    missing_printer = await client.post(
        f"/api/v1/filaments/{filament.id}/printer-profiles",
        json={"printer_id": 99999, "profile_name": "x"},
        headers=_h(csrf),
    )
    assert missing_printer.status_code == 400
    missing_filament = await client.get("/api/v1/filaments/99999/printer-profiles")
    assert missing_filament.status_code == 404


@pytest.mark.asyncio
async def test_default_flag_is_exclusive_per_printer(auth_client, entities):
    client, csrf = auth_client
    filament, printer = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"
    first = await client.post(
        base,
        json={"printer_id": printer.id, "profile_name": "a", "is_default_for_printer": True},
        headers=_h(csrf),
    )
    second = await client.post(
        base,
        json={"printer_id": printer.id, "profile_name": "b", "is_default_for_printer": True},
        headers=_h(csrf),
    )
    rows = {row["id"]: row for row in (await client.get(base)).json()}
    assert rows[first.json()["id"]]["is_default_for_printer"] is False
    assert rows[second.json()["id"]]["is_default_for_printer"] is True


@pytest.mark.asyncio
async def test_viewer_can_read_but_not_write(viewer_auth_client, db_session, entities):  # noqa: F811
    from app.models import FilamentPrinterProfile

    filament, printer = entities
    row = FilamentPrinterProfile(filament_id=filament.id, printer_id=printer.id, profile_name="p")
    db_session.add(row)
    await db_session.commit()
    pid = row.id
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"

    client, csrf = viewer_auth_client
    assert (await client.get(base)).status_code == 200
    post = await client.post(
        base, json={"printer_id": printer.id, "profile_name": "n"}, headers=_h(csrf)
    )
    put = await client.put(f"{base}/{pid}", json={"bed_temp_c": 50}, headers=_h(csrf))
    delete = await client.delete(f"{base}/{pid}", headers=_h(csrf))
    assert (post.status_code, put.status_code, delete.status_code) == (403, 403, 403)


@pytest.mark.asyncio
async def test_anonymous_cannot_read(client, entities):
    filament, _ = entities
    response = await client.get(f"/api/v1/filaments/{filament.id}/printer-profiles")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_printer_model_fields_roundtrip(auth_client):
    client, csrf = auth_client
    created = await client.post(
        "/api/v1/printers",
        json={
            "name": "Modell-Drucker",
            "driver_key": "",
            "filamentdb_printer_model_id": 7,
            "printer_manufacturer": "Prusa",
            "printer_model": "MK4",
        },
        headers=_h(csrf),
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["filamentdb_printer_model_id"] == 7
    assert (body["printer_manufacturer"], body["printer_model"]) == ("Prusa", "MK4")
    patched = await client.patch(
        f"/api/v1/printers/{body['id']}",
        json={"printer_model": "MK4S", "filamentdb_printer_model_id": None},
        headers=_h(csrf),
    )
    assert patched.status_code == 200
    assert patched.json()["printer_model"] == "MK4S"
    assert patched.json()["filamentdb_printer_model_id"] is None


# ─── Proxy /filamentdb/printer-models ─────────────────────────────────────────


@pytest_asyncio.fixture
async def plugin_row(db_session):
    from sqlalchemy import select

    row = await db_session.scalar(
        select(InstalledPlugin).where(InstalledPlugin.plugin_key == "filamentdb_import")
    )
    if row is None:
        row = InstalledPlugin(
            plugin_key="filamentdb_import",
            name="FilamentDB Import",
            version="1.0.0",
            plugin_type="import",
        )
        db_session.add(row)
    row.is_active = True
    await db_session.commit()
    filamentdb_proxy.clear_printer_models_cache()
    yield row
    filamentdb_proxy.clear_printer_models_cache()


@pytest.mark.asyncio
async def test_printer_models_unavailable_without_plugin(auth_client, plugin_row, db_session, monkeypatch):
    plugin_row.is_active = False
    await db_session.commit()
    filamentdb_proxy.clear_printer_models_cache()

    async def no_network(*args, **kwargs):
        raise AssertionError("must not call the FilaMan-DB without the plugin")

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", no_network)
    client, _ = auth_client
    response = await client.get("/api/v1/filamentdb/printer-models")
    assert response.status_code == 200
    assert response.json() == {"available": False, "items": []}


@pytest.mark.asyncio
async def test_printer_models_fetched_and_cached(auth_client, plugin_row, monkeypatch):
    client, _ = auth_client
    calls = []

    async def fake_get(path, params=None, *, client=None):
        calls.append((path, params))
        return {
            "items": [
                {"id": 1, "manufacturer": "Bambu Lab", "model": "X1C", "default_nozzle_mm": 0.4, "slug": "x"},
                {"id": 2, "manufacturer": "Prusa", "model": "MK4"},
            ],
            "total": 2,
        }

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_get)
    first = await client.get("/api/v1/filamentdb/printer-models")
    second = await client.get("/api/v1/filamentdb/printer-models")
    assert first.json()["available"] is True
    assert [i["model"] for i in first.json()["items"]] == ["X1C", "MK4"]
    assert "slug" not in first.json()["items"][0]
    assert second.json() == first.json()
    assert calls == [("/printer-models", {"page": 1, "page_size": 200})]


@pytest.mark.asyncio
async def test_printer_models_unreachable_returns_defined_answer(auth_client, plugin_row, monkeypatch):
    from fastapi import HTTPException

    client, _ = auth_client

    async def failing_get(path, params=None, *, client=None):
        raise HTTPException(status_code=502, detail={"code": "filamentdb_unreachable"})

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", failing_get)
    response = await client.get("/api/v1/filamentdb/printer-models")
    assert response.status_code == 200
    assert response.json() == {"available": False, "items": []}


@pytest.mark.asyncio
async def test_profile_without_printer_needs_model(auth_client, entities):
    client, csrf = auth_client
    filament, _ = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"

    missing = await client.post(base, json={"profile_name": "x"}, headers=_h(csrf))
    assert missing.status_code == 422
    assert missing.json()["detail"]["code"] == "printer_model_required"

    only_maker = await client.post(
        base, json={"profile_name": "x", "printer_manufacturer": "Prusa"}, headers=_h(csrf)
    )
    assert only_maker.status_code == 422

    ok = await client.post(
        base,
        json={"profile_name": "free", "printer_manufacturer": "Prusa", "printer_model": "MK4"},
        headers=_h(csrf),
    )
    assert ok.status_code == 201, ok.text
    body = ok.json()
    assert body["printer_id"] is None
    assert (body["printer_manufacturer"], body["printer_model"]) == ("Prusa", "MK4")

    by_id = await client.post(
        base,
        json={"profile_name": "db", "filamentdb_printer_model_id": 12},
        headers=_h(csrf),
    )
    assert by_id.status_code == 201, by_id.text


@pytest.mark.asyncio
async def test_default_needs_linked_printer(auth_client, entities):
    client, csrf = auth_client
    filament, _ = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"
    response = await client.post(
        base,
        json={
            "profile_name": "d",
            "printer_manufacturer": "Prusa",
            "printer_model": "MK4",
            "is_default_for_printer": True,
        },
        headers=_h(csrf),
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "printer_required_for_default"


@pytest.mark.asyncio
async def test_update_cannot_remove_model(auth_client, entities):
    client, csrf = auth_client
    filament, printer = entities
    base = f"/api/v1/filaments/{filament.id}/printer-profiles"
    created = (
        await client.post(
            base, json={"printer_id": printer.id, "profile_name": "p"}, headers=_h(csrf)
        )
    ).json()
    assert created["printer_model"] == "X1C"  # vom Drucker übernommen
    response = await client.put(
        f"{base}/{created['id']}",
        json={"printer_manufacturer": None, "printer_model": None},
        headers=_h(csrf),
    )
    assert response.status_code == 422
    unlink = await client.put(
        f"{base}/{created['id']}", json={"printer_id": None}, headers=_h(csrf)
    )
    assert unlink.status_code == 200
    assert unlink.json()["printer_id"] is None
    assert unlink.json()["printer_model"] == "X1C"


# ─── Proxy /filamentdb/build-plates ───────────────────────────────────────────


@pytest.fixture
def clean_plate_cache():
    filamentdb_proxy.clear_build_plates_cache()
    yield
    filamentdb_proxy.clear_build_plates_cache()


@pytest.mark.asyncio
async def test_build_plates_fetched_cached_and_page_size_capped(
    auth_client, plugin_row, clean_plate_cache, monkeypatch
):
    client, _ = auth_client
    calls = []

    async def fake_get(path, params=None, *, client=None):
        calls.append((path, params))
        return {
            "items": [
                {"id": 1, "name": "Textured PEI", "slug": "textured-pei"},
                {"id": 2, "name": "Cool Plate"},
                {"id": "x", "name": "bad id"},
                {"id": 3, "name": "  "},
            ],
            "total": 4,
            "page": 1,
            "page_size": 200,
        }

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_get)
    first = await client.get("/api/v1/filamentdb/build-plates")
    second = await client.get("/api/v1/filamentdb/build-plates")
    assert first.json() == {
        "available": True,
        "items": [{"id": 1, "name": "Textured PEI"}, {"id": 2, "name": "Cool Plate"}],
    }
    assert second.json() == first.json()
    assert calls == [("/build-plates", {"page": 1, "page_size": 200})]
    assert all(p["page_size"] <= 200 for _, p in calls)


@pytest.mark.asyncio
async def test_build_plates_unavailable_without_plugin_or_db(
    auth_client, plugin_row, db_session, clean_plate_cache, monkeypatch
):
    from fastapi import HTTPException

    client, _ = auth_client

    async def failing_get(path, params=None, *, client=None):
        raise HTTPException(status_code=502, detail={"code": "filamentdb_unreachable"})

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", failing_get)
    down = await client.get("/api/v1/filamentdb/build-plates")
    assert down.status_code == 200
    assert down.json() == {"available": False, "items": []}

    plugin_row.is_active = False
    await db_session.commit()
    off = await client.get("/api/v1/filamentdb/build-plates")
    assert off.json() == {"available": False, "items": []}


@pytest.mark.asyncio
async def test_build_plates_stale_cache_when_db_goes_away(
    auth_client, plugin_row, clean_plate_cache, monkeypatch
):
    from fastapi import HTTPException

    client, _ = auth_client

    async def ok_get(path, params=None, *, client=None):
        return {"items": [{"id": 1, "name": "Smooth PEI"}], "total": 1}

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", ok_get)
    assert (await client.get("/api/v1/filamentdb/build-plates")).json()["available"] is True

    async def failing_get(path, params=None, *, client=None):
        raise HTTPException(status_code=504, detail={"code": "filamentdb_timeout"})

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", failing_get)
    monkeypatch.setitem(filamentdb_proxy._build_plates_cache, "at", 0.0)  # abgelaufen
    stale = await client.get("/api/v1/filamentdb/build-plates")
    assert stale.json() == {"available": True, "items": [{"id": 1, "name": "Smooth PEI"}]}
