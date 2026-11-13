import json
import sys
from asyncio import CancelledError, sleep
from types import ModuleType

import pytest
import pytest_asyncio
from app.api.mcp_plugin_tools import load_plugin_read_tools
from app.core.security import generate_token_secret, hash_token
from app.main import app
from app.models import AppSettings, InstalledPlugin, Location, UserApiKey, UserRole
from sqlalchemy import delete, select


async def _set_flags(db_session, *, enabled: bool, write: bool) -> None:
    row = (await db_session.execute(select(AppSettings).where(AppSettings.id == 1))).scalar_one_or_none()
    if row is None:
        row = AppSettings(id=1)
        db_session.add(row)
    row.mcp_enabled = enabled
    row.mcp_write_enabled = write
    await db_session.commit()


async def _make_key(db_session, user, scopes=None) -> str:
    secret = generate_token_secret()
    key = UserApiKey(user_id=user.id, name="MCP test", key_hash=hash_token(secret), scopes=scopes)
    db_session.add(key)
    await db_session.commit()
    await db_session.refresh(key)
    return f"uak.{key.id}.{secret}"


@pytest_asyncio.fixture
async def admin_key(db_session, admin_user):
    return await _make_key(db_session, admin_user)


async def _rpc(client, token, method, params=None, req_id=1):
    body = {"jsonrpc": "2.0", "method": method}
    if req_id is not None:
        body["id"] = req_id
    if params is not None:
        body["params"] = params
    headers = {"Authorization": f"ApiKey {token}"} if token else {}
    return await client.post("/mcp", json=body, headers=headers)


def _tool_names(resp) -> set[str]:
    return {t["name"] for t in resp.json()["result"]["tools"]}


