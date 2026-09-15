import pytest
from fastapi import HTTPException
from sqlalchemy import select
from unittest.mock import AsyncMock, MagicMock, patch

from app.api.v1.devices import _device_url
from app.core.security import hash_password, hash_token, verify_password_async
from app.models import Device, Filament, Location, Manufacturer, Spool, SpoolStatus


async def _create_device(
    db_session,
    name: str = "Test Scale",
    device_type: str = "scale",
    device_code: str = "ABC123",
    **kwargs,
) -> Device:
    device = Device(
        name=name,
        device_type=device_type,
        device_code=device_code,
        token_hash=hash_token("placeholder"),
        is_active=True,
        **kwargs,
    )
    db_session.add(device)
    await db_session.commit()
    await db_session.refresh(device)
    return device


async def _register_device(client, device_code: str, csrf_token: str | None = None) -> tuple[str, int]:
    headers = {"X-Device-Code": device_code}
    if csrf_token:
        headers["X-CSRF-Token"] = csrf_token
    response = await client.post(
        "/api/v1/devices/register",
        headers=headers,
    )
    assert response.status_code == 200
    token = response.json()["token"]
    device_id = int(token.split(".")[1])
    return token, device_id


def _device_headers(token: str) -> dict:
    return {"Authorization": f"Device {token}"}


async def _get_status(db_session, key: str) -> SpoolStatus:
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == key))
    return result.scalar_one()


async def _create_manufacturer(db_session, name: str = "Test Mfr") -> Manufacturer:
    manufacturer = Manufacturer(name=name)
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)
    return manufacturer


async def _create_filament(
    db_session,
    manufacturer_id: int,
    designation: str = "Test PLA",
    material_type: str = "PLA",
    default_spool_weight_g: float = 250.0,
) -> Filament:
    filament = Filament(
        manufacturer_id=manufacturer_id,
        designation=designation,
        material_type=material_type,
        diameter_mm=1.75,
        default_spool_weight_g=default_spool_weight_g,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)
    return filament


