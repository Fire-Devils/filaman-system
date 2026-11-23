import httpx
import pytest

from app.api.v1 import system as system_api
from app.services import firmware_service

from tests.test_device_firmware import ESP32, S3, make_image
from tests.test_firmware_github_import import asset, mock_github

VC = "/api/v1/admin/system/version-check"
IMPORT = "/api/v1/admin/firmware/github-import"
N_ESP = "upgrade_filaman_firmware_v{}.bin"
N_S3 = "upgrade_filaman_firmware_esp32s3_v{}.bin"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(firmware_service, "DATA_DIR", tmp_path)
    system_api._invalidate_version_cache()
    yield
    system_api._invalidate_version_cache()


def release(version, s3=True):
    names = [N_ESP.format(version)] + ([N_S3.format(version)] if s3 else [])
    return {"tag_name": f"v{version}", "assets": [asset(n) for n in names] + [asset("filaman_full.bin")]}, names


async def upload(client, csrf, project_image):
    r = await client.post(
        "/api/v1/admin/firmware",
        headers={"X-CSRF-Token": csrf},
        files={"file": ("f.bin", project_image)},
    )
    assert r.status_code in (200, 201), r.text


def fw(body):
    return {u["project"]: u for u in body["firmware_updates"]}


@pytest.mark.asyncio
async def test_update_available_and_equal_or_older(auth_client, monkeypatch):
    client, csrf = auth_client
    await upload(client, csrf, make_image(ESP32, "3.5.0"))
    await upload(client, csrf, make_image(S3, "3.6.0"))
    rel, _ = release("3.6.0")
    mock_github(monkeypatch, rel, {})
    body = (await client.get(VC)).json()
    updates = fw(body)
    assert updates[ESP32] == {"project": ESP32, "latest_version": "3.6.0", "current_version": "3.5.0", "update_available": True}
    assert updates[S3]["update_available"] is False  # equal
    system_api._invalidate_version_cache()
    rel.clear()
    rel.update(release("3.5.5")[0])
    updates = fw((await client.get(VC)).json())
    assert updates[S3]["update_available"] is False  # latest older than current
    assert updates[ESP32]["update_available"] is True  # 3.5.5 > 3.5.0


@pytest.mark.asyncio
async def test_no_firmware_in_db(auth_client, monkeypatch):
    client, _ = auth_client
    rel, _ = release("3.6.0", s3=False)
    mock_github(monkeypatch, rel, {})
    updates = fw((await client.get(VC)).json())
    assert list(updates) == [ESP32]
    assert updates[ESP32]["current_version"] is None and updates[ESP32]["update_available"] is True


@pytest.mark.asyncio
async def test_github_down_empty_list(auth_client, monkeypatch):
    client, _ = auth_client
    mock_github(monkeypatch, httpx.ConnectError("boom"), {})
    r = await client.get(VC)
    assert r.status_code == 200
    assert r.json()["firmware_updates"] == []


@pytest.mark.asyncio
async def test_cache_hit_recomputes_current(auth_client, monkeypatch):
    client, csrf = auth_client
    rel, names = release("3.6.0", s3=False)
    hits = []
    mock_github(monkeypatch, rel, {names[0]: make_image(ESP32, "3.6.0")}, hits)
    first = fw((await client.get(VC)).json())
    assert first[ESP32]["update_available"] is True
    n = len(hits)
    r = await client.post(IMPORT, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    n_after_import = len(hits)
    second = fw((await client.get(VC)).json())
    assert len(hits) == n_after_import  # served from cache, no new GitHub call
    assert n_after_import > n
    assert second[ESP32]["current_version"] == "3.6.0"
    assert second[ESP32]["update_available"] is False


@pytest.mark.asyncio
async def test_hint_only_reported_projects(auth_client, db_session, monkeypatch):
    from app.models import Device

    client, _ = auth_client
    rel, _ = release("3.6.0")
    mock_github(monkeypatch, rel, {})
    assert set(fw((await client.get(VC)).json())) == {ESP32, S3}  # no device reported
    db_session.add(Device(name="d", device_type="scale", token_hash="x", firmware_project=S3))
    await db_session.commit()
    assert set(fw((await client.get(VC)).json())) == {S3}  # cache hit, fresh filter
