import pytest
from sqlalchemy import select

from app.models import AppSettings, DeviceFirmware
from app.services import firmware_github, firmware_service
from tests.test_device_firmware import ESP32, S3, make_image, upload
from tests.test_firmware_github_import import asset, mock_github

H = lambda csrf: {"X-CSRF-Token": csrf}  # noqa: E731


@pytest.fixture(autouse=True)
def firmware_tmp_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(firmware_service, "DATA_DIR", tmp_path)
    return tmp_path / "firmware"


async def set_prune(db_session, value=True):
    row = (await db_session.execute(select(AppSettings).where(AppSettings.id == 1))).scalar_one_or_none()
    if row is None:
        db_session.add(AppSettings(id=1, firmware_keep_latest_only=value))
    else:
        row.firmware_keep_latest_only = value
    await db_session.commit()


async def versions(db_session, project=ESP32):
    rows = (await db_session.execute(select(DeviceFirmware).where(DeviceFirmware.project == project))).scalars().all()
    return sorted(r.version for r in rows)


@pytest.mark.asyncio
async def test_setting_off_keeps_everything(auth_client, db_session):
    client, csrf = auth_client
    for v in ("3.5.0", "3.5.1", "3.5.2"):
        assert (await upload(client, csrf, make_image(ESP32, v))).status_code == 201
    assert await versions(db_session) == ["3.5.0", "3.5.1", "3.5.2"]


@pytest.mark.asyncio
async def test_upload_prunes_oldest(auth_client, db_session, firmware_tmp_dir):
    client, csrf = auth_client
    await set_prune(db_session)
    shas = {}
    for v in ("3.5.0", "3.5.1"):
        r = await upload(client, csrf, make_image(ESP32, v))
        shas[v] = r.json()["sha256"]
    assert await versions(db_session) == ["3.5.0", "3.5.1"]
    r = await upload(client, csrf, make_image(ESP32, "3.5.2"))
    assert r.status_code == 201
    assert await versions(db_session) == ["3.5.1", "3.5.2"]
    assert not (firmware_tmp_dir / f"{shas['3.5.0']}.bin").exists()
    assert (firmware_tmp_dir / f"{shas['3.5.1']}.bin").exists()


@pytest.mark.asyncio
async def test_switch_back_keeps_previous_and_newest(auth_client, db_session):
    client, csrf = auth_client
    await set_prune(db_session)
    ids = {}
    for v in ("3.5.0", "3.5.1", "3.5.2"):
        ids[v] = (await upload(client, csrf, make_image(ESP32, v))).json()["id"]
    assert await versions(db_session) == ["3.5.1", "3.5.2"]
    assert (await client.post(f"/api/v1/admin/firmware/{ids['3.5.1']}/current", headers=H(csrf))).status_code == 200
    assert await versions(db_session) == ["3.5.1", "3.5.2"]


@pytest.mark.asyncio
async def test_projects_separate(auth_client, db_session):
    client, csrf = auth_client
    await set_prune(db_session)
    for p, v in ((ESP32, "1.0.0"), (S3, "1.0.0"), (ESP32, "1.0.1"), (ESP32, "1.0.2"), (S3, "1.0.1")):
        await upload(client, csrf, make_image(p, v))
    assert await versions(db_session, ESP32) == ["1.0.1", "1.0.2"]
    assert await versions(db_session, S3) == ["1.0.0", "1.0.1"]


@pytest.mark.asyncio
async def test_enabling_via_put_prunes(auth_client, db_session):
    client, csrf = auth_client
    for v in ("3.5.0", "3.5.1", "3.5.2"):
        await upload(client, csrf, make_image(ESP32, v))
    assert len(await versions(db_session)) == 3
    r = await client.put("/api/v1/admin/app-settings/", json={"firmware_keep_latest_only": True}, headers=H(csrf))
    assert r.status_code == 200
    assert r.json()["firmware_keep_latest_only"] is True
    db_session.expire_all()
    assert await versions(db_session) == ["3.5.1", "3.5.2"]


@pytest.mark.asyncio
async def test_no_current_deletes_nothing(db_session):
    await set_prune(db_session)
    for i, v in enumerate(("1.0.0", "1.0.1", "1.0.2")):
        db_session.add(DeviceFirmware(project=ESP32, version=v, size=1, sha256=f"{i:064x}"))
    await db_session.commit()
    assert await firmware_service.prune_firmware(db_session) == 0
    assert len(await versions(db_session)) == 3


@pytest.mark.asyncio
async def test_github_import_prunes(auth_client, db_session, monkeypatch):
    client, csrf = auth_client
    await set_prune(db_session)
    for v in ("3.5.0", "3.5.1"):
        await upload(client, csrf, make_image(ESP32, v))
    name = "upgrade_filaman_firmware_v3.5.2.bin"
    mock_github(monkeypatch, {"tag_name": "v3.5.2", "assets": [asset(name)]}, {name: make_image(ESP32, "3.5.2")})
    r = await client.post("/api/v1/admin/firmware/github-import", headers=H(csrf))
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert await versions(db_session) == ["3.5.1", "3.5.2"]
