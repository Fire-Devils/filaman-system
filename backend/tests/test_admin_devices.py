import pytest


@pytest.mark.asyncio
async def test_device_list_exposes_pending_status_without_token_hash(auth_client):
    client, csrf_token = auth_client
    create_response = await client.post(
        "/api/v1/admin/devices",
        json={"name": "Workshop Scale"},
        headers={"X-CSRF-Token": csrf_token},
    )
    assert create_response.status_code == 201

    list_response = await client.get("/api/v1/admin/devices")
    assert list_response.status_code == 200
    device = list_response.json()["items"][0]
    assert device["registration_pending"] is True
    assert "token_hash" not in device


@pytest.mark.asyncio
async def test_create_device_does_not_print_enrollment_code(auth_client, capsys):
    client, csrf_token = auth_client
    response = await client.post(
        "/api/v1/admin/devices",
        json={"name": "Workshop Scale"},
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 201

    assert response.json()["device_code"] not in capsys.readouterr().out


@pytest.mark.asyncio
async def test_rotating_device_token_rejects_warm_cached_token(auth_client):
    client, csrf_token = auth_client
    create_response = await client.post(
        "/api/v1/admin/devices",
        json={"name": "Workshop Scale"},
        headers={"X-CSRF-Token": csrf_token},
    )
    device = create_response.json()
    register_response = await client.post(
        "/api/v1/devices/register",
        headers={
            "X-Device-Code": device["device_code"],
            "X-CSRF-Token": csrf_token,
        },
    )
    old_token = register_response.json()["token"]

    warm_response = await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.5"},
        headers={"Authorization": f"Device {old_token}"},
    )
    assert warm_response.status_code == 200

    rotate_response = await client.post(
        f"/api/v1/admin/devices/{device['id']}/rotate",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert rotate_response.status_code == 200
    client.cookies.clear()

    rejected_response = await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.6"},
        headers={"Authorization": f"Device {old_token}"},
    )
    assert rejected_response.status_code == 401
