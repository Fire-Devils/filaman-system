import pytest


class TestAppSettingsAdmin:
    @pytest.mark.asyncio
    async def test_get_app_settings_returns_defaults(self, auth_client):
        """GET /admin/app-settings should return default values if no row exists."""
        client, _ = auth_client

        response = await client.get("/api/v1/admin/app-settings/")

        assert response.status_code == 200
        data = response.json()
        assert data["login_disabled"] is False

    @pytest.mark.asyncio
    async def test_put_app_settings_creates_row(self, auth_client):
        """PUT /admin/app-settings should create a new row with id=1 if not exists."""
        client, csrf_token = auth_client

        response = await client.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["login_disabled"] is True

    @pytest.mark.asyncio
    async def test_put_get_roundtrip(self, auth_client):
        """PUT + GET should persist the value correctly."""
        client, csrf_token = auth_client

        # PUT
        put_response = await client.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert put_response.status_code == 200

        # GET
        get_response = await client.get("/api/v1/admin/app-settings/")
        assert get_response.status_code == 200
        data = get_response.json()
        assert data["login_disabled"] is True

    @pytest.mark.asyncio
    async def test_put_app_settings_updates_existing(self, auth_client):
        """PUT /admin/app-settings should update existing row."""
        client, csrf_token = auth_client

        # First PUT
        response1 = await client.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response1.status_code == 200
        assert response1.json()["login_disabled"] is True

        # Second PUT (update)
        response2 = await client.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": False},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response2.status_code == 200
        assert response2.json()["login_disabled"] is False

    @pytest.mark.asyncio
    async def test_get_app_settings_requires_auth(self, client):
        """GET /admin/app-settings should require authentication."""
        response = await client.get("/api/v1/admin/app-settings/")

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_put_app_settings_requires_auth(self, client):
        """PUT /admin/app-settings should require authentication."""
        response = await client.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
        )

        assert response.status_code == 401



class TestAppSettingsPublic:
    @pytest.mark.asyncio
    async def test_public_info_no_auth(self, client):
        """GET /app-settings/public-info should NOT require auth."""
        response = await client.get("/api/v1/app-settings/public-info")

        assert response.status_code == 200
        data = response.json()
        assert data["login_disabled"] is False

    @pytest.mark.asyncio
    async def test_public_info_returns_login_disabled_true(self, client, auth_client):
        """GET /app-settings/public-info should return login_disabled=true after update."""
        auth_client_inst, csrf_token = auth_client

        # First update to true via admin endpoint
        await auth_client_inst.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
            headers={"X-CSRF-Token": csrf_token},
        )

        # Then check public endpoint
        response = await client.get("/api/v1/app-settings/public-info")

        assert response.status_code == 200
        data = response.json()
        assert data["login_disabled"] is True


class TestLoginBypass:
    @pytest.mark.asyncio
    async def test_login_with_disabled_auth_maps_to_admin(self, client, auth_client):
        """POST /auth/login with login_disabled=true should map any credentials to admin."""
        auth_client_inst, csrf_token = auth_client

        # Enable login_disabled via admin endpoint
        await auth_client_inst.put(
            "/api/v1/admin/app-settings/",
            json={"login_disabled": True},
            headers={"X-CSRF-Token": csrf_token},
        )

        # Login with arbitrary credentials — should succeed and map to a superadmin
        response = await client.post(
            "/auth/login",
            json={"email": "anyone@example.com", "password": "anything"},
        )

        assert response.status_code == 200
        data = response.json()
        assert "email" in data
        assert "user_id" in data


    @pytest.mark.asyncio
    async def test_login_with_disabled_auth_no_admin_returns_500(self, client, db_session):
        """POST /auth/login with login_disabled=true and no admin user should return 500."""
        from app.models import AppSettings, User
        from sqlalchemy import update

        # Create app_settings row with login_disabled=true
        settings = AppSettings(id=1, login_disabled=True)
        db_session.add(settings)

        # Deactivate all superadmins
        await db_session.execute(
            update(User).where(User.is_superadmin.is_(True)).values(is_active=False)
        )
        await db_session.commit()

        response = await client.post(
            "/auth/login",
            json={"email": "anyone@example.com", "password": "anything"},
        )

        assert response.status_code == 500
        data = response.json()
        assert data["detail"]["code"] == "no_admin_user"

    @pytest.mark.asyncio
    async def test_login_normal_when_not_disabled(self, client, admin_user):
        """POST /auth/login with login_disabled=false should require valid credentials."""
        # Login with wrong password — should fail
        response = await client.post(
            "/auth/login",
            json={"email": admin_user.email, "password": "wrongpassword"},
        )

        assert response.status_code == 401
        data = response.json()
        assert data["detail"]["code"] == "invalid_credentials"
