import pytest

from app.models import InstalledPlugin


@pytest.mark.asyncio
async def test_discover_active_filament_hooks_without_requiring_sidebar_visibility(auth_client, db_session):
    client, _csrf = auth_client

    def plugin(key, path, hooks=None, active=True):
        return InstalledPlugin(
            plugin_key=key, name=key, version="1.0.0", plugin_type="integration",
            is_active=active, page_url=path, show_in_nav=False,
            capabilities={"filament_ui": hooks} if hooks is not None else None,
        )

    db_session.add_all([
        plugin("fixture_editor", "/plugin-page/editor/tools", {"editor": True}),
        plugin("fixture_selection", "/plugin-page/selection", {"selection": True}),
        plugin("fixture_disabled", "/plugin-page/disabled", {"editor": True}, active=False),
        plugin("fixture_external", "https://example.invalid/plugin", {"editor": True}),
        plugin("fixture_bad_path", "/plugin-page/../other", {"editor": True}),
        plugin("fixture_legacy", "/plugin-page/legacy"),
        plugin("fixture_truthy", "/plugin-page/truthy", {"editor": "true"}),
    ])
    await db_session.commit()

    for surface in ("create", "edit", "selection"):
        result = await client.get("/api/v1/filament-plugin-hooks", params={"surface": surface})
        assert result.status_code == 200
        expected = "fixture_selection" if surface == "selection" else "fixture_editor"
        path = "/plugin-page/selection" if surface == "selection" else "/plugin-page/editor/tools"
        assert result.json() == [{"plugin_key": expected, "name": expected, "page_url": path, "icon_url": None}]


@pytest.mark.asyncio
async def test_editor_launcher_metadata_is_opt_in_and_validated(auth_client, db_session):
    client, _csrf = auth_client
    for key, launcher in (
        ("fixture_icon", {"style": "icon", "allow_auto_open": True}),
        ("fixture_legacy", None),
        ("fixture_invalid", {"style": "https://example.invalid/icon.svg", "allow_auto_open": "true"}),
    ):
        db_session.add(InstalledPlugin(
            plugin_key=key, name=key, version="1.0.0", plugin_type="integration",
            page_url=f"/plugin-page/{key}", icon="icon.svg",
            capabilities={"filament_ui": {"editor": True, "editor_launcher": launcher}},
        ))
    await db_session.commit()
    path = "/api/v1/filament-plugin-hooks"
    default = await client.get(path, params={"surface": "edit"})
    assert all("editor_launcher" not in item for item in default.json())
    create = await client.get(path, params={"surface": "create", "include_launcher": True})
    assert create.json() == default.json()
    edit = await client.get(path, params={"surface": "edit", "include_launcher": True})
    entries = {item["plugin_key"]: item for item in edit.json()}
    assert entries["fixture_icon"]["editor_launcher"] == {"style": "icon", "allow_auto_open": True}
    assert entries["fixture_icon"]["icon_url"] == "/api/v1/plugin-icons/fixture_icon?v=1.0.0"
    assert all("editor_launcher" not in entries[key] for key in ("fixture_legacy", "fixture_invalid"))
