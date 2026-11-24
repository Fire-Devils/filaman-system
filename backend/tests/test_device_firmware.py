import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.security import generate_token_secret, hash_token
from app.models import Device, DeviceFirmware, UserSession
from app.services import firmware_service

ESP32 = "filaman-scale-esp32"
S3 = "filaman-scale-esp32s3"


def make_image(project: str = ESP32, version: str = "1.0.0", filler: bytes = b"\x00" * 64) -> bytes:
    return b"\xE9" + filler + f"FMFWINFO1:project={project};version={version};".encode() + b"\x00tail"


@pytest.fixture(autouse=True)
def firmware_tmp_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(firmware_service, "DATA_DIR", tmp_path)
    return tmp_path / "firmware"


async def upload(client, csrf, data: bytes, name: str = "fw.bin"):
    return await client.post(
        "/api/v1/admin/firmware",
        files={"file": (name, data, "application/octet-stream")},
        headers={"X-CSRF-Token": csrf},
    )


@pytest_asyncio.fixture
async def device_token(auth_client):
    client, csrf = auth_client
    created = (
        await client.post("/api/v1/admin/devices", json={"name": "Scale"}, headers={"X-CSRF-Token": csrf})
    ).json()
    reg = await client.post(
        "/api/v1/devices/register",
        headers={"X-Device-Code": created["device_code"], "X-CSRF-Token": csrf},
    )
    return reg.json()["token"], created["id"]


def dh(token):
    return {"Authorization": f"Device {token}"}


@pytest.mark.asyncio
async def test_upload_valid(auth_client, firmware_tmp_dir):
    client, csrf = auth_client
    data = make_image()
    r = await upload(client, csrf, data)
    assert r.status_code == 201
    body = r.json()
    assert body["project"] == ESP32 and body["version"] == "1.0.0"
    assert body["size"] == len(data) and body["is_current"] is True
    assert (firmware_tmp_dir / f"{body['sha256']}.bin").read_bytes() == data


@pytest.mark.asyncio
async def test_upload_wrong_magic(auth_client):
    client, csrf = auth_client
    r = await upload(client, csrf, b"\x00" + make_image()[1:])
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_firmware"


@pytest.mark.asyncio
async def test_upload_missing_marker(auth_client):
    client, csrf = auth_client
    r = await upload(client, csrf, b"\xE9" + b"\x00" * 100)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_firmware"


@pytest.mark.asyncio
async def test_upload_too_large(auth_client):
    client, csrf = auth_client
    r = await upload(client, csrf, make_image(filler=b"\x00" * 2_097_152))
    assert r.status_code == 413


@pytest.mark.asyncio
async def test_auto_current_and_replace_same_version(auth_client, firmware_tmp_dir):
    client, csrf = auth_client
    a = (await upload(client, csrf, make_image(version="1.0.0"))).json()
    b = (await upload(client, csrf, make_image(version="1.1.0"))).json()
    other = (await upload(client, csrf, make_image(project=S3, version="1.0.0"))).json()
    items = {i["id"]: i for i in (await client.get("/api/v1/admin/firmware")).json()}
    assert items[a["id"]]["is_current"] is False
    assert items[b["id"]]["is_current"] is True
    assert items[other["id"]]["is_current"] is True

    # same project+version, different bytes -> replaced, old file removed
    again = await upload(client, csrf, make_image(version="1.0.0", filler=b"\x01" * 64))
    assert again.status_code == 201
    new = again.json()
    assert new["id"] == a["id"] and new["sha256"] != a["sha256"] and new["is_current"] is True
    assert not (firmware_tmp_dir / f"{a['sha256']}.bin").exists()
    assert (firmware_tmp_dir / f"{new['sha256']}.bin").exists()
    items = {i["id"]: i for i in (await client.get("/api/v1/admin/firmware")).json()}
    assert len(items) == 3
    assert items[b["id"]]["is_current"] is False


