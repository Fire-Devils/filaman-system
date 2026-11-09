import json
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest
from app.api.deps import get_db
from app.api.v1 import router as loader
from app.core import database
from app.models.plugin import InstalledPlugin
from app.services import plugin_service
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def integration_zip(
    key, router, *, version="1.0.0", page_url="/plugin-view/example", prefix="/plugins/example",
    init_entry="__init__.py", router_entry="router.py",
):
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr("plugin.json", json.dumps({
            "plugin_key": key, "plugin_type": "integration", "name": "Example",
            "version": version, "description": "Hosted integration", "author": "Test",
            "page_url": page_url, "mount_prefix": prefix,
        }))
        archive.writestr(init_entry, "")
        if router is not None:
            archive.writestr(router_entry, router)
    return stream.getvalue()


HOSTED_ROUTER = (
    "from fastapi import APIRouter\n"
    "router = APIRouter()\n"
    "@router.get('/')\n"
    "def index(): return 'first version'\n"
)


@pytest.mark.parametrize("upgrade", [False, True])
@pytest.mark.parametrize("invalid_router", [
    "from fastapi import APIRouter\nfrom starlette.routing import Route\n"
    "router = APIRouter(routes=[Route('/', lambda request: None)])\n",
    HOSTED_ROUTER.replace("get('/')", "get('/other')"),
    HOSTED_ROUTER.replace("get('/')", "get('')"),
    "raise SystemExit(0)\n",
], ids=["unguarded", "no-launch-route", "slashless-launch", "exits-during-import"])
async def test_invalid_router_upload_preserves_installed_version(
    upgrade, invalid_router, db_session, db_engine, admin_user, tmp_path, monkeypatch,
):
    from app.api.v1 import system
    from app.core.security import Principal
    from fastapi import Request, UploadFile
    from starlette.datastructures import Headers

    key = "upgrade_fixture"
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(database, "async_session_maker", async_sessionmaker(db_engine))
    monkeypatch.setattr(system, "request_worker_reload", lambda: None)
    app = FastAPI()
    principal = Principal(auth_type="session", user_id=admin_user.id, is_superadmin=True)
    request = Request({"type": "http", "app": app})

    async def upload(package):
        file = UploadFile(BytesIO(package), headers=Headers({"content-type": "application/zip"}))
        return await system.install_plugin(request, db_session, file, principal)

    if upgrade:
        assert (await upload(integration_zip(key, HOSTED_ROUTER))).plugin.version == "1.0.0"
    with pytest.raises(HTTPException) as error:
        await upload(integration_zip(key, invalid_router, version="2.0.0"))
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "invalid_plugin_router"

    installed = await plugin_service.PluginInstallService(db_session).get_plugin(key)
    if upgrade:
        assert installed.version == "1.0.0"
        assert (tmp_path / key / "router.py").read_text() == HOSTED_ROUTER
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/plugins/example/")).json() == "first version"
    else:
        assert installed is None
        assert not (tmp_path / key).exists()


@pytest.mark.parametrize("uninstall", [False, True])
async def test_failed_plugin_commit_preserves_files_and_installed_version(
    uninstall, db_session, admin_user, tmp_path, monkeypatch,
):
    key = "commit_fixture"
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = plugin_service.PluginInstallService(db_session)
    installer_id = admin_user.id
    await service.install_from_zip(integration_zip(key, HOSTED_ROUTER), installed_by=installer_id)

    async def fail_commit():
        await db_session.flush()
        raise RuntimeError("commit failed")

    with monkeypatch.context() as patch:
        patch.setattr(db_session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="commit failed"):
            if uninstall:
                await service.uninstall(key)
            else:
                updated = HOSTED_ROUTER.replace("first version", "second version")
                await service.install_from_zip(integration_zip(key, updated, version="2.0.0"), installed_by=installer_id)

    assert (tmp_path / key / "router.py").read_text() == HOSTED_ROUTER
    assert (await service.get_plugin(key)).version == "1.0.0"


