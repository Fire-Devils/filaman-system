import hashlib
import json
import runpy
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.api.v1 import system
from app.services.plugin_service import PluginInstallError, PluginInstallService
from tests.test_plugin_service import _make_valid_plugin_zip


GITHUB_ZIP_URL = "https://github.com/Fire-Devils/test-plugin/releases/download/v1.0.0/test-plugin.zip"
GITHUB_ASSET_URL = "https://release-assets.githubusercontent.com/test-plugin.zip?signature=test"


def entry(**changes):
    return {
        "plugin_key": "test_plugin",
        "name": "Test plugin",
        "description": "A test integration",
        "publisher": "FilaMan",
        "repository_url": "https://github.com/Fire-Devils/test-plugin",
        "version": "1.0.0",
        "min_filaman_version": "2.0.3",
        "zip_path": "test_plugin-1.0.0.zip",
        "sha256": hashlib.sha256(b"approved").hexdigest(),
        **changes,
    }


def mock_registry(monkeypatch, respond):
    from app.services import plugin_catalog

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        plugin_catalog.httpx,
        "AsyncClient",
        lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs),
    )


async def test_browse_reads_catalog_again_without_restarting(monkeypatch):
    payload = [entry()]
    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=payload))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    monkeypatch.setattr(PluginInstallService, "list_installed", _no_plugins)
    first = await system.list_available_plugins(None, None)
    assert first[0].name == "Test plugin"
    assert first[0].is_compatible
    payload[0] = entry(name="Renamed integration", min_filaman_version="2.0.4")
    second = await system.list_available_plugins(None, None)
    assert second[0].name == "Renamed integration"
    assert not second[0].is_compatible
    assert not second[0].update_available


def selection(release):
    return system.CatalogSelection(
        plugin_key=release["plugin_key"], version=release["version"],
        release_id=system.CatalogRelease.model_validate(release).release_id,
    )


async def _no_plugins(self):
    return []


@pytest.mark.parametrize("path", ["../test_plugin-1.0.0.zip", "//example.com/file.zip", "other-1.0.0.zip"])
def test_catalog_rejects_unapproved_paths(path):
    from app.services.plugin_catalog import parse_catalog

    with pytest.raises(ValueError):
        parse_catalog(json.dumps([entry(zip_path=path)]).encode())


@pytest.mark.parametrize("source", [
    {"zip_path": None},
    {"github_release_url": GITHUB_ZIP_URL},
    {"zip_path": None, "github_release_url": GITHUB_ZIP_URL.replace("/download/v1.0.0", "/latest/download")},
    {"zip_path": None, "github_release_url": GITHUB_ZIP_URL.replace("github.com", "github.com.example.com")},
    {"zip_path": None, "github_release_url": GITHUB_ZIP_URL.replace("/releases/download/v1.0.0", "/archive/refs/tags")},
    {"zip_path": None, "github_release_url": GITHUB_ZIP_URL.replace("Fire-Devils/test-plugin", "OtherOrg/test-plugin")},
])
def test_catalog_requires_one_approved_source(source):
    from app.services.plugin_catalog import CatalogRelease

    with pytest.raises(ValueError):
        CatalogRelease.model_validate(entry(**source))


@pytest.mark.parametrize("key", ["spoolman_import", "spoolmandb"])
async def test_catalog_checker_rejects_reserved_plugin_keys(monkeypatch, tmp_path, key):
    checker = Path(__file__).resolve().parents[2] / "plugin-catalog" / "check.py"
    local_checker = tmp_path / checker.name
    local_checker.write_bytes(checker.read_bytes())
    (tmp_path / "catalog-v1.json").write_text(
        json.dumps([entry(plugin_key=key, zip_path=f"{key}-1.0.0.zip")]), encoding="utf-8"
    )
    mock_registry(monkeypatch, lambda _: pytest.fail("Reserved keys must be rejected before downloading"))

    with pytest.raises(ValueError, match=key):
        await runpy.run_path(str(local_checker))["check"]()


