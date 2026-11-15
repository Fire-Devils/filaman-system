import io
import json
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from app.services.plugin_service import PluginInstallError, PluginInstallService


def _make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


VALID_MANIFEST = {
    "plugin_key": "test_plugin",
    "name": "Test Plugin",
    "version": "1.0.0",
    "description": "A test plugin",
    "author": "Test Author",
    "plugin_type": "driver",
    "driver_key": "test_plugin",
}

VALID_DRIVER_PY = """
from app.plugins.base import BaseDriver

class Driver(BaseDriver):
    driver_key = "test_plugin"

    async def start(self):
        pass

    async def stop(self):
        pass
"""

VALID_INIT_PY = ""


def _make_valid_plugin_zip() -> bytes:
    return _make_zip(
        {
            "plugin.json": json.dumps(VALID_MANIFEST),
            "driver.py": VALID_DRIVER_PY,
            "__init__.py": VALID_INIT_PY,
        }
    )


class TestZipValidation:
    @pytest.mark.parametrize("compression", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA])
    def test_unsupported_compression_is_rejected_before_crc(self, monkeypatch, compression):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression) as archive:
            archive.writestr("helper.py", "print('test')")
        monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda _: pytest.fail("Unsupported ZIP expanded"))
        with pytest.raises(PluginInstallError) as error:
            PluginInstallService._validate_zip(buffer.getvalue())
        assert error.value.code == "unsupported_compression"

    @pytest.mark.parametrize(
        "sizes, code",
        [([1024 * 1024 + 1], "file_too_large"), ([600, 600], "zip_too_large")],
    )
    def test_unpacked_limits_are_checked_before_crc(self, monkeypatch, sizes, code):
        from app.services import plugin_service

        archive = _make_zip({f"file_{index}.txt": "x" * size for index, size in enumerate(sizes)})
        monkeypatch.setattr(plugin_service, "MAX_UNPACKED_ZIP_SIZE", 1000)
        monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda _: pytest.fail("ZIP expanded before checking sizes"))
        with pytest.raises(PluginInstallError) as error:
            PluginInstallService._validate_zip(archive)
        assert error.value.code == code

    @pytest.mark.asyncio
    async def test_validate_zip_valid(self, db_session):
        service = PluginInstallService(db_session)

        service._validate_zip(_make_valid_plugin_zip())

    @pytest.mark.asyncio
    async def test_validate_zip_invalid(self, db_session):
        service = PluginInstallService(db_session)

        with pytest.raises(PluginInstallError) as excinfo:
            service._validate_zip(b"not-a-zip")

        assert excinfo.value.code == "invalid_zip"

    @pytest.mark.asyncio
    async def test_validate_zip_too_large(self, db_session):
        service = PluginInstallService(db_session)
        oversized = b"0" * (10 * 1024 * 1024 + 1)

        with pytest.raises(PluginInstallError) as excinfo:
            await service.install_from_zip(oversized)

        assert excinfo.value.code == "zip_too_large"


class TestManifestValidation:
    @pytest.mark.asyncio
    async def test_validate_manifest_valid(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(VALID_MANIFEST), encoding="utf-8")

            manifest = service._validate_manifest(plugin_dir)

        assert manifest["plugin_key"] == "test_plugin"

    @pytest.mark.asyncio
    async def test_validate_manifest_missing_field(self, db_session):
        service = PluginInstallService(db_session)
        manifest = {**VALID_MANIFEST}
        manifest.pop("name")
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_manifest(plugin_dir)

        assert excinfo.value.code == "missing_field"

    @pytest.mark.asyncio
    async def test_validate_manifest_invalid_key(self, db_session):
        service = PluginInstallService(db_session)
        manifest = {**VALID_MANIFEST, "plugin_key": "INVALID!"}
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_manifest(plugin_dir)

        assert excinfo.value.code == "invalid_key"

    @pytest.mark.asyncio
    async def test_validate_manifest_invalid_version(self, db_session):
        service = PluginInstallService(db_session)
        manifest = {**VALID_MANIFEST, "version": "abc"}
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_manifest(plugin_dir)

        assert excinfo.value.code == "invalid_version"

    @pytest.mark.asyncio
    async def test_validate_manifest_reserved_key(self, db_session):
        service = PluginInstallService(db_session)
        manifest = {**VALID_MANIFEST, "plugin_key": "dummy", "driver_key": "dummy"}
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_manifest(plugin_dir)

        assert excinfo.value.code == "reserved_key"

    @pytest.mark.asyncio
    async def test_validate_manifest_driver_key_mismatch(self, db_session):
        service = PluginInstallService(db_session)
        manifest = {**VALID_MANIFEST, "driver_key": "other"}
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_manifest(plugin_dir)

        assert excinfo.value.code == "key_mismatch"


