"""Plugin-Installations-Service mit ZIP-Validierung."""

import ast
import json
import logging
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.plugin import InstalledPlugin

logger = logging.getLogger(__name__)

# Pfad zum plugins-Verzeichnis innerhalb des Backends
PLUGINS_DIR = Path(__file__).parent.parent / "plugins"

# Maximale ZIP-Groesse: 10 MB
MAX_ZIP_SIZE = 10 * 1024 * 1024

# Erlaubte Dateiendungen
ALLOWED_EXTENSIONS = {
    ".py", ".json", ".md", ".txt", ".cfg", ".ini", ".yaml", ".yml", ".toml",
}

# Pflichtfelder im Manifest
REQUIRED_MANIFEST_FIELDS = {"plugin_key", "name", "version", "description", "author", "driver_key"}

# Regex fuer plugin_key
PLUGIN_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,49}$")

# Regex fuer Semver (vereinfacht)
SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$")


class PluginInstallError(Exception):
    """Fehler bei der Plugin-Installation."""

    def __init__(self, message: str, code: str = "plugin_install_error"):
        super().__init__(message)
        self.code = code


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
    ) -> InstalledPlugin:
        """Plugin aus ZIP-Daten installieren.

        Durchlaeuft die komplette Pruefkette und installiert
        das Plugin bei Erfolg in das plugins-Verzeichnis.
        """
        # 1. Groessen-Pruefung
        if len(zip_data) > MAX_ZIP_SIZE:
            raise PluginInstallError(
                f"ZIP-Datei zu gross ({len(zip_data)} Bytes, max. {MAX_ZIP_SIZE})",
                "zip_too_large",
            )

        # 2. ZIP-Validierung
        self._validate_zip(zip_data)

        # 3. In temp-Verzeichnis entpacken
        with tempfile.TemporaryDirectory(prefix="filaman_plugin_") as tmpdir:
            plugin_dir = self._extract_zip(zip_data, tmpdir)

            # 4. Struktur-Pruefung
            self._validate_structure(plugin_dir)

            # 5. Manifest lesen und pruefen
            manifest = self._validate_manifest(plugin_dir)

            # 6. Sicherheits-Pruefung
            self._validate_security(plugin_dir)

            # 7. Treiber-Klasse pruefen
            self._validate_driver(plugin_dir, manifest)

            # 8. Konflikt-Pruefung (DB)
            plugin_key = manifest["plugin_key"]
            await self._check_conflicts(plugin_key)

            # 9. Plugin in plugins-Verzeichnis kopieren
            target_dir = PLUGINS_DIR / plugin_key
            if target_dir.exists():
                shutil.rmtree(target_dir)
            shutil.copytree(plugin_dir, target_dir)

            # 10. DB-Eintrag erstellen
            plugin = InstalledPlugin(
                plugin_key=plugin_key,
                name=manifest["name"],
                version=manifest["version"],
                description=manifest.get("description"),
                author=manifest.get("author"),
                homepage=manifest.get("homepage"),
                license=manifest.get("license"),
                driver_key=manifest["driver_key"],
                config_schema=manifest.get("config_schema"),
                is_active=True,
                installed_by=installed_by,
            )
            self.db.add(plugin)
            await self.db.commit()
            await self.db.refresh(plugin)

            logger.info(f"Plugin '{plugin_key}' v{manifest['version']} installiert")
            return plugin

    # ------------------------------------------------------------------ #
    #  Deinstallation
    # ------------------------------------------------------------------ #

    async def uninstall(self, plugin_key: str) -> None:
        """Plugin deinstallieren."""
        result = await self.db.execute(
            select(InstalledPlugin).where(InstalledPlugin.plugin_key == plugin_key)
        )
        plugin = result.scalar_one_or_none()

        if not plugin:
            raise PluginInstallError(
                f"Plugin '{plugin_key}' nicht gefunden",
                "not_found",
            )

        # Plugin-Verzeichnis entfernen
        target_dir = PLUGINS_DIR / plugin_key
        if target_dir.exists():
            shutil.rmtree(target_dir)
            logger.info(f"Plugin-Verzeichnis '{target_dir}' entfernt")

        # DB-Eintrag loeschen
        await self.db.delete(plugin)
        await self.db.commit()

        logger.info(f"Plugin '{plugin_key}' deinstalliert")

    # ------------------------------------------------------------------ #
    #  Installierte Plugins auflisten
    # ------------------------------------------------------------------ #

    async def list_installed(self) -> list[InstalledPlugin]:
        """Alle installierten Plugins auflisten."""
        result = await self.db.execute(
            select(InstalledPlugin).order_by(InstalledPlugin.name)
        )
        return list(result.scalars().all())

    async def get_plugin(self, plugin_key: str) -> InstalledPlugin | None:
        """Ein einzelnes Plugin anhand des Keys holen."""
        result = await self.db.execute(
            select(InstalledPlugin).where(InstalledPlugin.plugin_key == plugin_key)
        )
        return result.scalar_one_or_none()

    # ------------------------------------------------------------------ #
    #  Validierungs-Methoden
    # ------------------------------------------------------------------ #

    def _validate_zip(self, zip_data: bytes) -> None:
        """Pruefen, ob die Daten ein gueltiges ZIP-Archiv sind."""
        try:
            with zipfile.ZipFile(
                __import__("io").BytesIO(zip_data), "r"
            ) as zf:
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

    def _extract_zip(self, zip_data: bytes, tmpdir: str) -> Path:
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
            e for e in os.listdir(tmpdir)
            if not e.startswith(".") and not e == "__MACOSX"
        ]

        if len(entries) == 1 and os.path.isdir(os.path.join(tmpdir, entries[0])):
            return Path(tmpdir) / entries[0]

        # Dateien liegen direkt im Root
        return Path(tmpdir)

    def _validate_structure(self, plugin_dir: Path) -> None:
        """Pruefen, ob die Pflichtdateien vorhanden sind."""
        required_files = ["plugin.json", "__init__.py", "driver.py"]

        for filename in required_files:
            filepath = plugin_dir / filename
            if not filepath.exists():
                raise PluginInstallError(
                    f"Pflichtdatei '{filename}' fehlt",
                    "missing_file",
                )

    def _validate_manifest(self, plugin_dir: Path) -> dict[str, Any]:
        """plugin.json laden und validieren."""
        manifest_path = plugin_dir / "plugin.json"

        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except json.JSONDecodeError as e:
            raise PluginInstallError(
                f"plugin.json ist kein gueltiges JSON: {e}",
                "invalid_json",
            )

        # Pflichtfelder pruefen
        for field in REQUIRED_MANIFEST_FIELDS:
            if field not in manifest or not manifest[field]:
                raise PluginInstallError(
                    f"Pflichtfeld '{field}' fehlt im Manifest",
                    "missing_field",
                )

        # plugin_key validieren
        plugin_key = manifest["plugin_key"]
        if not PLUGIN_KEY_PATTERN.match(plugin_key):
            raise PluginInstallError(
                f"Ungueltiger plugin_key '{plugin_key}' "
                "(3-50 Zeichen, lowercase, Buchstaben/Ziffern/Underscores, "
                "muss mit Buchstabe beginnen)",
                "invalid_key",
            )

        # Version validieren
        version = manifest["version"]
        if not SEMVER_PATTERN.match(version):
            raise PluginInstallError(
                f"Ungueltige Version '{version}' (erwartet: Semver, z.B. 1.0.0)",
                "invalid_version",
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

        return manifest

    def _validate_security(self, plugin_dir: Path) -> None:
        """Sicherheitspruefungen durchfuehren."""
        for root, dirs, files in os.walk(plugin_dir):
            # __pycache__ ignorieren
            dirs[:] = [d for d in dirs if d != "__pycache__"]

            for filename in files:
                filepath = Path(root) / filename
                rel_path = filepath.relative_to(plugin_dir)

                # Dateiendung pruefen
                suffix = filepath.suffix.lower()
                if suffix and suffix not in ALLOWED_EXTENSIONS:
                    raise PluginInstallError(
                        f"Unerlaubte Dateiendung: {rel_path}",
                        "forbidden_extension",
                    )

                # Maximale Einzeldatei-Groesse: 1 MB
                if filepath.stat().st_size > 1 * 1024 * 1024:
                    raise PluginInstallError(
                        f"Datei zu gross: {rel_path} ({filepath.stat().st_size} Bytes)",
                        "file_too_large",
                    )

                # Keine versteckten Dateien (ausser __init__.py)
                if filename.startswith("."):
                    raise PluginInstallError(
                        f"Versteckte Datei nicht erlaubt: {rel_path}",
                        "hidden_file",
                    )

    def _validate_driver(self, plugin_dir: Path, manifest: dict[str, Any]) -> None:
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
                            if isinstance(target, ast.Name) and target.id == "driver_key":
                                driver_key_found = True

        if not driver_key_found:
            raise PluginInstallError(
                "Klasse 'Driver' definiert kein Attribut 'driver_key'",
                "no_driver_key",
            )

    async def _check_conflicts(self, plugin_key: str) -> None:
        """Pruefen, ob ein Plugin mit dem Key bereits installiert ist."""
        result = await self.db.execute(
            select(InstalledPlugin).where(InstalledPlugin.plugin_key == plugin_key)
        )
        existing = result.scalar_one_or_none()

        if existing:
            raise PluginInstallError(
                f"Plugin '{plugin_key}' ist bereits installiert (v{existing.version}). "
                "Bitte zuerst deinstallieren.",
                "already_installed",
            )

        # Pruefen ob ein built-in Plugin mit diesem Key existiert
        builtin_dir = PLUGINS_DIR / plugin_key
        if builtin_dir.exists():
            raise PluginInstallError(
                f"Ein integriertes Plugin mit dem Key '{plugin_key}' existiert bereits",
                "builtin_conflict",
            )