async def test_github_zip_rejects_redirect_outside_asset_host(monkeypatch):
    from app.services.plugin_catalog import CatalogRelease, fetch_verified_zip

    def respond(request):
        assert str(request.url) == GITHUB_ZIP_URL
        return httpx.Response(302, headers={"Location": "https://example.com/test-plugin.zip"})

    mock_registry(monkeypatch, respond)
    release = CatalogRelease.model_validate(entry(zip_path=None, github_release_url=GITHUB_ZIP_URL))
    with pytest.raises(PluginInstallError, match="Could not download"):
        await fetch_verified_zip(release)


async def test_download_rejects_changed_package(monkeypatch):
    from app.services.plugin_catalog import CatalogRelease, fetch_verified_zip

    mock_registry(monkeypatch, lambda request: httpx.Response(200, content=b"changed"))
    with pytest.raises(PluginInstallError, match="checksum"):
        await fetch_verified_zip(CatalogRelease.model_validate(entry()))


async def test_manifest_identity_is_checked_before_installing(db_session):
    service = PluginInstallService(db_session)
    with pytest.raises(PluginInstallError, match="manifest"):
        await service.install_from_zip(
            _make_valid_plugin_zip(), installed_by=1, expected_release=("test_plugin", "9.0.0")
        )
    assert await service.get_plugin("test_plugin") is None


def test_catalog_rejects_syntax_errors_in_plugin_helpers():
    from tests.test_plugin_service import VALID_DRIVER_PY, VALID_MANIFEST, _make_zip

    archive = _make_zip({
        "plugin.json": json.dumps(VALID_MANIFEST),
        "__init__.py": "",
        "driver.py": "from . import helper\n" + VALID_DRIVER_PY,
        "helper.py": "def invalid syntax",
    })
    with pytest.raises(PluginInstallError, match="helper.py") as error:
        with PluginInstallService.validated_archive(archive, ("test_plugin", "1.0.0")):
            pytest.fail("A broken helper passed archive validation")
    assert error.value.code == "syntax_error"


def test_driver_import_error_does_not_escape_the_manager(monkeypatch):
    from app.plugins import manager

    def import_driver(_name):
        raise RuntimeError("A plugin failed during import")

    monkeypatch.setattr(manager.importlib, "import_module", import_driver)
    assert manager.PluginManager().load_driver("test_plugin") is None


def test_driver_load_defers_only_the_archive_being_published(monkeypatch, tmp_path):
    from app.plugins import manager
    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    driver = type("Driver", (manager.BaseDriver,), {})
    imported = []

    def import_driver(name):
        imported.append(name)
        return SimpleNamespace(Driver=driver)

    monkeypatch.setattr(manager.importlib, "import_module", import_driver)
    plugin_manager = manager.PluginManager()
    with plugin_service.plugin_archive_lock(), plugin_service.plugin_archive_lock("test_plugin"):
        assert plugin_manager.load_driver("test_plugin") is None
        assert plugin_manager.load_driver("other_plugin") is driver
    assert plugin_manager.load_driver("test_plugin") is driver
    assert imported == ["app.plugins.other_plugin.driver", "app.plugins.test_plugin.driver"]


async def test_driver_reload_waits_for_an_inflight_start(monkeypatch):
    import asyncio
    import sys

    from app.plugins.manager import PluginManager

    manager = PluginManager()
    printer = SimpleNamespace(id=1, driver_key="test_plugin")
    module = "app.plugins.test_plugin.driver"
    monkeypatch.setitem(sys.modules, module, SimpleNamespace())
    started = asyncio.Event()
    finish = asyncio.Event()
    events = []

    async def start(active_printer):
        if active_printer.id in manager.drivers:
            return True
        version = "old" if module in sys.modules else "new"
        if version == "old":
            started.set()
            await finish.wait()
        manager.drivers[active_printer.id] = SimpleNamespace(driver_key=printer.driver_key, version=version)
        events.append(f"start {version}")
        return True

    async def stop(printer_id):
        events.append(f"stop {manager.drivers.pop(printer_id).version}")

    monkeypatch.setattr(manager, "_start_printer", start)
    monkeypatch.setattr(manager, "stop_printer", stop)
    initial = asyncio.create_task(manager.start_printer(printer))
    await asyncio.wait_for(started.wait(), 2)
    reload = asyncio.create_task(manager.reload_driver(printer.driver_key, [printer]))
    try:
        await asyncio.sleep(0)
        assert not reload.done()
    finally:
        finish.set()
        await asyncio.wait_for(asyncio.gather(initial, reload), 2)
    assert events == ["start old", "stop old", "start new"]
    assert manager.drivers[printer.id].version == "new"


