import pytest
from sqlalchemy import select

from app.core.security import hash_password, verify_password_async
from app.core.seeds import PERMISSIONS
from app.models import Role, User, UserRole


class TestAdminUsersListCreate:
    @pytest.mark.asyncio
    async def test_list_users_returns_paginated(self, auth_client, admin_user):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/users?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 1
        assert data["page_size"] == 10
        assert data["total"] >= 1
        emails = [item["email"] for item in data["items"]]
        assert admin_user.email in emails

    @pytest.mark.asyncio
    async def test_create_user_success(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/admin/users",
            json={
                "email": "new-admin-user@example.com",
                "password": "newpassword",
                "display_name": "New Admin User",
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == "new-admin-user@example.com"
        assert data["display_name"] == "New Admin User"
        assert data["is_superadmin"] is False

    @pytest.mark.asyncio
    async def test_create_user_duplicate_email_conflict(self, auth_client, admin_user):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/admin/users",
            json={
                "email": admin_user.email,
                "password": "duplicate",
                "display_name": "Duplicate",
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"


class TestAdminUserDetailUpdateDelete:
    @pytest.mark.asyncio
    async def test_get_user_returns_roles(self, auth_client, db_session):
        client, _ = auth_client

        user = User(
            email="role-user@example.com",
            password_hash=hash_password("testpassword"),
            display_name="Role User",
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        role_result = await db_session.execute(select(Role).where(Role.key == "user"))
        role = role_result.scalar_one()
        db_session.add(UserRole(user_id=user.id, role_id=role.id))
        await db_session.commit()

        response = await client.get(f"/api/v1/admin/users/{user.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "role-user@example.com"
        assert "user" in data["roles"]

    @pytest.mark.asyncio
    async def test_get_user_not_found(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/users/999999")

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_update_user_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        user = User(
            email="update-user@example.com",
            password_hash=hash_password("testpassword"),
            display_name="Update User",
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        response = await client.patch(
            f"/api/v1/admin/users/{user.id}",
            json={"display_name": "Updated Name", "is_active": False},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["display_name"] == "Updated Name"
        assert data["is_active"] is False

    @pytest.mark.asyncio
    async def test_update_user_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.patch(
            "/api/v1/admin/users/999999",
            json={"display_name": "Missing"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_reset_password_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        user = User(
            email="reset-user@example.com",
            password_hash=hash_password("oldpassword"),
            display_name="Reset User",
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        response = await client.post(
            f"/api/v1/admin/users/{user.id}/reset-password",
            json={"new_password": "newpassword"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200

        result = await db_session.execute(select(User).where(User.id == user.id))
        updated_user = result.scalar_one()
        assert await verify_password_async("newpassword", updated_user.password_hash)

    @pytest.mark.asyncio
    async def test_delete_user_soft_delete(self, auth_client, db_session):
        client, csrf_token = auth_client

        user = User(
            email="delete-user@example.com",
            password_hash=hash_password("testpassword"),
            display_name="Delete User",
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        response = await client.delete(
            f"/api/v1/admin/users/{user.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204

        result = await db_session.execute(select(User).where(User.id == user.id))
        deleted_user = result.scalar_one()
        assert deleted_user.deleted_at is not None

    @pytest.mark.asyncio
    async def test_delete_user_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.delete(
            "/api/v1/admin/users/999999",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_delete_self_prevented(self, auth_client, admin_user):
        client, csrf_token = auth_client

        response = await client.delete(
            f"/api/v1/admin/users/{admin_user.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "bad_request"

    @pytest.mark.asyncio
    async def test_delete_last_superadmin_prevented(self, auth_client, admin_user):
        client, csrf_token = auth_client

        response = await client.delete(
            f"/api/v1/admin/users/{admin_user.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "bad_request"


class TestAdminUserRoles:
    @pytest.mark.asyncio
    async def test_set_user_roles_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        user = User(
            email="roles-user@example.com",
            password_hash=hash_password("testpassword"),
            display_name="Roles User",
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

        response = await client.put(
            f"/api/v1/admin/users/{user.id}/roles",
            json=["viewer", "user"],
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert set(response.json()["roles"]) == {"viewer", "user"}

        detail_response = await client.get(f"/api/v1/admin/users/{user.id}")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert set(detail["roles"]) == {"viewer", "user"}


class TestAdminRoleManagement:
    @pytest.mark.asyncio
    async def test_list_roles(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/roles")

        assert response.status_code == 200
        role_keys = {role["key"] for role in response.json()}
        assert {"viewer", "user", "admin"}.issubset(role_keys)

    @pytest.mark.asyncio
    async def test_create_role_success(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/admin/roles",
            json={
                "key": "custom_role",
                "name": "Custom Role",
                "description": "Custom role for tests",
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["key"] == "custom_role"
        assert data["is_system"] is False

    @pytest.mark.asyncio
    async def test_get_role_with_permissions(self, auth_client, db_session):
        client, _ = auth_client

        result = await db_session.execute(select(Role).where(Role.key == "admin"))
        role = result.scalar_one()

        response = await client.get(f"/api/v1/admin/roles/{role.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["key"] == "admin"
        assert "admin:users_manage" in data["permissions"]

    @pytest.mark.asyncio
    async def test_update_role_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        role = Role(key="update_role", name="Update Role", description="Old", is_system=False)
        db_session.add(role)
        await db_session.commit()
        await db_session.refresh(role)

        response = await client.patch(
            f"/api/v1/admin/roles/{role.id}",
            json={"name": "Updated Role", "description": "Updated"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Role"
        assert data["description"] == "Updated"

    @pytest.mark.asyncio
    async def test_delete_role_custom(self, auth_client, db_session):
        client, csrf_token = auth_client

        role = Role(key="delete_role", name="Delete Role", description=None, is_system=False)
        db_session.add(role)
        await db_session.commit()
        await db_session.refresh(role)

        response = await client.delete(
            f"/api/v1/admin/roles/{role.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_delete_role_system_forbidden(self, auth_client, db_session):
        client, csrf_token = auth_client

        result = await db_session.execute(select(Role).where(Role.key == "viewer"))
        role = result.scalar_one()

        response = await client.delete(
            f"/api/v1/admin/roles/{role.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"

    @pytest.mark.asyncio
    async def test_set_role_permissions_success(self, auth_client, db_session):
        client, csrf_token = auth_client

        role = Role(key="perm_role", name="Perm Role", description=None, is_system=False)
        db_session.add(role)
        await db_session.commit()
        await db_session.refresh(role)

        permission_keys = [PERMISSIONS[0]["key"], PERMISSIONS[1]["key"]]

        response = await client.put(
            f"/api/v1/admin/roles/{role.id}/permissions",
            json=permission_keys,
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert set(response.json()["permissions"]) == set(permission_keys)


class TestAdminPermissions:
    @pytest.mark.asyncio
    async def test_list_permissions(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/admin/permissions")

        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1
        keys = {perm["key"] for perm in data}
        assert "admin:users_manage" in keys
