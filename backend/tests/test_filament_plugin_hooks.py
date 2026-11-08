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