async def _create_spool(
    db_session,
    filament_id: int,
    status_id: int,
    **kwargs,
) -> Spool:
    spool = Spool(
        filament_id=filament_id,
        status_id=status_id,
        initial_total_weight_g=kwargs.pop("initial_total_weight_g", 1000.0),
        empty_spool_weight_g=kwargs.pop("empty_spool_weight_g", None),
        remaining_weight_g=kwargs.pop("remaining_weight_g", 750.0),
        **kwargs,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


async def _create_location(db_session, name: str = "Shelf A", identifier: str | None = None) -> Location:
    location = Location(name=name, identifier=identifier)
    db_session.add(location)
    await db_session.commit()
    await db_session.refresh(location)
    return location


def test_device_url_rejects_invalid_legacy_address():
    with pytest.raises(HTTPException) as error:
        _device_url("printer.local", "/api/v1/rfid/write")

    assert error.value.status_code == 400
    assert error.value.detail["code"] == "unsafe_device_address"


class TestDeviceRegistration:
    @pytest.mark.asyncio
    async def test_register_device_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, device_code="ABC123")

        token, device_id = await _register_device(client, "ABC123", csrf_token)

        assert token.startswith("dev.")
        assert device_id == device.id

        await db_session.refresh(device)
        assert device.device_code is None

    @pytest.mark.asyncio
    async def test_register_device_invalid_code(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/devices/register",
            headers={"X-Device-Code": "NOPE12", "X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_register_device_re_registration(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, device_code="ABC123")

        token_one, _ = await _register_device(client, "ABC123", csrf_token)

        device.device_code = "ABC123"
        await db_session.commit()

        token_two, _ = await _register_device(client, "ABC123", csrf_token)

        assert token_one != token_two
        await db_session.refresh(device)
        assert device.device_code is None


class TestDeviceHeartbeat:
    @pytest.mark.asyncio
    async def test_heartbeat_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf_token)

        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

        result = await db_session.execute(select(Device).where(Device.id == device_id))
        device = result.scalar_one()
        assert device.ip_address == "10.0.0.5"
        assert device.last_seen_at is not None

    @pytest.mark.asyncio
    async def test_heartbeat_rejects_non_ip_address(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf_token)

        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": '\"><img src=x onerror=alert(1)>'},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 422
        result = await db_session.execute(select(Device).where(Device.id == device_id))
        assert result.scalar_one().ip_address is None

    @pytest.mark.asyncio
    async def test_heartbeat_unauthenticated(self, client):
        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers={"Authorization": "Bearer nope"},
        )

        assert response.status_code == 401
        assert response.json()["detail"]["code"] == "unauthenticated"

    @pytest.mark.asyncio
    async def test_heartbeat_rejects_wrong_device_secret(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf_token)
        prefix, _, _ = token.split(".")

        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers={
                "Authorization": f"Device {prefix}.{device_id}.wrong-secret",
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 401
        result = await db_session.execute(select(Device).where(Device.id == device_id))
        assert result.scalar_one().ip_address is None

    @pytest.mark.asyncio
    async def test_heartbeat_rechecks_persisted_token_on_every_request(
        self,
        auth_client,
        db_session,
    ):
        client, csrf_token = auth_client
        device = await _create_device(db_session, device_code="ABC123")
        token, _ = await _register_device(client, "ABC123", csrf_token)

        warm_response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers=_device_headers(token),
        )
        assert warm_response.status_code == 200

        device.token_hash = hash_token("rotated-secret")
        await db_session.commit()
        client.cookies.clear()

        rejected_response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.6"},
            headers=_device_headers(token),
        )
        assert rejected_response.status_code == 401

    @pytest.mark.asyncio
    async def test_heartbeat_migrates_legacy_device_token(self, client, db_session):
        secret = "legacy-secret"
        device = await _create_device(db_session)
        device.token_hash = hash_password(secret)
        await db_session.commit()

        response = await client.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers=_device_headers(f"dev.{device.id}.{secret}"),
        )

        assert response.status_code == 200
        await db_session.refresh(device)
        assert device.token_hash == hash_token(secret)

    @pytest.mark.asyncio
    async def test_heartbeat_accepts_token_migrated_by_concurrent_request(
        self,
        client,
        db_session,
    ):
        secret = "legacy-secret"
        device = await _create_device(db_session)
        device.token_hash = hash_password(secret)
        await db_session.commit()

        async def migrate_while_verifying(candidate: str, stored_hash: str) -> bool:
            device.token_hash = hash_token(secret)
            await db_session.commit()
            return await verify_password_async(candidate, stored_hash)

        with patch(
            "app.core.middleware.verify_password_async",
            side_effect=migrate_while_verifying,
        ):
            response = await client.post(
                "/api/v1/devices/heartbeat",
                json={"ip_address": "10.0.0.5"},
                headers=_device_headers(f"dev.{device.id}.{secret}"),
            )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_heartbeat_does_not_restore_token_rotated_during_legacy_migration(
        self,
        client,
        db_session,
    ):
        old_secret = "legacy-secret"
        new_hash = hash_token("rotated-secret")
        device = await _create_device(db_session)
        device.token_hash = hash_password(old_secret)
        await db_session.commit()

        async def rotate_while_verifying(secret: str, stored_hash: str) -> bool:
            device.token_hash = new_hash
            await db_session.commit()
            return await verify_password_async(secret, stored_hash)

        with patch(
            "app.core.middleware.verify_password_async",
            side_effect=rotate_while_verifying,
        ):
            response = await client.post(
                "/api/v1/devices/heartbeat",
                json={"ip_address": "10.0.0.5"},
                headers=_device_headers(f"dev.{device.id}.{old_secret}"),
            )

        assert response.status_code == 401
        await db_session.refresh(device)
        assert device.token_hash == new_hash


class TestActiveDevices:
    @pytest.mark.asyncio
    async def test_list_active_devices(self, auth_client, client, db_session):
        auth, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(auth, "ABC123", csrf_token)

        heartbeat = await auth.post(
            "/api/v1/devices/heartbeat",
            json={"ip_address": "10.0.0.5"},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )
        assert heartbeat.status_code == 200

        response = await auth.get("/api/v1/devices/active")
        assert response.status_code == 200
        data = response.json()
        assert any(item["id"] == device_id for item in data)

    @pytest.mark.asyncio
    async def test_list_active_devices_empty(self, auth_client):
        client, _ = auth_client
        response = await client.get("/api/v1/devices/active")
        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_active_devices_requires_authentication(self, client):
        response = await client.get("/api/v1/devices/active")

        assert response.status_code == 401


