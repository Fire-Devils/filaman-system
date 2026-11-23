import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.models import InstalledPlugin
from app.services.plugin_ui_launchers import parse_ui_launchers


@pytest.fixture
def installed_page(tmp_path, monkeypatch):
    import json

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)

    def create(key, path=None):
        directory = tmp_path / key
        directory.mkdir(exist_ok=True)
        (directory / "plugin.json").write_text(
            json.dumps({"plugin_key": key, "page_url": path or "/plugin-page/" + key})
        )
        (directory / "page.html").write_text("<!doctype html><title>Fixture</title>")
        return directory

    return create


def declaration():
    return {
        "id": "research",
        "surface": "filaments.editor",
        "label": "Research",
        "modes": ["create", "edit"],
    }


@pytest.mark.parametrize(
    "entries",
    [
        [{"id": "x", "surface": "filaments.editor", "label": "X"}],
        [{"id": "x", "surface": "colors.library", "label": "X", "modes": ["edit"]}],
        [{"id": "../x", "surface": "colors.library", "label": "X"}],
        [{"id": "x", "surface": "colors.library", "label": " "}],
        [
            {
                "id": "x",
                "surface": "colors.library",
                "label": "X",
                "url": "https://example.com",
            }
        ],
        [declaration(), declaration()],
        [dict(declaration(), modes=["edit", "edit"])],
        [dict(declaration(), modes=["view"])],
        [dict(declaration(), id=str(i)) for i in range(17)],
    ],
)
def test_invalid_declarations(entries):
    with pytest.raises((ValueError, ValidationError)):
        parse_ui_launchers({"ui_launchers": entries})


def test_bounded_future_surfaces_and_legacy_capabilities():
    assert parse_ui_launchers({"filament_ui": {"editor": True}}) == []
    assert (
        len(
            parse_ui_launchers(
                {"ui_launchers": [dict(declaration(), id=str(i)) for i in range(16)]}
            )
        )
        == 16
    )
    assert parse_ui_launchers(
        {
            "ui_launchers": [
                {
                    "id": "future",
                    "surface": "spools.editor",
                    "label": "Future",
                    "modes": ["edit"],
                }
            ]
        }
    )


@pytest.mark.asyncio
async def test_discovery_deduplicates_per_mode_and_preserves_legacy_shape(
    auth_client, db_session, installed_page
):
    installed_page("fixture")
    client, _ = auth_client
    db_session.add(
        InstalledPlugin(
            plugin_key="fixture",
            name="Fixture",
            version="1",
            plugin_type="integration",
            page_url="/plugin-page/fixture",
            capabilities={
                "filament_ui": {"editor": True},
                "ui_launchers": [dict(declaration(), modes=["edit"])],
            },
        )
    )
    await db_session.commit()
    base = "/api/v1/plugin-ui-launchers"
    edit = await client.get(
        base, params={"surface": "filaments.editor", "mode": "edit"}
    )
    assert edit.status_code == 200
    assert [i["launcher_id"] for i in edit.json()] == ["research"]
    create = await client.get(
        base, params={"surface": "filaments.editor", "mode": "create"}
    )
    assert create.status_code == 200
    assert len(create.json()) == 1
    assert create.json()[0]["legacy"] is True
    old = await client.get("/api/v1/filament-plugin-hooks", params={"surface": "edit"})
    assert old.json() == [
        {
            "plugin_key": "fixture",
            "name": "Fixture",
            "page_url": "/plugin-page/fixture",
            "icon_url": None,
        }
    ]
    for params in (
        {"surface": "bad"},
        {"surface": "colors.editor"},
        {"surface": "colors.library", "mode": "edit"},
    ):
        assert (await client.get(base, params=params)).status_code == 422


@pytest.mark.asyncio
async def test_discovery_skips_invalid_inactive_and_wrong_namespace(
    auth_client, db_session, installed_page
):
    installed_page("valid")
    client, _ = auth_client
    for key, active, path, entries in [
        (
            "valid",
            True,
            "/plugin-page/valid",
            [{"id": "library", "surface": "colors.library", "label": "<b>Plain</b>"}],
        ),
        (
            "disabled",
            False,
            "/plugin-page/disabled",
            [{"id": "library", "surface": "colors.library", "label": "Off"}],
        ),
        (
            "wrong",
            True,
            "/plugin-page/not_owned",
            [{"id": "library", "surface": "colors.library", "label": "Wrong"}],
        ),
        (
            "broken",
            True,
            "/plugin-page/broken",
            [{"id": "../bad", "surface": "colors.library", "label": "Bad"}],
        ),
    ]:
        db_session.add(
            InstalledPlugin(
                plugin_key=key,
                name=key,
                version="1",
                plugin_type="integration",
                is_active=active,
                page_url=path,
                capabilities={"ui_launchers": entries},
            )
        )
    await db_session.commit()
    result = await client.get(
        "/api/v1/plugin-ui-launchers", params={"surface": "colors.library"}
    )
    assert result.status_code == 200
    assert [i["plugin_key"] for i in result.json()] == ["valid"]
    assert result.json()[0]["label"] == "<b>Plain</b>"


