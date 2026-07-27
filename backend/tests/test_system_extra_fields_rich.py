"""
Tests for rich field types on SystemExtraField (feat/rich-field-types).

Covers:
  - Schema / Pydantic validator unit tests (no DB)
  - API integration tests for all new field types
  - config column roundtrip
  - backwards compatibility for existing definition API payloads
  - plugin-source protection
"""

import pytest
from app.api.v1.schemas_system_extra_field import (
    VALID_FIELD_TYPES,
    SystemExtraFieldCreate,
    SystemExtraFieldResponse,
)
from pydantic import ValidationError

# ──────────────────────────────────────────────────────────────
# Schema / validator unit tests  (pure Pydantic, no DB, no HTTP)
# ──────────────────────────────────────────────────────────────


class TestValidFieldTypes:
    def test_all_11_types_present(self):
        expected = {
            "text", "number", "range",
            "dropdown", "checkbox", "formula",
            "date", "datetime", "url", "multiselect", "textarea",
        }
        assert VALID_FIELD_TYPES == expected

    def test_frozenset_immutable(self):
        with pytest.raises(AttributeError):
            VALID_FIELD_TYPES.add("invalid")  # type: ignore[attr-defined]


class TestSchemaValidation:
    """Unit tests for SystemExtraFieldCreate model_validator."""

    def _base(self, **overrides):
        defaults = {
            "target_type": "filament",
            "key": "test_field",
            "label": "Test Field",
            "field_type": "text",
        }
        defaults.update(overrides)
        return defaults

    # ── valid field types ──

    def test_valid_type_text(self):
        SystemExtraFieldCreate(**self._base(field_type="text"))

    def test_valid_type_number(self):
        SystemExtraFieldCreate(**self._base(field_type="number"))

    def test_valid_type_range(self):
        SystemExtraFieldCreate(**self._base(field_type="range"))

    def test_valid_type_date(self):
        SystemExtraFieldCreate(**self._base(field_type="date"))

    def test_valid_type_datetime(self):
        SystemExtraFieldCreate(**self._base(field_type="datetime"))

    def test_valid_type_url(self):
        SystemExtraFieldCreate(**self._base(field_type="url"))

    def test_valid_type_textarea(self):
        SystemExtraFieldCreate(**self._base(field_type="textarea"))

    def test_valid_type_multiselect_with_options(self):
        SystemExtraFieldCreate(**self._base(field_type="multiselect", options=["A", "B"]))

    def test_valid_type_dropdown_with_options(self):
        SystemExtraFieldCreate(**self._base(field_type="dropdown", options=["X", "Y"]))

    # ── legacy API compatibility ──

    def test_spoolman_style_integer_type_remains_accepted(self):
        field = SystemExtraFieldCreate(**self._base(field_type="integer"))
        assert field.field_type == "integer"

    def test_unknown_field_type_remains_accepted(self):
        field = SystemExtraFieldCreate(**self._base(field_type="freetext"))
        assert field.field_type == "freetext"

    def test_legacy_float_type_remains_accepted(self):
        field = SystemExtraFieldCreate(**self._base(field_type="float"))
        assert field.field_type == "float"

    # ── options required for dropdown / multiselect ──

    def test_dropdown_without_options_remains_accepted(self):
        SystemExtraFieldCreate(**self._base(field_type="dropdown", options=None))

    def test_dropdown_empty_options_remains_accepted(self):
        SystemExtraFieldCreate(**self._base(field_type="dropdown", options=[]))

    def test_multiselect_without_options_raises(self):
        with pytest.raises(ValidationError, match="options must be provided"):
            SystemExtraFieldCreate(**self._base(field_type="multiselect", options=None))

    # ── range config bounds validation ──

    def test_range_valid_bounds(self):
        SystemExtraFieldCreate(**self._base(
            field_type="range",
            config={"min_bound": 0, "max_bound": 100},
        ))

    def test_range_min_equals_max_raises(self):
        with pytest.raises(ValidationError, match="min_bound must be less than"):
            SystemExtraFieldCreate(**self._base(
                field_type="range",
                config={"min_bound": 10, "max_bound": 10},
            ))

    def test_range_min_greater_than_max_raises(self):
        with pytest.raises(ValidationError, match="min_bound must be less than"):
            SystemExtraFieldCreate(**self._base(
                field_type="range",
                config={"min_bound": 50, "max_bound": 10},
            ))

    def test_number_min_greater_than_max_raises(self):
        with pytest.raises(ValidationError, match="min_bound must be less than"):
            SystemExtraFieldCreate(**self._base(
                field_type="number",
                config={"min_bound": 50, "max_bound": 10},
            ))

    def test_range_config_none_is_valid(self):
        """Range without config (no bounds) is allowed."""
        SystemExtraFieldCreate(**self._base(field_type="range", config=None))

    def test_range_partial_bounds_no_validation_error(self):
        """Only min_bound or only max_bound is fine — both needed to compare."""
        SystemExtraFieldCreate(**self._base(
            field_type="range",
            config={"min_bound": 10, "max_bound": None},
        ))

    # ── config is optional for scalar types ──

    def test_number_config_with_unit_and_dp(self):
        SystemExtraFieldCreate(**self._base(
            field_type="number",
            config={"unit": "mm", "decimal_places": 2},
        ))

    def test_text_config_none(self):
        SystemExtraFieldCreate(**self._base(field_type="text", config=None))

    def test_text_rejects_numeric_config(self):
        with pytest.raises(ValidationError, match="Unsupported config keys"):
            SystemExtraFieldCreate(**self._base(
                field_type="text",
                config={"min_bound": 0},
            ))

    def test_text_with_options_remains_accepted(self):
        SystemExtraFieldCreate(**self._base(
            field_type="text",
            options=["unused"],
        ))

    def test_textarea_with_max_length(self):
        SystemExtraFieldCreate(**self._base(
            field_type="textarea",
            config={"max_length": 500},
        ))

    def test_number_rejects_non_numeric_bound(self):
        with pytest.raises(ValidationError, match="min_bound must be a number"):
            SystemExtraFieldCreate(**self._base(
                field_type="number",
                config={"min_bound": "low"},
            ))

    def test_textarea_rejects_invalid_max_length(self):
        with pytest.raises(ValidationError, match="max_length must be a positive integer"):
            SystemExtraFieldCreate(**self._base(
                field_type="textarea",
                config={"max_length": 0},
            ))

    def test_response_allows_legacy_dropdown_without_options(self):
        """Existing invalid rows must not make the list endpoint fail after migration."""
        response = SystemExtraFieldResponse.model_validate({
            **self._base(field_type="dropdown", options=None),
            "id": 1,
        })
        assert response.options is None
        assert "config" not in response.model_dump()


