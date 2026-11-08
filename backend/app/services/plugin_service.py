"""Plugin-Installations-Service mit ZIP-Validierung."""

import ast
import asyncio
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import zipfile
from collections.abc import Awaitable, Iterator
from contextlib import AbstractContextManager, contextmanager, nullcontext, suppress
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import DATA_DIR, settings
from app.core.file_lock import FileLockBusy, exclusive_file_lock, file_lock
from app.models.plugin import InstalledPlugin
from app.services.plugin_icon_service import read_plugin_icon

logger = logging.getLogger(__name__)


def _resolve_plugins_dir() -> Path:
    """Resolve the directory for user-installed plugins.

    Priority:
    1. PLUGINS_DIR env var (explicit override)
    2. /app/data/plugins (Docker volume — auto-detected)
    3. Alongside built-in plugins (dev fallback, backward compatible)
    """
    if settings.plugins_dir:
        p = Path(settings.plugins_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p
    # Docker: /app/data is the volume mount
    data_dir = Path("/app/data")
    if data_dir.is_dir():
        p = data_dir / "plugins"
        p.mkdir(parents=True, exist_ok=True)
        return p
    # Dev fallback: alongside built-in plugins
    return Path(__file__).parent.parent / "plugins"


# Directory for user-installed plugins (persisted across Docker updates)
PLUGINS_DIR = _resolve_plugins_dir()

# Maximale ZIP-Groesse: 10 MB
MAX_ZIP_SIZE = 10 * 1024 * 1024
MAX_UNPACKED_ZIP_SIZE = 100 * 1024 * 1024
MAX_PLUGIN_FILE_SIZE = 1024 * 1024

# Erlaubte Dateiendungen
ALLOWED_EXTENSIONS = {
    ".py",
    ".json",
    ".md",
    ".txt",
    ".cfg",
    ".ini",
    ".yaml",
    ".yml",
    ".toml",
    ".html",
    ".svg",
}

# Pflichtfelder im Manifest (Basisfelder, gelten fuer alle Plugin-Typen)
REQUIRED_MANIFEST_FIELDS = {"plugin_key", "name", "version", "description", "author"}

# Zusaetzliche Pflichtfelder je Plugin-Typ
REQUIRED_DRIVER_FIELDS = {"driver_key"}

# Gueltige Plugin-Typen
VALID_PLUGIN_TYPES = {"driver", "import", "integration"}

# Regex fuer plugin_key
PLUGIN_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,49}$")

# Regex fuer Semver (vereinfacht)
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$")


_VERSION_PARTS = re.compile(
    r"(\d{1,30})\.(\d{1,30})\.(\d{1,30})(-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.-]+)?"
)


def version_key(version: str) -> tuple[int, ...]:
    match = _VERSION_PARTS.fullmatch(version)
    if not match:
        return ()
    major, minor, patch, prerelease = match.groups()
    # Catalog and system updates offer stable versions.
    return int(major), int(minor), int(patch), int(prerelease is None)


class PluginInstallError(Exception):
    """Fehler bei der Plugin-Installation."""

    def __init__(self, message: str, code: str = "plugin_install_error"):
        super().__init__(message)
        self.code = code


def plugin_restore_lock(*, shared: bool = False) -> AbstractContextManager[None]:
    return file_lock(DATA_DIR / "locks" / "plugin-backup-restore.lock", shared=shared)


def plugin_archive_lock(
    plugin_key: str | None = None, *, reading: bool = False, blocking: bool = False,
) -> AbstractContextManager[None]:
    if plugin_key is not None and not PLUGIN_KEY_PATTERN.fullmatch(plugin_key):
        return nullcontext()
    filename = "plugin-archive-publication.lock" if plugin_key is None else f"plugin-driver-archive-{plugin_key}.lock"
    return file_lock(DATA_DIR / "locks" / filename, shared=reading, blocking=blocking)


