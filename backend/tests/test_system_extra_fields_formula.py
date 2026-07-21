import pytest
from sqlalchemy import select

from app.models import SystemExtraField


@pytest.mark.asyncio
async def test_regular_definition_response_keeps_pre_formula_shape(auth_client):
    client, csrf_token = auth_client
    response = await client.post(
        "/api/v1/system-extra-fields",
        json={
            "target_type": "spool",
            "key": "legacy_note",
            "label": "Legacy note",
            "field_type": "text",
        },
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 200
    assert response.json() == {
        "target_type": "spool",
        "key": "legacy_note",
        "label": "Legacy note",
        "default_value": None,
        "field_type": "text",
        "options": None,
        "id": response.json()["id"],
        "source": None,
    }


@pytest.mark.asyncio
async def test_legacy_plugin_definition_remains_readable_with_original_shape(
    auth_client, db_session
):
    field = SystemExtraField(
        target_type="filament_printer_param",
        key="legacy_calibration",
        label="Legacy calibration",
        field_type="vendor_specific_type",
        options=["A", "B"],
        source="legacy_plugin",
    )
    db_session.add(field)
    await db_session.commit()
    await db_session.refresh(field)

    client, _ = auth_client
    response = await client.get(
        "/api/v1/system-extra-fields"
        "?target_type=filament_printer_param&source=legacy_plugin"
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "target_type": "filament_printer_param",
            "key": "legacy_calibration",
            "label": "Legacy calibration",
            "default_value": None,
            "field_type": "vendor_specific_type",
            "options": ["A", "B"],
            "id": field.id,
            "source": "legacy_plugin",
        }
    ]


