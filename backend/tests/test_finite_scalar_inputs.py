"""Nonfinite native input must never commit values that poison later reads."""

import json

import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import func, select

from app.api.v1.schemas_filament import (
    BulkFilamentUpdateRequest,
    ResolveFilamentFromTagRequest,
)
from app.api.v1.schemas_spool import (
    AdjustmentRequest,
    BulkSpoolUpdateRequest,
    ConsumptionRequest,
    DeviceMeasurementRequest,
    MeasurementRequest,
    SpoolBulkCreate,
)
from app.core.cache import response_cache
from app.models import Filament, Manufacturer, Spool

FILAMENT_FLOATS = (
    "drying_temp_c", "drying_time_hours", "softening_temp_c", "chamber_temp_c",
    "max_volumetric_speed_mm3_s", "flow_ratio", "pressure_advance_k",
    "diameter_mm", "raw_material_weight_g", "default_spool_weight_g",
    "spool_outer_diameter_mm", "spool_width_mm", "price", "density_g_cm3",
)
MANUFACTURER_FLOATS = (
    "empty_spool_weight_g", "spool_outer_diameter_mm", "spool_width_mm",
)
SPOOL_FLOATS = (
    "purchase_price", "initial_total_weight_g", "empty_spool_weight_g",
    "spool_core_weight_g", "spool_outer_diameter_mm", "spool_width_mm",
)
NONFINITE = ("Infinity", "-Infinity", "1e1000", "NaN")
ENTITIES = (
    ("manufacturers", Manufacturer, MANUFACTURER_FLOATS),
    ("filaments", Filament, FILAMENT_FLOATS),
    ("spools", Spool, SPOOL_FLOATS),
)


@pytest_asyncio.fixture
async def finite_inventory(auth_client):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    bodies = {"manufacturers": {"name": "Finite manufacturer", **dict.fromkeys(MANUFACTURER_FLOATS, 12.5)}}
    records = {}
    for collection, _, fields in ENTITIES:
        if collection == "filaments":
            bodies[collection] = {
                "manufacturer_id": records["manufacturers"]["id"],
                "designation": "Finite PLA", "material_type": "PLA",
                **dict.fromkeys(fields, 12.5), "diameter_mm": 1.75,
            }
        elif collection == "spools":
            bodies[collection] = {
                "filament_id": records["filaments"]["id"],
                "external_id": "finite-spool", **dict.fromkeys(fields, 12.5),
                "remaining_weight_g": 500,
            }
        response = await client.post(f"/api/v1/{collection}", headers=headers, json=bodies[collection])
        assert response.status_code == 201, response.text
        records[collection] = response.json()
    return client, headers, bodies, records