class TestWriteTag:
    @pytest.mark.asyncio
    async def test_write_tag_requires_authentication(self, client, db_session):
        device = await _create_device(db_session, ip_address="192.168.1.10")

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            response = await client.post(
                f"/api/v1/devices/{device.id}/write-tag",
                json={"spool_id": 123},
            )

        assert response.status_code == 401
        mock_httpx.assert_not_called()

    @pytest.mark.asyncio
    async def test_write_tag_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="192.168.1.10")

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            mock_httpx.return_value = mock_client_instance

            response = await client.post(
                f"/api/v1/devices/{device.id}/write-tag",
                json={"spool_id": 123},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200

        await db_session.refresh(device)
        assert device.custom_fields is not None
        assert device.custom_fields["last_write_result"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_write_tag_missing_ids(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="192.168.1.10")

        response = await client.post(
            f"/api/v1/devices/{device.id}/write-tag",
            json={},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "bad_request"

    @pytest.mark.asyncio
    async def test_write_tag_device_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/devices/999999/write-tag",
            json={"spool_id": 123},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_write_tag_formats_ipv6_device_url(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(
            db_session,
            ip_address="2606:4700:4700::1111",
        )
        mock_response = MagicMock(status_code=200)

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_httpx.return_value = mock_client

            response = await client.post(
                f"/api/v1/devices/{device.id}/write-tag",
                json={"spool_id": 123},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200
        requested_url = mock_client.post.await_args.args[0]
        assert str(requested_url) == "http://[2606:4700:4700::1111]/api/v1/rfid/write"
        assert mock_httpx.call_args.kwargs["follow_redirects"] is False

    @pytest.mark.asyncio
    async def test_write_tag_rejects_unsafe_device_address(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="127.0.0.1")

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            response = await client.post(
                f"/api/v1/devices/{device.id}/write-tag",
                json={"spool_id": 123},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "unsafe_device_address"
        mock_httpx.assert_not_called()


class TestWriteStatus:
    @pytest.mark.asyncio
    async def test_write_status_requires_authentication(self, client, db_session):
        device = await _create_device(db_session)

        response = await client.get(f"/api/v1/devices/{device.id}/write-status")

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_write_status_none(self, auth_client, db_session):
        client, _ = auth_client
        device = await _create_device(db_session)

        response = await client.get(f"/api/v1/devices/{device.id}/write-status")

        assert response.status_code == 200
        assert response.json()["status"] == "none"

    @pytest.mark.asyncio
    async def test_write_status_after_write(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="192.168.1.10")

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            mock_httpx.return_value = mock_client_instance

            write_response = await client.post(
                f"/api/v1/devices/{device.id}/write-tag",
                json={"spool_id": 123},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert write_response.status_code == 200

        status_response = await client.get(f"/api/v1/devices/{device.id}/write-status")

        assert status_response.status_code == 200
        assert status_response.json()["status"] == "pending"


class TestRfidResult:
    @pytest.mark.asyncio
    async def test_rfid_result_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, _ = await _register_device(client, "ABC123", csrf_token)

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.post(
            "/api/v1/devices/rfid-result",
            json={"success": True, "tag_uuid": "RFID-123", "spool_id": spool.id},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

        await db_session.refresh(spool)
        assert spool.rfid_uid == "RFID-123"

    @pytest.mark.asyncio
    async def test_rfid_result_failure(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf_token)

        response = await client.post(
            "/api/v1/devices/rfid-result",
            json={"success": False, "tag_uuid": "RFID-123", "error_message": "Write failed"},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        assert response.json()["message"] == "Failure noted"

        result = await db_session.execute(select(Device).where(Device.id == device_id))
        device = result.scalar_one()
        assert device.custom_fields is not None
        assert device.custom_fields["last_write_result"]["status"] == "error"
        assert device.custom_fields["last_write_result"]["error_message"] == "Write failed"


class TestWeighSpool:
    @pytest.mark.asyncio
    async def test_weigh_spool_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, _ = await _register_device(client, "ABC123", csrf_token)

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, default_spool_weight_g=250.0)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id, empty_spool_weight_g=None)

        response = await client.post(
            "/api/v1/devices/scale/weight",
            json={"spool_id": spool.id, "measured_weight_g": 500.0},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["remaining_weight_g"] == 250.0
        assert data["spool_id"] == spool.id

        await db_session.refresh(spool)
        assert spool.remaining_weight_g == 250.0

    @pytest.mark.asyncio
    async def test_weigh_spool_auto_assign_proxies_to_primary(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123", auto_assign_enabled=True)
        token, _ = await _register_device(client, "ABC123", csrf_token)

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, default_spool_weight_g=250.0)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id, empty_spool_weight_g=None)

        proxied = {
            "remaining_weight_g": 250.0,
            "spool_id": spool.id,
            "filament_name": "Test PLA",
        }

        with patch("app.api.v1.devices._is_primary_worker", return_value=False), patch(
            "app.api.v1.printers._proxy_to_primary",
            new=AsyncMock(return_value=proxied),
        ) as mock_proxy:
            response = await client.post(
                "/api/v1/devices/scale/weight",
                json={"spool_id": spool.id, "measured_weight_g": 500.0},
                headers={
                    **_device_headers(token),
                    "X-CSRF-Token": csrf_token,
                },
            )

        assert response.status_code == 200
        assert response.json() == proxied
        mock_proxy.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_weigh_spool_auto_assign_rejects_proxied_hop_on_secondary(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123", auto_assign_enabled=True)
        token, _ = await _register_device(client, "ABC123", csrf_token)

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        with patch("app.api.v1.devices._is_primary_worker", return_value=False):
            response = await client.post(
                "/api/v1/devices/scale/weight",
                json={"spool_id": spool.id, "measured_weight_g": 500.0},
                headers={
                    **_device_headers(token),
                    "X-CSRF-Token": csrf_token,
                    "x-filaman-primary-hop": "1",
                },
            )

        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "primary_worker_required"

    @pytest.mark.asyncio
    async def test_locate_spool_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, _ = await _register_device(client, "ABC123", csrf_token)

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)
        location = await _create_location(db_session, name="New Shelf")

        response = await client.post(
            "/api/v1/devices/scale/locate",
            json={"spool_id": spool.id, "location_id": location.id},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["location_id"] == location.id

        await db_session.refresh(spool)
        assert spool.location_id == location.id


class TestTagScan:
    @pytest.mark.asyncio
    async def test_tag_scan_result_requires_authentication(self, client, db_session):
        device = await _create_device(db_session)

        response = await client.get(
            f"/api/v1/devices/{device.id}/tag-scan-result",
        )

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_request_tag_scan_requires_authentication(self, client, db_session):
        device = await _create_device(db_session, ip_address="192.168.1.10")

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            response = await client.post(
                f"/api/v1/devices/{device.id}/request-tag-scan",
            )

        assert response.status_code == 401
        mock_httpx.assert_not_called()

    @pytest.mark.asyncio
    async def test_request_tag_scan_rejects_unsafe_address_without_pending_state(
        self,
        auth_client,
        db_session,
    ):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="127.0.0.1")

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            response = await client.post(
                f"/api/v1/devices/{device.id}/request-tag-scan",
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 400
        await db_session.refresh(device)
        assert "last_tag_scan" not in (device.custom_fields or {})
        mock_httpx.assert_not_called()

    @pytest.mark.asyncio
    async def test_request_tag_scan_success(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="192.168.1.10")

        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            mock_httpx.return_value = mock_client_instance

            response = await client.post(
                f"/api/v1/devices/{device.id}/request-tag-scan",
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200
        assert response.json()["success"] is True

        await db_session.refresh(device)
        assert device.custom_fields is not None
        assert device.custom_fields["last_tag_scan"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_request_tag_scan_device_rejects_request(self, auth_client, db_session):
        client, csrf_token = auth_client
        device = await _create_device(db_session, ip_address="192.168.1.10")

        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("app.api.v1.devices.httpx.AsyncClient") as mock_httpx:
            mock_client_instance = AsyncMock()
            mock_client_instance.post = AsyncMock(return_value=mock_response)
            mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
            mock_client_instance.__aexit__ = AsyncMock(return_value=False)
            mock_httpx.return_value = mock_client_instance

            response = await client.post(
                f"/api/v1/devices/{device.id}/request-tag-scan",
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "device_scan_request_failed"

        await db_session.refresh(device)
        assert device.custom_fields is not None
        assert device.custom_fields["last_tag_scan"]["status"] == "error"

    @pytest.mark.asyncio
    async def test_receive_tag_data_error_status_updates_scan_state(self, auth_client, db_session):
        client, csrf_token = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf_token)

        response = await client.post(
            "/api/v1/devices/tag-data",
            json={"tag_json": "{\"scan_status\":\"error\",\"error_message\":\"Timeout - no tag found\"}"},
            headers={
                **_device_headers(token),
                "X-CSRF-Token": csrf_token,
            },
        )

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

        result = await db_session.execute(select(Device).where(Device.id == device_id))
        device = result.scalar_one()
        assert device.custom_fields is not None
        assert device.custom_fields["last_tag_scan"]["status"] == "error"
        assert device.custom_fields["last_tag_scan"]["error_message"] == "Timeout - no tag found"
        assert device.custom_fields["last_tag_scan"]["tag_data"] is None
