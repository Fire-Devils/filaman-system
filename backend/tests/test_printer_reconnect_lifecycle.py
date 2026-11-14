import asyncio
from contextlib import asynccontextmanager

import pytest
from app.core.shared_health import SharedStateStore
from app.models import InstalledPlugin, Printer
from app.plugins import manager as manager_module
from app.plugins.base import BaseDriver


@pytest.fixture(autouse=True)
def use_test_session(db_session, monkeypatch):
    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(manager_module, "async_session_maker", session)


async def test_reconnect_settles_before_concurrent_stop(db_session, tmp_path, monkeypatch):
    printer = Printer(name="Fixture", driver_key="fixture", is_active=True)
    db_session.add(printer)
    await db_session.flush()
    reconnecting, release = asyncio.Event(), asyncio.Event()

    class Driver(BaseDriver):
        driver_key = "fixture"

        async def start(self):
            self._running = True

        async def stop(self):
            if not reconnecting.is_set():
                reconnecting.set()
                await release.wait()
            self._running = False

    driver = Driver(printer.id, {}, lambda _event: None)
    await driver.start()
    manager = manager_module.PluginManager()
    manager.drivers[printer.id] = driver
    monkeypatch.setattr(manager_module, "shared_health_store", SharedStateStore(lambda: tmp_path / "health.json"))
    reconnect = asyncio.create_task(manager.reconnect_all())
    stop = None
    try:
        await asyncio.wait_for(reconnecting.wait(), 1)
        stop = asyncio.create_task(manager.stop_printer(printer.id))
        await asyncio.sleep(0)
    finally:
        release.set()
        result = await reconnect
        if stop is not None:
            await stop

    assert result == {printer.id: "reconnected"}
    assert not driver.health()["running"]
    assert printer.id not in manager.drivers


async def test_reconnect_timeout_does_not_skip_healthy_printer(db_session, tmp_path, monkeypatch):
    first = Printer(name="Unresponsive", driver_key="fixture", is_active=True)
    second = Printer(name="Healthy", driver_key="fixture", is_active=True)
    db_session.add_all([first, second])
    await db_session.flush()
    manager = manager_module.PluginManager()
    release = asyncio.Event()

    class Driver:
        async def reconnect(self):
            pass

        def health(self):
            return {"connected": True}

    class SlowDriver(Driver):
        async def reconnect(self):
            await release.wait()

    manager.drivers.update({first.id: SlowDriver(), second.id: Driver()})
    health = SharedStateStore(lambda: tmp_path / "health.json")
    monkeypatch.setattr(manager_module, "shared_health_store", health)
    monkeypatch.setattr(manager_module, "_DRIVER_RECONNECT_TIMEOUT", 0.01, raising=False)
    reconnect = asyncio.create_task(manager.reconnect_all())
    try:
        done, _ = await asyncio.wait({reconnect}, timeout=0.25)
        assert reconnect in done
        result = reconnect.result()
        assert result[first.id] == "error: reconnect timed out"
        assert result[second.id] == "reconnected"
        assert health.read(second.id) == {"connected": True}
    finally:
        release.set()
        await reconnect


async def test_reconnect_skips_plugin_disabled_after_check_started(db_session, tmp_path, monkeypatch):
    first = Printer(name="First", driver_key="fixture_a", is_active=True)
    second = Printer(name="Second", driver_key="fixture_b", is_active=True)
    plugin = InstalledPlugin(
        plugin_key="fixture_b", name="Fixture B", version="1.0", author="Test", description="Test",
        plugin_type="driver", driver_key="fixture_b", is_active=True,
    )
    db_session.add_all([first, second, plugin])
    await db_session.flush()
    manager = manager_module.PluginManager()
    refreshing, release = asyncio.Event(), asyncio.Event()
    started = []

    class Driver:
        async def reconnect(self):
            refreshing.set()
            await release.wait()

        def health(self):
            return {"connected": True}

    async def start(printer):
        started.append(printer.id)
        return True

    manager.drivers[first.id] = Driver()
    monkeypatch.setattr(manager, "_start_printer", start)
    monkeypatch.setattr(manager_module, "shared_health_store", SharedStateStore(lambda: tmp_path / "health.json"))
    reconnect = asyncio.create_task(manager.reconnect_all())
    try:
        await asyncio.wait_for(refreshing.wait(), 1)
        plugin.is_active = False
        await db_session.flush()
    finally:
        release.set()
        results = await reconnect

    assert results == {first.id: "reconnected"}
    assert not started
