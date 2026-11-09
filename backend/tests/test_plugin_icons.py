import json
from unittest.mock import patch

import pytest
from app.models.plugin import InstalledPlugin
from app.services.plugin_service import PluginInstallError, PluginInstallService

from tests.test_plugin_service import VALID_DRIVER_PY, VALID_MANIFEST, _make_zip

SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#168a72"/></svg>'


def package(icon="icon.svg", content=SVG):
    return _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "icon": icon, "show_in_nav": True, "page_url": "/plugin-page/test"}),
        "__init__.py": "", "driver.py": VALID_DRIVER_PY, "icon.svg": content,
    })


def test_hosted_svg_artwork_is_allowed_but_is_not_a_sidebar_icon():
    artwork_path = "static/artwork.svg"
    artwork = (
        '<svg xmlns="http://www.w3.org/2000/svg"><defs>'
        '<linearGradient id="shade"><stop offset="0" stop-color="red"/></linearGradient>'
        '</defs><rect width="24" height="24" fill="url(#shade)"/></svg>'
    )
    manifest = {
        **VALID_MANIFEST,
        "plugin_type": "integration",
        "page_url": "/plugin-view/example",
        "mount_prefix": "/plugins/example",
        "icon": "icon.svg",
    }
    files = {
        "plugin.json": json.dumps(manifest),
        "__init__.py": "",
        "router.py": "from fastapi import APIRouter\nrouter = APIRouter()\n",
        "icon.svg": SVG,
        artwork_path: artwork,
    }
    with PluginInstallService.validated_archive(_make_zip(files)) as (path, validated):
        assert validated["icon"] == "icon.svg"
        assert (path / artwork_path).read_text() == artwork

    files["plugin.json"] = json.dumps({**manifest, "icon": artwork_path})
    with pytest.raises(PluginInstallError) as error, PluginInstallService.validated_archive(_make_zip(files)):
        pass
    assert error.value.code == "invalid_icon"

    files["plugin.json"] = json.dumps({**manifest, "page_url": "/plugin-page/example", "mount_prefix": None})
    with pytest.raises(PluginInstallError) as error, PluginInstallService.validated_archive(_make_zip(files)):
        pass
    assert error.value.code == "invalid_icon"


def test_declared_icon_size_limit_preserves_legacy_svg_assets():
    with PluginInstallService.validated_archive(package(content=SVG.ljust(4096))):
        pass

    artwork = SVG.ljust(4097)
    with (
        pytest.raises(PluginInstallError, match="at most 4 KiB"),
        PluginInstallService.validated_archive(package(content=artwork)),
    ):
        pass

    with PluginInstallService.validated_archive(package(icon=None, content=artwork)):
        pass