# ──────────────────────────────────────────────────────────────
# API integration tests
# ──────────────────────────────────────────────────────────────

_ENDPOINT = "/api/v1/system-extra-fields"


async def _create_field(client, csrf_token, **overrides):
    """Helper: POST a new system extra field and return the response JSON."""
    payload = {
        "target_type": "filament",
        "key": "test_key",
        "label": "Test Label",
        "field_type": "text",
    }
    payload.update(overrides)
    resp = await client.post(
        _ENDPOINT,
        json=payload,
        headers={"X-CSRF-Token": csrf_token},
    )
    return resp


class TestCreateRichFieldTypes:
    @pytest.mark.asyncio
    async def test_create_number_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="print_temp", label="Print Temp", field_type="number",
            config={"unit": "°C", "decimal_places": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["field_type"] == "number"
        assert data["config"]["unit"] == "°C"
        assert data["config"]["decimal_places"] == 1

    @pytest.mark.asyncio
    async def test_create_range_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="temp_range", label="Temp Range", field_type="range",
            config={"unit": "°C", "min_bound": 0, "max_bound": 300},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["field_type"] == "range"
        assert data["config"]["min_bound"] == 0
        assert data["config"]["max_bound"] == 300

    @pytest.mark.asyncio
    async def test_create_date_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf, key="expire_date", label="Expiry", field_type="date",
        )
        assert resp.status_code == 200
        assert resp.json()["field_type"] == "date"

    @pytest.mark.asyncio
    async def test_create_datetime_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client,
            csrf,
            key="certified_at",
            label="Certified at",
            field_type="datetime",
            default_value="2026-07-26T14:30",
        )
        assert resp.status_code == 200
        assert resp.json()["field_type"] == "datetime"
        assert resp.json()["default_value"] == "2026-07-26T14:30"

    @pytest.mark.asyncio
    async def test_create_url_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf, key="datasheet_url", label="Datasheet", field_type="url",
        )
        assert resp.status_code == 200
        assert resp.json()["field_type"] == "url"

    @pytest.mark.asyncio
    async def test_create_multiselect_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="tags", label="Tags", field_type="multiselect",
            options=["PLA", "PETG", "ABS"],
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["field_type"] == "multiselect"
        assert "PLA" in data["options"]

    @pytest.mark.asyncio
    async def test_create_textarea_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="notes", label="Notes", field_type="textarea",
            config={"max_length": 500},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["field_type"] == "textarea"
        assert data["config"]["max_length"] == 500

    @pytest.mark.asyncio
    async def test_create_unknown_type_preserves_existing_api_behavior(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf, key="bad_field", label="Bad", field_type="integer",
        )
        assert resp.status_code == 200
        assert resp.json()["field_type"] == "integer"

    @pytest.mark.asyncio
    async def test_create_multiselect_without_options_returns_422(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="no_opts", label="No Options", field_type="multiselect",
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_range_invalid_bounds_returns_422(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf,
            key="bad_range", label="Bad Range", field_type="range",
            config={"min_bound": 100, "max_bound": 10},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_config_null_for_text_field(self, auth_client):
        client, csrf = auth_client
        resp = await _create_field(
            client, csrf, key="plain_text", label="Plain", field_type="text",
        )
        assert resp.status_code == 200
        assert "config" not in resp.json()

    @pytest.mark.asyncio
    async def test_duplicate_key_returns_400(self, auth_client):
        client, csrf = auth_client
        await _create_field(client, csrf, key="dupe_key", label="First", field_type="text")
        resp = await _create_field(client, csrf, key="dupe_key", label="Second", field_type="text")
        assert resp.status_code == 400


class TestFieldTypeUpdates:
    @pytest.mark.asyncio
    async def test_change_field_type_preserves_existing_api_behavior(self, auth_client):
        client, csrf = auth_client
        create_resp = await _create_field(
            client, csrf, key="immutable_type", label="Immut", field_type="text",
        )
        assert create_resp.status_code == 200
        field_id = create_resp.json()["id"]

        patch_resp = await client.put(
            f"{_ENDPOINT}/{field_id}",
            json={"field_type": "number"},
            headers={"X-CSRF-Token": csrf},
        )
        assert patch_resp.status_code == 200
        assert patch_resp.json()["field_type"] == "number"

    @pytest.mark.asyncio
    async def test_update_same_field_type_is_allowed(self, auth_client):
        """Sending the same field_type in an update remains supported."""
        client, csrf = auth_client
        create_resp = await _create_field(
            client, csrf, key="same_type", label="Same", field_type="text",
        )
        assert create_resp.status_code == 200
        field_id = create_resp.json()["id"]

        patch_resp = await client.put(
            f"{_ENDPOINT}/{field_id}",
            json={"label": "Updated Label", "field_type": "text"},
            headers={"X-CSRF-Token": csrf},
        )
        assert patch_resp.status_code == 200
        assert patch_resp.json()["label"] == "Updated Label"

    @pytest.mark.asyncio
    async def test_update_config_without_changing_type(self, auth_client):
        client, csrf = auth_client
        create_resp = await _create_field(
            client, csrf,
            key="upd_cfg", label="Update Config", field_type="number",
            config={"unit": "mm", "decimal_places": 1},
        )
        assert create_resp.status_code == 200
        field_id = create_resp.json()["id"]

        patch_resp = await client.put(
            f"{_ENDPOINT}/{field_id}",
            json={"config": {"unit": "cm", "decimal_places": 2}},
            headers={"X-CSRF-Token": csrf},
        )
        assert patch_resp.status_code == 200
        updated = patch_resp.json()
        assert updated["config"]["unit"] == "cm"
        assert updated["config"]["decimal_places"] == 2

    @pytest.mark.asyncio
    async def test_update_invalid_range_config_returns_422(self, auth_client):
        client, csrf = auth_client
        create_resp = await _create_field(
            client, csrf,
            key="upd_range", label="Update Range", field_type="range",
            config={"min_bound": 0, "max_bound": 100},
        )
        assert create_resp.status_code == 200
        field_id = create_resp.json()["id"]

        patch_resp = await client.put(
            f"{_ENDPOINT}/{field_id}",
            json={"config": {"min_bound": 100, "max_bound": 10}},
            headers={"X-CSRF-Token": csrf},
        )
        assert patch_resp.status_code == 422
        assert "min_bound must be less than" in patch_resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_update_multiselect_options_cannot_be_cleared(self, auth_client):
        client, csrf = auth_client
        create_resp = await _create_field(
            client, csrf,
            key="upd_multi", label="Update Multi", field_type="multiselect",
            options=["A", "B"],
        )
        assert create_resp.status_code == 200
        field_id = create_resp.json()["id"]

        patch_resp = await client.put(
            f"{_ENDPOINT}/{field_id}",
            json={"options": []},
            headers={"X-CSRF-Token": csrf},
        )
        assert patch_resp.status_code == 422
        assert "options must be provided" in patch_resp.json()["detail"]


class TestPluginFieldProtection:
    @pytest.mark.asyncio
    async def test_plugin_field_cannot_be_edited(self, auth_client, db_session):
        """A field with source set must return 403 on PUT."""
        from app.models.system_extra_field import SystemExtraField

        field = SystemExtraField(
            target_type="filament",
            key="plugin_field",
            label="Plugin Field",
            field_type="text",
            source="test_plugin",
        )
        db_session.add(field)
        await db_session.commit()
        await db_session.refresh(field)

        client, csrf = auth_client
        resp = await client.put(
            f"{_ENDPOINT}/{field.id}",
            json={"label": "Hacked"},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_plugin_field_can_be_read(self, auth_client, db_session):
        from app.models.system_extra_field import SystemExtraField

        field = SystemExtraField(
            target_type="spool",
            key="plugin_spool_field",
            label="Plugin Spool",
            field_type="text",
            source="test_plugin",
        )
        db_session.add(field)
        await db_session.commit()
        await db_session.refresh(field)

        client, _ = auth_client
        resp = await client.get(f"{_ENDPOINT}?target_type=spool")
        assert resp.status_code == 200
        keys = [f["key"] for f in resp.json()]
        assert "plugin_spool_field" in keys


class TestGetReturnsConfigField:
    @pytest.mark.asyncio
    async def test_get_list_includes_config(self, auth_client):
        client, csrf = auth_client
        await _create_field(
            client, csrf,
            key="cfg_check", label="Config Check", field_type="number",
            config={"unit": "kg", "decimal_places": 3},
        )
        resp = await client.get(f"{_ENDPOINT}?target_type=filament")
        assert resp.status_code == 200
        items = resp.json()
        match = next((f for f in items if f["key"] == "cfg_check"), None)
        assert match is not None
        assert "config" in match
        assert match["config"]["unit"] == "kg"

    @pytest.mark.asyncio
    async def test_get_returns_config_none_for_unset(self, auth_client):
        client, csrf = auth_client
        await _create_field(
            client, csrf, key="no_cfg", label="No Config", field_type="text",
        )
        resp = await client.get(f"{_ENDPOINT}?target_type=filament")
        assert resp.status_code == 200
        match = next((f for f in resp.json() if f["key"] == "no_cfg"), None)
        assert match is not None
        assert "config" not in match