@contextmanager
def _plugin_write_lock(plugin_key: str, *, backup_restore_locked: bool = False) -> Iterator[None]:
    if not PLUGIN_KEY_PATTERN.fullmatch(plugin_key):
        raise PluginInstallError(f"Plugin '{plugin_key}' nicht gefunden", "not_found")
    try:
        restore_guard = nullcontext() if backup_restore_locked else plugin_restore_lock(shared=True)
        with restore_guard, exclusive_file_lock(PLUGINS_DIR / ".locks" / f"{plugin_key}.lock"):
            yield
    except FileLockBusy as exc:
        raise PluginInstallError(
            "Another plugin change or backup restore is in progress. Try again.",
            "plugin_mutation_in_progress",
        ) from exc


@contextmanager
def _stage_archive(source: Path | None = None) -> Iterator[Path]:
    staging = Path(tempfile.mkdtemp(dir=PLUGINS_DIR, prefix=".install-"))
    try:
        if source is not None:
            shutil.copytree(source, staging / "new")
        yield staging
    finally:
        if (staging / "previous").exists():
            logger.warning("Previous plugin files retained at %s", staging / "previous")
        else:
            shutil.rmtree(staging, ignore_errors=True)


@contextmanager
def _replace_archive(staging: Path, target: Path) -> Iterator[None]:
    staged = staging / "new"
    previous = staging / "previous"
    if target.exists():
        target.rename(previous)
    published = False
    try:
        if staged.exists():
            staged.rename(target)
            published = True
        yield
    except BaseException:
        if published:
            target.rename(staged)
        if previous.exists():
            previous.rename(target)
        raise
    else:
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)


async def _settle_plugin_write(work: Awaitable[None]) -> bool:
    """Finish a commit or its activation before releasing the archive lock."""
    pending = asyncio.ensure_future(work)
    cancelled = False
    while not pending.done():
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            cancelled = True
    pending.result()
    return cancelled