class TestStructureValidation:
    @pytest.mark.asyncio
    async def test_validate_structure_valid(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(VALID_MANIFEST), encoding="utf-8")
            (plugin_dir / "__init__.py").write_text("", encoding="utf-8")
            (plugin_dir / "driver.py").write_text(VALID_DRIVER_PY, encoding="utf-8")

            service._validate_structure(plugin_dir, "driver")

    @pytest.mark.asyncio
    async def test_validate_structure_missing_driver(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(VALID_MANIFEST), encoding="utf-8")
            (plugin_dir / "__init__.py").write_text("", encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_structure(plugin_dir, "driver")

        assert excinfo.value.code == "missing_file"


class TestSecurityValidation:
    @pytest.mark.asyncio
    async def test_validate_security_forbidden_extension(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(VALID_MANIFEST), encoding="utf-8")
            (plugin_dir / "__init__.py").write_text("", encoding="utf-8")
            (plugin_dir / "driver.py").write_text(VALID_DRIVER_PY, encoding="utf-8")
            (plugin_dir / "bad.exe").write_text("boom", encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_security(plugin_dir)

        assert excinfo.value.code == "forbidden_extension"

    @pytest.mark.asyncio
    async def test_validate_security_hidden_file(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "plugin.json").write_text(json.dumps(VALID_MANIFEST), encoding="utf-8")
            (plugin_dir / "__init__.py").write_text("", encoding="utf-8")
            (plugin_dir / "driver.py").write_text(VALID_DRIVER_PY, encoding="utf-8")
            (plugin_dir / ".hidden.txt").write_text("nope", encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_security(plugin_dir)

        assert excinfo.value.code == "hidden_file"


class TestDriverValidation:
    @pytest.mark.asyncio
    async def test_validate_driver_valid(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "driver.py").write_text(VALID_DRIVER_PY, encoding="utf-8")

            service._validate_driver(plugin_dir, VALID_MANIFEST)

    @pytest.mark.asyncio
    async def test_validate_driver_no_class(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "driver.py").write_text("class NotDriver: pass", encoding="utf-8")

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_driver(plugin_dir, VALID_MANIFEST)

        assert excinfo.value.code == "no_driver_class"

    @pytest.mark.asyncio
    async def test_validate_driver_no_base(self, db_session):
        service = PluginInstallService(db_session)
        with tempfile.TemporaryDirectory() as tmpdir:
            plugin_dir = Path(tmpdir)
            (plugin_dir / "driver.py").write_text(
                "class Driver: driver_key = 'test_plugin'", encoding="utf-8"
            )

            with pytest.raises(PluginInstallError) as excinfo:
                service._validate_driver(plugin_dir, VALID_MANIFEST)

        assert excinfo.value.code == "invalid_inheritance"


class TestPluginDBOperations:
    @pytest.mark.asyncio
    async def test_register_builtin(self, db_session):
        service = PluginInstallService(db_session)

        plugin = await service.register_builtin(
            plugin_key="builtin_test",
            name="Builtin",
            version="1.0.0",
            description="Builtin plugin",
            author="System",
            plugin_type="driver",
            page_url="https://example.com",
            homepage="https://example.com/home",
        )

        assert plugin.plugin_key == "builtin_test"
        assert plugin.page_url == "https://example.com"
        assert plugin.homepage == "https://example.com/home"
        assert plugin.installed_by is None

    @pytest.mark.asyncio
    async def test_register_builtin_update(self, db_session):
        service = PluginInstallService(db_session)

        await service.register_builtin(
            plugin_key="builtin_test",
            name="Builtin",
            version="1.0.0",
            description="Builtin plugin",
            author="System",
            plugin_type="driver",
        )
        updated = await service.register_builtin(
            plugin_key="builtin_test",
            name="Builtin",
            version="1.0.1",
            description="Builtin plugin v2",
            author="System",
            plugin_type="driver",
        )

        assert updated.version == "1.0.1"
        assert updated.description == "Builtin plugin v2"

    @pytest.mark.asyncio
    async def test_list_installed(self, db_session):
        service = PluginInstallService(db_session)

        await service.register_builtin(
            plugin_key="alpha",
            name="Alpha",
            version="1.0.0",
            description="Alpha",
            author="System",
            plugin_type="driver",
        )
        await service.register_builtin(
            plugin_key="beta",
            name="Beta",
            version="1.0.0",
            description="Beta",
            author="System",
            plugin_type="driver",
        )

        plugins = await service.list_installed()

        names = [plugin.name for plugin in plugins]

        assert names == sorted(names)
        assert names.count("Alpha") == 1
        assert names.count("Beta") == 1

    @pytest.mark.asyncio
    async def test_get_plugin(self, db_session):
        service = PluginInstallService(db_session)

        await service.register_builtin(
            plugin_key="alpha",
            name="Alpha",
            version="1.0.0",
            description="Alpha",
            author="System",
            plugin_type="driver",
        )

        plugin = await service.get_plugin("alpha")

        assert plugin is not None
        assert plugin.plugin_key == "alpha"

    @pytest.mark.asyncio
    async def test_get_plugin_not_found(self, db_session):
        service = PluginInstallService(db_session)

        plugin = await service.get_plugin("missing")

        assert plugin is None

    @pytest.mark.asyncio
    async def test_set_active_deactivate(self, db_session):
        service = PluginInstallService(db_session)

        await service.register_builtin(
            plugin_key="alpha",
            name="Alpha",
            version="1.0.0",
            description="Alpha",
            author="System",
            plugin_type="driver",
        )

        plugin = await service.set_active("alpha", False)

        assert plugin.is_active is False

    @pytest.mark.asyncio
    async def test_uninstall_not_found(self, db_session, tmp_path, monkeypatch):
        monkeypatch.setattr("app.services.plugin_service.PLUGINS_DIR", tmp_path)
        service = PluginInstallService(db_session)

        with pytest.raises(PluginInstallError) as excinfo:
            await service.uninstall("missing")

        assert excinfo.value.code == "not_found"


class TestInstallFromZip:
    @pytest.mark.asyncio
    async def test_install_valid_plugin(self, db_session):
        service = PluginInstallService(db_session)
        zip_data = _make_valid_plugin_zip()

        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "app.services.plugin_service.PLUGINS_DIR", Path(tmpdir)
        ):
            plugin, is_upgrade = await service.install_from_zip(zip_data)

        assert is_upgrade is False
        assert plugin.plugin_key == "test_plugin"


async def test_failed_dependency_upgrade_preserves_installed_plugin(db_session, monkeypatch, tmp_path):
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    failing_upgrade = _make_zip(
        {
            "plugin.json": json.dumps({**VALID_MANIFEST, "version": "2.0.0", "dependencies": ["example"]}),
            "driver.py": VALID_DRIVER_PY,
            "__init__.py": VALID_INIT_PY,
        }
    )
    monkeypatch.setattr(
        service, "_install_dependencies", AsyncMock(side_effect=PluginInstallError("dependency failed"))
    )
    activate = AsyncMock()

    with pytest.raises(PluginInstallError, match="dependency failed"):
        await service.install_from_zip(failing_upgrade, installed_by=1, after_install=activate)

    assert (await service.get_plugin("test_plugin")).version == "1.0.0"
    manifest = json.loads((tmp_path / "test_plugin" / "plugin.json").read_text())
    assert manifest["version"] == "1.0.0"
    activate.assert_not_awaited()


async def test_plugin_mutations_reject_overlap_while_dependencies_install(db_session, monkeypatch, tmp_path):
    import asyncio

    from app.core.file_lock import FileLockBusy
    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    upgrade = _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "version": "2.0.0", "dependencies": ["example"]}),
        "driver.py": VALID_DRIVER_PY,
        "__init__.py": VALID_INIT_PY,
    })
    started = asyncio.Event()
    resume = asyncio.Event()

    async def install_dependencies(*_):
        started.set()
        await resume.wait()

    monkeypatch.setattr(service, "_install_dependencies", install_dependencies)
    active_install = asyncio.create_task(service.install_from_zip(upgrade, installed_by=1))
    try:
        await asyncio.wait_for(started.wait(), 5)
        with pytest.raises(FileLockBusy), plugin_service.plugin_restore_lock():
            pytest.fail("A complete restore acquired the lock during an upgrade")

        with pytest.raises(PluginInstallError) as install_error:
            await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
        assert install_error.value.code == "plugin_mutation_in_progress"

        peer_manifest = {**VALID_MANIFEST, "plugin_key": "peer_driver", "driver_key": "peer_driver"}
        peer_archive = _make_zip({
            "plugin.json": json.dumps(peer_manifest),
            "driver.py": VALID_DRIVER_PY.replace("test_plugin", "peer_driver"),
            "__init__.py": VALID_INIT_PY,
        })
        with pytest.raises(PluginInstallError) as peer_error:
            await service.install_from_zip(peer_archive, installed_by=1)
        assert peer_error.value.code == "plugin_mutation_in_progress"

        with pytest.raises(PluginInstallError) as uninstall_error:
            await service.uninstall("test_plugin")
        assert uninstall_error.value.code == "plugin_mutation_in_progress"
    finally:
        resume.set()
        await active_install