@pytest.mark.asyncio
async def test_preexisting_larger_icon_stays_visible(auth_client, db_session, tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.plugin_service.PLUGINS_DIR", tmp_path)
    plugin = InstalledPlugin(plugin_key="legacy_icon", name="Legacy icon", version="1.0.0", icon="icon.svg")
    db_session.add(plugin)
    await db_session.commit()
    plugin_dir = tmp_path / plugin.plugin_key
    plugin_dir.mkdir()
    icon = SVG.ljust(4097)
    (plugin_dir / "icon.svg").write_text(icon)

    client, _ = auth_client
    response = await client.get(f"/api/v1/plugin-icons/{plugin.plugin_key}")
    assert response.status_code == 200
    assert response.text == icon


@pytest.mark.asyncio
@pytest.mark.parametrize("installed_by", [1, None])
async def test_icon_survives_install_and_appears_in_both_apis(auth_client, db_session, tmp_path, installed_by):
    client, _ = auth_client
    with patch("app.services.plugin_service.PLUGINS_DIR", tmp_path):
        plugin, _ = await PluginInstallService(db_session).install_from_zip(package(), installed_by=installed_by)
        assert plugin.icon == "icon.svg"
        for endpoint in ("/api/v1/plugin-nav", "/api/v1/admin/system/plugins"):
            response = await client.get(endpoint)
            assert response.status_code == 200
            item = next(p for p in response.json() if p["plugin_key"] == "test_plugin")
            assert item["icon_url"] == "/api/v1/plugin-icons/test_plugin?v=1.0.0"
        image = await client.get("/api/v1/plugin-icons/test_plugin")
        assert image.status_code == 200
        assert image.text == SVG
        assert image.headers["content-type"].startswith("image/svg+xml")
        assert image.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in image.headers["content-security-policy"]
        # Admins still need to identify deactivated plugins in the list.
        await PluginInstallService(db_session).set_active("test_plugin", False)
        assert (await client.get("/api/v1/plugin-icons/test_plugin")).status_code == 200


@pytest.mark.asyncio
async def test_icon_is_cleared_when_upgrade_omits_it(db_session, tmp_path):
    service = PluginInstallService(db_session)
    with patch("app.services.plugin_service.PLUGINS_DIR", tmp_path):
        await service.install_from_zip(package(), installed_by=1)
        plugin, upgraded = await service.install_from_zip(_make_zip({
            "plugin.json": json.dumps({**VALID_MANIFEST, "version": "1.0.1"}),
            "__init__.py": "", "driver.py": VALID_DRIVER_PY,
        }))
    assert upgraded
    assert plugin.icon is None
    assert plugin.icon_url is None


@pytest.mark.asyncio
@pytest.mark.parametrize("icon", ["../icon.svg", "/icon.svg", "https://example.com/icon.svg", "icon.svg?x=1", "icon.png", "missing.svg", 42, ""])
async def test_rejects_invalid_icon_before_install(db_session, tmp_path, icon):
    with patch("app.services.plugin_service.PLUGINS_DIR", tmp_path):
        with pytest.raises(PluginInstallError) as error:
            await PluginInstallService(db_session).install_from_zip(package(icon), installed_by=1)
    assert error.value.code == "invalid_icon"
    assert not (tmp_path / "test_plugin").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.com/a)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
    '<?xml-stylesheet href="https://example.com/style.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<html/>', '<svg', SVG + ' ' * 65536,
])
async def test_rejects_active_or_invalid_svg(db_session, tmp_path, content):
    with patch("app.services.plugin_service.PLUGINS_DIR", tmp_path):
        with pytest.raises(PluginInstallError) as error:
            await PluginInstallService(db_session).install_from_zip(package(content=content), installed_by=1)
    assert error.value.code == "invalid_icon"


@pytest.mark.asyncio
async def test_builtin_icons_and_missing_icons(auth_client):
    client, _ = auth_client
    response = await client.get("/api/v1/admin/system/plugins")
    for key in ("spoolman_import", "filamentdb_import"):
        plugin = next(p for p in response.json() if p["plugin_key"] == key)
        assert plugin["icon_url"].startswith(f"/api/v1/plugin-icons/{key}")
        image = await client.get(plugin["icon_url"])
        assert image.status_code == 200
        assert "<svg" in image.text
    assert (await client.get("/api/v1/plugin-icons/unknown")).status_code == 404


@pytest.mark.asyncio
async def test_pre_icon_backup_keeps_builtin_icons(auth_client, db_session, monkeypatch, tmp_path):
    from app.api.v1 import system
    from app.core.seeds import BUILTIN_PLUGINS

    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    old_records = [{key: value for key, value in plugin.items() if key != "icon"} for plugin in BUILTIN_PLUGINS]
    client, token = auth_client
    response = await client.post(
        "/api/v1/admin/system/backup/import",
        files={"file": ("old.json", json.dumps({"metadata": {}, "data": {"installed_plugins": old_records}}), "application/json")},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 200, response.text
    for record in old_records:
        plugin = await PluginInstallService(db_session).get_plugin(record["plugin_key"])
        assert plugin.icon_url
        image = await system.plugin_icon(record["plugin_key"], db_session, None)
        assert image.media_type == "image/svg+xml"


@pytest.mark.asyncio
async def test_icon_is_revalidated_when_served(auth_client, db_session, tmp_path):
    client, _ = auth_client
    with patch("app.services.plugin_service.PLUGINS_DIR", tmp_path):
        await PluginInstallService(db_session).install_from_zip(package(), installed_by=1)
        path = tmp_path / "test_plugin" / "icon.svg"
        path.write_text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
        assert (await client.get("/api/v1/plugin-icons/test_plugin")).status_code == 404
        path.unlink()
        outside = tmp_path / "outside.svg"
        outside.write_text(SVG)
        path.symlink_to(outside)
        assert (await client.get("/api/v1/plugin-icons/test_plugin")).status_code == 404


@pytest.mark.asyncio
async def test_icon_requires_authentication(client):
    assert (await client.get("/api/v1/plugin-icons/spoolman_import")).status_code == 401