@pytest.mark.asyncio
async def test_set_current_and_delete(auth_client, firmware_tmp_dir):
    client, csrf = auth_client
    h = {"X-CSRF-Token": csrf}
    a = (await upload(client, csrf, make_image(version="1.0.0"))).json()
    b = (await upload(client, csrf, make_image(version="1.1.0"))).json()

    assert (await client.delete(f"/api/v1/admin/firmware/{b['id']}", headers=h)).status_code == 409
    r = await client.post(f"/api/v1/admin/firmware/{a['id']}/current", headers=h)
    assert r.status_code == 200 and r.json()["is_current"] is True
    items = {i["id"]: i for i in (await client.get("/api/v1/admin/firmware")).json()}
    assert items[b["id"]]["is_current"] is False

    r = await client.delete(f"/api/v1/admin/firmware/{b['id']}", headers=h)
    assert r.status_code == 204
    assert not (firmware_tmp_dir / f"{b['sha256']}.bin").exists()
    assert (await client.delete(f"/api/v1/admin/firmware/{b['id']}", headers=h)).status_code == 404


@pytest.mark.asyncio
async def test_latest_and_download(auth_client, device_token):
    client, csrf = auth_client
    token, _ = device_token
    data = make_image()
    fw = (await upload(client, csrf, data)).json()
    await upload(client, csrf, make_image(project=S3, version="2.0.0"))

    r = await client.get(f"/api/v1/devices/firmware/latest?project={ESP32}", headers=dh(token))
    assert r.status_code == 200
    assert r.json() == {
        "project": ESP32,
        "version": "1.0.0",
        "size": len(data),
        "sha256": fw["sha256"],
        "url": f"/api/v1/devices/firmware/{fw['sha256']}.bin",
    }
    r = await client.get(f"/api/v1/devices/firmware/latest?project={S3}", headers=dh(token))
    assert r.json()["version"] == "2.0.0"
    r = await client.get("/api/v1/devices/firmware/latest?project=unknown", headers=dh(token))
    assert r.status_code == 404

    r = await client.get(f"/api/v1/devices/firmware/{fw['sha256']}.bin", headers=dh(token))
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-type"] == "application/octet-stream"
    assert int(r.headers["content-length"]) == len(data)

    # Resume after a broken connection (the ESP sends a Range header)
    r = await client.get(
        f"/api/v1/devices/firmware/{fw['sha256']}.bin",
        headers={**dh(token), "Range": "bytes=10-", "Accept-Encoding": "identity"},
    )
    assert r.status_code == 206
    assert r.content == data[10:]
    assert int(r.headers["content-length"]) == len(data) - 10


@pytest.mark.asyncio
async def test_download_unknown_and_invalid_sha(auth_client, device_token):
    client, _ = auth_client
    token, _ = device_token
    r = await client.get(f"/api/v1/devices/firmware/{'a' * 64}.bin", headers=dh(token))
    assert r.status_code == 404
    for bad in ("..%2F..%2Fetc%2Fpasswd", "ABC", "G" * 64, "a" * 63):
        r = await client.get(f"/api/v1/devices/firmware/{bad}.bin", headers=dh(token))
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_ota_report(auth_client, device_token, db_session):
    client, _ = auth_client
    token, device_id = device_token
    r = await client.post(
        "/api/v1/devices/ota-report",
        json={"from_version": "1.0.0", "to_version": "1.1.0", "result": "failed", "error": "x" * 300},
        headers=dh(token),
    )
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    device = (await db_session.execute(select(Device).where(Device.id == device_id))).scalar_one()
    await db_session.refresh(device)
    assert device.last_ota_result == "failed"
    assert len(device.last_ota_error) == 255
    assert (device.last_ota_from, device.last_ota_to) == ("1.0.0", "1.1.0")
    assert device.last_ota_at is not None

    r = await client.post(
        "/api/v1/devices/ota-report",
        json={"from_version": "1", "to_version": "2", "result": "bogus"},
        headers=dh(token),
    )
    assert r.status_code == 422

    listed = (await client.get("/api/v1/admin/devices")).json()["items"][0]
    assert listed["last_ota_result"] == "failed"


@pytest.mark.asyncio
async def test_heartbeat_with_and_without_firmware(auth_client, device_token):
    client, _ = auth_client
    token, _ = device_token
    r = await client.post("/api/v1/devices/heartbeat", json={"ip_address": "10.0.0.5"}, headers=dh(token))
    assert r.status_code == 200
    item = (await client.get("/api/v1/admin/devices")).json()["items"][0]
    assert item["firmware_version"] is None

    r = await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.5", "firmware_version": "1.2.3", "firmware_project": ESP32},
        headers=dh(token),
    )
    assert r.status_code == 200
    item = (await client.get("/api/v1/admin/devices")).json()["items"][0]
    assert item["firmware_version"] == "1.2.3" and item["firmware_project"] == ESP32