@pytest.mark.parametrize("change", [{"name": [1]}, {"dependencies": 1}, {"homepage": "x" * 501}, {"config_schema": []}])
def test_validated_archive_rejects_malformed_install_metadata(change):
    archive = _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, **change}),
        "driver.py": VALID_DRIVER_PY,
        "__init__.py": "",
    })
    with pytest.raises(PluginInstallError), PluginInstallService.validated_archive(archive):
        pass


@pytest.mark.parametrize("failure", ["copy", "commit"])
async def test_failed_archive_replacement_keeps_previous_install(db_session, monkeypatch, tmp_path, failure):
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    upgrade = _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "version": "2.0.0"}),
        "driver.py": VALID_DRIVER_PY,
        "__init__.py": "",
    })

    def failed_copy(*args, **kwargs):
        raise OSError("install failed")

    with monkeypatch.context() as patch:
        if failure == "copy":
            patch.setattr(plugin_service.shutil, "copytree", failed_copy)
        else:
            patch.setattr(db_session, "commit", AsyncMock(side_effect=OSError("install failed")))
        with pytest.raises(OSError, match="install failed"):
            await service.install_from_zip(upgrade, installed_by=1)

    assert (await service.get_plugin("test_plugin")).version == "1.0.0"
    manifest = json.loads((tmp_path / "test_plugin" / "plugin.json").read_text())
    assert manifest["version"] == "1.0.0"


