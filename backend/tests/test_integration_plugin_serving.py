import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.deps import get_db
from app.api.v1 import router as loader
from app.models.plugin import InstalledPlugin
from app.services import plugin_service


@pytest.mark.parametrize("mount", ["hot", "startup"])
async def test_integration_routes_follow_active_state(mount, db_session, tmp_path, monkeypatch):
    key = "serving_test"
    plugin_dir = tmp_path / key
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").touch()
    (plugin_dir / "plugin.json").write_text(json.dumps({
        "plugin_key": key, "plugin_type": "integration", "mount_prefix": "/plugins/serving-test",
    }))
    (plugin_dir / "router.py").write_text(
        "from fastapi import APIRouter\n"
        "router = APIRouter()\n"
        "@router.get('/hosted-config')\n"
        "def config(): return {'active': True}\n"
    )
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(loader, "_deferred_plugin_routers", [])

    app = FastAPI()
    if mount == "hot":
        assert loader.mount_plugin_router_on_app(app, key)
    else:
        loader._mount_plugin_routers()
        loader.mount_deferred_plugin_routers(app)

    async def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    plugin = InstalledPlugin(plugin_key=key, name="Test", version="1.0.0", plugin_type="integration")
    db_session.add(plugin)
    await db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        url = "/plugins/serving-test/hosted-config"
        assert (await client.get(url)).status_code == 200
        await plugin_service.PluginInstallService(db_session).set_active(key, False)
        assert (await client.get(url)).status_code == 404
        await plugin_service.PluginInstallService(db_session).set_active(key, True)
        assert (await client.get(url)).status_code == 200


async def test_bookmarked_shell_requires_an_active_install(db_session, tmp_path, monkeypatch):
    from app import main

    shell = tmp_path / "plugin-view/detail/index.html"
    shell.parent.mkdir(parents=True)
    shell.write_text("integration shell")
    monkeypatch.setattr(main, "static_files_path", str(tmp_path), raising=False)
    app = FastAPI()
    app.add_api_route("/plugin-view/{plugin_slug}", main.serve_plugin_view)

    async def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    plugin = InstalledPlugin(
        plugin_key="bookmarked", name="Bookmarked", version="1.0.0",
        plugin_type="integration", page_url="/plugin-view/bookmarked",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        url = plugin.page_url
        assert (await client.get(url)).status_code == 404
        db_session.add(plugin)
        await db_session.commit()
        assert (await client.get(url)).text == "integration shell"
        await plugin_service.PluginInstallService(db_session).set_active(plugin.plugin_key, False)
        assert (await client.get(url)).status_code == 404
