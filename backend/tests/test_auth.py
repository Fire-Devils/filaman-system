from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from app.api.auth import LOCKOUT_DURATION_MINUTES, MAX_LOGIN_ATTEMPTS
from app.core.security import hash_password, hash_token, generate_token_secret
from app.models import User, UserSession


class TestAuthLogin:
    @pytest.mark.asyncio
    async def test_login_success(self, client: AsyncClient, admin_user):
        response = await client.post(
            "/auth/login",
            json={
                "email": "test-admin@example.com",
                "password": "testpassword",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "test-admin@example.com"
        assert "session_id" in response.cookies
        assert "csrf_token" in response.cookies

    @pytest.mark.asyncio
    async def test_login_invalid_password(self, client: AsyncClient, admin_user):
        response = await client.post(
            "/auth/login",
            json={
                "email": "test-admin@example.com",
                "password": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "invalid_credentials"

    @pytest.mark.asyncio
    async def test_login_invalid_email(self, client: AsyncClient):
        response = await client.post(
            "/auth/login",
            json={
                "email": "nonexistent@example.com",
                "password": "testpassword",
            },
        )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "invalid_credentials"

    @pytest.mark.asyncio
    async def test_login_disabled_user(self, client: AsyncClient, db_session):
        user = User(
            email="disabled@example.com",
            password_hash=hash_password("testpassword"),
            is_active=False,
        )
        db_session.add(user)
        await db_session.commit()

        response = await client.post(
            "/auth/login",
            json={
                "email": "disabled@example.com",
                "password": "testpassword",
            },
        )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "account_disabled"


class TestBruteForceProtection:
    """Tests for brute-force protection on login endpoint."""

    @pytest.mark.asyncio
    async def test_failed_login_increments_counter(
        self, client: AsyncClient, db_session
    ):
        """Failed login attempts should increment the failed_login_count."""
        user = User(
            email="bruteforce-test@example.com",
            password_hash=hash_password("correctpassword"),
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        # Attempt login with wrong password
        response = await client.post(
            "/auth/login",
            json={
                "email": "bruteforce-test@example.com",
                "password": "wrongpassword",
            },
        )

        assert response.status_code == 401

        # Refresh user and check counter
        await db_session.refresh(user)
        assert user.failed_login_count == 1

    @pytest.mark.asyncio
    async def test_account_locks_after_max_attempts(
        self, client: AsyncClient, db_session
    ):
        """Account should be locked after MAX_LOGIN_ATTEMPTS failed attempts."""
        user = User(
            email="lockout-test@example.com",
            password_hash=hash_password("correctpassword"),
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()

        # Make MAX_LOGIN_ATTEMPTS failed attempts
        for i in range(MAX_LOGIN_ATTEMPTS):
            response = await client.post(
                "/auth/login",
                json={
                    "email": "lockout-test@example.com",
                    "password": "wrongpassword",
                },
            )

            if i < MAX_LOGIN_ATTEMPTS - 1:
                assert response.status_code == 401
            else:
                # Last attempt should trigger lockout
                assert response.status_code == 429
                detail = response.json()["detail"]
                assert detail["code"] == "account_locked"
                assert "retry_after" in detail

        # Verify account is locked
        await db_session.refresh(user)
        assert user.locked_until is not None
        assert user.locked_until > datetime.now(timezone.utc)

    @pytest.mark.asyncio
    async def test_locked_account_rejects_login(self, client: AsyncClient, db_session):
        """Locked account should reject login even with correct password."""
        user = User(
            email="locked-user@example.com",
            password_hash=hash_password("correctpassword"),
            is_active=True,
            locked_until=datetime.now(timezone.utc) + timedelta(minutes=10),
        )
        db_session.add(user)
        await db_session.commit()

        response = await client.post(
            "/auth/login",
            json={
                "email": "locked-user@example.com",
                "password": "correctpassword",
            },
        )

        assert response.status_code == 429
        detail = response.json()["detail"]
        assert detail["code"] == "account_locked"
        assert "retry_after" in detail

    @pytest.mark.asyncio
    async def test_lock_expires_allows_login(self, client: AsyncClient, db_session):
        """Expired lock should allow login with correct password."""
        user = User(
            email="expired-lock@example.com",
            password_hash=hash_password("correctpassword"),
            is_active=True,
            locked_until=datetime.now(timezone.utc) - timedelta(minutes=1),  # Expired
            failed_login_count=3,
        )
        db_session.add(user)
        await db_session.commit()

        response = await client.post(
            "/auth/login",
            json={
                "email": "expired-lock@example.com",
                "password": "correctpassword",
            },
        )

        assert response.status_code == 200

        # Verify counters are reset
        await db_session.refresh(user)
        assert user.failed_login_count == 0
        assert user.locked_until is None

    @pytest.mark.asyncio
    async def test_successful_login_resets_failed_count(
        self, client: AsyncClient, db_session
    ):
        """Successful login should reset failed_login_count."""
        user = User(
            email="reset-test@example.com",
            password_hash=hash_password("correctpassword"),
            is_active=True,
            failed_login_count=3,
        )
        db_session.add(user)
        await db_session.commit()

        response = await client.post(
            "/auth/login",
            json={
                "email": "reset-test@example.com",
                "password": "correctpassword",
            },
        )

        assert response.status_code == 200

        await db_session.refresh(user)
        assert user.failed_login_count == 0


class TestAuthMe:
    @pytest.mark.asyncio
    async def test_me_authenticated(self, auth_client):
        client, _ = auth_client

        response = await client.get("/auth/me")

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "test-admin@example.com"
        assert data["is_superadmin"] is True
        assert "permissions" in data

    @pytest.mark.asyncio
    async def test_me_unauthenticated(self, client: AsyncClient):
        response = await client.get("/auth/me")

        assert response.status_code == 401


class TestAuthLogout:
    @pytest.mark.asyncio
    async def test_logout_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        response = await client.post(
            "/auth/logout",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200

        # httpx does not automatically remove expired cookies from the jar,
        # so check the response Set-Cookie header instead.
        set_cookie_headers = response.headers.get_list("set-cookie")
        session_deleted = any(
            "session_id" in h
            and ("max-age=0" in h.lower() or "expires=thu, 01 jan 1970" in h.lower())
            for h in set_cookie_headers
        )
        assert session_deleted, (
            f"Expected session_id cookie to be deleted. Set-Cookie headers: {set_cookie_headers}"
        )


class TestCSRF:
    @pytest.mark.asyncio
    async def test_csrf_required_for_mutating_requests(self, auth_client):
        client, _ = auth_client

        response = await client.post(
            "/api/v1/locations",
            json={
                "name": "Test Location",
            },
        )

        assert response.status_code == 403
        assert response.json()["code"] == "csrf_failed"

    @pytest.mark.asyncio
    async def test_csrf_valid_token_accepted(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/locations",
            json={"name": "Test Location"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_csrf_mismatch_rejected(self, auth_client):
        client, _ = auth_client

        response = await client.post(
            "/api/v1/locations",
            json={"name": "Test Location"},
            headers={"X-CSRF-Token": "wrong-token"},
        )

        assert response.status_code == 403
        assert response.json()["code"] == "csrf_failed"

    @pytest.mark.asyncio
    async def test_csrf_not_required_for_get(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/locations")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_csrf_cookie_renewed_when_session_rolls(
        self, client: AsyncClient, admin_user, db_session
    ):
        """When a rolling session is extended, the CSRF cookie must be renewed
        with the same value so its lifetime stays in lock-step with the
        session cookie. Otherwise it expires 30 days after login while the
        session keeps rolling, producing spurious csrf_failed errors."""
        # Session that expires in < 15 days -> triggers rolling extension.
        secret = generate_token_secret()
        session = UserSession(
            user_id=admin_user.id,
            session_token_hash=hash_token(secret),
            expires_at=datetime.now(timezone.utc) + timedelta(days=10),
        )
        db_session.add(session)
        await db_session.commit()
        await db_session.refresh(session)

        csrf_token = generate_token_secret()
        client.cookies.set("session_id", f"sess.{session.id}.{secret}")
        client.cookies.set("csrf_token", csrf_token)

        response = await client.get("/api/v1/me")
        assert response.status_code == 200

        set_cookies = [
            v for k, v in response.headers.multi_items() if k.lower() == "set-cookie"
        ]
        # Both cookies must be re-issued together on a rolling extension.
        assert any(c.startswith("session_id=") for c in set_cookies)
        csrf_set = [c for c in set_cookies if c.startswith("csrf_token=")]
        assert csrf_set, "CSRF cookie was not renewed on rolling session extension"
        # Same token value is reused so in-flight requests keep validating.
        assert f"csrf_token={csrf_token}" in csrf_set[0]

    @pytest.mark.asyncio
    async def test_csrf_cookie_not_renewed_without_rolling(self, auth_client):
        """A healthy session far from expiry must not re-issue the CSRF cookie
        on every request (only session-rolling triggers renewal)."""
        client, _ = auth_client

        response = await client.get("/api/v1/me")
        assert response.status_code == 200

        set_cookies = [
            v for k, v in response.headers.multi_items() if k.lower() == "set-cookie"
        ]
        assert not any(c.startswith("csrf_token=") for c in set_cookies)


class TestAuthMiddleware:
    @pytest.mark.asyncio
    async def test_session_auth(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/me")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_api_key_auth(self, client: AsyncClient, admin_user, db_session):
        from app.models import UserApiKey

        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=admin_user.id,
            name="Test Key",
            key_hash=hash_token(secret),
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)

        token = f"uak.{api_key.id}.{secret}"
        response = await client.get(
            "/api/v1/me",
            headers={"Authorization": f"ApiKey {token}"},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_device_auth(self, client: AsyncClient, db_session):
        from app.models import Device

        secret = generate_token_secret()
        device = Device(
            name="Test Device",
            device_type="scale",
            token_hash=hash_token(secret),
            scopes=["spool_events:create_measurement"],
        )
        db_session.add(device)
        await db_session.commit()
        await db_session.refresh(device)

        token = f"dev.{device.id}.{secret}"
        response = await client.get(
            "/api/v1/spools",
            headers={"Authorization": f"Device {token}"},
        )

        assert response.status_code == 200