@pytest.mark.asyncio
async def test_formula_definition_response_has_only_formula_contract_fields(auth_client):
    client, csrf_token = auth_client
    response = await client.post(
        "/api/v1/system-extra-fields",
        json={
            "target_type": "filament",
            "key": "display_name",
            "label": "Display name",
            "field_type": "formula",
            "formula": {"upper": [{"var": "designation"}]},
            "show_in_detail": False,
            "show_in_template": True,
            "include_in_api": True,
        },
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 200
    assert response.json() == {
        "target_type": "filament",
        "key": "display_name",
        "label": "Display name",
        "default_value": None,
        "field_type": "formula",
        "options": None,
        "formula": {"upper": [{"var": "designation"}]},
        "show_in_detail": False,
        "show_in_template": True,
        "include_in_api": True,
        "id": response.json()["id"],
        "source": None,
    }


@pytest.mark.asyncio
async def test_formula_routes_require_authentication(client):
    unauthenticated = await client.get("/api/v1/system-extra-fields")
    unauthenticated_preview = await client.post(
        "/api/v1/system-extra-fields/preview",
        json={"formula": {"var": "id"}, "context": {"id": 1}},
    )

    assert unauthenticated.status_code == 401
    assert unauthenticated_preview.status_code == 401


@pytest.mark.asyncio
async def test_formula_preview_preserves_csrf_contract(auth_client):
    authenticated, _ = auth_client
    missing_csrf = await authenticated.post(
        "/api/v1/system-extra-fields/preview",
        json={"formula": {"var": "id"}, "context": {"id": 1}},
    )

    assert missing_csrf.status_code == 403
    assert missing_csrf.json()["code"] == "csrf_failed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"field_type": "formula"}, "requires a formula"),
        (
            {"field_type": "formula", "formula": {"unknown": [1, 2]}},
            "Unsupported JSON Logic operator",
        ),
        (
            {"field_type": "formula", "formula": {"/": [1, 0]}},
            "division by zero",
        ),
        (
            {"field_type": "text", "formula": {"var": "id"}},
            "formula is only valid",
        ),
    ],
)
async def test_create_rejects_invalid_formula_definitions(
    auth_client,
    payload,
    message,
):
    client, csrf_token = auth_client
    response = await client.post(
        "/api/v1/system-extra-fields",
        json={
            "target_type": "spool",
            "key": "invalid_formula",
            "label": "Invalid formula",
            **payload,
        },
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 422
    assert message in response.text


@pytest.mark.asyncio
async def test_regular_field_type_updates_remain_compatible(auth_client, db_session):
    client, csrf_token = auth_client
    field = SystemExtraField(
        target_type="spool",
        key="changeable",
        label="Changeable",
        field_type="text",
    )
    db_session.add(field)
    await db_session.commit()
    await db_session.refresh(field)

    response = await client.put(
        f"/api/v1/system-extra-fields/{field.id}",
        json={"field_type": "dropdown", "options": ["A", "B"]},
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 200
    assert response.json()["field_type"] == "dropdown"


@pytest.mark.asyncio
async def test_formula_conversion_is_rejected_without_changing_row(auth_client, db_session):
    client, csrf_token = auth_client
    field = SystemExtraField(
        target_type="spool",
        key="stored_value",
        label="Stored value",
        field_type="text",
    )
    db_session.add(field)
    await db_session.commit()
    await db_session.refresh(field)

    response = await client.put(
        f"/api/v1/system-extra-fields/{field.id}",
        json={"field_type": "formula", "formula": {"var": "id"}},
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 409
    await db_session.refresh(field)
    assert field.field_type == "text"
    assert field.formula is None


@pytest.mark.asyncio
async def test_formula_to_stored_conversion_is_rejected_without_changing_row(
    auth_client, db_session
):
    client, csrf_token = auth_client
    field = SystemExtraField(
        target_type="spool",
        key="computed_value",
        label="Computed value",
        field_type="formula",
        formula={"var": "id"},
    )
    db_session.add(field)
    await db_session.commit()
    await db_session.refresh(field)

    response = await client.put(
        f"/api/v1/system-extra-fields/{field.id}",
        json={"field_type": "text", "formula": None},
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 409
    await db_session.refresh(field)
    assert field.field_type == "formula"
    assert field.formula == {"var": "id"}


@pytest.mark.asyncio
async def test_delete_checks_exact_cross_entity_var_reference(auth_client, db_session):
    client, csrf_token = auth_client
    stored = SystemExtraField(
        target_type="filament",
        key="temperature",
        label="Temperature",
        field_type="number",
    )
    formula = SystemExtraField(
        target_type="spool",
        key="temperature_label",
        label="Temperature label",
        field_type="formula",
        formula={"cat": [{"var": "filament.custom_fields.temperature"}, " temperature"]},
    )
    db_session.add_all([stored, formula])
    await db_session.commit()

    response = await client.delete(
        f"/api/v1/system-extra-fields/{stored.id}",
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 409
    remaining = await db_session.execute(
        select(SystemExtraField).where(SystemExtraField.id == stored.id)
    )
    assert remaining.scalar_one_or_none() is not None


@pytest.mark.asyncio
async def test_delete_ignores_similar_but_nonmatching_var_reference(
    auth_client, db_session
):
    client, csrf_token = auth_client
    stored = SystemExtraField(
        target_type="filament",
        key="temp",
        label="Temp",
        field_type="number",
    )
    formula = SystemExtraField(
        target_type="filament",
        key="temperature_label",
        label="Temperature label",
        field_type="formula",
        formula={"var": "custom_fields.temperature"},
    )
    db_session.add_all([stored, formula])
    await db_session.commit()

    response = await client.delete(
        f"/api/v1/system-extra-fields/{stored.id}",
        headers={"X-CSRF-Token": csrf_token},
    )

    assert response.status_code == 204
    remaining = await db_session.execute(
        select(SystemExtraField).where(SystemExtraField.id == stored.id)
    )
    assert remaining.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_preview_reports_validation_and_runtime_errors(auth_client):
    client, csrf_token = auth_client
    unknown = await client.post(
        "/api/v1/system-extra-fields/preview",
        json={"formula": {"unknown": [1]}, "context": {}},
        headers={"X-CSRF-Token": csrf_token},
    )
    runtime = await client.post(
        "/api/v1/system-extra-fields/preview",
        json={"formula": {"/": [{"var": "dividend"}, {"var": "divisor"}]}, "context": {"dividend": 1, "divisor": 0}},
        headers={"X-CSRF-Token": csrf_token},
    )

    assert unknown.status_code == 200
    assert "Unsupported JSON Logic operator" in unknown.json()["error"]
    assert runtime.status_code == 200
    assert "division by zero" in runtime.json()["error"]