@pytest.mark.parametrize("payload, code", [
    ([], "catalog_release_unavailable"),
    ([entry(min_filaman_version="9.0.0")], "catalog_release_incompatible"),
])
async def test_install_rejects_withdrawn_or_incompatible_release(monkeypatch, payload, code):
    from fastapi import HTTPException

    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=payload))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    with pytest.raises(HTTPException) as exc:
        await system.install_from_registry(
            None, selection(payload[0] if payload else entry()), None,
            SimpleNamespace(user_id=1),
        )
    assert exc.value.detail["code"] == code


@pytest.mark.parametrize("from_github", [False, True])
async def test_install_uses_current_catalog_zip_and_manifest(monkeypatch, db_session, tmp_path, from_github):
    from app.services import plugin_service

    archive = _make_valid_plugin_zip()
    release = entry(sha256=hashlib.sha256(archive).hexdigest())
    if from_github:
        release.pop("zip_path")
        release["github_release_url"] = GITHUB_ZIP_URL
        release["repository_url"] = release["repository_url"].lower()
    requested = []

    def respond(request):
        requested.append(str(request.url))
        if len(requested) == 1:
            return httpx.Response(200, json=[release])
        if str(request.url) == GITHUB_ZIP_URL:
            return httpx.Response(302, headers={"Location": GITHUB_ASSET_URL})
        return httpx.Response(200, content=archive)

    mock_registry(monkeypatch, respond)
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    response = await system.install_from_registry(
        None, selection(release),
        db_session, SimpleNamespace(user_id=1),
    )
    assert response.plugin.plugin_key == "test_plugin"
    assert (tmp_path / "test_plugin" / "plugin.json").is_file()
    assert requested[0] == "https://raw.githubusercontent.com/Fire-Devils/filaman-system/main/plugin-catalog/catalog-v1.json"
    expected_zip_requests = (
        [GITHUB_ZIP_URL, GITHUB_ASSET_URL] if from_github
        else ["https://www.filaman.app/plugins/test_plugin-1.0.0.zip"]
    )
    assert requested[1:] == expected_zip_requests


async def test_backup_reinstall_warns_without_installing_when_catalog_unavailable(monkeypatch):
    mock_registry(monkeypatch, lambda request: httpx.Response(503))
    restored, warnings = await system._reinstall_plugins_from_backup(
        None, None, [system.BackupPluginInfo(plugin_key="test_plugin", version="1.0.0")], 1
    )
    assert not restored
    assert "test_plugin" in warnings[0]


@pytest.mark.parametrize("worker_master", [False, True])
async def test_automatic_backup_restores_plugin_and_activates_it(
    auth_client, admin_user, db_session, monkeypatch, tmp_path, worker_master
):
    import shutil

    from app.main import app
    from app.services import plugin_service
    from tests.test_plugin_service import VALID_MANIFEST, _make_zip

    key = "catalog_restore_test"
    archive = _make_zip({
        "plugin.json": json.dumps({
            **VALID_MANIFEST, "plugin_key": key, "plugin_type": "integration", "driver_key": None,
        }),
        "__init__.py": "",
        "router.py": (
            "from fastapi import APIRouter\n"
            "router = APIRouter(prefix='/catalog-restore-test')\n"
            "@router.get('/ping')\n"
            "def ping(): return {'restored': True}\n"
        ),
    })
    payload = entry(plugin_key=key, zip_path=f"{key}-1.0.0.zip", sha256=hashlib.sha256(archive).hexdigest())
    mock_registry(monkeypatch, lambda request: httpx.Response(200, content=archive)
                  if request.url.path.endswith(".zip") else httpx.Response(200, json=[payload]))
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path / "backups")
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    monkeypatch.setattr(system, "worker_reload_available", lambda: worker_master)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(app.router, "routes", app.router.routes.copy())
    reloads = []

    def reload_workers():
        assert (tmp_path / key / "plugin.json").is_file()
        reloads.append(True)
        return True

    monkeypatch.setattr(system, "request_worker_reload", reload_workers)
    await PluginInstallService(db_session).install_from_zip(archive, installed_by=admin_user.id)
    backup = (await system._create_auto_backup(db_session)).read_bytes()
    shutil.rmtree(tmp_path / key)
    client, token = auth_client

    async def restore():
        return await client.post(
            "/api/v1/admin/system/backup/import",
            files={"file": ("auto.jsonl", backup, "application/x-ndjson")},
            headers={"X-CSRF-Token": token},
        )

    with plugin_service.plugin_restore_lock(shared=True):
        busy = await restore()
    assert busy.status_code == 409, busy.text
    response = await restore()
    assert response.status_code == 200, response.text
    assert response.json()["plugins_installed"]
    assert (tmp_path / key / "plugin.json").is_file()
    assert reloads == ([True] if worker_master else [])
    restored_route = await client.get("/api/v1/catalog-restore-test/ping")
    assert restored_route.status_code == (404 if worker_master else 200)


