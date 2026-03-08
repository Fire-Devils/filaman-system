import logging
import uuid
from unittest.mock import patch

import pytest

from app.core.config import PROJECT_ROOT, Settings, settings
from app.core.logging_config import get_request_id, set_request_id, setup_logging
from app.core.security import generate_token_secret, hash_token
from app.models import Device, UserApiKey


class TestConfigSettings:
    @pytest.mark.asyncio
    async def test_default_app_name(self):
        assert settings.app_name == "FilaMan"

    @pytest.mark.asyncio
    async def test_default_debug_false(self):
        """Test that Settings default for debug is False when no env file is loaded."""
        s = Settings(_env_file=None)
        assert s.debug is False

    @pytest.mark.asyncio
    async def test_default_log_level(self):
        """Test that Settings default for log_level is INFO when no env file is loaded."""
        s = Settings(_env_file=None)
        assert s.log_level == "INFO"

    @pytest.mark.asyncio
    async def test_default_log_format(self):
        assert settings.log_format == "json"

    @pytest.mark.asyncio
    async def test_resolve_relative_db_path_with_dot_slash(self):
        resolved = Settings.resolve_relative_db_path("sqlite+aiosqlite:///./test.db")

        assert str(PROJECT_ROOT) in resolved
        assert "/./" not in resolved
        assert resolved == f"sqlite+aiosqlite:///{PROJECT_ROOT}/test.db"

    @pytest.mark.asyncio
    async def test_resolve_relative_db_path_absolute_unchanged(self):
        absolute = "sqlite+aiosqlite:////absolute/path/test.db"
        assert Settings.resolve_relative_db_path(absolute) == absolute

    @pytest.mark.asyncio
    async def test_resolve_relative_db_path_mysql_unchanged(self):
        mysql_url = "aiomysql://user:pass@host/db"
        assert Settings.resolve_relative_db_path(mysql_url) == mysql_url


class TestLoggingConfig:
    @pytest.mark.asyncio
    async def test_set_and_get_request_id(self):
        set_request_id("abc-123")
        assert get_request_id() == "abc-123"
        set_request_id(None)

    @pytest.mark.asyncio
    async def test_request_id_default_none(self):
        set_request_id(None)
        assert get_request_id() is None

    @pytest.mark.asyncio
    async def test_set_request_id_to_none(self):
        set_request_id("temp")
        set_request_id(None)
        assert get_request_id() is None

    @pytest.mark.asyncio
    async def test_setup_logging_production_level(self):
        root_logger = logging.getLogger()
        previous_handlers = root_logger.handlers
        previous_level = root_logger.level

        with patch.object(settings, "debug", False):
            setup_logging()
            assert logging.getLogger().level == logging.WARNING

        root_logger.handlers = previous_handlers
        root_logger.setLevel(previous_level)


class TestRequestIdMiddleware:
    @pytest.mark.asyncio
    async def test_request_id_generated_if_not_provided(self, client):
        response = await client.get("/api/v1/spools/statuses")

        request_id = response.headers.get("X-Request-Id")
        assert request_id is not None
        uuid.UUID(request_id)

    @pytest.mark.asyncio
    async def test_request_id_propagated_from_header(self, client):
        response = await client.get(
            "/api/v1/spools/statuses",
            headers={"X-Request-Id": "my-custom-id"},
        )

        assert response.headers.get("X-Request-Id") == "my-custom-id"

    @pytest.mark.asyncio
    async def test_static_file_skips_auth(self, client):
        response = await client.get("/_astro/something.js")

        assert response.status_code not in (401, 403)


class TestCsrfMiddlewareEdges:
    @pytest.mark.asyncio
    async def test_csrf_skipped_for_api_key_auth(self, auth_client, admin_user, db_session):
        client, _ = auth_client
        client.cookies.clear()

        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=admin_user.id,
            name="Test API Key",
            key_hash=hash_token(secret),
            scopes=["spools:read", "spools:write", "locations:create"],
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)

        token = f"uak.{api_key.id}.{secret}"
        response = await client.post(
            "/api/v1/locations",
            json={"name": "API Key Location"},
            headers={"Authorization": f"ApiKey {token}"},
        )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_csrf_skipped_for_device_auth(self, auth_client, db_session):
        client, _ = auth_client
        client.cookies.clear()

        secret = generate_token_secret()
        device = Device(
            name="Test Device",
            device_type="scale",
            token_hash=hash_token(secret),
            scopes=["device:heartbeat"],
            is_active=True,
        )
        db_session.add(device)
        await db_session.commit()
        await db_session.refresh(device)

        token = f"dev.{device.id}.{secret}"
        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "127.0.0.1"},
            headers={"Authorization": f"Device {token}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_csrf_required_for_session_auth_mutation(self, auth_client):
        client, _ = auth_client

        response = await client.post("/auth/logout")

        assert response.status_code == 403
        assert response.json()["code"] == "csrf_failed"