@pytest.mark.parametrize(
    "collection,model,field",
    [(collection, model, field) for collection, model, fields in ENTITIES for field in fields],
    ids=[f"{collection}-{field}" for collection, _, fields in ENTITIES for field in fields],
)
async def test_nonfinite_create_and_update_leave_catalog_readable(
    finite_inventory, db_session, collection, model, field,
):
    client, headers, bodies, records = finite_inventory
    path = f"/api/v1/{collection}"
    entity_id = records[collection]["id"]
    original = (await client.get(f"{path}/{entity_id}")).json()
    count = await db_session.scalar(select(func.count()).select_from(model))
    for value in NONFINITE:
        response = await client.post(path, headers=headers, json={**bodies[collection], field: value})
        assert response.status_code == 422, response.text
        response = await client.patch(f"{path}/{entity_id}", headers=headers, json={field: value})
        assert response.status_code == 422, response.text
        assert await db_session.scalar(select(func.count()).select_from(model)) == count
        assert await db_session.scalar(select(getattr(model, field)).where(model.id == entity_id)) == original[field]
        db_session.expunge_all()
        response_cache.clear()
        detail = await client.get(f"{path}/{entity_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json() == original
        listing = await client.get(path)
        assert listing.status_code == 200, listing.text
        assert next(item for item in listing.json()["items"] if item["id"] == entity_id)[field] == original[field]


@pytest.mark.parametrize("value", NONFINITE)
async def test_nonfinite_initial_remaining_weight_is_rejected(finite_inventory, value):
    client, headers, bodies, records = finite_inventory
    response = await client.post("/api/v1/spools", headers=headers, json={**bodies["spools"], "remaining_weight_g": value})
    assert response.status_code == 422, response.text
    detail = await client.get(f"/api/v1/spools/{records['spools']['id']}")
    assert detail.status_code == 200
    assert detail.json()["remaining_weight_g"] == 500


AUXILIARY_INPUTS = [
    *[(BulkFilamentUpdateRequest, {"filament_ids": [1]}, field) for field in ("price", "diameter_mm", "default_spool_weight_g", "density_g_cm3")],
    *[(BulkSpoolUpdateRequest, {"spool_ids": [1]}, field) for field in ("empty_spool_weight_g", "spool_core_weight_g", "purchase_price")],
    *[(SpoolBulkCreate, {"filament_id": 1}, field) for field in (*SPOOL_FLOATS, "remaining_weight_g")],
    (MeasurementRequest, {}, "measured_weight_g"),
    (AdjustmentRequest, {"adjustment_type": "correction"}, "delta_weight_g"),
    (AdjustmentRequest, {"adjustment_type": "correction"}, "measured_weight_g"),
    (ConsumptionRequest, {}, "delta_weight_g"),
    (DeviceMeasurementRequest, {"external_id": "finite-spool"}, "measured_weight_g"),
    *[(ResolveFilamentFromTagRequest, {}, field) for field in ("diameter", "min_temp", "max_temp")],
]


@pytest.mark.parametrize("schema,required,field", AUXILIARY_INPUTS, ids=[f"{schema.__name__}-{field}" for schema, _, field in AUXILIARY_INPUTS])
def test_other_native_scalar_write_paths_reject_nonfinite(schema, required, field):
    for value in (*NONFINITE, float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValidationError):
            schema(**required, **{field: value})
    for value, expected in (("2.5", 2.5), (0, 0), (-1.25, -1.25)):
        actual = getattr(schema(**required, **{field: value}), field)
        assert actual == (value if schema is ResolveFilamentFromTagRequest else expected)
    if not schema.model_fields[field].is_required():
        assert getattr(schema(**required, **{field: None}), field) is None
        assert field not in schema(**required).model_dump(exclude_unset=True)


@pytest.mark.parametrize("collection,field", [("filaments", "drying_temp_c"), ("manufacturers", "spool_width_mm"), ("spools", "purchase_price")])
async def test_finite_zero_null_and_omitted_controls(finite_inventory, collection, field):
    client, headers, _, records = finite_inventory
    path = f"/api/v1/{collection}/{records[collection]['id']}"
    for value, expected in (("2.5", 2.5), (0, 0), (-1.25, -1.25), (None, None)):
        response = await client.patch(path, headers=headers, json={field: value})
        assert response.status_code == 200, response.text
        assert response.json()[field] == expected
        response = await client.patch(path, headers=headers, json={})
        assert response.status_code == 200, response.text
        assert response.json()[field] == expected


def test_tag_non_numeric_fallback_text_remains_accepted():
    for field in ("diameter", "min_temp", "max_temp"):
        for value in ("", "unknown", "1.75mm", " 🧵 "):
            assert getattr(ResolveFilamentFromTagRequest(**{field: value}), field) == value


@pytest.mark.parametrize("literal", ("1e1000", "-1e1000", "Infinity", "-Infinity", "NaN"))
async def test_raw_nonfinite_json_number_is_rejected(finite_inventory, db_session, literal):
    client, headers, bodies, records = finite_inventory
    path = f"/api/v1/filaments/{records['filaments']['id']}"
    response = await client.patch(
        path, headers={**headers, "Content-Type": "application/json"},
        content='{"drying_temp_c":' + literal + '}',
    )
    assert response.status_code == 422, response.text
    error = response.json()["detail"][0]
    assert error["type"] == "finite_number"
    assert error["loc"] == ["body", "drying_temp_c"]
    assert error["input"] in ("inf", "-inf", "nan")
    count = await db_session.scalar(select(func.count()).select_from(Filament))
    body = dict(bodies["filaments"])
    body.pop("drying_temp_c")
    response = await client.post(
        "/api/v1/filaments", headers={**headers, "Content-Type": "application/json"},
        content=json.dumps(body)[:-1] + ',"drying_temp_c":' + literal + '}',
    )
    assert response.status_code == 422, response.text
    assert await db_session.scalar(select(func.count()).select_from(Filament)) == count
    assert await db_session.scalar(select(Filament.drying_temp_c).where(Filament.id == records["filaments"]["id"])) == 12.5
    db_session.expunge_all()
    response_cache.clear()
    detail = await client.get(path)
    assert detail.status_code == 200
    assert detail.json()["drying_temp_c"] == 12.5
    assert (await client.get("/api/v1/filaments")).status_code == 200


async def test_validation_error_keeps_standard_detail_and_finite_input(finite_inventory):
    client, headers, bodies, _ = finite_inventory
    response = await client.post(
        "/api/v1/spools/bulk", headers=headers,
        json={**bodies["spools"], "quantity": 1.5},
    )
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert len(errors) == 1
    assert errors[0]["type"] == "int_from_float"
    assert errors[0]["loc"] == ["body", "quantity"]
    assert errors[0]["input"] == 1.5