async def test_worker_discovery_waits_for_archive_rollback(db_session, monkeypatch, tmp_path):
    import asyncio
    from importlib import import_module

    from fastapi import FastAPI
    from sqlalchemy.exc import OperationalError

    from app.services import plugin_service
    from tests.test_plugin_service import VALID_MANIFEST, _make_zip

    archive = _make_zip({
        "plugin.json": json.dumps({
            **VALID_MANIFEST, "plugin_key": "pending_router", "plugin_type": "integration",
        }),
        "__init__.py": "",
        "router.py": (
            "from fastapi import APIRouter\n"
            "router = APIRouter()\n"
            "@router.get('/pending-route')\n"
            "def pending(): return {}\n"
        ),
    })
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    router = import_module("app.api.v1.router")
    worker_app = FastAPI()
    monkeypatch.setattr(router, "api_router", worker_app.router)
    scan = None

    async def fail_commit():
        nonlocal scan
        assert (tmp_path / "pending_router" / "router.py").is_file()
        scan = asyncio.create_task(asyncio.to_thread(router._mount_plugin_routers))
        done, _ = await asyncio.wait({scan}, timeout=0.1)
        assert not done
        raise OperationalError("COMMIT", {}, RuntimeError("forced rollback"))

    monkeypatch.setattr(db_session, "commit", fail_commit)
    try:
        with pytest.raises(OperationalError):
            await PluginInstallService(db_session).install_from_zip(archive, installed_by=1)
    finally:
        if scan is not None:
            await asyncio.wait_for(scan, 5)

    assert not (tmp_path / "pending_router").exists()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=worker_app), base_url="http://test") as client:
        assert (await client.get("/pending-route")).status_code == 404


def test_worker_discovery_does_not_write_to_plugin_storage(monkeypatch, tmp_path):
    from app.api.v1 import router
    from app.services import plugin_service

    plugins = tmp_path / "plugins"
    plugins.mkdir(mode=0o555)
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", plugins)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path / "data")
    try:
        router._mount_plugin_routers()
        assert not (plugins / ".locks").exists()
    finally:
        plugins.chmod(0o755)


def test_source_checkout_finds_the_release_version():
    version = Path(__file__).resolve().parents[2] / "version.txt"
    assert system._read_installed_version() == version.read_text().strip()


@pytest.mark.parametrize("pid, expected", [(1, True), (22, False), (0, False)])
def test_worker_reload_targets_the_current_parent(monkeypatch, tmp_path, pid, expected):
    from app.core import worker_reload

    pidfile = tmp_path / "gunicorn.pid"
    pidfile.write_text(str(pid))
    signals = []
    monkeypatch.setattr(worker_reload, "_GUNICORN_PID_FILE", pidfile)
    monkeypatch.setattr(worker_reload.os, "getppid", lambda: 1)
    monkeypatch.setattr(worker_reload.os, "kill", lambda *args: signals.append(args))

    assert worker_reload.worker_reload_available() is expected
    assert worker_reload.request_worker_reload() is expected
    assert signals == ([(1, worker_reload.signal.SIGHUP)] if expected else [])


def test_plugin_version_with_oversized_component_is_invalid():
    assert not system.version_key("9" * 4301 + ".0.0")


async def test_install_rejects_a_changed_release_at_the_same_version(monkeypatch):
    from fastapi import HTTPException

    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=[entry(publisher="New publisher")]))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    with pytest.raises(HTTPException) as exc:
        await system.install_from_registry(
            None, selection(entry()),
            None, SimpleNamespace(user_id=1),
        )
    assert exc.value.detail["code"] == "catalog_release_unavailable"


