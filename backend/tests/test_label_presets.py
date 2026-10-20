import json

import pytest
from sqlalchemy import delete, func, select

from app.models import LabelPreset
from app.models.label_preset import label_preset_name_key
from tests.support.backup import export_backup_data


class TestLabelPresets:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("format", ["json", "jsonl"])
    async def test_restore_converts_legacy_presets(self, auth_client, db_session, admin_user, tmp_path, monkeypatch, format):
        from app.api.v1 import system
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        preset = LabelPreset(user_id=admin_user.id, preset_type="spool", name="Old", name_key=label_preset_name_key("Old"),
            selected=True, data={"settings": {"label": {"width": 40, "height": 30}}})
        db_session.add(preset)
        await db_session.commit()
        preset_id = preset.id
        client, csrf = auth_client
        exported = await client.get(f"/api/v1/admin/system/backup/export?format={format}")
        assert exported.status_code == 200
        response = await client.post("/api/v1/admin/system/backup/import", files={
            "file": (f"backup.{format}", exported.content, exported.headers["content-type"])},
            headers={"X-CSRF-Token": csrf})
        assert response.status_code == 200, response.text
        db_session.expire_all()
        restored = await db_session.get(LabelPreset, preset_id)
        assert restored.selected is True
        assert restored.data["version"] == 2
        assert restored.data["design"]["label"]["widthMm"] == 40

    @pytest.mark.asyncio
    @pytest.mark.parametrize("method", ["put", "migrate"])
    async def test_legacy_input_is_persisted_as_v2(self, auth_client, db_session, method):
        client, csrf = auth_client
        source = {"version": 1, "settings": {"label": {"width": 40, "height": 30}}}
        body = {"name": "Legacy", "data": source}
        response = await client.put("/api/v1/me/label-presets/spool/item", json=body,
            headers={"X-CSRF-Token": csrf}) if method == "put" else await client.post(
                "/api/v1/me/label-presets/migrate", json={"presets": [{**body, "preset_type": "spool"}]},
                headers={"X-CSRF-Token": csrf})
        assert response.status_code == 200
        item = response.json() if method == "put" else response.json()[0]
        assert item["data"]["version"] == 2
        assert item["data"]["legacy_v1"] == source["settings"]
        stored = await db_session.get(LabelPreset, item["id"])
        assert stored.data == item["data"]

    @pytest.mark.asyncio
    async def test_spool_preset_selection_is_user_scoped(
        self, auth_client, db_session, admin_user, normal_user
    ):
        client, csrf_token = auth_client
        first = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="First",
            name_key=label_preset_name_key("First"),
            data={},
        )
        second = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Second",
            name_key=label_preset_name_key("Second"),
            data={},
        )
        foreign = LabelPreset(
            user_id=normal_user.id,
            preset_type="spool",
            name="Foreign",
            name_key=label_preset_name_key("Foreign"),
            data={},
        )
        filament = LabelPreset(
            user_id=admin_user.id,
            preset_type="filament",
            name="Filament",
            name_key=label_preset_name_key("Filament"),
            data={},
        )
        db_session.add_all([first, second, foreign, filament])
        await db_session.commit()

        selection_path = "/api/v1/me/label-presets/selection"
        response = await client.put(
            selection_path,
            json={"preset_id": first.id},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204
        assert (await client.get("/api/v1/labels/presets")).json() == [
            {"id": first.id, "name": first.name, "selected": True, "width_mm": None, "height_mm": None},
            {"id": second.id, "name": second.name, "selected": False, "width_mm": None, "height_mm": None},
        ]

        for preset_id in (foreign.id, filament.id, 999_999):
            response = await client.put(
                selection_path,
                json={"preset_id": preset_id},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 404

        after_rejections = await client.get("/api/v1/labels/presets")
        assert next(
            item for item in after_rejections.json() if item["id"] == first.id
        )["selected"] is True

        response = await client.put(
            selection_path,
            json={"preset_id": None},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204
        assert all(
            not item["selected"]
            for item in (await client.get("/api/v1/labels/presets")).json()
        )

    @pytest.mark.asyncio
    async def test_spool_preset_selection_requires_spool_read_scope(
        self, client, db_session, normal_user
    ):
        from app.core.middleware import invalidate_auth_caches
        from app.core.security import generate_token_secret, hash_token
        from app.models import UserApiKey

        preset = LabelPreset(
            user_id=normal_user.id,
            preset_type="spool",
            name="Restricted",
            name_key=label_preset_name_key("Restricted"),
            data={},
        )
        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=normal_user.id,
            name="Restricted scale",
            key_hash=hash_token(secret),
            scopes=[],
        )
        db_session.add_all([preset, api_key])
        await db_session.commit()
        headers = {"Authorization": f"ApiKey uak.{api_key.id}.{secret}"}

        denied = await client.put(
            "/api/v1/me/label-presets/selection",
            json={"preset_id": preset.id},
            headers=headers,
        )

        assert denied.status_code == 403
        await db_session.refresh(preset)
        assert preset.selected is False

        api_key.scopes = ["spools:read"]
        await db_session.commit()
        invalidate_auth_caches()
        allowed = await client.put(
            "/api/v1/me/label-presets/selection",
            json={"preset_id": preset.id},
            headers=headers,
        )
        assert allowed.status_code == 204

    @pytest.mark.asyncio
    async def test_spool_upsert_preserves_selection_and_delete_restores_default(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        first = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "First", "data": {}},
            headers={"X-CSRF-Token": csrf_token},
        )
        second = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Second", "data": {}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert first.status_code == second.status_code == 200

        selected = await client.put(
            "/api/v1/me/label-presets/selection",
            json={"preset_id": first.json()["id"]},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert selected.status_code == 204
        updated = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Second", "data": {"settings": {"width": 72}}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert updated.status_code == 200

        first_row = await db_session.get(LabelPreset, first.json()["id"])
        second_row = await db_session.get(LabelPreset, second.json()["id"])
        await db_session.refresh(first_row)
        await db_session.refresh(second_row)
        assert first_row.selected is True
        assert second_row.selected is False

        response = await client.delete(
            "/api/v1/me/label-presets/spool/item?name=First",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204
        assert (await client.get("/api/v1/labels/presets")).json() == [
            {"id": second_row.id, "name": second_row.name, "selected": False, "width_mm": None, "height_mm": None}
        ]

    @pytest.mark.asyncio
    async def test_upsert_and_list_presets(self, auth_client):
        client, csrf_token = auth_client
        for name, width in (("Compact", 40), ("Wide", 70)):
            response = await client.put(
                "/api/v1/me/label-presets/spool/item",
                json={"name": name, "data": {"settings": {"width": width}}},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 200

        response = await client.get("/api/v1/me/label-presets?preset_type=spool")
        assert response.status_code == 200
        assert {item["preset_type"] for item in response.json()} == {"spool"}

        response = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Wide", "data": {"settings": {"width": 75}}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200
        assert response.json()["data"]["settings"]["width"] == 75

        response = await client.get("/api/v1/me/label-presets")
        assert [item["name"] for item in response.json()] == ["Compact", "Wide"]

    @pytest.mark.asyncio
    async def test_create_only_save_rejects_an_existing_name_without_overwriting(
        self, auth_client
    ):
        client, csrf_token = auth_client
        original = {"settings": {"source": "first tab"}}
        created = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Shared", "data": original},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert created.status_code == 200

        conflict = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={
                "name": "Shared",
                "data": {"settings": {"source": "stale second tab"}},
                "create_only": True,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert conflict.status_code == 409
        response = await client.get("/api/v1/me/label-presets?preset_type=spool")
        assert response.json()[0]["data"] == original

    @pytest.mark.asyncio
    async def test_create_only_save_cannot_rename_an_existing_preset(
        self, auth_client
    ):
        client, csrf_token = auth_client
        original = {"settings": {"source": "original"}}
        created = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Original", "data": original},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert created.status_code == 200

        conflict = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={
                "name": "Renamed",
                "previous_name": "Original",
                "data": {"settings": {"source": "replacement"}},
                "create_only": True,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert conflict.status_code == 422
        response = await client.get("/api/v1/me/label-presets?preset_type=spool")
        assert [(item["name"], item["data"]) for item in response.json()] == [
            ("Original", original)
        ]

    @pytest.mark.asyncio
    async def test_native_api_contract_and_api_key_auth(
        self, client, db_session, normal_user
    ):
        from app.core.security import generate_token_secret, hash_token
        from app.models import UserApiKey

        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=normal_user.id,
            name="Preset client",
            key_hash=hash_token(secret),
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)
        headers = {"Authorization": f"ApiKey uak.{api_key.id}.{secret}"}

        response = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "  API preset  ", "data": {"settings": {"width": 48}}},
            headers=headers,
        )

        assert response.status_code == 200
        payload = response.json()
        assert set(payload) == {
            "id",
            "preset_type",
            "name",
            "data",
            "created_at",
            "updated_at",
        }
        assert payload["preset_type"] == "spool"
        assert payload["name"] == "API preset"
        assert payload["data"] == {"settings": {"width": 48}}
        assert isinstance(payload["id"], int)
        assert isinstance(payload["created_at"], str)
        assert isinstance(payload["updated_at"], str)

        response = await client.get(
            "/api/v1/me/label-presets?preset_type=spool", headers=headers
        )
        assert response.status_code == 200
        assert response.json() == [payload]

        response = await client.delete(
            "/api/v1/me/label-presets/spool/item?name=API%20preset",
            headers=headers,
        )
        assert response.status_code == 204
        assert response.content == b""

    @pytest.mark.asyncio
    async def test_browser_migration_adds_missing_without_overwriting(
        self, auth_client
    ):
        client, csrf_token = auth_client
        await client.put(
            "/api/v1/me/label-presets/filament/item",
            json={
                "name": "Default",
                "data": {"settings": {"source": "database"}},
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        response = await client.post(
            "/api/v1/me/label-presets/migrate",
            json={
                "presets": [
                    {
                        "preset_type": "filament",
                        "name": "Default",
                        "data": {"settings": {"source": "browser"}},
                    },
                    {
                        "preset_type": "sheet",
                        "name": "My Avery Sheet",
                        "data": {
                            "id": "legacy-sheet",
                            "settings": {"rows": 10, "columns": 3},
                        },
                    },
                ]
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        presets = {
            (item["preset_type"], item["name"]): item for item in response.json()
        }
        assert (
            presets[("filament", "Default")]["data"]["settings"]["source"] == "database"
        )
        assert presets[("sheet", "My Avery Sheet")]["data"]["id"] == "legacy-sheet"

    @pytest.mark.asyncio
    async def test_browser_migration_enforces_accumulated_type_limit(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        response = await client.post(
            "/api/v1/me/label-presets/migrate",
            json={
                "presets": [
                    {
                        "preset_type": "spool",
                        "name": f"Preset {index}",
                        "data": {"settings": {"index": index}},
                    }
                    for index in range(100)
                ]
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200

        response = await client.post(
            "/api/v1/me/label-presets/migrate",
            json={
                "presets": [
                    {
                        "preset_type": "spool",
                        "name": "Preset 101",
                        "data": {"settings": {}},
                    }
                ]
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        count = await db_session.scalar(select(func.count()).select_from(LabelPreset))
        assert count == 100

    @pytest.mark.asyncio
    async def test_single_preset_mutations_preserve_siblings(self, auth_client):
        client, csrf_token = auth_client
        for name in ("First", "Second"):
            response = await client.put(
                "/api/v1/me/label-presets/spool/item",
                json={"name": name, "data": {"settings": {"name": name}}},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 200

        response = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Second", "data": {"settings": {"updated": True}}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200

        response = await client.delete(
            "/api/v1/me/label-presets/spool/item?name=First",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204

        response = await client.get("/api/v1/me/label-presets?preset_type=spool")
        assert response.status_code == 200
        assert [item["name"] for item in response.json()] == ["Second"]
        assert response.json()[0]["data"]["settings"] == {"updated": True}

    @pytest.mark.asyncio
    async def test_preset_rename_is_atomic(self, auth_client):
        client, csrf_token = auth_client
        for name in ("Original", "Sibling"):
            response = await client.put(
                "/api/v1/me/label-presets/sheet/item",
                json={"name": name, "data": {"settings": {"name": name}}},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 200

        response = await client.put(
            "/api/v1/me/label-presets/sheet/item",
            json={
                "name": "Renamed",
                "previous_name": "Original",
                "data": {"settings": {"renamed": True}},
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200

        response = await client.get("/api/v1/me/label-presets?preset_type=sheet")
        assert [item["name"] for item in response.json()] == ["Renamed", "Sibling"]

        response = await client.put(
            "/api/v1/me/label-presets/sheet/item",
            json={
                "name": "Sibling",
                "previous_name": "Renamed",
                "data": {"settings": {}},
            },
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 409

        response = await client.get("/api/v1/me/label-presets?preset_type=sheet")
        assert [item["name"] for item in response.json()] == ["Renamed", "Sibling"]

    @pytest.mark.asyncio
    async def test_non_finite_preset_json_is_rejected(self, auth_client, db_session):
        client, csrf_token = auth_client
        response = await client.put(
            "/api/v1/me/label-presets/filament/item",
            content=b'{"name":"Invalid","data":{"value":NaN}}',
            headers={
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "validation_error"
        count = await db_session.scalar(select(func.count()).select_from(LabelPreset))
        assert count == 0

    @pytest.mark.asyncio
    async def test_preset_names_are_database_safe_and_portably_unique(
        self, auth_client
    ):
        client, csrf_token = auth_client
        for name, width in (("Favorite 🎨 / draft", 40), ("favorite 🎨 / draft", 50)):
            response = await client.put(
                "/api/v1/me/label-presets/spool/item",
                json={"name": name, "data": {"settings": {"width": width}}},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 200

        response = await client.get("/api/v1/me/label-presets?preset_type=spool")
        assert len(response.json()) == 2
        assert {
            item["name"]: item["data"]["settings"]["width"] for item in response.json()
        } == {
            "Favorite 🎨 / draft": 40,
            "favorite 🎨 / draft": 50,
        }

        for invalid_name in ("line\nbreak", "nul\u0000byte"):
            response = await client.put(
                "/api/v1/me/label-presets/spool/item",
                json={"name": invalid_name, "data": {"settings": {}}},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_presets_are_isolated_per_user(
        self, auth_client, db_session, normal_user
    ):
        client, csrf_token = auth_client
        response = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Admin Only", "data": {"settings": {}}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200

        from app.core.security import generate_token_secret, hash_token
        from app.models import UserSession

        secret = generate_token_secret()
        session = UserSession(
            user_id=normal_user.id,
            session_token_hash=hash_token(secret),
        )
        db_session.add(session)
        await db_session.commit()
        await db_session.refresh(session)
        client.cookies.set("session_id", f"sess.{session.id}.{secret}")

        response = await client.get("/api/v1/me/label-presets")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_presets_require_authentication(self, client):
        response = await client.get("/api/v1/me/label-presets")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_presets_are_in_complete_backup(self, auth_client):
        client, csrf_token = auth_client
        response = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Backed Up", "data": {"settings": {"width": 62}}},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 200

        response = await client.get("/api/v1/admin/system/backup/export?format=jsonl")

        assert response.status_code == 200
        records = [json.loads(line) for line in response.content.splitlines()]
        presets = [
            record["row"]
            for record in records
            if record.get("table") == "label_presets"
        ]
        assert len(presets) == 1
        assert presets[0]["name"] == "Backed Up"
        assert presets[0]["data"]["settings"]["width"] == 62

    @pytest.mark.asyncio
    async def test_iso_like_preset_names_round_trip_through_import(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        names = [
            "2026-07-13T12:34:56+00:00",
            "2026-07-13 12:34:56+00:00",
        ]
        db_session.add_all(
            LabelPreset(
                user_id=admin_user.id,
                preset_type="spool",
                name=name,
                name_key=label_preset_name_key(name),
                data={"settings": {}},
            )
            for name in names
        )
        await db_session.commit()
        exported = (await export_backup_data(db_session))["label_presets"]
        for preset in exported:
            preset["name_key"] = "0" * 64

        await db_session.execute(
            delete(LabelPreset).where(LabelPreset.user_id == admin_user.id)
        )
        await db_session.flush()
        await _import_all_data(db_session, {"label_presets": exported})

        restored = (
            await db_session.execute(
                select(LabelPreset.name, LabelPreset.name_key).order_by(LabelPreset.id)
            )
        ).all()
        assert restored == [(name, label_preset_name_key(name)) for name in names]
