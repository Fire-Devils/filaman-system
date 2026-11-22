"""Account delegation and revocation must hold after credentials have been used."""

from datetime import UTC, datetime

import pytest

from app.core.security import hash_token
from app.models import UserApiKey, UserSession
from tests import test_rbac

admin_role_auth_client = test_rbac.admin_role_auth_client
admin_role_user = test_rbac.admin_role_user
viewer_user = test_rbac.viewer_user


@pytest.mark.parametrize("scopes", [["user_api_keys:create_own", "filaments:read"], ["user_api_keys:create_own", "manufacturers:create"]])
async def test_api_key_delegation_retains_scope_ceiling(client, admin_user, db_session, scopes):
    key = UserApiKey(user_id=admin_user.id, name="limited", key_hash=hash_token("limited-secret"), scopes=scopes)
    db_session.add(key)
    await db_session.commit()
    client.cookies.clear()
    response = await client.post("/api/v1/me/api-keys", json={"name": "delegated"}, headers={
        "Authorization": f"ApiKey uak.{key.id}.limited-secret",
    })
    assert response.status_code == 201
    delegated = response.json()
    headers = {"Authorization": "ApiKey " + delegated["token"]}
    assert (await client.get("/api/v1/admin/users", headers=headers)).status_code == 403
    assert (await db_session.get(UserApiKey, delegated["id"])).scopes == scopes
    # Native inventory reads accept authenticated callers; permission-protected writes enforce scopes.
    assert (await client.get("/api/v1/filaments", headers=headers)).status_code == 200
    write = await client.post("/api/v1/manufacturers", json={"name": "Delegated fixture"}, headers=headers)
    assert write.status_code == (201 if "manufacturers:create" in scopes else 403)


@pytest.mark.parametrize("credential,change", [
    (credential, change)
    for credential in ("session", "api_key")
    for change in ("disabled", "deleted", "revoked", "demoted", "scopes")
    if credential == "api_key" or change != "scopes"
])
async def test_used_credentials_observe_current_account_state(
    client, admin_user, db_session, credential, change,
):
    client.cookies.clear()
    if credential == "session":
        record = UserSession(user_id=admin_user.id, session_token_hash=hash_token("session-secret"))
    else:
        record = UserApiKey(user_id=admin_user.id, name="fixture", key_hash=hash_token("key-secret"))
    db_session.add(record)
    await db_session.commit()
    headers = {}
    if credential == "session":
        client.cookies.set("session_id", f"sess.{record.id}.session-secret")
    else:
        headers = {"Authorization": f"ApiKey uak.{record.id}.key-secret"}
    assert (await client.get("/api/v1/admin/users", headers=headers)).status_code == 200
    if change == "disabled":
        admin_user.is_active = False
    elif change == "deleted":
        admin_user.deleted_at = datetime.now(UTC)
    elif change == "revoked":
        if credential == "session":
            record.revoked_at = datetime.now(UTC)
        else:
            await db_session.delete(record)
    elif change == "demoted":
        admin_user.is_superadmin = False
    else:
        record.scopes = ["filaments:read"]
    await db_session.commit()
    expected = 401 if change in {"disabled", "deleted", "revoked"} else 403
    assert (await client.get("/api/v1/admin/users", headers=headers)).status_code == expected


@pytest.mark.parametrize("operation", ["create", "promote", "edit_root", "reset_root", "root_roles"])
async def test_delegated_user_manager_cannot_manage_superadmins(
    admin_role_auth_client, admin_role_user, admin_user, operation,
):
    client, csrf = admin_role_auth_client
    headers = {"X-CSRF-Token": csrf}
    if operation == "create":
        response = await client.post("/api/v1/admin/users", json={
            "email": "new-root@example.test", "password": "fixture-password", "is_superadmin": True,
        }, headers=headers)
    elif operation == "promote":
        response = await client.patch(f"/api/v1/admin/users/{admin_role_user.id}", json={"is_superadmin": True}, headers=headers)
    elif operation == "edit_root":
        response = await client.patch(f"/api/v1/admin/users/{admin_user.id}", json={"email": "takeover@example.test"}, headers=headers)
    elif operation == "reset_root":
        response = await client.post(f"/api/v1/admin/users/{admin_user.id}/reset-password", json={"new_password": "takeover"}, headers=headers)
    else:
        created = await client.post("/api/v1/admin/roles", json={"key": "custom_manager", "name": "Custom manager"}, headers=headers)
        assert created.status_code == 201
        response = await client.put(f"/api/v1/admin/users/{admin_user.id}/roles", json=["custom_manager"], headers=headers)
    assert response.status_code == 403


