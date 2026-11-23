from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import select

from app.core.security import generate_token_secret, hash_token
from app.models import AppSettings, DeviceFirmware, UserSession
from app.services import firmware_github, firmware_service

from tests.test_device_firmware import ESP32, S3, make_image

URL = "/api/v1/admin/firmware/github-import"
DL = "https://github.com/Fire-Devils/FilaMan-System-ESP32/releases/download/v1/"


@pytest.fixture(autouse=True)
def firmware_tmp_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(firmware_service, "DATA_DIR", tmp_path)
    return tmp_path / "firmware"


def asset(name, size=100):
    return {"name": name, "size": size, "browser_download_url": DL + name}


def mock_github(monkeypatch, release, files, hits=None):
    def respond(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if hits is not None:
            hits.append(url)
        if url == firmware_github.GITHUB_FIRMWARE_RELEASE_URL:
            if isinstance(release, Exception):
                raise release
            if isinstance(release, int):
                return httpx.Response(release)
            return httpx.Response(200, json=release)
        name = url.rsplit("/", 1)[-1]
        if url.startswith("https://evil.example/"):
            return httpx.Response(200, content=b"x")
        if name in files:
            value = files[name]
            if isinstance(value, httpx.Response):
                return value
            return httpx.Response(200, content=value)
        return httpx.Response(404)

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        firmware_github.httpx,
        "AsyncClient",
        lambda **kw: factory(transport=httpx.MockTransport(respond), **kw),
    )


def by_asset(body):
    return {r["asset"]: r for r in body["results"]}


@pytest.mark.asyncio
async def test_import_new_and_second_project(auth_client, monkeypatch):
    client, csrf = auth_client
    esp = make_image(ESP32, "3.5.0")
    s3 = make_image(S3, "3.5.0")
    names = ["upgrade_filaman_firmware_v3.5.0.bin", "upgrade_filaman_firmware_esp32s3_v3.5.0.bin"]
    mock_github(
        monkeypatch,
        {"tag_name": "v3.5.0", "assets": [asset(names[0]), asset(names[1])]},
        {names[0]: esp, names[1]: s3},
    )
    r = await client.post(URL, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    body = r.json()
    assert body["release"] == "v3.5.0"
    res = by_asset(body)
    assert res[names[0]]["status"] == "imported" and res[names[0]]["project"] == ESP32
    assert res[names[1]]["status"] == "imported" and res[names[1]]["project"] == S3
    listed = (await client.get("/api/v1/admin/firmware")).json()
    assert {(f["project"], f["is_current"]) for f in listed} == {(ESP32, True), (S3, True)}


@pytest.mark.asyncio
async def test_no_marker_skipped_and_other_assets_ignored(auth_client, monkeypatch):
    client, csrf = auth_client
    old = "upgrade_filaman_firmware_v3.4.11.bin"
    mock_github(
        monkeypatch,
        {
            "tag_name": "v3.4.11",
            "assets": [
                asset(old),
                asset("filaman_full_v3.4.11.bin"),
                asset("upgrade_filaman_website_v3.4.11.bin"),
            ],
        },
        {old: b"\xE9" + b"\x00" * 50},
    )
    body = (await client.post(URL, headers={"X-CSRF-Token": csrf})).json()
    assert [r["asset"] for r in body["results"]] == [old]
    assert body["results"][0]["status"] == "skipped"
    assert "OTA" in body["results"][0]["message"]


@pytest.mark.asyncio
async def test_exists_keeps_rolled_back_current(auth_client, monkeypatch):
    client, csrf = auth_client
    h = {"X-CSRF-Token": csrf}
    new = make_image(ESP32, "2.0.0")
    name = "upgrade_filaman_firmware_v2.0.0.bin"
    mock_github(monkeypatch, {"tag_name": "v2.0.0", "assets": [asset(name)]}, {name: new})
    assert by_asset((await client.post(URL, headers=h)).json())[name]["status"] == "imported"
    # newer image so that 2.0.0 can be rolled back to
    older = make_image(ESP32, "1.0.0")
    await client.post(
        "/api/v1/admin/firmware", files={"file": ("a.bin", older, "application/octet-stream")}, headers=h
    )
    listed = (await client.get("/api/v1/admin/firmware")).json()
    v2 = next(f for f in listed if f["version"] == "2.0.0")
    await client.post(f"/api/v1/admin/firmware/{v2['id']}/current", headers=h)
    v1 = next(f for f in listed if f["version"] == "1.0.0")
    await client.post(f"/api/v1/admin/firmware/{v1['id']}/current", headers=h)  # deliberate rollback
    assert by_asset((await client.post(URL, headers=h)).json())[name]["status"] == "exists"
    after = {f["version"]: f["is_current"] for f in (await client.get("/api/v1/admin/firmware")).json()}
    assert after == {"1.0.0": True, "2.0.0": False}


@pytest.mark.asyncio
async def test_oversized_asset_skipped_without_download(auth_client, monkeypatch):
    client, csrf = auth_client
    name = "upgrade_filaman_firmware_v9.0.0.bin"
    hits = []
    mock_github(
        monkeypatch,
        {"tag_name": "v9", "assets": [asset(name, size=firmware_service.MAX_FIRMWARE_BYTES + 1)]},
        {name: make_image()},
        hits,
    )
    body = (await client.post(URL, headers={"X-CSRF-Token": csrf})).json()
    assert body["results"][0]["status"] == "skipped"
    assert len(hits) == 1


@pytest.mark.asyncio
async def test_oversized_stream_fails(auth_client, monkeypatch):
    client, csrf = auth_client
    name = "upgrade_filaman_firmware_v9.0.0.bin"
    mock_github(
        monkeypatch,
        {"tag_name": "v9", "assets": [asset(name, size=10)]},
        {name: b"\xE9" + b"\x00" * firmware_service.MAX_FIRMWARE_BYTES},
    )
    body = (await client.post(URL, headers={"X-CSRF-Token": csrf})).json()
    assert body["results"][0]["status"] == "failed"


@pytest.mark.asyncio
async def test_redirect_to_foreign_host_fails(auth_client, monkeypatch):
    client, csrf = auth_client
    name = "upgrade_filaman_firmware_v3.5.0.bin"
    redirect = httpx.Response(302, headers={"location": "https://evil.example/fw.bin"})
    mock_github(monkeypatch, {"tag_name": "v3.5.0", "assets": [asset(name)]}, {name: redirect})
    body = (await client.post(URL, headers={"X-CSRF-Token": csrf})).json()
    assert body["results"][0]["status"] == "failed"
    assert "Host" in body["results"][0]["message"]


@pytest.mark.asyncio
async def test_redirect_to_githubusercontent_ok(auth_client, monkeypatch):
    client, csrf = auth_client
    name = "upgrade_filaman_firmware_v3.5.0.bin"
    target = "https://release-assets.githubusercontent.com/x/" + name
    redirect = httpx.Response(302, headers={"location": target})

    def respond(request):
        url = str(request.url)
        if url == firmware_github.GITHUB_FIRMWARE_RELEASE_URL:
            return httpx.Response(200, json={"tag_name": "v3.5.0", "assets": [asset(name)]})
        if url.startswith("https://github.com/"):
            return redirect
        return httpx.Response(200, content=make_image(ESP32, "3.5.0"))

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        firmware_github.httpx,
        "AsyncClient",
        lambda **kw: factory(transport=httpx.MockTransport(respond), **kw),
    )
    body = (await client.post(URL, headers={"X-CSRF-Token": csrf})).json()
    assert body["results"][0]["status"] == "imported"


