import json
from unittest.mock import patch

import pytest

from app.services.plugin_service import PluginInstallError, PluginInstallService
from tests.test_plugin_service import VALID_MANIFEST, VALID_DRIVER_PY, _make_zip


SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#168a72"/></svg>'


def package(icon="icon.svg", content=SVG):
    return _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "icon": icon, "show_in_nav": True, "page_url": "/plugin-page/test"}),
        "__init__.py": "", "driver.py": VALID_DRIVER_PY, "icon.svg": content,
    })


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