async def test_cancelled_dependency_install_reaps_its_process(monkeypatch):
    import asyncio
    import sys

    from app.services import plugin_service

    spawn = asyncio.create_subprocess_exec
    started = asyncio.Event()
    process = None

    async def spawn_fixture(*args, **kwargs):
        nonlocal process
        process = await spawn(sys.executable, "-c", "import time; time.sleep(60)", **kwargs)
        started.set()
        return process

    monkeypatch.setattr(plugin_service.asyncio, "create_subprocess_exec", spawn_fixture)
    install = asyncio.create_task(PluginInstallService(None)._install_dependencies(["fixture"], "test_plugin"))
    try:
        await asyncio.wait_for(started.wait(), 5)
        install.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(install, 5)
        assert process.returncode is not None
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.communicate()


async def test_failed_uninstall_commit_keeps_files_and_record(db_session, monkeypatch, tmp_path):
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    with monkeypatch.context() as patch:
        patch.setattr(db_session, "commit", AsyncMock(side_effect=OSError("uninstall failed")))
        with pytest.raises(OSError, match="uninstall failed"):
            await service.uninstall("test_plugin")

    assert (await service.get_plugin("test_plugin")).version == "1.0.0"
    assert (tmp_path / "test_plugin" / "plugin.json").is_file()


