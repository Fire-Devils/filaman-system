"""Opt-in read tools from installed integration plugins."""

import inspect
import json
import logging
import re
from asyncio import timeout
from collections.abc import Awaitable, Callable
from copy import deepcopy
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ensure_any_permission
from app.core import database
from app.core.config import settings
from app.core.security import Principal
from app.models import InstalledPlugin, Permission

logger = logging.getLogger(__name__)


class PluginReadTool(BaseModel):
    description: str
    permission: str
    arguments: type[BaseModel]
    handler: Callable[[BaseModel, AsyncSession, Principal], Awaitable[Any]]


class InvalidPluginToolArguments(ValueError):
    pass


def _archive_identity(path: Path) -> tuple[int, int, int] | None:
    try:
        info = path.stat()
    except OSError:
        return None
    return info.st_dev, info.st_ino, info.st_mtime_ns


def load_plugin_read_tools(plugin_key, manifest, module, archive: Path):
    """Read declarations only from the module the integration loader mounted."""
    if manifest["plugin_type"] != "integration":
        return {}
    declarations = vars(module).get("mcp_read_tools")
    if declarations is None:
        return {}
    version = manifest.get("version")
    if not isinstance(declarations, dict) or not isinstance(version, str):
        logger.warning("Invalid MCP tool declarations for plugin %s", plugin_key)
        return {}
    tools = {}
    identity = _archive_identity(archive)
    if identity is None:
        return tools
    for suffix, declaration in declarations.items():
        if not isinstance(suffix, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", suffix):
            logger.warning("Invalid MCP tool name for plugin %s", plugin_key)
            continue
        try:
            tool = PluginReadTool.model_validate(declaration, extra="forbid")
            if not tool.permission.endswith(":read") or not inspect.iscoroutinefunction(tool.handler):
                raise ValueError("Expected a read permission and an async handler")
            schema = tool.arguments.model_json_schema()
            if (tool.arguments.model_config.get("extra") != "forbid"
                    or schema.get("type") != "object" or schema.get("additionalProperties") is not False):
                raise ValueError("Expected an arguments model that forbids unknown fields")
            name = f"{plugin_key}-{suffix}"
            descriptor = {
                "name": name,
                "description": tool.description,
                "inputSchema": schema,
                "annotations": {"readOnlyHint": True, "openWorldHint": True},
            }
            json.dumps(descriptor, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except Exception:  # Optional MCP metadata must not prevent HTTP routes from mounting.
            logger.warning("Invalid MCP tool %s for plugin %s", suffix, plugin_key, exc_info=True)
            continue
        tools[name] = (version, archive, identity, tool, descriptor)
    return tools


async def available_plugin_read_tools(request: Request, db: AsyncSession, name: str | None = None):
    allowlist = {entry.strip() for entry in settings.mcp_plugin_read_tools.split(",") if entry.strip()}
    if name is not None:
        allowlist.intersection_update({name})
    if not allowlist:
        return {}
    registered = getattr(request.app.state, "plugin_mcp_tools", {})
    candidates = {
        tool_name: (key, version, archive, identity, tool, descriptor)
        for key, tools in registered.items()
        for tool_name, (version, archive, identity, tool, descriptor) in tools.items()
        if tool_name in allowlist
    }
    if not candidates:
        return {}

    installed = dict((await db.execute(
        select(InstalledPlugin.plugin_key, InstalledPlugin.version).where(
            InstalledPlugin.plugin_key.in_({entry[0] for entry in candidates.values()}),
            InstalledPlugin.plugin_type == "integration",
            InstalledPlugin.is_active.is_(True),
        )
    )).all())
    candidates = {
        name: (archive, identity, tool, descriptor)
        for name, (key, version, archive, identity, tool, descriptor) in candidates.items()
        if installed.get(key) == version
    }
    if not candidates:
        return {}
    permissions = set(await db.scalars(select(Permission.key).where(
        Permission.key.in_({tool.permission for _, _, tool, _ in candidates.values()}),
    )))
    if not permissions:
        return {}
    try:
        allowed = await ensure_any_permission(db, request.state.principal, *permissions)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        return {}
    # The installer replaces the directory even when the version is unchanged.
    return {
        name: (tool, descriptor)
        for name, (archive, identity, tool, descriptor) in sorted(candidates.items())
        if tool.permission in allowed and _archive_identity(archive) == identity
    }


async def call_plugin_read_tool(request: Request, name: str, arguments: dict):
    async with database.async_session_maker() as db:
        tools = await available_plugin_read_tools(request, db, name)
    if name not in tools:
        raise HTTPException(404, "Unknown tool")
    tool, _ = tools[name]
    try:
        args = tool.arguments.model_validate(arguments)
    except ValidationError as exc:
        raise InvalidPluginToolArguments from exc
    async with timeout(60), database.async_session_maker() as db:
        return await tool.handler(args, db, deepcopy(request.state.principal))