@pytest.mark.asyncio
async def test_heartbeat_with_target_version_marks_started_update_ok(auth_client, device_token):
    """The ok report before the reboot can get lost; the heartbeat of the new version settles it."""
    client, _ = auth_client
    token, _ = device_token
    await client.post(
        "/api/v1/devices/ota-report",
        json={"from_version": "1.0.0", "to_version": "1.1.0", "result": "started"},
        headers=dh(token),
    )
    # Still the old version: stays "started"
    await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.5", "firmware_version": "1.0.0", "firmware_project": ESP32},
        headers=dh(token),
    )
    item = (await client.get("/api/v1/admin/devices")).json()["items"][0]
    assert item["last_ota_result"] == "started"

    await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.5", "firmware_version": "1.1.0", "firmware_project": ESP32},
        headers=dh(token),
    )
    item = (await client.get("/api/v1/admin/devices")).json()["items"][0]
    assert item["last_ota_result"] == "ok"
    assert (item["last_ota_from"], item["last_ota_to"]) == ("1.0.0", "1.1.0")


async def _hb(client, token, version="1.0.0", project=ESP32):
    r = await client.post(
        "/api/v1/devices/heartbeat",
        json={"ip_address": "10.0.0.5", "firmware_version": version, "firmware_project": project},
        headers=dh(token),
    )
    assert r.status_code == 200
    return r.json()


@pytest.mark.asyncio
async def test_heartbeat_firmware_hint(auth_client, device_token):
    client, csrf = auth_client
    token, _ = device_token
    assert await _hb(client, token) == {"status": "ok"}  # no firmware for project
    assert (await upload(client, csrf, make_image(version="1.1.0"))).status_code in (200, 201)
    assert await _hb(client, token, "1.0.0") == {"status": "ok", "firmware_update": "1.1.0"}
    assert await _hb(client, token, "1.1.0") == {"status": "ok"}
    assert await _hb(client, token, "1.0.0", project=S3) == {"status": "ok"}


@pytest.mark.asyncio
async def test_heartbeat_firmware_hint_suppressed_after_rollback(auth_client, device_token):
    client, csrf = auth_client
    token, _ = device_token
    assert (await upload(client, csrf, make_image(version="1.1.0"))).status_code in (200, 201)
    await client.post(
        "/api/v1/devices/ota-report",
        json={"from_version": "1.0.0", "to_version": "1.1.0", "result": "rolled_back"},
        headers=dh(token),
    )
    assert await _hb(client, token, "1.0.0") == {"status": "ok"}
    assert (await upload(client, csrf, make_image(version="1.2.0"))).status_code in (200, 201)
    assert await _hb(client, token, "1.0.0") == {"status": "ok", "firmware_update": "1.2.0"}


@pytest.mark.asyncio
async def test_admin_endpoints_forbidden_without_permission(client, normal_user, db_session):
    secret = generate_token_secret()
    session = UserSession(user_id=normal_user.id, session_token_hash=hash_token(secret))
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)
    csrf = generate_token_secret()
    client.cookies.set("session_id", f"sess.{session.id}.{secret}")
    client.cookies.set("csrf_token", csrf)
    h = {"X-CSRF-Token": csrf}

    assert (await client.get("/api/v1/admin/firmware")).status_code == 403
    assert (await upload(client, csrf, make_image())).status_code == 403
    assert (await client.post("/api/v1/admin/firmware/1/current", headers=h)).status_code == 403
    assert (await client.delete("/api/v1/admin/firmware/1", headers=h)).status_code == 403


@pytest.mark.asyncio
async def test_device_endpoints_require_device_auth(client):
    sha = "a" * 64
    h = {"Authorization": "Bearer nope"}
    assert (await client.get(f"/api/v1/devices/firmware/latest?project={ESP32}", headers=h)).status_code == 401
    assert (await client.get(f"/api/v1/devices/firmware/{sha}.bin", headers=h)).status_code == 401
    r = await client.post(
        "/api/v1/devices/ota-report",
        json={"from_version": "1", "to_version": "2", "result": "ok"},
        headers=h,
    )
    assert r.status_code == 401