@pytest.mark.parametrize("phase", ["commit", "activation"])
async def test_cancelled_install_keeps_files_and_activates_after_commit(
    db_session, monkeypatch, tmp_path, phase
):
    import asyncio

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    upgrade = _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "version": "2.0.0"}),
        "driver.py": VALID_DRIVER_PY,
        "__init__.py": "",
    })
    committed, finish = asyncio.Event(), asyncio.Event()
    activated = asyncio.Event()
    commit = db_session.commit

    async def delayed_commit():
        await commit()
        committed.set()
        await finish.wait()

    async def activate(*_):
        if phase == "activation":
            committed.set()
            await finish.wait()
        activated.set()

    if phase == "commit":
        monkeypatch.setattr(db_session, "commit", delayed_commit)
    install = asyncio.create_task(service.install_from_zip(upgrade, installed_by=1, after_install=activate))
    try:
        await asyncio.wait_for(committed.wait(), 5)
        install.cancel()
        await asyncio.sleep(0)
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(install, 5)
    finally:
        finish.set()

    assert activated.is_set()
    assert (await service.get_plugin("test_plugin")).version == "2.0.0"
    manifest = json.loads((tmp_path / "test_plugin" / "plugin.json").read_text())
    assert manifest["version"] == "2.0.0"


def test_gunicorn_startup_provisions_persisted_plugins(tmp_path, monkeypatch):
    import runpy
    from pathlib import Path

    from app.services import plugin_service

    packages = []

    async def install(dependencies, plugin_key):
        packages.append((plugin_key, dependencies))

    monkeypatch.setenv("FILAMAN_GUNICORN_INSTANCE", "startup-test")
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", staticmethod(install))
    for name in ("broken", "working"):
        folder = tmp_path / name
        folder.mkdir()
        (folder / "plugin.json").write_text(json.dumps({
            "plugin_key": name, "dependencies": [f"{name}-package"]
        }))

    config = runpy.run_path(str(Path(__file__).parents[1] / "gunicorn.conf.py"))
    config["on_starting"](None)

    assert packages == [("broken, working", ["broken-package", "working-package"])]


@pytest.mark.parametrize("master_provisioned", [False, True])
async def test_only_master_hook_skips_primary_provisioning(tmp_path, monkeypatch, master_provisioned):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from app import main

    @asynccontextmanager
    async def session():
        yield None

    provision = AsyncMock(return_value={})
    monkeypatch.setenv("SERVER_SOFTWARE", "gunicorn/25")
    if master_provisioned:
        monkeypatch.setenv("FILAMAN_GUNICORN_INSTANCE", "fixture")
    else:
        monkeypatch.delenv("FILAMAN_GUNICORN_INSTANCE", raising=False)
    monkeypatch.setenv("RUN_MIGRATIONS_IN_APP", "false")
    monkeypatch.setattr(main, "_STARTUP_LOCK_PATH", tmp_path / "election.lock")
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main, "_lock_fd", None)
    monkeypatch.setattr(main, "async_session_maker", session)
    monkeypatch.setattr(main, "run_all_seeds", AsyncMock())
    monkeypatch.setattr(main.plugin_manager, "start_all", AsyncMock())
    monkeypatch.setattr(main, "worker_is_draining", lambda: True)
    monkeypatch.setattr(main, "provision_installed_plugin_dependencies", provision)
    monkeypatch.setattr(main.plugin_manager, "stop_all", AsyncMock())

    async with main.lifespan(main.app):
        assert provision.await_count == (0 if master_provisioned else 1)