@pytest.mark.parametrize("operation", ["create", "reset", "roles", "delete"])
async def test_scoped_root_key_cannot_escape_through_root_accounts(client, admin_user, db_session, operation):
    key = UserApiKey(user_id=admin_user.id, name="manager", key_hash=hash_token("manager-secret"), scopes=["admin:users_manage"])
    db_session.add(key)
    await db_session.commit()
    headers = {"Authorization": f"ApiKey uak.{key.id}.manager-secret"}
    if operation == "create":
        response = await client.post("/api/v1/admin/users", json={
            "email": "new-root@example.test", "password": "fixture-password", "is_superadmin": True,
        }, headers=headers)
    elif operation == "reset":
        response = await client.post(f"/api/v1/admin/users/{admin_user.id}/reset-password", json={"new_password": "takeover"}, headers=headers)
    elif operation == "roles":
        response = await client.put(f"/api/v1/admin/users/{admin_user.id}/roles", json=["viewer"], headers=headers)
    else:
        # A different root account is needed to exercise the root permission before self-deletion.
        from app.models import User
        other = User(email="other-root@example.test", is_superadmin=True)
        db_session.add(other)
        await db_session.commit()
        response = await client.delete(f"/api/v1/admin/users/{other.id}", headers=headers)
    assert response.status_code == 403


@pytest.mark.parametrize("update", [{"is_superadmin": False}, {"is_active": False}])
async def test_last_active_superadmin_cannot_be_demoted_or_disabled(auth_client, admin_user, db_session, update):
    from app.models import User
    db_session.add(User(email="inactive-root@example.test", is_superadmin=True, is_active=False))
    db_session.add(User(email="deleted-root@example.test", is_superadmin=True, deleted_at=datetime.now(UTC)))
    await db_session.commit()
    client, csrf = auth_client
    response = await client.patch(f"/api/v1/admin/users/{admin_user.id}", json=update, headers={"X-CSRF-Token": csrf})
    assert response.status_code == 400
    await db_session.refresh(admin_user)
    assert admin_user.is_active and admin_user.is_superadmin


async def test_user_manager_can_still_manage_ordinary_accounts(admin_role_auth_client, admin_role_user):
    client, csrf = admin_role_auth_client
    headers = {"X-CSRF-Token": csrf}
    created = await client.post("/api/v1/admin/users", json={"email": "ordinary@example.test", "password": "fixture-password"}, headers=headers)
    assert created.status_code == 201
    user_id = created.json()["id"]
    assert (await client.patch(f"/api/v1/admin/users/{user_id}", json={"display_name": "Updated"}, headers=headers)).status_code == 200
    assert (await client.post(f"/api/v1/admin/users/{user_id}/reset-password", json={"new_password": "replacement"}, headers=headers)).status_code == 200
    assert (await client.put(f"/api/v1/admin/users/{user_id}/roles", json=["viewer"], headers=headers)).status_code == 200
    assert (await client.delete(f"/api/v1/admin/users/{user_id}", headers=headers)).status_code == 204


async def test_full_root_can_manage_other_root_accounts(auth_client):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    created = await client.post("/api/v1/admin/users", json={
        "email": "second-root@example.test", "password": "fixture-password", "is_superadmin": True,
    }, headers=headers)
    assert created.status_code == 201
    user_id = created.json()["id"]
    assert (await client.patch(f"/api/v1/admin/users/{user_id}", json={"display_name": "Updated"}, headers=headers)).status_code == 200
    assert (await client.post(f"/api/v1/admin/users/{user_id}/reset-password", json={"new_password": "replacement"}, headers=headers)).status_code == 200
    assert (await client.put(f"/api/v1/admin/users/{user_id}/roles", json=["viewer"], headers=headers)).status_code == 200
    assert (await client.patch(f"/api/v1/admin/users/{user_id}", json={"is_active": False}, headers=headers)).status_code == 200
    assert (await client.delete(f"/api/v1/admin/users/{user_id}", headers=headers)).status_code == 204


@pytest.mark.parametrize("credential", ["session", "api_key"])
async def test_legacy_migration_and_usage_write_throttle(client, admin_user, db_session, credential):
    from app.core.security import hash_password

    client.cookies.clear()
    if credential == "session":
        record = UserSession(user_id=admin_user.id, session_token_hash=hash_password("legacy-secret"))
        field = "session_token_hash"
    else:
        record = UserApiKey(user_id=admin_user.id, name="legacy", key_hash=hash_password("legacy-secret"))
        field = "key_hash"
    db_session.add(record)
    await db_session.commit()
    headers = {}
    if credential == "session":
        client.cookies.set("session_id", f"sess.{record.id}.legacy-secret")
    else:
        headers = {"Authorization": f"ApiKey uak.{record.id}.legacy-secret"}
    assert (await client.get("/api/v1/me", headers=headers)).status_code == 200
    await db_session.refresh(record)
    assert getattr(record, field) == hash_token("legacy-secret")
    written_at = record.last_used_at
    assert written_at is not None
    assert (await client.get("/api/v1/me", headers=headers)).status_code == 200
    await db_session.refresh(record)
    assert record.last_used_at == written_at


