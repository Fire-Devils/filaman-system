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
    async def test_uninstall_not_found(self, db_session):
        service = PluginInstallService(db_session)

        with pytest.raises(PluginInstallError) as excinfo:
            await service.uninstall("missing")

        assert excinfo.value.code == "not_found"


class TestInstallFromZip:
    @pytest.mark.asyncio
    async def test_install_valid_plugin(self, db_session):
        service = PluginInstallService(db_session)
        zip_data = _make_valid_plugin_zip()

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("app.services.plugin_service.PLUGINS_DIR", Path(tmpdir)):
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
    with pytest.raises(PluginInstallError):
        with PluginInstallService.validated_archive(archive):
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