async def test_preflight_imports_installed_peer_without_falling_back_to_old_candidate(
    db_session, admin_user, tmp_path, monkeypatch,
):
    monkeypatch.chdir(tmp_path)
    plugins_dir = Path("plugins")
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", plugins_dir)
    peer = plugins_dir / "peer_fixture"
    peer.mkdir(parents=True)
    (peer / "__init__.py").write_text("MESSAGE = 'from installed peer'\n")
    router = "from app.plugins.peer_fixture import MESSAGE\n" + HOSTED_ROUTER.replace("'first version'", "MESSAGE")
    service = plugin_service.PluginInstallService(db_session)
    installer_id = admin_user.id
    key = "peer_consumer"
    await service.install_from_zip(integration_zip(key, router), installed_by=installer_id)

    malformed = integration_zip(key, "raise RuntimeError('bad candidate')\n", version="2.0.0", init_entry="__init__.py/")
    with pytest.raises(plugin_service.PluginInstallError) as error:
        await service.install_from_zip(malformed, installed_by=installer_id)
    assert error.value.code == "missing_file"
    assert (plugins_dir / key / "router.py").read_text() == router


@pytest.mark.parametrize(("replacement", "router_entry"), [
    (None, "router.py"),
    ("from fastapi import APIRouter\nrouter = APIRouter()\n", "router.py"),
    ("", "router.py/"),
], ids=["absent", "empty-router", "directory"])
async def test_page_only_upgrade_removes_previous_plugin_routes(
    replacement, router_entry, db_session, db_engine, admin_user, tmp_path, monkeypatch,
):
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(database, "async_session_maker", async_sessionmaker(db_engine))
    service = plugin_service.PluginInstallService(db_session)
    installer_id = admin_user.id
    key = "page_only_upgrade"
    legacy = {"page_url": "/plugin-page/example", "prefix": None}
    app = FastAPI()
    old_path = "/api/v1/legacy-route"
    source = HOSTED_ROUTER.replace("get('/')", "get('/legacy-route')")
    await service.install_from_zip(integration_zip(key, source, **legacy), installed_by=installer_id)
    assert loader.mount_plugin_router_on_app(app, key)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get(old_path)).json() == "first version"
        update = integration_zip(key, replacement, version="2.0.0", router_entry=router_entry, **legacy)
        await service.install_from_zip(update, installed_by=installer_id)
        assert loader.mount_plugin_router_on_app(app, key) == bool(replacement)
        assert (await client.get(old_path)).status_code == 404


@pytest.mark.parametrize("mount", ["hot", "startup"])
@pytest.mark.parametrize("hosted", [True, False])
async def test_integration_routes_follow_active_state(mount, hosted, db_session, db_engine, tmp_path, monkeypatch):
    key = f"serving_{mount}_{hosted}".lower()
    page_url = "/plugin-view/serving-test" if hosted else "/plugin-page/serving-test"
    prefix = "/plugins/serving-test" if hosted else "/api/v1/spa"
    plugin_dir = tmp_path / key
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").touch()
    (plugin_dir / "plugin.json").write_text(json.dumps({
        "plugin_key": key, "plugin_type": "integration", "page_url": page_url,
        **({"mount_prefix": prefix} if hosted else {}),
    }))
    source = (
        "from fastapi import APIRouter\n"
        "router = APIRouter()\n"
        "@router.get('/')\n"
        "def index(): return 'plugin'\n"
        "nested = APIRouter(prefix='/spa')\n"
        "@nested.get('/hosted-config')\n"
        "def config(): return {'active': True}\n"
        "router.include_router(nested)\n"
        "admin_router = APIRouter()\n"
        "admin = APIRouter(prefix='/spa')\n"
        "@admin.get('/admin')\n"
        "def settings(): return {'settings': True}\n"
        "admin_router.include_router(admin)\n"
    )
    (plugin_dir / "router.py").write_text(source)
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(loader, "_deferred_plugin_routers", [])
    monkeypatch.setattr(database, "async_session_maker", async_sessionmaker(db_engine))

    app = FastAPI()

    @app.get(f"{prefix}/preview")
    def preview_config():
        return {"preview": True}

    if mount == "hot":
        assert loader.mount_plugin_router_on_app(app, key)
    else:
        loader._mount_plugin_routers()
        loader.mount_deferred_plugin_routers(app)

    plugin = InstalledPlugin(
        plugin_key=key, name="Test", version="1.0.0",
        plugin_type="integration", page_url=page_url,
    )
    db_session.add(plugin)
    await db_session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        url = f"{prefix}/{'spa/' if hosted else ''}hosted-config"
        admin_url = "/api/v1/spa/admin"
        assert (await client.get(url)).json() == {"active": True}
        assert (await client.get(admin_url)).json() == {"settings": True}
        await plugin_service.PluginInstallService(db_session).set_active(key, False)
        assert (await client.get(url)).status_code == 404
        assert (await client.get(admin_url)).status_code == 404
        await plugin_service.PluginInstallService(db_session).set_active(key, True)
        assert (await client.get(admin_url)).status_code == 200

        (plugin_dir / "router.py").write_text(
            source.split("admin_router =", 1)[0].replace("'active': True", "'reloaded': True")
        )
        assert loader.mount_plugin_router_on_app(app, key)
        assert (await client.get(url)).json() == {"reloaded": True}
        assert (await client.get(admin_url)).status_code == 404
        assert (await client.get(f"{prefix}/preview")).json() == {"preview": True}
        if hosted:
            plugin.page_url = "/plugin-view/renamed"
            await db_session.commit()
            assert (await client.get(url)).status_code == 404