@pytest.mark.parametrize("scopes", [[], ["filaments:read"], ["user_api_keys:read_own"]])
async def test_key_management_enforces_existing_own_key_permissions(client, admin_user, db_session, scopes):
    limited = UserApiKey(user_id=admin_user.id, name="limited", key_hash=hash_token("limited-secret"), scopes=scopes)
    target = UserApiKey(user_id=admin_user.id, name="target", key_hash=hash_token("target-secret"))
    db_session.add_all([limited, target])
    await db_session.commit()
    headers = {"Authorization": f"ApiKey uak.{limited.id}.limited-secret"}
    response = await client.post("/api/v1/me/api-keys", json={"name": "unauthorized"}, headers=headers)
    assert response.status_code == 403
    response = await client.get("/api/v1/me/api-keys", headers=headers)
    assert response.status_code == (200 if "user_api_keys:read_own" in scopes else 403)
    response = await client.delete(f"/api/v1/me/api-keys/{target.id}", headers=headers)
    assert response.status_code == 403
    assert await db_session.get(UserApiKey, target.id) is not None


async def test_device_cannot_manage_user_api_keys(client, db_session):
    from app.models import Device

    device = Device(name="fixture", device_type="scale", token_hash=hash_token("device-secret"), scopes=[
        "user_api_keys:create_own", "user_api_keys:read_own", "user_api_keys:delete_own",
    ])
    db_session.add(device)
    await db_session.commit()
    headers = {"Authorization": f"Device dev.{device.id}.device-secret"}
    assert (await client.get("/api/v1/me/api-keys", headers=headers)).status_code == 403
    assert (await client.post("/api/v1/me/api-keys", json={"name": "invalid"}, headers=headers)).status_code == 403
    assert (await client.delete("/api/v1/me/api-keys/1", headers=headers)).status_code == 403


async def test_normal_user_can_manage_own_keys_and_not_another_users(client, normal_user, admin_user, db_session):
    from tests.test_rbac import _create_session

    client, csrf = await _create_session(client, db_session, normal_user.id)
    headers = {"X-CSRF-Token": csrf}
    created = await client.post("/api/v1/me/api-keys", json={"name": "own"}, headers=headers)
    assert created.status_code == 201
    key_id = created.json()["id"]
    assert key_id in [row["id"] for row in (await client.get("/api/v1/me/api-keys")).json()]
    other = UserApiKey(user_id=admin_user.id, name="other", key_hash=hash_token("other-secret"))
    db_session.add(other)
    await db_session.commit()
    assert (await client.delete(f"/api/v1/me/api-keys/{other.id}", headers=headers)).status_code == 404
    assert (await client.delete(f"/api/v1/me/api-keys/{key_id}", headers=headers)).status_code == 204


async def test_user_manager_cannot_reset_account_promoted_during_password_hash(
    admin_role_auth_client, admin_role_user, admin_user, normal_user, db_session, monkeypatch,
):
    import asyncio

    import httpx

    from app.api.v1 import admin
    from app.main import app

    client, csrf = admin_role_auth_client
    target_id = normal_user.id
    old_hash = normal_user.password_hash
    started, release = asyncio.Event(), asyncio.Event()
    hash_password = admin.hash_password_async

    async def paused_hash(password):
        started.set()
        await release.wait()
        return await hash_password(password)

    monkeypatch.setattr(admin, "hash_password_async", paused_hash)
    reset = asyncio.create_task(client.post(f"/api/v1/admin/users/{target_id}/reset-password", json={
        "new_password": "unauthorized-replacement",
    }, headers={"X-CSRF-Token": csrf}))
    try:
        await asyncio.wait_for(started.wait(), 3)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as root:
            root, root_csrf = await test_rbac._create_session(root, db_session, admin_user.id)
            promoted = await root.patch(f"/api/v1/admin/users/{target_id}", json={"is_superadmin": True}, headers={"X-CSRF-Token": root_csrf})
            assert promoted.status_code == 200
        release.set()
        assert (await reset).status_code == 403
        await db_session.refresh(normal_user)
        assert normal_user.is_superadmin
        assert normal_user.password_hash == old_hash
    finally:
        release.set()
        await asyncio.gather(reset, return_exceptions=True)


async def test_viewer_retains_personal_key_self_service(client, viewer_user, db_session):
    from tests.test_rbac import _create_session

    api, csrf = await _create_session(client, db_session, viewer_user.id)
    headers = {"X-CSRF-Token": csrf}
    created = await api.post("/api/v1/me/api-keys", json={"name": "Viewer personal key"}, headers=headers)
    assert created.status_code == 201
    key_id = created.json()["id"]
    assert key_id in [item["id"] for item in (await api.get("/api/v1/me/api-keys")).json()]
    api.cookies.clear()
    key_headers = {"Authorization": "ApiKey " + created.json()["token"]}
    assert (await api.post("/api/v1/manufacturers", json={"name": "Not allowed"}, headers=key_headers)).status_code == 403
    assert (await api.delete(f"/api/v1/me/api-keys/{key_id}", headers=key_headers)).status_code == 204