class PluginInstallService:
    """Service fuer Plugin-Installation, -Validierung und -Deinstallation."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ------------------------------------------------------------------ #
    #  Installation
    # ------------------------------------------------------------------ #

    async def install_from_zip(
        self,
        zip_data: bytes,
        installed_by: int | None = None,
        expected_release: tuple[str, str] | None = None,
        after_install: Callable[[InstalledPlugin, str | None], Awaitable[None]] | None = None,
        *,
        backup_restore_locked: bool = False,
    ) -> tuple[InstalledPlugin, bool]:
        """Plugin aus ZIP-Daten installieren oder aktualisieren.

        Durchlaeuft die komplette Pruefkette und installiert
        das Plugin bei Erfolg in das plugins-Verzeichnis.
        Bei bestehendem Plugin wird ein Upgrade durchgefuehrt.

        Returns:
            Tuple aus (InstalledPlugin, is_upgrade).
        """
        with (
            self.validated_archive(zip_data, expected_release) as (plugin_dir, manifest),
            _plugin_write_lock(manifest["plugin_key"], backup_restore_locked=backup_restore_locked),
        ):
            plugin_key = manifest["plugin_key"]
            try:
                existing = await self._find_existing(plugin_key)
                previous_type = existing.plugin_type if existing else None
                if (
                    expected_release and existing
                    and version_key(existing.version) > version_key(manifest["version"])
                ):
                    raise PluginInstallError(
                        f"The recorded plugin version {existing.version} is newer than this catalog release.",
                        "catalog_downgrade",
                    )

                with _stage_archive(plugin_dir) as staging:
                    dependencies = manifest.get("dependencies") or []
                    if dependencies:
                        await self._install_dependencies(dependencies, plugin_key)

                    with (
                        plugin_archive_lock(), plugin_archive_lock(plugin_key),
                        _replace_archive(staging, PLUGINS_DIR / plugin_key),
                    ):
                        plugin = existing or InstalledPlugin(
                            plugin_key=plugin_key, is_active=True, installed_by=installed_by
                        )
                        for field in (
                            "name", "version", "description", "author", "homepage", "license",
                            "plugin_type", "driver_key", "page_url", "icon", "config_schema", "capabilities",
                        ):
                            setattr(plugin, field, manifest.get(field))
                        plugin.show_in_nav = manifest.get("show_in_nav", False)
                        if existing is None:
                            self.db.add(plugin)
                        cancelled = await _settle_plugin_write(self.db.commit())
            except (Exception, asyncio.CancelledError):
                await self.db.rollback()
                raise

            async def activate() -> None:
                await self.db.refresh(plugin)
                if after_install:
                    await after_install(plugin, previous_type)

            if await _settle_plugin_write(activate()) or cancelled:
                raise asyncio.CancelledError
            logger.info("Installed plugin %s v%s", plugin_key, plugin.version)
            return plugin, existing is not None

    # ------------------------------------------------------------------ #
    #  Deinstallation
    # ------------------------------------------------------------------ #

    async def uninstall(
        self,
        plugin_key: str,
        before_delete: Callable[[InstalledPlugin], Awaitable[None]] | None = None,
        after_delete: Callable[[InstalledPlugin], Awaitable[None]] | None = None,
    ) -> InstalledPlugin:
        """Remove the plugin and its record under the same lock used for installs."""
        with _plugin_write_lock(plugin_key):
            try:
                plugin = await self.get_plugin(plugin_key, for_update=True)
                if not plugin:
                    raise PluginInstallError(f"Plugin '{plugin_key}' nicht gefunden", "not_found")
                if plugin.installed_by is None:
                    raise PluginInstallError(
                        f"Plugin '{plugin_key}' ist ein eingebautes Plugin und kann nicht deinstalliert werden",
                        "builtin_protected",
                    )
                with _stage_archive() as staging:
                    if before_delete:
                        await before_delete(plugin)
                    with (
                        plugin_archive_lock(), plugin_archive_lock(plugin_key),
                        _replace_archive(staging, PLUGINS_DIR / plugin_key),
                    ):
                        await self.db.delete(plugin)
                        cancelled = await _settle_plugin_write(self.db.commit())
            except (Exception, asyncio.CancelledError):
                await self.db.rollback()
                raise

            if after_delete:
                cancelled = await _settle_plugin_write(after_delete(plugin)) or cancelled
            if cancelled:
                raise asyncio.CancelledError
            logger.info(f"Plugin '{plugin_key}' deinstalliert")
            return plugin

    # ------------------------------------------------------------------ #
    #  Installierte Plugins auflisten
    # ------------------------------------------------------------------ #

    async def list_installed(self) -> list[InstalledPlugin]:
        """Alle installierten Plugins auflisten."""
        result = await self.db.execute(
            select(InstalledPlugin).order_by(InstalledPlugin.name)
        )
        return list(result.scalars().all())

    def has_plugin_files(self, plugin_key: str, version: str) -> bool:
        try:
            path = PLUGINS_DIR / plugin_key / "plugin.json"
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, RecursionError):
            return False
        return isinstance(manifest, dict) and (manifest.get("plugin_key"), manifest.get("version")) == (plugin_key, version)

    async def get_plugin(self, plugin_key: str, *, for_update: bool = False) -> InstalledPlugin | None:
        statement = select(InstalledPlugin).where(InstalledPlugin.plugin_key == plugin_key)
        if for_update:
            # MySQL's ordinary reads can reuse the permission check's older snapshot.
            statement = statement.with_for_update().execution_options(populate_existing=True)
        result = await self.db.execute(statement)
        return result.scalar_one_or_none()

    async def set_active(self, plugin_key: str, is_active: bool) -> InstalledPlugin:
        """Plugin aktivieren oder deaktivieren."""
        with _plugin_write_lock(plugin_key):
            try:
                plugin = await self.get_plugin(plugin_key, for_update=True)
                if not plugin:
                    raise PluginInstallError(f"Plugin '{plugin_key}' nicht gefunden", "not_found")
                plugin.is_active = is_active
                cancelled = await _settle_plugin_write(self.db.commit())
                await self.db.refresh(plugin)
            except (Exception, asyncio.CancelledError):
                await self.db.rollback()
                raise
            if cancelled:
                raise asyncio.CancelledError

        logger.info(
            f"Plugin '{plugin_key}' {'aktiviert' if is_active else 'deaktiviert'}"
        )
        return plugin

    # ------------------------------------------------------------------ #
    #  Validierungs-Methoden
    # ------------------------------------------------------------------ #

    @classmethod
    @contextmanager
    def validated_archive(
        cls, zip_data: bytes, expected_release: tuple[str, str] | None = None
    ) -> Iterator[tuple[Path, dict[str, Any]]]:
        """Check an archive without installing dependencies or touching installed files."""
        if len(zip_data) > MAX_ZIP_SIZE:
            raise PluginInstallError(
                f"ZIP-Datei zu gross ({len(zip_data)} Bytes, max. {MAX_ZIP_SIZE})",
                "zip_too_large",
            )

        cls._validate_zip(zip_data)
        with tempfile.TemporaryDirectory(prefix="filaman_plugin_") as tmpdir:
            plugin_dir = cls._extract_zip(zip_data, tmpdir)
            manifest = cls._validate_manifest(plugin_dir)
            if expected_release is not None and (manifest["plugin_key"], manifest["version"]) != expected_release:
                raise PluginInstallError(
                    "Plugin ZIP manifest does not match the catalog release.", "manifest_mismatch"
                )

            plugin_type = manifest["plugin_type"]
            cls._validate_structure(plugin_dir, plugin_type)
            cls._validate_security(plugin_dir)
            if plugin_type == "driver":
                cls._validate_driver(plugin_dir, manifest)
            yield plugin_dir, manifest

    @staticmethod
    def _validate_zip(zip_data: bytes) -> None:
        """Pruefen, ob die Daten ein gueltiges ZIP-Archiv sind."""
        try:
            with zipfile.ZipFile(__import__("io").BytesIO(zip_data), "r") as zf:
                entries = zf.infolist()
                for entry in entries:
                    if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                        raise PluginInstallError(
                            "Plugin ZIP entries must use Store or Deflate compression.", "unsupported_compression"
                        )
                    if entry.file_size > MAX_PLUGIN_FILE_SIZE:
                        raise PluginInstallError(f"Plugin file is too large: {entry.filename}", "file_too_large")
                if sum(entry.file_size for entry in entries) > MAX_UNPACKED_ZIP_SIZE:
                    raise PluginInstallError("The unpacked plugin ZIP exceeds 100 MB.", "zip_too_large")
                # Test auf Korruption
                bad = zf.testzip()
                if bad is not None:
                    raise PluginInstallError(
                        f"Korrupte Datei im ZIP: {bad}",
                        "zip_corrupt",
                    )
        except zipfile.BadZipFile:
            raise PluginInstallError(
                "Ungueltige ZIP-Datei",
                "invalid_zip",
            )

    @staticmethod
    def _extract_zip(zip_data: bytes, tmpdir: str) -> Path:
        """ZIP entpacken und das Plugin-Verzeichnis zurueckgeben.

        Erkennt automatisch, ob Dateien direkt im Root oder in einem
        einzelnen Unterverzeichnis liegen.
        """
        import io

        with zipfile.ZipFile(io.BytesIO(zip_data), "r") as zf:
            # Sicherheits-Check: Keine Pfade ausserhalb des Zielverzeichnisses
            for info in zf.infolist():
                normalized = os.path.normpath(info.filename)
                if normalized.startswith("..") or os.path.isabs(normalized):
                    raise PluginInstallError(
                        f"Unerlaubter Pfad im ZIP: {info.filename}",
                        "path_traversal",
                    )

            zf.extractall(tmpdir)

        # Pruefen ob ein einziges Unterverzeichnis vorhanden ist
        entries = [
            e
            for e in os.listdir(tmpdir)
            if not e.startswith(".") and not e == "__MACOSX"
        ]

        if len(entries) == 1 and os.path.isdir(os.path.join(tmpdir, entries[0])):
            return Path(tmpdir) / entries[0]

        # Dateien liegen direkt im Root
        return Path(tmpdir)

    @staticmethod
    def _validate_structure(
        plugin_dir: Path, plugin_type: str = "driver"
    ) -> None:
        """Pruefen, ob die Pflichtdateien vorhanden sind."""
        required_files = ["plugin.json", "__init__.py"]

        # Nur Treiber-Plugins brauchen eine driver.py
        if plugin_type == "driver":
            required_files.append("driver.py")

        for filename in required_files:
            filepath = plugin_dir / filename
            if not filepath.exists():
                raise PluginInstallError(
                    f"Pflichtdatei '{filename}' fehlt",
                    "missing_file",
                )

    @classmethod
    def _validate_manifest(cls, plugin_dir: Path) -> dict[str, Any]:
        """plugin.json laden und validieren."""
        manifest_path = plugin_dir / "plugin.json"

        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except (ValueError, RecursionError) as e:
            raise PluginInstallError(
                f"plugin.json ist kein gueltiges JSON: {e}",
                "invalid_json",
            )

        if not isinstance(manifest, dict):
            raise PluginInstallError("Plugin manifest must be a JSON object.", "invalid_manifest")

        # Pflichtfelder pruefen (Basisfelder)
        for field in REQUIRED_MANIFEST_FIELDS:
            if field not in manifest or not manifest[field]:
                raise PluginInstallError(
                    f"Pflichtfeld '{field}' fehlt im Manifest",
                    "missing_field",
                )

        for field, max_length in (
            ("plugin_key", 50), ("name", 200), ("author", 200), ("version", 30),
            ("homepage", 500), ("license", 100), ("driver_key", 50), ("page_url", 500),
        ):
            value = manifest.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > max_length):
                raise PluginInstallError(f"Invalid manifest field: {field}.", "invalid_manifest")
        if not isinstance(manifest["description"], str):
            raise PluginInstallError("Invalid manifest field: description.", "invalid_manifest")
        if not isinstance(manifest.get("show_in_nav", False), bool):
            raise PluginInstallError("Invalid manifest field: show_in_nav.", "invalid_manifest")
        for field in ("config_schema", "capabilities"):
            value = manifest.get(field)
            if value is not None and not isinstance(value, dict):
                raise PluginInstallError(f"Invalid manifest field: {field}.", "invalid_manifest")

        dependencies = manifest.get("dependencies")
        if dependencies is not None and (
            not isinstance(dependencies, list)
            or any(not isinstance(item, str) or not item.strip() for item in dependencies)
        ):
            raise PluginInstallError("Plugin dependencies must be a list of package requirements.", "invalid_manifest")

        # plugin_type validieren (Default: "driver")
        plugin_type = manifest.get("plugin_type", "driver")
        if not isinstance(plugin_type, str) or plugin_type not in VALID_PLUGIN_TYPES:
            raise PluginInstallError(
                f"Ungueltiger plugin_type '{plugin_type}' "
                f"(erlaubt: {', '.join(sorted(VALID_PLUGIN_TYPES))})",
                "invalid_plugin_type",
            )
        manifest["plugin_type"] = plugin_type

        # plugin_key validieren
        plugin_key = manifest["plugin_key"]
        if not PLUGIN_KEY_PATTERN.fullmatch(plugin_key):
            raise PluginInstallError(
                f"Ungueltiger plugin_key '{plugin_key}' "
                "(3-50 Zeichen, lowercase, Buchstaben/Ziffern/Underscores, "
                "muss mit Buchstabe beginnen)",
                "invalid_key",
            )

        # Version validieren
        version = manifest["version"]
        if not SEMVER_PATTERN.fullmatch(version):
            raise PluginInstallError(
                f"Ungueltige Version '{version}' (erwartet: Semver, z.B. 1.0.0)",
                "invalid_version",
            )

        # Treiber-spezifische Validierung
        if plugin_type == "driver":
            for field in REQUIRED_DRIVER_FIELDS:
                if field not in manifest or not manifest[field]:
                    raise PluginInstallError(
                        f"Pflichtfeld '{field}' fehlt im Manifest (erforderlich fuer Typ 'driver')",
                        "missing_field",
                    )

            # driver_key muss mit plugin_key uebereinstimmen
            if manifest["driver_key"] != plugin_key:
                raise PluginInstallError(
                    f"driver_key '{manifest['driver_key']}' muss mit "
                    f"plugin_key '{plugin_key}' uebereinstimmen",
                    "key_mismatch",
                )

        # Reservierte Keys pruefen
        reserved_keys = {"dummy", "base", "manager", "__pycache__"}
        if plugin_key in reserved_keys:
            raise PluginInstallError(
                f"Plugin-Key '{plugin_key}' ist reserviert",
                "reserved_key",
            )

        if manifest.get("icon") is not None:
            cls._validate_icon(plugin_dir, manifest["icon"])

        return manifest

    @staticmethod
    def _validate_icon(plugin_dir: Path, icon: str) -> None:
        try:
            read_plugin_icon(plugin_dir, icon)
        except (OSError, ValueError) as error:
            raise PluginInstallError(f"Ungueltiges Plugin-Icon: {error}", "invalid_icon") from error

    @classmethod
    def _validate_security(cls, plugin_dir: Path) -> None:
        """Sicherheitspruefungen durchfuehren."""
        for root, dirs, files in os.walk(plugin_dir):
            # __pycache__ ignorieren
            dirs[:] = [d for d in dirs if d != "__pycache__"]

            for filename in files:
                filepath = Path(root) / filename
                rel_path = filepath.relative_to(plugin_dir)

                # Dateiendung pruefen
                suffix = filepath.suffix.lower()
                if suffix == ".svg":
                    cls._validate_icon(plugin_dir, str(rel_path))
                if suffix and suffix not in ALLOWED_EXTENSIONS:
                    raise PluginInstallError(
                        f"Unerlaubte Dateiendung: {rel_path}",
                        "forbidden_extension",
                    )

                # Maximale Einzeldatei-Groesse: 1 MB
                if filepath.stat().st_size > MAX_PLUGIN_FILE_SIZE:
                    raise PluginInstallError(
                        f"Datei zu gross: {rel_path} ({filepath.stat().st_size} Bytes)",
                        "file_too_large",
                    )

                if suffix == ".py":
                    try:
                        compile(filepath.read_bytes(), str(rel_path), "exec")
                    except (SyntaxError, ValueError) as exc:
                        raise PluginInstallError(
                            f"Invalid Python in {rel_path}: {exc}", "syntax_error"
                        ) from exc

                # Keine versteckten Dateien (ausser __init__.py)
                if filename.startswith("."):
                    raise PluginInstallError(
                        f"Versteckte Datei nicht erlaubt: {rel_path}",
                        "hidden_file",
                    )

    @staticmethod
    def _validate_driver(plugin_dir: Path, manifest: dict[str, Any]) -> None:
        """Pruefen, ob driver.py eine gueltige Driver-Klasse enthaelt."""
        driver_path = plugin_dir / "driver.py"

        try:
            source = driver_path.read_text(encoding="utf-8")
        except Exception as e:
            raise PluginInstallError(
                f"driver.py kann nicht gelesen werden: {e}",
                "unreadable_driver",
            )

        # AST-Analyse: Pruefen ob eine Klasse "Driver" existiert
        try:
            tree = ast.parse(source)
        except SyntaxError as e:
            raise PluginInstallError(
                f"Syntaxfehler in driver.py: {e}",
                "syntax_error",
            )

        driver_class_found = False
        inherits_base = False

        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "Driver":
                driver_class_found = True
                # Pruefen ob BaseDriver in den Basisklassen vorkommt
                for base in node.bases:
                    if isinstance(base, ast.Name) and base.id == "BaseDriver":
                        inherits_base = True
                    elif isinstance(base, ast.Attribute) and base.attr == "BaseDriver":
                        inherits_base = True

        if not driver_class_found:
            raise PluginInstallError(
                "driver.py enthaelt keine Klasse 'Driver'",
                "no_driver_class",
            )

        if not inherits_base:
            raise PluginInstallError(
                "Klasse 'Driver' in driver.py erbt nicht von 'BaseDriver'",
                "invalid_inheritance",
            )

        # Pruefen ob driver_key gesetzt ist
        driver_key_found = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "Driver":
                for item in node.body:
                    if isinstance(item, ast.Assign):
                        for target in item.targets:
                            if (
                                isinstance(target, ast.Name)
                                and target.id == "driver_key"
                            ):
                                driver_key_found = True

        if not driver_key_found:
            raise PluginInstallError(
                "Klasse 'Driver' definiert kein Attribut 'driver_key'",
                "no_driver_key",
            )

    async def _find_existing(self, plugin_key: str) -> InstalledPlugin | None:
        """Pruefen, ob ein Plugin mit dem Key bereits installiert ist.

        Gibt das vorhandene Plugin zurueck (fuer Upgrade) oder None.
        Wirft einen Fehler bei integrierten Plugins (nicht per ZIP ueberschreibbar).
        """
        existing = await self.get_plugin(plugin_key, for_update=True)

        if existing and existing.installed_by is None:
            raise PluginInstallError(
                f"Integriertes Plugin '{plugin_key}' kann nicht ueberschrieben werden",
                "builtin_conflict",
            )

        return existing

    async def _install_dependencies(
        self, dependencies: list[str], plugin_key: str
    ) -> None:
        """Python-Pakete installieren (versucht uv, dann pip)."""
        logger.info(f"Installiere Abhaengigkeiten fuer '{plugin_key}': {dependencies}")

        # Kommandos: uv pip (falls vorhanden), dann sys.executable -m pip
        commands: list[list[str]] = []
        uv_path = shutil.which("uv")
        if uv_path:
            commands.append(
                [
                    uv_path,
                    "pip",
                    "install",
                    "--python",
                    sys.executable,
                    "--quiet",
                    *dependencies,
                ]
            )
        commands.append(
            [sys.executable, "-m", "pip", "install", "--quiet", *dependencies]
        )

        last_error = ""
        for cmd in commands:
            try:
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=120)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.communicate()
                    raise

                if process.returncode == 0:
                    logger.info(
                        f"Abhaengigkeiten fuer '{plugin_key}' erfolgreich installiert"
                    )
                    return

                last_error = stderr.decode().strip() if stderr else "Unbekannter Fehler"
                logger.warning(
                    f"Dependency install fehlgeschlagen mit {cmd[0]}: {last_error}"
                )
            except FileNotFoundError:
                last_error = f"{cmd[0]} nicht gefunden"
                logger.warning(last_error)
                continue
            except asyncio.TimeoutError:
                raise PluginInstallError(
                    "Timeout bei der Installation der Abhaengigkeiten (120s)",
                    "dependency_timeout",
                )

        raise PluginInstallError(
            f"Abhaengigkeiten konnten nicht installiert werden: {last_error}",
            "dependency_install_failed",
        )

    # ------------------------------------------------------------------ #
    #  Eingebaute Plugins registrieren
    # ------------------------------------------------------------------ #

    async def register_builtin(
        self,
        plugin_key: str,
        name: str,
        version: str,
        description: str,
        author: str,
        plugin_type: str,
        page_url: str | None = None,
        homepage: str | None = None,
        show_in_nav: bool = False,
        icon: str | None = None,
    ) -> InstalledPlugin:
        """Ein eingebautes Plugin registrieren (kein ZIP noetig).

        Falls bereits vorhanden, wird Version/Beschreibung aktualisiert.
        """
        result = await self.db.execute(
            select(InstalledPlugin).where(InstalledPlugin.plugin_key == plugin_key)
        )
        existing = result.scalar_one_or_none()

        if existing:
            # Update metadata if version changed
            existing.name = name
            existing.version = version
            existing.description = description
            existing.plugin_type = plugin_type
            existing.page_url = page_url
            existing.homepage = homepage
            existing.show_in_nav = show_in_nav
            existing.icon = icon
            await self.db.commit()
            await self.db.refresh(existing)
            return existing

        plugin = InstalledPlugin(
            plugin_key=plugin_key,
            name=name,
            version=version,
            description=description,
            author=author,
            plugin_type=plugin_type,
            page_url=page_url,
            homepage=homepage,
            show_in_nav=show_in_nav,
            icon=icon,
            is_active=True,
        )
        self.db.add(plugin)
        await self.db.commit()
        await self.db.refresh(plugin)

        logger.info(f"Eingebautes Plugin '{plugin_key}' v{version} registriert")
        return plugin