def test_catalog_validation_enforces_the_runtime_size_limit():
    from app.services.plugin_catalog import MAX_CATALOG_SIZE, parse_catalog

    payload = json.dumps([entry()]).encode().ljust(MAX_CATALOG_SIZE + 1)
    with pytest.raises(ValueError, match="size limit"):
        parse_catalog(payload)


async def test_catalog_offers_reinstall_if_backup_restored_only_plugin_metadata(monkeypatch, tmp_path):
    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, 'PLUGINS_DIR', tmp_path)
    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=[entry()]))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")

    async def restored_metadata(self):
        return [SimpleNamespace(plugin_key="test_plugin", version="1.0.0")]

    monkeypatch.setattr(PluginInstallService, "list_installed", restored_metadata)
    rows = await system.list_available_plugins(None, None)
    assert not rows[0].is_installed


async def test_catalog_check_rejects_a_hashed_archive_missing_driver_files(monkeypatch, tmp_path):
    from importlib.util import module_from_spec, spec_from_file_location

    from tests.test_plugin_service import VALID_MANIFEST, _make_zip

    checker_path = Path(__file__).resolve().parents[2] / "plugin-catalog" / "check.py"
    spec = spec_from_file_location("check_catalog", checker_path)
    checker = module_from_spec(spec)
    spec.loader.exec_module(checker)

    archive = _make_zip({"plugin.json": json.dumps(VALID_MANIFEST)})
    (tmp_path / "catalog-v1.json").write_text(json.dumps([entry(sha256=hashlib.sha256(archive).hexdigest())]))
    monkeypatch.setattr(checker, "__file__", str(tmp_path / "check.py"))
    mock_registry(monkeypatch, lambda request: httpx.Response(200, content=archive))

    with pytest.raises(PluginInstallError) as error:
        await checker.check()
    assert error.value.code == "missing_file"


@pytest.mark.parametrize("core_version, installed_version, has_files, expected", [
    ("2.0.3", "2.0.0", False, (True, False, True)),
    ("2.0.3", "1000000000.0.0", False, (True, False, True)),
    ("2.0.3", "٢.٠.٠", False, (True, False, True)),
    ("2.0.3", "1.0.0-rc.1", True, (True, True, False)),
    ("2.0.3-rc.1", "0.9.0", True, (False, False, False)),
])
async def test_catalog_reports_install_eligibility(
    monkeypatch, core_version, installed_version, has_files, expected
):
    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=[entry()]))
    monkeypatch.setattr(system, "_read_installed_version", lambda: core_version)

    async def installed(self):
        return [SimpleNamespace(
            plugin_key="test_plugin", version=installed_version,
            icon_url="/api/v1/plugin-icons/test_plugin?v=1.0.0",
        )]

    monkeypatch.setattr(PluginInstallService, "list_installed", installed)
    monkeypatch.setattr(PluginInstallService, "has_plugin_files", lambda *_: has_files)

    row, = await system.list_available_plugins(None, None)
    assert (row.is_compatible, row.update_available) == expected[:2]
    assert row.requires_newer_zip == expected[2]
    assert row.icon_url == ("/api/v1/plugin-icons/test_plugin?v=1.0.0" if has_files else None)


async def test_slow_catalog_install_cannot_replace_newer_manual_install(monkeypatch, tmp_path):
    import asyncio

    from fastapi import HTTPException
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models import Base
    from app.services import plugin_service
    from tests.test_plugin_service import VALID_DRIVER_PY, VALID_MANIFEST, _make_zip

    def archive(version):
        return _make_zip({
            "plugin.json": json.dumps({**VALID_MANIFEST, "version": version}),
            "driver.py": VALID_DRIVER_PY,
            "__init__.py": "",
        })

    entered_download = asyncio.Event()
    finish_download = asyncio.Event()
    payload = entry()

    async def delayed_download(release):
        entered_download.set()
        await finish_download.wait()
        return archive("1.0.0")

    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=[payload]))
    monkeypatch.setattr(system, "fetch_verified_zip", delayed_download)
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'install.db'}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as manual_db, sessions() as catalog_db:
            manual_service = PluginInstallService(manual_db)
            await manual_service.install_from_zip(archive("0.9.0"), installed_by=1)
            old_install = asyncio.create_task(system.install_from_registry(
                None, selection(payload), catalog_db, SimpleNamespace(user_id=1)
            ))
            try:
                await asyncio.wait_for(entered_download.wait(), 5)
                await manual_service.install_from_zip(archive("2.0.0"), installed_by=1)
                finish_download.set()
                with pytest.raises(HTTPException) as error:
                    await old_install
                assert error.value.status_code == 409
                assert error.value.detail["code"] == "catalog_downgrade"
                manifest = json.loads((tmp_path / "test_plugin" / "plugin.json").read_text())
                assert manifest["version"] == "2.0.0"
            finally:
                if not old_install.done():
                    old_install.cancel()
                    await asyncio.gather(old_install, return_exceptions=True)
    finally:
        await engine.dispose()