@pytest.mark.asyncio
@pytest.mark.parametrize("release", [500, httpx.ConnectTimeout("timeout")])
async def test_github_unavailable_502(auth_client, monkeypatch, release):
    client, csrf = auth_client
    mock_github(monkeypatch, release, {})
    r = await client.post(URL, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "github_unavailable"


@pytest.mark.asyncio
async def test_github_import_forbidden_without_permission(client, normal_user, db_session):
    secret = generate_token_secret()
    session = UserSession(user_id=normal_user.id, session_token_hash=hash_token(secret))
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)
    csrf = generate_token_secret()
    client.cookies.set("session_id", f"sess.{session.id}.{secret}")
    client.cookies.set("csrf_token", csrf)
    assert (await client.post(URL, headers={"X-CSRF-Token": csrf})).status_code == 403


@pytest.mark.asyncio
async def test_auto_import_once(db_session, monkeypatch):
    import app.core.database as db_module

    @asynccontextmanager
    async def maker():
        yield db_session

    monkeypatch.setattr(db_module, "async_session_maker", maker)
    name = "upgrade_filaman_firmware_v3.5.0.bin"
    hits = []
    mock_github(
        monkeypatch,
        {"tag_name": "v3.5.0", "assets": [asset(name)]},
        {name: make_image(ESP32, "3.5.0")},
        hits,
    )
    # no settings row / setting off: nothing happens
    assert await firmware_github.run_firmware_auto_import_once() is None
    db_session.add(AppSettings(id=1, firmware_auto_import=False))
    await db_session.commit()
    assert await firmware_github.run_firmware_auto_import_once() is None
    assert hits == []
    row = (await db_session.execute(select(AppSettings))).scalar_one()
    row.firmware_auto_import = True
    await db_session.commit()
    result = await firmware_github.run_firmware_auto_import_once()
    assert result["results"][0]["status"] == "imported"
    assert (await db_session.execute(select(DeviceFirmware))).scalars().one().version == "3.5.0"
