from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

from app.api.v1 import printers
from app.models import InstalledPlugin, Printer
from app.plugins.manager import PluginManager
from fastapi import Request


async def test_reconnect_all_skips_deactivated_plugin_drivers(db_session, monkeypatch):
    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr("app.plugins.manager.async_session_maker", session)
    printer = Printer(name="Fixture printer", driver_key="fixture")
    db_session.add(printer)
    db_session.add(InstalledPlugin(
        plugin_key=printer.driver_key, driver_key=printer.driver_key,
        name="Deactivated driver", version="1.0.0", is_active=False,
    ))
    await db_session.commit()

    manager = PluginManager()
    started = []

    async def start(candidate):
        started.append(candidate.id)
        return True

    monkeypatch.setattr(manager, "_start_printer", start)
    assert await manager.reconnect_all() == {}
    assert started == []


async def test_reconnect_all_uses_the_long_running_command_timeout(monkeypatch):
    proxy = AsyncMock(return_value={"results": {"1": "reconnected"}})
    request = Request({"type": "http", "headers": []})
    monkeypatch.setattr(printers, "_is_primary_worker", lambda: False)
    monkeypatch.setattr(printers, "_proxy_to_primary", proxy)

    assert await printers.reconnect_all_printers(request, None) == {"results": {"1": "reconnected"}}
    proxy.assert_awaited_once_with(
        request, method="POST", path="/api/v1/printers/reconnect-all", timeout=120.0,
    )