async def test_browse_offers_repair_when_disk_version_differs_from_restored_record(monkeypatch, tmp_path):
    from app.services import plugin_service

    plugin_dir = tmp_path / "test_plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.json").write_text(json.dumps({"plugin_key": "test_plugin", "version": "0.9.0"}))
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    mock_registry(monkeypatch, lambda request: httpx.Response(200, json=[entry()]))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")

    async def restored_plugins(self):
        return [SimpleNamespace(plugin_key="test_plugin", version="1.0.0")]

    monkeypatch.setattr(PluginInstallService, "list_installed", restored_plugins)
    row, = await system.list_available_plugins(None, None)
    assert not row.is_installed
    assert not row.requires_newer_zip


@pytest.mark.parametrize("worker_master, attached_printer, previous_type", [
    (False, True, None), (True, True, None), (True, False, None),
    (True, False, "driver"), (True, False, "integration"),
])
async def test_catalog_install_coordinates_driver_startup(
    monkeypatch, db_session, tmp_path, worker_master, attached_printer, previous_type
):
    import asyncio

    from fastapi import HTTPException

    from app.models import Printer
    from app.plugins.manager import plugin_manager
    from app.services import plugin_service

    from tests.test_plugin_service import VALID_DRIVER_PY, VALID_MANIFEST, _make_zip

    archive = _make_valid_plugin_zip()
    release = entry(sha256=hashlib.sha256(archive).hexdigest())
    mock_registry(monkeypatch, lambda request: (
        httpx.Response(200, json=[release]) if request.url.host == "raw.githubusercontent.com"
        else httpx.Response(200, content=archive)
    ))
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)

    if previous_type:
        previous = _make_zip({
            "plugin.json": json.dumps({**VALID_MANIFEST, "version": "0.9.0", "plugin_type": previous_type}),
            "driver.py": VALID_DRIVER_PY,
            "__init__.py": "",
        })
        await PluginInstallService(db_session).install_from_zip(previous, installed_by=1)

    started, finish = asyncio.Event(), asyncio.Event()
    reloads = []

    async def start_driver(printer):
        started.set()
        await finish.wait()

    def reload_workers():
        reloads.append(True)
        return worker_master

    monkeypatch.setattr(plugin_manager, "_start_printer", start_driver)
    monkeypatch.setattr(system, "request_worker_reload", reload_workers)
    monkeypatch.setattr(system, "worker_reload_available", lambda: worker_master)
    monkeypatch.setattr(system, "_is_primary_worker", lambda: True)
    if attached_printer:
        db_session.add(Printer(name="Test printer", driver_key="test_plugin", is_active=True))
        await db_session.commit()
    principal = SimpleNamespace(user_id=1)
    install = asyncio.create_task(system.install_from_registry(None, selection(release), db_session, principal))
    try:
        if attached_printer:
            await asyncio.wait_for(started.wait(), 5)
            with pytest.raises(HTTPException) as error:
                await system.uninstall_plugin("test_plugin", db_session, principal, None, delete_data=False)
            assert error.value.status_code == 409
    finally:
        finish.set()
        await asyncio.wait_for(install, 5)
    assert reloads == ([True] if previous_type == "integration" else [])
    assert started.is_set() is attached_printer
    assert (tmp_path / "test_plugin" / "plugin.json").is_file()
    reloads.clear()
    await system.uninstall_plugin("test_plugin", db_session, principal, None, delete_data=False)
    assert not reloads