def test_gunicorn_cancels_provisioning_on_master_shutdown(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    config = Path(__file__).parents[1] / "gunicorn.conf.py"
    script = """
import asyncio
import os
import runpy
import signal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from app.services import plugin_service

async def provision():
    asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
    try:
        await asyncio.Future()
    finally:
        Path("cancelled").touch()

plugin_service.provision_installed_plugin_dependencies = provision
server = SimpleNamespace(pidfile=Mock())
try:
    runpy.run_path(CONFIG)["on_starting"](server)
except SystemExit:
    server.pidfile.unlink.assert_called_once()
    raise
""".replace("CONFIG", repr(str(config)))
    env = {**os.environ, "PYTHONPATH": str(config.parent)}
    result = subprocess.run([sys.executable, "-c", script], cwd=tmp_path, env=env, timeout=10, check=False)
    assert result.returncode == 0
    assert (tmp_path / "cancelled").exists()


async def test_provisioning_skips_unpublished_plugin_archives(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    install = AsyncMock()
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", install)
    for name in ("working", ".unpublished", "bad_type"):
        path = tmp_path / name
        path.mkdir()
        (path / "plugin.json").write_text(json.dumps({
            "dependencies": "invalid" if name == "bad_type" else ["fixture"]
        }))

    await plugin_service.provision_installed_plugin_dependencies()

    install.assert_awaited_once_with(["fixture"], "working")


async def test_provisioning_can_be_cancelled_while_publication_is_busy(tmp_path, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    plugin = tmp_path / "fixture"
    plugin.mkdir()
    (plugin / "plugin.json").write_text(json.dumps({"dependencies": ["fixture"]}))
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    install = AsyncMock()
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", install)

    locks = []
    archive_lock = plugin_service.plugin_archive_lock

    def track_lock(*, reading=False, blocking=False):
        locks.append((reading, blocking))
        # Never let the regression test block the loop while holding the write lock below.
        return archive_lock(reading=reading)

    monkeypatch.setattr(plugin_service, "plugin_archive_lock", track_lock)
    with archive_lock():
        pending = asyncio.create_task(plugin_service.provision_installed_plugin_dependencies())
        await asyncio.sleep(0)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    assert locks == [(True, False)]
    install.assert_not_called()


async def test_upgrade_resolves_dependencies_with_other_installed_plugins(db_session, tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    for key, dependency in (("peer", "shared-fixture==1"), ("test_plugin", "other-fixture==1")):
        path = tmp_path / key
        path.mkdir()
        (path / "plugin.json").write_text(json.dumps({"dependencies": [dependency]}))

    install = AsyncMock()
    service = PluginInstallService(db_session)
    monkeypatch.setattr(service, "_install_dependencies", install)
    archive = _make_zip({
        "plugin.json": json.dumps({**VALID_MANIFEST, "dependencies": ["other-fixture==2"]}),
        "driver.py": VALID_DRIVER_PY,
        "__init__.py": VALID_INIT_PY,
    })

    await service.install_from_zip(archive, installed_by=1)

    install.assert_awaited_once_with(["shared-fixture==1", "other-fixture==2"], "test_plugin")


async def test_startup_recovers_compatible_plugins_after_joint_resolution_failure(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock, call

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    for key, dependency in (("alpha", "shared==1"), ("conflicting", "shared==2"), ("working", "other==1")):
        path = tmp_path / key
        path.mkdir()
        (path / "plugin.json").write_text(json.dumps({"dependencies": [dependency]}))

    install = AsyncMock(side_effect=[
        PluginInstallError("conflicting requirements"),
        None,
        PluginInstallError("conflicting requirements"),
        None,
        None,
    ])
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", install)

    await plugin_service.provision_installed_plugin_dependencies()

    assert install.await_args_list == [
        call(["shared==1", "shared==2", "other==1"], "alpha, conflicting, working"),
        call(["shared==1"], "alpha", dry_run=True),
        call(["shared==1", "shared==2"], "conflicting", dry_run=True),
        call(["shared==1", "other==1"], "working", dry_run=True),
        call(["shared==1", "other==1"], "compatible installed plugins"),
    ]
    assert plugin_service.plugin_dependencies_available(tmp_path / "alpha")
    assert not plugin_service.plugin_dependencies_available(tmp_path / "conflicting")
    assert plugin_service.plugin_dependencies_available(tmp_path / "working")

    install.reset_mock(side_effect=True)
    await plugin_service.provision_installed_plugin_dependencies()
    assert plugin_service.plugin_dependencies_available(tmp_path / "conflicting")


async def test_rejected_plugin_stays_unloaded_until_successful_repair(db_session, tmp_path, monkeypatch):
    from app.api.v1 import router
    from app.plugins import manager
    from app.services import plugin_service
    from fastapi import FastAPI

    plugin = tmp_path / "test_plugin"
    plugin.mkdir()
    (plugin / "plugin.json").write_text(json.dumps({"plugin_type": "integration"}))
    (plugin / "router.py").write_text("raise AssertionError('rejected plugin was imported')")
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    monkeypatch.setattr(manager, "USER_PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(router, "_deferred_plugin_routers", [])

    marker = plugin_service._dependency_failure_marker(plugin)
    marker.parent.mkdir(parents=True)
    marker.touch()
    router._mount_plugin_routers()
    assert not router._deferred_plugin_routers
    assert not router.mount_plugin_router_on_app(FastAPI(), "test_plugin")
    assert manager.PluginManager().load_driver("test_plugin") is None

    await PluginInstallService(db_session).install_from_zip(_make_valid_plugin_zip(), installed_by=1)
    assert plugin_service.plugin_dependencies_available(plugin)


@pytest.mark.parametrize("repair", ["upgrade", "drop_dependency", "uninstall"])
async def test_mutation_recovers_a_peer_with_previously_conflicting_dependencies(
    db_session, tmp_path, monkeypatch, repair,
):
    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path / "plugins")
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    plugin_service.PLUGINS_DIR.mkdir()

    async def install(dependencies, plugin_key, *, dry_run=False):
        if len(set(dependencies)) > 1:
            raise PluginInstallError("incompatible fixture versions")

    monkeypatch.setattr(PluginInstallService, "_install_dependencies", staticmethod(install))
    service = PluginInstallService(db_session)

    def archive(version, dependencies):
        return _make_zip({
            "plugin.json": json.dumps({
                **VALID_MANIFEST, "version": version, "dependencies": dependencies,
            }),
            "driver.py": VALID_DRIVER_PY,
            "__init__.py": VALID_INIT_PY,
        })

    await service.install_from_zip(archive("1.0.0", ["shared-fixture==1"]), installed_by=1)
    peer = plugin_service.PLUGINS_DIR / "unavailable_peer"
    peer.mkdir()
    (peer / "plugin.json").write_text(json.dumps({"dependencies": ["shared-fixture==2"]}))
    await plugin_service.provision_installed_plugin_dependencies()
    assert not plugin_service.plugin_dependencies_available(peer)

    if repair == "uninstall":
        await service.uninstall("test_plugin")
    else:
        dependencies = ["shared-fixture==2"] if repair == "upgrade" else []
        await service.install_from_zip(archive("2.0.0", dependencies), installed_by=1)

    assert plugin_service.plugin_dependencies_available(peer)


async def test_provisioning_uses_writable_data_for_read_only_plugin_archives(tmp_path, monkeypatch):
    from app.services import plugin_service

    plugin_dir = tmp_path / "archives"
    plugin = plugin_dir / "fixture"
    plugin.mkdir(parents=True)
    (plugin / "plugin.json").write_text(json.dumps({"dependencies": ["fixture"]}))
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", plugin_dir)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path / "data")

    async def install(dependencies, plugin_key):
        raise PluginInstallError("fixture package unavailable")

    mkdir = Path.mkdir

    def read_only(path, *args, **kwargs):
        if path.is_relative_to(plugin_dir):
            raise PermissionError("read-only archive mount")
        mkdir(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", read_only)
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", staticmethod(install))

    await plugin_service.provision_installed_plugin_dependencies()

    assert not plugin_service.plugin_dependencies_available(plugin)
    other = tmp_path / "other-archives" / plugin.name
    assert plugin_service.plugin_dependencies_available(other)


async def test_startup_fallback_mounts_router_after_restoring_dependencies(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from app import main
    from app.services import plugin_service
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    plugin = tmp_path / "fixture_router"
    plugin.mkdir()
    (plugin / "__init__.py").touch()
    (plugin / "plugin.json").write_text(json.dumps({
        "plugin_type": "import",
        "mount_prefix": "/fixture",
        "dependencies": ["fixture"],
    }))
    (plugin / "router.py").write_text(
        "from fastapi import APIRouter\nrouter = APIRouter()\n"
        "@router.get('/ping')\nasync def ping(): return {'restored': True}\n"
    )
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    marker = tmp_path / ".locks" / "fixture_router.dependency-unavailable"
    marker.parent.mkdir()
    marker.touch()
    monkeypatch.delenv("FILAMAN_GUNICORN_INSTANCE", raising=False)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(main, "_lock_fd", None)
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main, "worker_is_draining", lambda: True)
    monkeypatch.setattr(main.plugin_manager, "start_all", AsyncMock())
    monkeypatch.setattr(main.plugin_manager, "stop_all", AsyncMock())
    monkeypatch.setattr(PluginInstallService, "_install_dependencies", AsyncMock())

    app = FastAPI()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/fixture/ping")).status_code == 404
        await main._start_primary_drivers(app, initial=True)
        assert (await client.get("/fixture/ping")).json() == {"restored": True}


@pytest.mark.parametrize("conflicts", [False, True])
async def test_provisioning_preserves_healthy_peers_when_a_resolved_package_fails_to_build(
    tmp_path, monkeypatch, conflicts,
):
    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)

    async def install(dependencies, plugin_key, *, dry_run=False):
        if conflicts and len(dependencies) > 1:
            raise PluginInstallError("incompatible fixture versions")
        if not dry_run and "broken-fixture" in dependencies:
            raise PluginInstallError("wheel build failed")

    monkeypatch.setattr(PluginInstallService, "_install_dependencies", staticmethod(install))
    for key, dependency in (("healthy", "healthy-fixture"), ("broken", "broken-fixture")):
        directory = tmp_path / key
        directory.mkdir()
        (directory / "plugin.json").write_text(json.dumps({"dependencies": [dependency]}))

    assert await plugin_service.provision_installed_plugin_dependencies() == {"broken": False, "healthy": True}
    assert plugin_service.plugin_dependencies_available(tmp_path / "healthy")
    assert not plugin_service.plugin_dependencies_available(tmp_path / "broken")


async def test_uninstall_activates_after_timed_out_peer_recovery(db_session, tmp_path, monkeypatch):
    import asyncio

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "DATA_DIR", tmp_path)
    monkeypatch.setattr(plugin_service, "_PEER_RECOVERY_TIMEOUT", 0)
    service = PluginInstallService(db_session)
    await service.install_from_zip(_make_valid_plugin_zip(), installed_by=1)

    peer = tmp_path / "slow_peer"
    peer.mkdir()
    (peer / "plugin.json").write_text(json.dumps({"dependencies": ["slow-fixture"]}))
    marker = plugin_service._dependency_failure_marker(peer)
    marker.parent.mkdir(parents=True)
    marker.touch()

    cancelled = False
    activated = False

    async def install(dependencies, plugin_key, *, dry_run=False):
        nonlocal cancelled
        try:
            await asyncio.wait_for(asyncio.Future(), timeout=0.1)
        except asyncio.CancelledError:
            cancelled = True
            raise

    async def activate(plugin):
        nonlocal activated
        activated = True

    monkeypatch.setattr(PluginInstallService, "_install_dependencies", staticmethod(install))

    await service.uninstall("test_plugin", after_delete=activate)

    assert cancelled
    assert activated
    assert await service.get_plugin("test_plugin") is None
    assert not plugin_service.plugin_dependencies_available(peer)