@pytest.mark.asyncio
async def test_mcp_disabled_returns_404(client, db_session, admin_key):
    await _set_flags(db_session, enabled=False, write=False)
    resp = await _rpc(client, admin_key, "initialize", {"protocolVersion": "2025-06-18"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "mcp_disabled"


@pytest.mark.asyncio
async def test_mcp_requires_api_key(client, db_session):
    await _set_flags(db_session, enabled=True, write=True)
    resp = await _rpc(client, None, "initialize")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_mcp_rejects_session_cookie(auth_client, db_session):
    client, csrf = auth_client
    await _set_flags(db_session, enabled=True, write=True)
    resp = await client.post(
        "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"X-CSRF-Token": csrf}
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_initialize_negotiates_protocol(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=False)
    resp = await _rpc(client, admin_key, "initialize", {"protocolVersion": "2025-06-18"})
    assert resp.status_code == 200
    result = resp.json()["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert "tools" in result["capabilities"]
    assert result["serverInfo"]["name"] == "filaman"

    resp = await _rpc(client, admin_key, "initialize", {"protocolVersion": "1999-01-01"})
    assert resp.json()["result"]["protocolVersion"] == "2025-11-25"


@pytest.mark.asyncio
async def test_notification_returns_202(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=False)
    resp = await _rpc(client, admin_key, "notifications/initialized", req_id=None)
    assert resp.status_code == 202


@pytest.mark.asyncio
@pytest.mark.parametrize("handler_returns_after_cancellation", [False, True])
async def test_batch_deadline_returns_completed_results(
    client, db_session, admin_key, monkeypatch, handler_returns_after_cancellation,
):
    from app.api import mcp_server

    await _set_flags(db_session, enabled=True, write=False)
    calls = []

    async def read_tool(request, name, arguments):
        calls.append(name)
        if name == "plugin-slow":
            try:
                await sleep(0.25)
            except CancelledError:
                if not handler_returns_after_cancellation:
                    raise
        if name == "plugin-invalid":
            return {"name": chr(0xD800)}
        return {"name": name}

    monkeypatch.setattr(mcp_server, "call_plugin_read_tool", read_tool)
    monkeypatch.setattr(mcp_server, "MCP_BATCH_TIMEOUT_SECONDS", 0.1)
    batch = [
        {
            "jsonrpc": "2.0", "id": req_id, "method": "tools/call",
            "params": {"name": name, "arguments": {}},
        }
        for req_id, name in enumerate(("plugin-invalid", "plugin-fast", "plugin-slow", "plugin-later"), start=1)
    ]
    batch.append({"jsonrpc": "2.0", "method": "notifications/initialized"})
    resp = await client.post("/mcp", json=batch, headers={"Authorization": f"ApiKey {admin_key}"})
    assert resp.status_code == 200
    invalid, first, slow, later = resp.json()
    assert invalid["id"] == 1 and invalid["result"]["isError"]
    assert first["id"] == 2
    assert json.loads(first["result"]["content"][0]["text"]) == {"name": "plugin-fast"}
    assert [slow["id"], later["id"]] == [3, 4]
    if handler_returns_after_cancellation:
        assert not slow["result"]["isError"]
    else:
        assert slow["error"]["message"] == "MCP batch deadline exceeded while running this request. Its outcome is unknown."
    assert later["error"]["message"] == "MCP batch deadline exceeded before this request started"
    assert calls == ["plugin-invalid", "plugin-fast", "plugin-slow"]


@pytest.mark.asyncio
async def test_failed_plugin_discovery_keeps_native_mcp_tools(client, db_session, admin_key, monkeypatch):
    from app.api import mcp_server

    async def unavailable(*args):
        raise RuntimeError("Discovery failed")

    await _set_flags(db_session, enabled=True, write=False)
    monkeypatch.setattr(mcp_server.settings, "mcp_plugin_read_tools", "plugin-tool")
    monkeypatch.setattr(mcp_server, "available_plugin_read_tools", unavailable)
    resp = await _rpc(client, admin_key, "tools/list")
    assert "list_spools" in _tool_names(resp)


@pytest.mark.asyncio
async def test_unknown_method_and_parse_error(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=False)
    resp = await _rpc(client, admin_key, "resources/list")
    assert resp.json()["error"]["code"] == -32601

    resp = await client.post(
        "/mcp", content=b"{not json", headers={"Authorization": f"ApiKey {admin_key}"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == -32700


@pytest.mark.asyncio
async def test_read_only_mode_hides_and_blocks_write_tools(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=False)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert "list_spools" in names
    assert "create_spool" not in names

    resp = await _rpc(client, admin_key, "tools/call", {"name": "create_location", "arguments": {"name": "X"}})
    result = resp.json()["result"]
    assert result["isError"] is True
    assert "disabled" in result["content"][0]["text"]
    count = (await db_session.execute(select(Location).where(Location.name == "X"))).scalars().all()
    assert count == []


@pytest.mark.asyncio
async def test_write_mode_lists_and_runs_write_tools(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert {"create_spool", "record_spool_measurement", "move_spool"} <= names

    resp = await _rpc(
        client, admin_key, "tools/call", {"name": "create_location", "arguments": {"name": "Regal MCP"}}
    )
    result = resp.json()["result"]
    assert result["isError"] is False, result
    created = json.loads(result["content"][0]["text"])
    assert created["name"] == "Regal MCP"

    resp = await _rpc(client, admin_key, "tools/call", {"name": "list_locations", "arguments": {}})
    listing = json.loads(resp.json()["result"]["content"][0]["text"])
    assert any(loc["name"] == "Regal MCP" for loc in listing["items"])


@pytest.mark.asyncio
async def test_api_key_scopes_still_apply(client, db_session, normal_user):
    await _set_flags(db_session, enabled=True, write=True)
    token = await _make_key(db_session, normal_user, scopes=["spools:read"])
    resp = await _rpc(client, token, "tools/call", {"name": "create_location", "arguments": {"name": "Nope"}})
    result = resp.json()["result"]
    assert result["isError"] is True
    assert json.loads(result["content"][0]["text"])["http_status"] == 403


@pytest.mark.asyncio
async def test_argument_validation(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    resp = await _rpc(client, admin_key, "tools/call", {"name": "get_spool", "arguments": {}})
    assert resp.json()["result"]["isError"] is True

    resp = await _rpc(
        client, admin_key, "tools/call", {"name": "get_spool", "arguments": {"spool_id": "1/../../admin"}}
    )
    assert "positive integer" in resp.json()["result"]["content"][0]["text"]

    resp = await _rpc(client, admin_key, "tools/call", {"name": "nope", "arguments": {}})
    assert resp.json()["result"]["isError"] is True


@pytest.mark.parametrize("plugin_type", ["import", "integration"])
def test_missing_mcp_declaration_does_not_query_lazy_plugin_exports(tmp_path, plugin_type):
    module = ModuleType("legacy_plugin")

    def load_optional_export(name):
        raise KeyError(name)

    module.__getattr__ = load_optional_export
    manifest = {"plugin_type": plugin_type, "version": "1.0.0"}
    assert load_plugin_read_tools("legacy_plugin", manifest, module, tmp_path / "plugin.json") == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("startup", [False, True])
async def test_plugin_read_tool_requires_allowlist_active_version_and_permission(
    client, db_session, admin_user, normal_user, tmp_path, monkeypatch, startup
):
    from app.api.v1 import router as loader
    from app.core.config import settings
    from app.services import plugin_service

    plugin_dir = tmp_path / "sample_mcp"
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").touch()
    manifest = json.dumps({
        "plugin_key": "sample_mcp", "plugin_type": "integration", "version": "1.0.0",
    })
    (plugin_dir / "plugin.json").write_text(manifest)
    source = """\
from fastapi import APIRouter
from decimal import Decimal
from pydantic import BaseModel, ConfigDict
router = APIRouter()
class Nested(BaseModel):
    model_config = ConfigDict(extra="allow")
class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int
    nested: Nested | None = None
class MisleadingArgs(BaseModel):
    model_config = ConfigDict(json_schema_extra={"additionalProperties": False})
class NonJsonArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [Decimal("1.5")]})
def broken_schema(_schema):
    raise RuntimeError("Schema fixture failed")
class BrokenArgs(BaseModel):
    model_config = ConfigDict(json_schema_extra=broken_schema)
async def read(args, db, principal):
    if args.count == 0:
        Args.model_validate({"count": "invalid handler data"})
    return {"count": args.count, "key_id": principal.api_key_id, "nested": args.nested.model_dump() if args.nested else None}
mcp_read_tools = {
    "lookup": {
        "description": "Look up a fixture",
        "permission": "filaments:read",
        "arguments": Args,
        "handler": read,
    },
    "unknown_permission": {
        "description": "Look up a fixture",
        "permission": "missing:read",
        "arguments": Args,
        "handler": read,
    },
    "broken_schema": {
        "description": "An invalid optional declaration",
        "permission": "filaments:read",
        "arguments": BrokenArgs,
        "handler": read,
    },
    "misleading_schema": {
        "description": "An arguments model that accepts extra keys",
        "permission": "filaments:read",
        "arguments": MisleadingArgs,
        "handler": read,
    },
    "non_json_schema": {
        "description": "A schema that cannot be sent to clients",
        "permission": "filaments:read",
        "arguments": NonJsonArgs,
        "handler": read,
    },
}
"""
    router_path = plugin_dir / "router.py"
    router_path.write_text(source)
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "sample_mcp", raising=False)
    monkeypatch.delitem(sys.modules, "sample_mcp.router", raising=False)
    monkeypatch.setattr(loader, "_deferred_plugin_routers", [])
    monkeypatch.setattr(app.router, "routes", list(app.router.routes))
    monkeypatch.setattr(app.state, "plugin_routes", {}, raising=False)
    monkeypatch.setattr(app.state, "plugin_mcp_tools", {}, raising=False)
    if startup:
        loader._mount_plugin_routers()
        loader.mount_deferred_plugin_routers(app)
    else:
        assert loader.mount_plugin_router_on_app(app, "sample_mcp")

    install = InstalledPlugin(plugin_key="sample_mcp", plugin_type="integration", name="Sample", version="1.0.0")
    db_session.add(install)
    await db_session.commit()
    token = await _make_key(db_session, admin_user, ["filaments:read"])
    limited = await _make_key(db_session, admin_user, ["spools:read"])
    name = "sample_mcp-lookup"
    await _set_flags(db_session, enabled=True, write=False)

    async def listing(key=token):
        return (await _rpc(client, key, "tools/list")).json()["result"]["tools"]

    async def call(key=token, arguments=None):
        return (await _rpc(
            client, key, "tools/call", {"name": name, "arguments": {"count": 3} if arguments is None else arguments},
        )).json()["result"]

    assert name not in {tool["name"] for tool in await listing()}
    assert (await call())["isError"]
    missing_permission = "sample_mcp-unknown_permission"
    broken_tool = "sample_mcp-broken_schema"
    misleading_tool = "sample_mcp-misleading_schema"
    non_json_tool = "sample_mcp-non_json_schema"
    monkeypatch.setattr(settings, "mcp_plugin_read_tools", f"{name},{missing_permission},{broken_tool},{misleading_tool},{non_json_tool}")
    tools = {tool["name"]: tool for tool in await listing()}
    assert "list_spools" in tools and "create_spool" not in tools
    assert tools[name]["annotations"]["readOnlyHint"]
    assert tools[name]["annotations"]["openWorldHint"]
    assert broken_tool not in tools
    assert misleading_tool not in tools
    assert non_json_tool not in tools
    unscoped = await _make_key(db_session, admin_user)
    assert missing_permission not in {tool["name"] for tool in await listing(unscoped)}
    assert name not in {tool["name"] for tool in await listing(limited)}
    assert (await call(limited))["isError"]
    await db_session.execute(delete(UserRole).where(UserRole.user_id == normal_user.id))
    await db_session.commit()
    no_role = await _make_key(db_session, normal_user, ["filaments:read"])
    assert (await call(no_role))["isError"]
    assert (await call(arguments=[]))["isError"]
    bad_input = await call(arguments={"count": "bad"})
    assert bad_input["isError"]
    assert "Invalid plugin tool arguments" in bad_input["content"][0]["text"]
    handler_failure = await call(arguments={"count": 0})
    assert handler_failure["isError"]
    assert handler_failure["content"][0]["text"] == "Internal error while running the tool"
    assert (await call(arguments={"count": 3, "url": "https://example.test"}))["isError"]
    result = await call(arguments={"count": 3, "nested": {"label": "PLA"}})
    assert not result["isError"]
    assert json.loads(result["content"][0]["text"]) == {
        "count": 3, "key_id": int(token.split(".")[1]), "nested": {"label": "PLA"},
    }

    install.is_active = False
    await db_session.commit()
    assert name not in {tool["name"] for tool in await listing()}
    assert (await call())["isError"]
    install.is_active = True
    install.version = "1.1.0"
    await db_session.commit()
    assert (await call())["isError"]
    install.version = "1.0.0"
    await db_session.commit()
    # A same-version package replaces the whole directory before workers reload.
    plugin_dir.rename(tmp_path / "previous-package")
    plugin_dir.mkdir()
    (plugin_dir / "__init__.py").touch()
    (plugin_dir / "plugin.json").write_text(manifest)
    router_path.write_text(source.split("mcp_read_tools", 1)[0])
    assert name not in {tool["name"] for tool in await listing()}
    assert (await call())["isError"]
    assert loader.mount_plugin_router_on_app(app, "sample_mcp")
    assert (await call())["isError"]


@pytest.mark.asyncio
async def test_get_returns_405(client):
    resp = await client.get("/mcp")
    assert resp.status_code == 405


async def _call(client, key, name, arguments):
    resp = await _rpc(client, key, "tools/call", {"name": name, "arguments": arguments})
    return resp.json()["result"]


@pytest.mark.asyncio
async def test_color_tools_listed_by_mode(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=False)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert "list_colors" in names
    assert not {"create_color", "set_filament_colors"} & names
    await _set_flags(db_session, enabled=True, write=True)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert {"list_colors", "create_color", "set_filament_colors"} <= names


@pytest.mark.asyncio
async def test_create_color_and_set_filament_colors(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    result = await _call(client, admin_key, "create_color", {"name": "Rot MCP", "hex_code": "#ff0000"})
    assert result["isError"] is False, result
    color = json.loads(result["content"][0]["text"])

    listing = await _call(client, admin_key, "list_colors", {})
    assert any(c["id"] == color["id"] for c in json.loads(listing["content"][0]["text"])["items"])

    result = await _call(client, admin_key, "create_manufacturer", {"name": "Farb-Hersteller"})
    manufacturer = json.loads(result["content"][0]["text"])
    result = await _call(client, admin_key, "create_filament", {
        "manufacturer_id": manufacturer["id"], "designation": "PLA Rot",
        "material_type": "PLA", "diameter_mm": 1.75,
    })
    assert result["isError"] is False, result
    filament = json.loads(result["content"][0]["text"])

    result = await _call(client, admin_key, "set_filament_colors", {
        "filament_id": filament["id"], "color_mode": "single",
        "colors": [{"color_id": color["id"], "position": 1}],
    })
    assert result["isError"] is False, result

    result = await _call(client, admin_key, "get_filament", {"filament_id": filament["id"]})
    detail = json.loads(result["content"][0]["text"])
    assert detail["color_mode"] == "single"
    assert [c["color_id"] for c in detail["colors"]] == [color["id"]]


@pytest.mark.asyncio
async def test_update_filament_rejects_unknown_fields(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    result = await _call(client, admin_key, "update_filament", {"filament_id": 1, "fields": {"color": "red"}})
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "color" in text and "set_filament_colors" in text


def _json(result):
    return json.loads(result["content"][0]["text"])


async def _make_filament(client, key, **extra):
    manufacturer = _json(await _call(client, key, "create_manufacturer", {"name": f"Hersteller {extra.get('tag', 'x')}"}))
    result = await _call(client, key, "create_filament", {
        "manufacturer_id": manufacturer["id"], "designation": "PLA Test",
        "material_type": "PLA", "diameter_mm": 1.75,
    })
    assert result["isError"] is False, result
    return manufacturer, _json(result)


@pytest.mark.asyncio
async def test_new_tools_listed_by_mode(client, db_session, admin_key):
    read_tools = {"get_spool_events", "search_filamentdb_filaments", "list_filamentdb_manufacturers"}
    write_tools = {
        "import_filamentdb_filament", "create_spools_bulk", "record_spool_adjustment", "update_location",
        "update_manufacturer", "request_spool_label_print", "request_filament_label_print",
    }
    await _set_flags(db_session, enabled=True, write=False)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert read_tools <= names
    assert not write_tools & names
    await _set_flags(db_session, enabled=True, write=True)
    names = _tool_names(await _rpc(client, admin_key, "tools/list"))
    assert (read_tools | write_tools) <= names


@pytest.mark.asyncio
async def test_create_filament_with_colors(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    color = _json(await _call(client, admin_key, "create_color", {"name": "Blau MCP", "hex_code": "#0000ff"}))
    manufacturer = _json(await _call(client, admin_key, "create_manufacturer", {"name": "Farb-Hersteller 2"}))
    result = await _call(client, admin_key, "create_filament", {
        "manufacturer_id": manufacturer["id"], "designation": "PLA Blau", "material_type": "PLA",
        "diameter_mm": 1.75, "color_mode": "single", "colors": [{"color_id": color["id"], "position": 1}],
    })
    assert result["isError"] is False, result
    filament = _json(result)
    detail = _json(await _call(client, admin_key, "get_filament", {"filament_id": filament["id"]}))
    assert detail["color_mode"] == "single"
    assert [c["color_id"] for c in detail["colors"]] == [color["id"]]


@pytest.mark.asyncio
async def test_filamentdb_search_tools(client, db_session, admin_key, monkeypatch):
    from app.api.v1 import filamentdb_proxy

    calls = []

    async def fake_proxy_get(path, params=None, *, client=None):
        calls.append((path, params))
        return {"items": [{"id": 1, "designation": "PLA Rot"}], "total": 1, "page": 1, "page_size": 20}

    monkeypatch.setattr(filamentdb_proxy, "_proxy_get", fake_proxy_get)
    await _set_flags(db_session, enabled=True, write=False)
    result = await _call(client, admin_key, "search_filamentdb_filaments", {"search": "PLA", "material_key": "pla"})
    assert result["isError"] is False, result
    assert _json(result)["items"][0]["designation"] == "PLA Rot"
    assert calls[0][0] == "/filaments" and calls[0][1]["material_key"] == "pla"

    result = await _call(client, admin_key, "list_filamentdb_manufacturers", {"search": "Prusa"})
    assert result["isError"] is False, result
    assert calls[-1][0] == "/manufacturers"


@pytest.mark.asyncio
async def test_import_filamentdb_filament(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    result = await _call(client, admin_key, "import_filamentdb_filament", {
        "manufacturer_name": "Katalog GmbH", "designation": "Silk Duo", "material_name": "pla",
        "diameter_mm": 1.75, "nominal_weight_g": 1000, "price": 19.9,
        "color_mode": "multi", "multi_color_style": "gradient",
        "colors": [{"hex_code": "#FF0000", "color_name": "Rot", "position": 1},
                   {"hex_code": "#00FF00", "color_name": "Gruen", "position": 2}],
    })
    assert result["isError"] is False, result
    imported = _json(result)
    assert imported["manufacturer_created"] is True and imported["colors_created"] == 2
    filament = imported["filament"]
    detail = _json(await _call(client, admin_key, "get_filament", {"filament_id": filament["id"]}))
    assert detail["designation"] == "Silk Duo" and detail["material_type"] == "PLA"
    assert detail["color_mode"] == "multi" and len(detail["colors"]) == 2
    assert detail["manufacturer"]["name"] == "Katalog GmbH"


@pytest.mark.asyncio
async def test_bulk_spools_adjustment_and_events(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    _, filament = await _make_filament(client, admin_key, tag="bulk")
    result = await _call(client, admin_key, "create_spools_bulk", {
        "filament_id": filament["id"], "quantity": 3, "initial_total_weight_g": 1200,
        "empty_spool_weight_g": 200, "remaining_weight_g": 1000,
    })
    assert result["isError"] is False, result
    spools = _json(result)
    assert len(spools) == 3

    spool_id = spools[0]["id"]
    result = await _call(client, admin_key, "record_spool_adjustment", {
        "spool_id": spool_id, "adjustment_type": "relative", "delta_weight_g": -100, "note": "Korrektur",
    })
    assert result["isError"] is False, result
    spool = _json(await _call(client, admin_key, "get_spool", {"spool_id": spool_id}))
    assert spool["remaining_weight_g"] == 900

    events = _json(await _call(client, admin_key, "get_spool_events", {"spool_id": spool_id, "page_size": 10}))
    assert any(e["event_type"] == "manual_adjust" for e in events["items"])

    bad = await _call(client, admin_key, "record_spool_adjustment", {
        "spool_id": spool_id, "adjustment_type": "relative",
    })
    assert bad["isError"] is True


@pytest.mark.asyncio
async def test_update_location_and_manufacturer(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    location = _json(await _call(client, admin_key, "create_location", {"name": "Alt"}))
    result = await _call(client, admin_key, "update_location", {
        "location_id": location["id"], "fields": {"name": "Neu", "identifier": "R1"},
    })
    assert result["isError"] is False, result
    assert _json(result)["name"] == "Neu" and _json(result)["identifier"] == "R1"

    manufacturer = _json(await _call(client, admin_key, "create_manufacturer", {"name": "Alt GmbH"}))
    result = await _call(client, admin_key, "update_manufacturer", {
        "manufacturer_id": manufacturer["id"], "fields": {"name": "Neu GmbH", "empty_spool_weight_g": 220},
    })
    assert result["isError"] is False, result
    assert _json(result)["name"] == "Neu GmbH"

    for name, args in (
        ("update_location", {"location_id": location["id"], "fields": {"custom_fields": {}}}),
        ("update_manufacturer", {"manufacturer_id": manufacturer["id"], "fields": {"logo_file": "x"}}),
    ):
        bad = await _call(client, admin_key, name, args)
        assert bad["isError"] is True and "Unknown field" in bad["content"][0]["text"]


@pytest.mark.asyncio
async def test_request_label_print(client, db_session, admin_key):
    await _set_flags(db_session, enabled=True, write=True)
    _, filament = await _make_filament(client, admin_key, tag="label")
    spool = _json(await _call(client, admin_key, "create_spool", {"filament_id": filament["id"]}))

    result = await _call(client, admin_key, "request_spool_label_print", {"spool_id": spool["id"]})
    assert result["isError"] is False, result
    assert _json(result)["spool_id"] == spool["id"]

    result = await _call(client, admin_key, "request_filament_label_print", {"filament_id": filament["id"]})
    assert result["isError"] is False, result
    assert _json(result)["filament_id"] == filament["id"]
