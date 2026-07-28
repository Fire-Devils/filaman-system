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
from pydantic import ValidationError
from sqlalchemy import select

from app.api.v1.schemas_system_extra_field import (
    VALID_FIELD_TYPES,
    SystemExtraFieldCreate,
    SystemExtraFieldResponse,
)
from app.core.security import generate_token_secret, hash_token
from app.models import (
    Filament,
    Manufacturer,
    Role,
    Spool,
    SpoolStatus,
    SystemExtraField,
    User,
    UserRole,
    UserSession,
)
from app.services.system_extra_field_compatibility import (
    get_custom_field_value,
    is_existing_value_compatible,
    resolve_custom_field_value,
)

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

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_number_rejects_non_finite_bounds(self, value):
        with pytest.raises(ValidationError, match="must be finite"):
            SystemExtraFieldCreate(**self._base(
                field_type="number",
                config={"min_bound": value},
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

    @pytest.mark.parametrize("target_type", ["vendor", "", "FILAMENT"])
    def test_create_rejects_unknown_target_type(self, target_type):
        with pytest.raises(ValidationError, match="target_type"):
            SystemExtraFieldCreate(**self._base(target_type=target_type))

    @pytest.mark.parametrize("key", ["safe..field", "__proto__", "a.constructor.b"])
    def test_create_rejects_unsafe_field_path(self, key):
        with pytest.raises(ValidationError, match="path segments"):
            SystemExtraFieldCreate(**self._base(key=key))


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


async def _create_filament_with_custom_fields(db_session, custom_fields):
    manufacturer = Manufacturer(name="Compatibility Test Manufacturer")
    filament = Filament(
        manufacturer=manufacturer,
        designation="Compatibility Test Filament",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields=custom_fields,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)
    return filament


async def _create_spool_with_custom_fields(db_session, custom_fields):
    filament = await _create_filament_with_custom_fields(db_session, None)
    status_result = await db_session.execute(select(SpoolStatus).limit(1))
    spool = Spool(
        filament_id=filament.id,
        status_id=status_result.scalar_one().id,
        custom_fields=custom_fields,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


async def _authenticate_user(client, db_session, user):
    secret = generate_token_secret()
    session = UserSession(
        user_id=user.id,
        session_token_hash=hash_token(secret),
    )
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)
    csrf = generate_token_secret()
    client.cookies.set("session_id", f"sess.{session.id}.{secret}")
    client.cookies.set("csrf_token", csrf)
    return csrf


class TestExistingValueCompatibility:
    def test_resolves_nested_dotted_path(self):
        found, value = get_custom_field_value(
            {"quality": {"score": "92.5"}},
            "quality.score",
        )
        assert found is True
        assert value == "92.5"

    def test_distinguishes_missing_path_from_scalar_parent_collision(self):
        assert resolve_custom_field_value(
            {"quality": "legacy"},
            "quality.score",
        ) == ("collision", "legacy")
        assert resolve_custom_field_value(
            {"quality": {}},
            "quality.score",
        ) == ("missing", None)

    @pytest.mark.parametrize(
        ("value", "field_type", "options", "compatible"),
        [
            ("92.5", "number", None, True),
            ("not a number", "number", None, False),
            (True, "checkbox", None, True),
            ("false", "checkbox", None, True),
            ("TRUE", "checkbox", None, False),
            ("yes", "checkbox", None, False),
            ({"min": 10, "max": "20"}, "range", None, True),
            ([10, 20], "range", None, False),
            ("PLA", "dropdown", ["PLA", "PETG"], True),
            ("ABS", "dropdown", ["PLA", "PETG"], False),
            (["PLA", "PETG"], "multiselect", ["PLA", "PETG"], True),
            (["PLA", "ABS"], "multiselect", ["PLA", "PETG"], False),
            ("2026-07-26", "date", None, True),
            ("20260726", "date", None, False),
            ("2026-07-26T14:30:00", "date", None, False),
            ("2026-07-26T14:30:00Z", "datetime", None, True),
            ("2026-07-26", "datetime", None, False),
        ],
    )
    def test_validates_native_storage_shapes(
        self,
        value,
        field_type,
        options,
        compatible,
    ):
        assert is_existing_value_compatible(value, field_type, options) is compatible

    def test_numeric_and_text_config_are_applied_to_retained_values(self):
        assert is_existing_value_compatible(
            20,
            "number",
            config={"min_bound": 10, "max_bound": 30},
        )
        assert not is_existing_value_compatible(
            40,
            "number",
            config={"min_bound": 10, "max_bound": 30},
        )
        assert not is_existing_value_compatible(
            "too long",
            "textarea",
            config={"max_length": 3},
        )

    @pytest.mark.asyncio
    async def test_delete_then_recreate_rejects_incompatible_retained_values(
        self,
        auth_client,
        db_session,
    ):
        filament = await _create_filament_with_custom_fields(
            db_session,
            {"inspection": "yes"},
        )
        client, csrf = auth_client

        created = await _create_field(
            client,
            csrf,
            key="inspection",
            label="Inspection",
            field_type="text",
        )
        assert created.status_code == 200

        deleted = await client.delete(
            f"{_ENDPOINT}/{created.json()['id']}",
            headers={"X-CSRF-Token": csrf},
        )
        assert deleted.status_code == 204

        recreated = await _create_field(
            client,
            csrf,
            key="inspection",
            label="Inspection",
            field_type="checkbox",
        )
        assert recreated.status_code == 409
        detail = recreated.json()["detail"]
        assert detail["code"] == "incompatible_existing_values"
        assert detail["incompatible_count"] == 1
        assert detail["sample_record_ids"] == [filament.id]

    @pytest.mark.asyncio
    async def test_recreate_allows_compatible_retained_values(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"inspection": True},
        )
        client, csrf = auth_client

        response = await _create_field(
            client,
            csrf,
            key="inspection",
            label="Inspection",
            field_type="checkbox",
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_nested_incompatible_value_is_detected(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"quality": {"score": "not a number"}},
        )
        client, csrf = auth_client

        response = await _create_field(
            client,
            csrf,
            key="quality.score",
            label="Quality score",
            field_type="number",
        )
        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_scalar_parent_collision_is_detected(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"quality": "legacy"},
        )
        client, csrf = auth_client

        response = await _create_field(
            client,
            csrf,
            key="quality.score",
            label="Quality score",
            field_type="text",
        )

        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_spool_values_are_checked_without_cross_target_false_positive(
        self,
        auth_client,
        db_session,
    ):
        await _create_spool_with_custom_fields(
            db_session,
            {"inspection": ["unexpected"]},
        )
        client, csrf = auth_client

        filament_response = await _create_field(
            client,
            csrf,
            target_type="filament",
            key="inspection",
            label="Filament inspection",
            field_type="number",
        )
        assert filament_response.status_code == 200

        spool_response = await _create_field(
            client,
            csrf,
            target_type="spool",
            key="inspection",
            label="Spool inspection",
            field_type="number",
        )
        assert spool_response.status_code == 409

    @pytest.mark.asyncio
    async def test_dropdown_options_must_include_retained_value(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"material_family": "ABS"},
        )
        client, csrf = auth_client

        response = await _create_field(
            client,
            csrf,
            key="material_family",
            label="Material family",
            field_type="dropdown",
            options=["PLA", "PETG"],
        )
        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_system_definition_paths_cannot_overlap(self, auth_client):
        client, csrf = auth_client
        created = await _create_field(
            client,
            csrf,
            key="quality",
            label="Quality",
        )
        assert created.status_code == 200

        child = await _create_field(
            client,
            csrf,
            key="quality.score",
            label="Quality score",
        )
        assert child.status_code == 400
        assert "overlaps" in child.json()["detail"]

    @pytest.mark.asyncio
    async def test_internal_transactional_conversion_is_not_blocked(
        self,
        db_session,
    ):
        """Import/repair services can still define and convert a field atomically."""
        filament = await _create_filament_with_custom_fields(
            db_session,
            {"inspection": "yes"},
        )
        definition = SystemExtraField(
            target_type="filament",
            key="inspection",
            label="Inspection",
            field_type="checkbox",
        )
        db_session.add(definition)
        filament.custom_fields = {"inspection": True}
        await db_session.commit()
        await db_session.refresh(definition)
        await db_session.refresh(filament)

        assert definition.id is not None
        assert filament.custom_fields == {"inspection": True}


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
    async def test_change_field_type_rejects_incompatible_retained_values(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"inspection": "yes"},
        )
        client, csrf = auth_client
        create_resp = await _create_field(
            client,
            csrf,
            key="inspection",
            label="Inspection",
            field_type="text",
        )

        patch_resp = await client.put(
            f"{_ENDPOINT}/{create_resp.json()['id']}",
            json={"field_type": "checkbox"},
            headers={"X-CSRF-Token": csrf},
        )

        assert patch_resp.status_code == 409
        assert patch_resp.json()["detail"]["code"] == "incompatible_existing_values"

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

    @pytest.mark.asyncio
    async def test_update_dropdown_cannot_remove_retained_option(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"material_family": "ABS"},
        )
        client, csrf = auth_client
        create_resp = await _create_field(
            client,
            csrf,
            key="material_family",
            label="Material family",
            field_type="dropdown",
            options=["PLA", "ABS"],
        )

        patch_resp = await client.put(
            f"{_ENDPOINT}/{create_resp.json()['id']}",
            json={"options": ["PLA"]},
            headers={"X-CSRF-Token": csrf},
        )

        assert patch_resp.status_code == 409

    @pytest.mark.asyncio
    async def test_update_bounds_cannot_exclude_retained_number(
        self,
        auth_client,
        db_session,
    ):
        await _create_filament_with_custom_fields(
            db_session,
            {"temperature": 220},
        )
        client, csrf = auth_client
        create_resp = await _create_field(
            client,
            csrf,
            key="temperature",
            label="Temperature",
            field_type="number",
            config={"min_bound": 0, "max_bound": 300},
        )

        patch_resp = await client.put(
            f"{_ENDPOINT}/{create_resp.json()['id']}",
            json={"config": {"min_bound": 0, "max_bound": 200}},
            headers={"X-CSRF-Token": csrf},
        )

        assert patch_resp.status_code == 409


