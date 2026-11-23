"""Host-owned plugin launcher declarations and discovery."""

import json
import re
from collections import Counter
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    ValidationError,
    model_validator,
)
from sqlalchemy import select

from app.models import InstalledPlugin

Surface = Literal[
    "filaments.editor",
    "colors.editor",
    "filaments.library",
    "colors.library",
    "filaments.selection",
    "colors.selection",
]
Mode = Literal["create", "edit"]


class UiLauncherDeclaration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    surface: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=80)
    modes: list[Mode] | None = None

    @model_validator(mode="after")
    def validate_modes(self):
        if not self.label.strip():
            raise ValueError("Launcher label must not be blank")
        if self.surface.endswith(".editor"):
            if not self.modes or len(set(self.modes)) != len(self.modes):
                raise ValueError("Editor launchers require unique modes")
        elif "modes" in self.model_fields_set:
            raise ValueError("Only editor launchers accept modes")
        return self


def parse_ui_launchers(capabilities: dict) -> list[UiLauncherDeclaration]:
    if "ui_launchers" not in capabilities:
        return []
    entries = capabilities["ui_launchers"]
    if not isinstance(entries, list) or len(entries) > 16:
        raise ValueError("ui_launchers must be an array of at most 16 entries")
    result = [UiLauncherDeclaration.model_validate(entry) for entry in entries]
    if len({entry.id for entry in result}) != len(result):
        raise ValueError("Launcher IDs must be unique within the plugin")
    return result


class PluginEditorLauncher(BaseModel):
    style: Literal["text", "icon"] = "text"
    allow_auto_open: StrictBool = False


class UiLauncherItem(BaseModel):
    plugin_key: str
    plugin_name: str
    launcher_id: str
    surface: Surface
    label: str
    page_url: str
    icon_url: str | None
    legacy: bool = False
    editor_launcher: PluginEditorLauncher | None = None


def owned_plugin_page(key: str, path: str | None) -> bool:
    return bool(
        path
        and re.fullmatch(
            r"/plugin-page/" + re.escape(key) + r"(?:/[a-z0-9][a-z0-9_-]*)*", path
        )
    )


async def discover_ui_launchers(
    db, surface: Surface, mode: Mode | None
) -> list[UiLauncherItem]:
    from app.services.plugin_service import PLUGINS_DIR

    plugins = list(await db.scalars(select(InstalledPlugin)))
    database_claims = Counter(plugin.page_url for plugin in plugins)
    file_claims: dict[str, list[str]] = {}
    if PLUGINS_DIR.is_dir():
        for directory in PLUGINS_DIR.iterdir():
            if not (directory / "page.html").is_file():
                continue
            try:
                meta = json.loads(
                    (directory / "plugin.json").read_text(encoding="utf-8")
                )
                path = meta.get("page_url", "").strip()
                file_claims.setdefault(path, []).append(
                    meta.get("plugin_key", directory.name)
                )
            except (OSError, ValueError, AttributeError, RecursionError):
                continue
    result = []
    for plugin in plugins:
        page_owners = file_claims.get(plugin.page_url, [])
        if (
            not plugin.is_active
            or database_claims[plugin.page_url] > 1
            or len(page_owners) > 1
            or any(key != plugin.plugin_key for key in page_owners)
        ):
            continue
        capabilities = (
            plugin.capabilities if isinstance(plugin.capabilities, dict) else {}
        )
        # Legacy installed mappings are kept; explicit declarations require page ownership.
        if not re.fullmatch(
            r"/plugin-page/[a-z0-9][a-z0-9_-]*(?:/[a-z0-9][a-z0-9_-]*)*",
            plugin.page_url or "",
        ):
            continue
        entries = []
        seen_ids = set()
        raw_entries = capabilities.get("ui_launchers")
        for raw in raw_entries[:16] if isinstance(raw_entries, list) else []:
            try:
                declaration = UiLauncherDeclaration.model_validate(raw)
            except ValidationError:
                continue
            if declaration.id not in seen_ids:
                entries.append(declaration)
                seen_ids.add(declaration.id)
        matching = [
            entry
            for entry in entries
            if entry.surface == surface
            and (mode is None or mode in (entry.modes or []))
        ]
        if matching and page_owners == [plugin.plugin_key] and owned_plugin_page(plugin.plugin_key, plugin.page_url):
            for entry in matching:
                result.append(
                    UiLauncherItem(
                        plugin_key=plugin.plugin_key,
                        plugin_name=plugin.name,
                        launcher_id=entry.id,
                        surface=surface,
                        label=entry.label,
                        page_url=plugin.page_url,
                        icon_url=plugin.icon_url,
                    )
                )
            continue
        entity, location = surface.split(".")
        hooks = capabilities.get("filament_ui" if entity == "filaments" else "color_ui")
        if (
            location == "library"
            or (entity == "colors" and location != "editor")
            or not isinstance(hooks, dict)
            or hooks.get(location) is not True
        ):
            continue
        launcher = None
        if location == "editor" and mode == "edit" and isinstance(hooks.get("editor_launcher"), dict):
            try:
                launcher = PluginEditorLauncher.model_validate(hooks["editor_launcher"])
            except ValidationError:
                pass
        result.append(
            UiLauncherItem(
                plugin_key=plugin.plugin_key,
                plugin_name=plugin.name,
                launcher_id="legacy-" + location,
                surface=surface,
                label=plugin.name,
                page_url=plugin.page_url,
                icon_url=plugin.icon_url,
                legacy=True,
                editor_launcher=launcher,
            )
        )
    return sorted(
        result, key=lambda item: (item.plugin_name, item.plugin_key, item.launcher_id)
    )