@pytest.mark.asyncio
async def test_surface_permissions_do_not_grant_write_access(
    auth_client, admin_user, db_session
):
    client, _ = auth_client
    admin_user.is_superadmin = False
    await db_session.commit()
    from app.core.middleware import invalidate_auth_caches

    invalidate_auth_caches()
    for surface, mode in [
        ("filaments.editor", "create"),
        ("filaments.editor", "edit"),
        ("colors.editor", "create"),
        ("colors.editor", "edit"),
        ("colors.selection", None),
        ("filaments.selection", None),
    ]:
        params = {"surface": surface}
        if mode:
            params["mode"] = mode
        assert (
            await client.get("/api/v1/plugin-ui-launchers", params=params)
        ).status_code == 403
    for surface in ["filaments.library", "colors.library"]:
        assert (
            await client.get("/api/v1/plugin-ui-launchers", params={"surface": surface})
        ).status_code == 200
    assert (
        await client.post(
            "/api/v1/colors", json={"name": "No permission", "hex_code": "#123456"}
        )
    ).status_code == 403


@pytest.mark.parametrize(
    "entries,page,valid",
    [
        ([declaration()], "/plugin-page/fixture", True),
        ([declaration()], "/plugin-page/other", False),
        (
            [dict(declaration(), url="https://example.com")],
            "/plugin-page/fixture",
            False,
        ),
        ([dict(declaration(), surface="spools.editor")], "/plugin-page/fixture", True),
    ],
)
def test_manifest_validates_only_new_optional_capability(
    tmp_path, entries, page, valid
):
    import json

    from app.services.plugin_service import PluginInstallError, PluginInstallService

    manifest = {
        "plugin_key": "fixture",
        "name": "Fixture",
        "version": "1.0.0",
        "author": "Fixture",
        "description": "Fixture",
        "plugin_type": "integration",
        "page_url": page,
        "capabilities": {"ui_launchers": entries},
    }
    (tmp_path / "plugin.json").write_text(json.dumps(manifest))
    (tmp_path / "page.html").write_text("<!doctype html><title>Fixture</title>")
    if valid:
        assert (
            PluginInstallService._validate_manifest(tmp_path)["capabilities"][
                "ui_launchers"
            ]
            == entries
        )
    else:
        with pytest.raises(PluginInstallError):
            PluginInstallService._validate_manifest(tmp_path)


@pytest.mark.asyncio
async def test_runtime_recovers_valid_siblings_and_compat_color_stays_legacy(
    auth_client, db_session, installed_page
):
    installed_page("fixture")
    client, _ = auth_client
    db_session.add(
        InstalledPlugin(
            plugin_key="fixture",
            name="Fixture",
            version="1",
            plugin_type="integration",
            page_url="/plugin-page/fixture",
            capabilities={
                "color_ui": {"editor": True},
                "ui_launchers": [
                    {"id": "valid", "surface": "colors.library", "label": "Valid"},
                    {"id": "../invalid", "surface": "filaments.editor", "label": "Bad"},
                    {
                        "id": "editor-a",
                        "surface": "colors.editor",
                        "label": "A",
                        "modes": ["edit"],
                    },
                    {
                        "id": "editor-b",
                        "surface": "colors.editor",
                        "label": "B",
                        "modes": ["edit"],
                    },
                ],
            },
        )
    )
    await db_session.commit()
    result = await client.get(
        "/api/v1/plugin-ui-launchers", params={"surface": "colors.library"}
    )
    assert [item["launcher_id"] for item in result.json()] == ["valid"]
    legacy = await client.get("/api/v1/plugin-ui-launchers", params={"surface": "colors.editor", "mode": "create"})
    assert len(legacy.json()) == 1
    assert legacy.json()[0]["legacy"] is True
    assert legacy.json()[0]["plugin_key"] == "fixture"


@pytest.mark.asyncio
@pytest.mark.parametrize("filesystem", [False, True])
async def test_ambiguous_plugin_page_is_not_a_launcher(
    auth_client, db_session, tmp_path, monkeypatch, filesystem
):
    import json

    from app.services import plugin_service

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    client, _ = auth_client
    db_session.add(
        InstalledPlugin(
            plugin_key="fixture",
            name="Fixture",
            version="1",
            plugin_type="integration",
            page_url="/plugin-page/fixture",
            capabilities={"ui_launchers": [declaration()]},
        )
    )
    if filesystem:
        for key in ["fixture", "shadow"]:
            directory = tmp_path / key
            directory.mkdir()
            (directory / "plugin.json").write_text(
                json.dumps({"plugin_key": key, "page_url": "/plugin-page/fixture"})
            )
            (directory / "page.html").write_text(key)
    else:
        db_session.add(
            InstalledPlugin(
                plugin_key="shadow",
                name="Shadow",
                version="1",
                plugin_type="integration",
                page_url="/plugin-page/fixture",
                is_active=False,
            )
        )
    await db_session.commit()
    result = await client.get(
        "/api/v1/plugin-ui-launchers",
        params={"surface": "filaments.editor", "mode": "edit"},
    )
    assert result.status_code == 200
    assert result.json() == []