async def test_plugin_changes_on_a_secondary_forward_before_writing(auth_client, monkeypatch):
    from unittest.mock import AsyncMock

    from app import main

    client, token = auth_client
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(system, "worker_reload_available", lambda: True)
    forwarded = AsyncMock(side_effect=[
        {"message": "Installed", "plugin": {
            "id": 1, "plugin_key": "test_plugin", "name": "Test plugin", "version": "1.0.0",
            "description": None, "author": None, "homepage": None, "license": None,
            "plugin_type": "driver", "driver_key": "test_plugin", "page_url": None,
            "config_schema": None, "is_active": True, "show_in_nav": False,
            "installed_at": "2026-11-08T00:00:00Z", "installed_by": 1,
        }},
        None,
    ])
    monkeypatch.setattr(system, "_proxy_to_primary", forwarded)
    headers = {"X-CSRF-Token": token}
    path = "/api/v1/admin/system/plugins"
    response = await client.post(
        f"{path}/install", files={"file": ("test.zip", b"plugin bytes", "application/zip")}, headers=headers
    )
    assert response.status_code == 201, response.text
    assert forwarded.await_args.kwargs["files"] == {"file": ("test.zip", b"plugin bytes", "application/zip")}
    response = await client.delete(f"{path}/test_plugin?delete_data=true", headers=headers)
    assert response.status_code == 204, response.text
    assert forwarded.await_args.args[1:3] == ("DELETE", f"{path}/test_plugin")
    assert forwarded.await_args.kwargs["timeout"] == 120.0

    response = await client.post(
        f"{path}/install-from-registry", json=selection(entry()).model_dump(),
        headers={**headers, "X-FilaMan-Primary-Hop": "1"},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "primary_worker_required"
    assert forwarded.await_count == 2

    forged_hop = await client.delete(f"{path}/test_plugin", headers={"X-FilaMan-Primary-Hop": "1"})
    assert forged_hop.status_code == 403
    assert forged_hop.json()["code"] == "csrf_failed"


async def test_plugin_proxy_retries_secondary_responses_and_accepts_delete_204(auth_client, monkeypatch):
    from app import main
    from app.api.v1 import printers

    client, token = auth_client
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(system, "worker_reload_available", lambda: True)
    attempts = []

    def respond(request):
        assert request.headers["x-csrf-token"] == token
        assert request.url.params["delete_data"] == "true"
        attempts.append(request)
        if len(attempts) <= 8:
            return httpx.Response(503, json={"detail": {"code": "primary_worker_required"}})
        return httpx.Response(204)

    factory = httpx.AsyncClient
    monkeypatch.setattr(printers.httpx, "AsyncClient", lambda **kwargs: factory(
        transport=httpx.MockTransport(respond), **kwargs,
    ))
    response = await client.delete(
        "/api/v1/admin/system/plugins/test_plugin?delete_data=true", headers={"X-CSRF-Token": token}
    )
    assert response.status_code == 204, response.text
    assert len(attempts) == 9


async def test_restore_continues_after_one_plugin_has_a_disk_error(monkeypatch, db_session):
    available = {
        key: system.CatalogRelease.model_validate(entry(plugin_key=key, zip_path=f"{key}-1.0.0.zip"))
        for key in ("one_plugin", "broken_plugin", "last_plugin")
    }

    async def fetch():
        return available

    async def download(release):
        return release.plugin_key.encode()

    async def install(self, zip_data, **kwargs):
        key = zip_data.decode()
        if key == "broken_plugin":
            raise OSError("disk error")
        return SimpleNamespace(name=key, version="1.0.0"), False

    monkeypatch.setattr(system, "fetch_catalog", fetch)
    monkeypatch.setattr(system, "fetch_verified_zip", download)
    monkeypatch.setattr(PluginInstallService, "install_from_zip", install)
    monkeypatch.setattr(system, "_read_installed_version", lambda: "2.0.3")
    restored, warnings = await system._reinstall_plugins_from_backup(
        None, db_session, [system.BackupPluginInfo(plugin_key=key, version="1.0.0") for key in available], 1
    )
    assert len(restored) == 2 and "last_plugin" in restored[1]
    assert len(warnings) == 1 and "broken_plugin" in warnings[0]
