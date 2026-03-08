import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select

from app.api.deps import resolve_user_permissions
from app.core.security import generate_token_secret, hash_password, hash_token
from app.core.seeds import USER_PERMISSIONS
from app.models import Device, Role, User, UserApiKey, UserRole, UserSession


async def _create_session(client: AsyncClient, db_session, user_id: int):
    secret = generate_token_secret()
    session = UserSession(
        user_id=user_id,
        session_token_hash=hash_token(secret),
    )
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)

    session_token = f"sess.{session.id}.{secret}"
    csrf_token = generate_token_secret()

    client.cookies.set("session_id", session_token)
    client.cookies.set("csrf_token", csrf_token)

    return client, csrf_token


@pytest_asyncio.fixture
async def viewer_user(db_session):
    user = User(
        email="test-viewer@example.com",
        password_hash=hash_password("testpassword"),
        display_name="Test Viewer",
        is_superadmin=False,
        is_active=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    result = await db_session.execute(select(Role).where(Role.key == "viewer"))
    viewer_role = result.scalar_one_or_none()
    if viewer_role:
        db_session.add(UserRole(user_id=user.id, role_id=viewer_role.id))
        await db_session.commit()

    return user


@pytest_asyncio.fixture
async def viewer_auth_client(client, viewer_user, db_session):
    return await _create_session(client, db_session, viewer_user.id)


@pytest_asyncio.fixture
async def admin_role_user(db_session):
    user = User(
        email="test-admin-role@example.com",
        password_hash=hash_password("testpassword"),
        display_name="Test Admin Role",
        is_superadmin=False,
        is_active=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    result = await db_session.execute(select(Role).where(Role.key == "admin"))
    admin_role = result.scalar_one_or_none()
    if admin_role:
        db_session.add(UserRole(user_id=user.id, role_id=admin_role.id))
        await db_session.commit()

    return user


@pytest_asyncio.fixture
async def admin_role_auth_client(client, admin_role_user, db_session):
    return await _create_session(client, db_session, admin_role_user.id)


@pytest_asyncio.fixture
async def user_auth_client(client, normal_user, db_session):
    return await _create_session(client, db_session, normal_user.id)


class TestSuperadminAccess:
    @pytest.mark.asyncio
    async def test_superadmin_can_access_admin_users(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/users")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_superadmin_can_access_admin_roles(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/roles")

        assert response.status_code == 200


class TestRoleBasedAccess:
    @pytest.mark.asyncio
    async def test_admin_role_can_access_user_management(self, admin_role_auth_client):
        client, _ = admin_role_auth_client

        response = await client.get("/api/v1/admin/users")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_user_role_can_access_spools(self, user_auth_client):
        client, _ = user_auth_client

        response = await client.get("/api/v1/spools")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_user_role_cannot_access_user_management(self, user_auth_client):
        client, _ = user_auth_client

        response = await client.get("/api/v1/admin/users")

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_viewer_can_read_filaments(self, viewer_auth_client):
        client, _ = viewer_auth_client

        response = await client.get("/api/v1/filaments")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_viewer_can_read_spools(self, viewer_auth_client):
        client, _ = viewer_auth_client

        response = await client.get("/api/v1/spools")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_viewer_cannot_create_spool(self, viewer_auth_client):
        client, csrf_token = viewer_auth_client

        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": 9999},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_viewer_cannot_create_location(self, viewer_auth_client):
        client, csrf_token = viewer_auth_client

        response = await client.post(
            "/api/v1/locations",
            json={"name": "Viewer Location"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_viewer_cannot_manage_users(self, viewer_auth_client):
        client, _ = viewer_auth_client

        response = await client.get("/api/v1/admin/users")

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"


class TestUnauthenticatedAccess:
    @pytest.mark.asyncio
    async def test_unauthenticated_admin_users_denied(self, client: AsyncClient):
        response = await client.get("/api/v1/admin/users")

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "unauthenticated"

    @pytest.mark.asyncio
    async def test_unauthenticated_spools_denied(self, client: AsyncClient):
        response = await client.get("/api/v1/spools")

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "unauthenticated"


class TestPermissionResolution:
    @pytest.mark.asyncio
    async def test_resolve_user_permissions_for_user_role(self, db_session, normal_user):
        permissions = await resolve_user_permissions(db_session, normal_user.id)

        assert permissions == set(USER_PERMISSIONS)

    @pytest.mark.asyncio
    async def test_resolve_user_permissions_no_roles(self, db_session):
        user = User(
            email="test-norole@example.com",
            password_hash=hash_password("testpassword"),
            display_name="No Role",
            is_superadmin=False,
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        permissions = await resolve_user_permissions(db_session, user.id)

        assert permissions == set()


class TestDeviceScopeAuth:
    @pytest.mark.asyncio
    async def test_device_with_scope_can_access_scoped_endpoint(self, client: AsyncClient, db_session):
        secret = generate_token_secret()
        device = Device(
            name="Scoped Device",
            device_type="scale",
            token_hash=hash_token(secret),
            scopes=["spool_events:create_measurement"],
        )
        db_session.add(device)
        await db_session.commit()
        await db_session.refresh(device)

        token = f"dev.{device.id}.{secret}"
        response = await client.post(
            "/api/v1/spool-measurements",
            json={"rfid_uid": "rfid-123", "measured_weight_g": 12.5},
            headers={"Authorization": f"Device {token}"},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_device_without_scope_forbidden(self, client: AsyncClient, db_session):
        secret = generate_token_secret()
        device = Device(
            name="Limited Device",
            device_type="scale",
            token_hash=hash_token(secret),
            scopes=["spools:read"],
        )
        db_session.add(device)
        await db_session.commit()
        await db_session.refresh(device)

        token = f"dev.{device.id}.{secret}"
        response = await client.post(
            "/api/v1/spool-measurements",
            json={"rfid_uid": "rfid-456", "measured_weight_g": 8.0},
            headers={"Authorization": f"Device {token}"},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"


class TestApiKeyScopeRestriction:
    @pytest.mark.asyncio
    async def test_api_key_scope_intersection_denies_create_spool(self, client: AsyncClient, normal_user, db_session):
        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=normal_user.id,
            name="ReadOnly Spool Key",
            key_hash=hash_token(secret),
            scopes=["spools:read"],
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)

        token = f"uak.{api_key.id}.{secret}"
        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": 9999},
            headers={"Authorization": f"ApiKey {token}"},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_api_key_with_scope_allows_create_spool_flow(self, client: AsyncClient, normal_user, db_session):
        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=normal_user.id,
            name="Create Spool Key",
            key_hash=hash_token(secret),
            scopes=["spools:create"],
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)

        token = f"uak.{api_key.id}.{secret}"
        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": 9999},
            headers={"Authorization": f"ApiKey {token}"},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "validation_error"