@pytest.mark.asyncio
async def test_explicit_discovery_requires_its_page_but_legacy_fallback_stays_accepted(
    auth_client, db_session, installed_page
):
    client, _ = auth_client
    directory = installed_page("fixture")
    db_session.add(
        InstalledPlugin(
            plugin_key="fixture",
            name="Fixture",
            version="1",
            plugin_type="integration",
            page_url="/plugin-page/fixture",
            capabilities={"ui_launchers": [declaration()]},
        )
    )
    await db_session.commit()
    (directory / "page.html").unlink()
    result = await client.get(
        "/api/v1/plugin-ui-launchers",
        params={"surface": "filaments.editor", "mode": "edit"},
    )
    assert result.json() == []
    plugin = await db_session.scalar(select(InstalledPlugin).where(InstalledPlugin.plugin_key == 'fixture'))
    plugin.capabilities = {"filament_ui": {"editor": True}}
    await db_session.commit()
    legacy = await client.get(
        "/api/v1/plugin-ui-launchers",
        params={"surface": "filaments.editor", "mode": "edit"},
    )
    assert legacy.json()[0]["legacy"] is True


@pytest.mark.asyncio
async def test_missing_page_upgrade_keeps_working_install(
    db_session, admin_user, tmp_path, monkeypatch
):
    import io
    import json
    import zipfile

    from app.services import plugin_service
    from app.services.plugin_service import PluginInstallError, PluginInstallService

    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    db_session.add(
        InstalledPlugin(
            plugin_key="fixture",
            name="Fixture",
            version="1.0.0",
            plugin_type="integration",
            page_url="/plugin-page/fixture",
            installed_by=admin_user.id,
            capabilities={"ui_launchers": [declaration()]},
        )
    )
    await db_session.commit()
    current = tmp_path / "fixture"
    current.mkdir()
    (current / "page.html").write_text("Working page")
    manifest = {
        "plugin_key": "fixture",
        "name": "Fixture",
        "version": "2.0.0",
        "author": "Fixture",
        "description": "Fixture",
        "plugin_type": "integration",
        "page_url": "/plugin-page/fixture",
        "capabilities": {"ui_launchers": [declaration()]},
    }
    (current / "plugin.json").write_text(json.dumps({**manifest, "version": "1.0.0"}))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("plugin.json", json.dumps(manifest))
        archive.writestr("__init__.py", "")
    with pytest.raises(PluginInstallError, match="page.html") as failure:
        await PluginInstallService(db_session).install_from_zip(
            buffer.getvalue(), installed_by=admin_user.id
        )
    assert failure.value.code == "missing_file"
    assert (current / "page.html").read_text() == "Working page"
    assert (await db_session.scalar(select(InstalledPlugin).where(InstalledPlugin.plugin_key == 'fixture'))).version == "1.0.0"


@pytest.mark.asyncio
async def test_legacy_color_selection_does_not_create_a_launcher(auth_client, db_session):
    client, _ = auth_client
    db_session.add(InstalledPlugin(plugin_key="color_selection_only", name="Color only",
        version="1.0.0", plugin_type="integration", page_url="/plugin-page/color_selection_only",
        capabilities={"color_ui": {"selection": True}}, is_active=True))
    await db_session.commit()
    response = await client.get("/api/v1/plugin-ui-launchers?surface=colors.selection")
    assert response.status_code == 200
    assert all(item["plugin_key"] != "color_selection_only" for item in response.json())


@pytest.mark.asyncio
@pytest.mark.parametrize("entity", ["filaments", "colors"])
async def test_legacy_launcher_presentation_is_edit_only(auth_client, db_session, entity):
    client, _ = auth_client
    db_session.add(InstalledPlugin(plugin_key="legacy_mode", name="Legacy mode", version="1",
        plugin_type="integration", page_url="/plugin-page/legacy_mode",
        capabilities={"filament_ui" if entity == "filaments" else "color_ui": {
            "editor": True, "editor_launcher": {"style": "icon", "allow_auto_open": True}}}))
    await db_session.commit()
    for mode in ["create", "edit"]:
        response = await client.get("/api/v1/plugin-ui-launchers", params={"surface": f"{entity}.editor", "mode": mode})
        item = next(item for item in response.json() if item["plugin_key"] == "legacy_mode")
        assert item["legacy"] is True
        assert item["editor_launcher"] == (None if mode == "create" else {"style": "icon", "allow_auto_open": True})
    if entity == "filaments":
        old = await client.get("/api/v1/filament-plugin-hooks", params={"surface": "create", "include_launcher": True})
        assert "editor_launcher" not in next(item for item in old.json() if item["plugin_key"] == "legacy_mode")
