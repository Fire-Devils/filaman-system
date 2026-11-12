import json

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.security import generate_token_secret, hash_token
from app.models import AppSettings, Location, UserApiKey


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


@pytest.mark.asyncio
async def test_get_returns_405(client):
    resp = await client.get("/mcp")
    assert resp.status_code == 405