async def test_websocket_activation_check_releases_its_connection(tmp_path, monkeypatch):
    from app.api import deps
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'plugin.db'}", pool_size=1, max_overflow=0)
    sessions = async_sessionmaker(engine)
    async with engine.begin() as conn:
        await conn.run_sync(InstalledPlugin.__table__.create)
    async with sessions.begin() as db:
        db.add(InstalledPlugin(plugin_key="live", name="Live", version="1.0.0", plugin_type="integration"))

    monkeypatch.setattr(database, "async_session_maker", sessions)
    monkeypatch.setattr(deps, "async_session_maker", sessions)

    from fastapi import APIRouter, WebSocket

    router = APIRouter()

    @router.websocket("/live")
    async def live(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_json(engine.pool.checkedout())

    app = FastAPI()
    app.include_router(router, dependencies=loader._integration_dependencies("live", {"plugin_type": "integration"}, router))
    try:
        with TestClient(app) as client, client.websocket_connect("/live") as socket:
            assert socket.receive_json() == 0
    finally:
        await engine.dispose()


async def test_bookmarked_shell_requires_an_active_install(db_session, tmp_path, monkeypatch):
    from app import main

    static_dir = tmp_path / "static"
    legacy_shell = static_dir / "plugin-view/index.html"
    legacy_shell.parent.mkdir(parents=True)
    legacy_shell.write_text("legacy shell")
    (tmp_path / "plugin-shell.html").write_text("integration shell")
    monkeypatch.setattr(main, "static_files_path", str(static_dir), raising=False)
    app = FastAPI()
    app.add_api_route("/plugin-view/{plugin_slug:path}", main.serve_plugin_view, methods=["GET", "HEAD"])
    app.mount("/", StaticFiles(directory=static_dir, html=True))

    async def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    plugin = InstalledPlugin(
        plugin_key="bookmarked", name="Bookmarked", version="1.0.0",
        plugin_type="integration", page_url="/plugin-view/bookmarked",
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        url = plugin.page_url
        for legacy in ("/plugin-view/", "/plugin-view/index.html"):
            assert (await client.get(legacy)).text == "legacy shell"
        for method in ("GET", "HEAD"):
            assert (await client.request(method, "/plugin-view/_shell/index.html")).status_code == 404
        assert (await client.get("/%2E/plugin-view/_shell/index.html")).status_code == 404
        assert (await client.get("/plugin-shell.html")).status_code == 404
        assert (await client.get(url)).status_code == 404
        db_session.add(plugin)
        await db_session.commit()
        assert (await client.get(url)).text == "integration shell"
        assert (await client.get(url + "/")).text == "integration shell"
        await plugin_service.PluginInstallService(db_session).set_active(plugin.plugin_key, False)
        assert (await client.get(url)).status_code == 404


async def test_navigation_reflects_plugin_toggle_without_worker_cache(db_session):
    from app.api.v1.system import plugin_nav

    plugin = InstalledPlugin(
        plugin_key="nav_test", name="Nav test", version="1.0.0", plugin_type="integration",
        page_url="/plugin-view/nav-test", show_in_nav=True,
    )
    db_session.add(plugin)
    await db_session.commit()
    assert plugin.plugin_key in [item.plugin_key for item in await plugin_nav(db_session, None)]
    await plugin_service.PluginInstallService(db_session).set_active(plugin.plugin_key, False)
    assert plugin.plugin_key not in [item.plugin_key for item in await plugin_nav(db_session, None)]


@pytest.mark.parametrize("prefix,has_router,valid", [
    ("/plugins/detail", True, True),
    ("/plugins/different", True, False),
    ("/plugins/detail", False, False),
])
async def test_install_manifest_requires_a_matching_shell_router(prefix, has_router, valid, tmp_path, db_session):
    (tmp_path / "plugin.json").write_text(json.dumps({
        "plugin_key": "detail", "plugin_type": "integration", "name": "Detail",
        "version": "1.0.0", "description": "Hosted integration", "author": "Test",
        "page_url": "/plugin-view/detail", "mount_prefix": prefix,
    }))
    if has_router:
        (tmp_path / "router.py").touch()
    service = plugin_service.PluginInstallService(db_session)
    if valid:
        assert service._validate_manifest(tmp_path)["mount_prefix"] == prefix
    else:
        with pytest.raises(plugin_service.PluginInstallError) as error:
            service._validate_manifest(tmp_path)
        assert error.value.code == "invalid_integration_shell"


@pytest.mark.parametrize("router_name", ["router", "admin_router"])
def test_unguarded_starlette_route_is_not_published(tmp_path, monkeypatch, router_name):
    key = f"plain_test_{router_name}"
    plugin_dir = tmp_path / key
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").touch()
    (plugin_dir / "plugin.json").write_text(json.dumps({
        "plugin_key": key, "plugin_type": "integration", "mount_prefix": "/plugins/plain-test",
        "page_url": "/plugin-view/plain-test",
    }))
    (plugin_dir / "router.py").write_text(
        "from fastapi import APIRouter\n"
        "from starlette.routing import Route\n"
        "from starlette.responses import Response\n"
        "router = APIRouter()\n"
        "admin_router = APIRouter(prefix='/plain-test')\n"
        "nested = APIRouter(routes=[Route('/', lambda request: Response('plain'))])\n"
        f"{router_name}.include_router(nested)\n"
    )
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    app = FastAPI()
    assert not loader.mount_plugin_router_on_app(app, key)
    assert all(not route.path.startswith("/plugins/plain-test") for route in app.routes)


async def test_two_plugins_cannot_claim_one_shell_url(db_session, admin_user, tmp_path, monkeypatch):
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = plugin_service.PluginInstallService(db_session)

    def package(key, page_url="/plugin-view/example", prefix="/plugins/example"):
        return integration_zip(key, HOSTED_ROUTER, page_url=page_url, prefix=prefix)

    installer_id = admin_user.id
    await service.install_from_zip(package("first_example"), installed_by=installer_id)
    with pytest.raises(plugin_service.PluginInstallError) as error:
        await service.install_from_zip(package("second_example"))
    assert error.value.code == "integration_shell_conflict"
    assert not (tmp_path / "second_example").exists()
    with pytest.raises(plugin_service.PluginInstallError) as error:
        await service.install_from_zip(package("unregistered_example", page_url=None))
    assert error.value.code == "invalid_integration_shell"
    assert not (tmp_path / "unregistered_example").exists()
    with pytest.raises(plugin_service.PluginInstallError) as error:
        await service.install_from_zip(package("shell_mount", page_url=None, prefix="/plugin-view"))
    assert error.value.code == "invalid_integration_shell"
    _, upgraded = await service.install_from_zip(package("first_example"), installed_by=installer_id)
    assert upgraded


async def test_uninstall_conflicts_with_an_install(db_session, admin_user, tmp_path, monkeypatch):
    from app.api.v1.system import uninstall_plugin

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    key = "uninstall_conflict"
    plugin_dir = tmp_path / key
    plugin_dir.mkdir()
    db_session.add(InstalledPlugin(
        plugin_key=key, name="Conflict", version="1.0.0", installed_by=admin_user.id,
    ))
    await db_session.commit()

    with plugin_service._plugin_write_lock(key), pytest.raises(HTTPException) as error:
        await uninstall_plugin(key, db_session, None, None, delete_data=True)
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "plugin_mutation_in_progress"
    assert plugin_dir.is_dir()
    assert await plugin_service.PluginInstallService(db_session).get_plugin(key) is not None

    await uninstall_plugin(key, db_session, None, None, delete_data=True)
    assert not plugin_dir.exists()
    assert await plugin_service.PluginInstallService(db_session).get_plugin(key) is None