class TestSystemExtraFieldPermissions:
    @pytest.mark.asyncio
    async def test_unauthenticated_mutation_returns_401(self, client):
        csrf = generate_token_secret()
        client.cookies.set("csrf_token", csrf)

        response = await _create_field(client, csrf, key="unauthenticated")

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_user_without_permission_returns_403(
        self,
        client,
        normal_user,
        db_session,
    ):
        csrf = await _authenticate_user(client, db_session, normal_user)

        response = await _create_field(client, csrf, key="forbidden")

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_seeded_admin_role_can_manage_system_fields(
        self,
        client,
        db_session,
    ):
        admin_role = (
            await db_session.execute(select(Role).where(Role.key == "admin"))
        ).scalar_one()
        user = User(
            email="rbac-admin@example.com",
            display_name="RBAC Admin",
            is_superadmin=False,
            is_active=True,
        )
        db_session.add(user)
        await db_session.flush()
        db_session.add(UserRole(user_id=user.id, role_id=admin_role.id))
        await db_session.commit()
        await db_session.refresh(user)
        csrf = await _authenticate_user(client, db_session, user)

        response = await _create_field(client, csrf, key="rbac_allowed")

        assert response.status_code == 200


class TestPluginFieldProtection:
    @pytest.mark.asyncio
    async def test_plugin_field_cannot_be_edited(self, auth_client, db_session):
        """A field with source set must return 403 on PUT."""
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
        assert resp.json()["detail"] == (
            "Cannot edit plugin-managed field (source: test_plugin). "
            "Plugin fields are read-only."
        )

    @pytest.mark.asyncio
    async def test_plugin_field_cannot_be_deleted(self, auth_client, db_session):
        field = SystemExtraField(
            target_type="filament",
            key="plugin_delete_field",
            label="Plugin Delete Field",
            field_type="text",
            source="test_plugin",
        )
        db_session.add(field)
        await db_session.commit()
        await db_session.refresh(field)

        client, csrf = auth_client
        resp = await client.delete(
            f"{_ENDPOINT}/{field.id}",
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == (
            "Cannot delete plugin-managed field (source: test_plugin). "
            "Uninstall the plugin to remove its fields."
        )

    @pytest.mark.asyncio
    async def test_plugin_field_can_be_read(self, auth_client, db_session):
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
