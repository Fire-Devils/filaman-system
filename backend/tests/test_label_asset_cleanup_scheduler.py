import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from socket import socket
from unittest.mock import AsyncMock, Mock

import pytest

from app import main
from app.core import worker_reload
from app.services import label_asset_service


@pytest.mark.asyncio
async def test_stale_label_asset_cleanup_runs_at_most_daily(monkeypatch):
    class Session:
        commit = AsyncMock()

    session = Session()

    class SessionContext:
        async def __aenter__(self):
            return session

        async def __aexit__(self, *_args):
            return None

    cleanup = AsyncMock(return_value=2)
    monkeypatch.setattr(main, "async_session_maker", SessionContext)
    monkeypatch.setattr(label_asset_service, "cleanup_orphaned_label_assets", cleanup)
    monkeypatch.setattr(main.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(main, "_next_label_asset_cleanup", 0.0)

    await main._cleanup_stale_label_assets()
    await main._cleanup_stale_label_assets()

    cleanup.assert_awaited_once_with(session)
    session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_cleanup_waits_until_the_next_daily_window(monkeypatch):
    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_args):
            return None

    cleanup = AsyncMock(side_effect=RuntimeError("database unavailable"))
    monkeypatch.setattr(main, "async_session_maker", SessionContext)
    monkeypatch.setattr(label_asset_service, "cleanup_orphaned_label_assets", cleanup)
    monkeypatch.setattr(main.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(main, "_next_label_asset_cleanup", 0.0)

    with pytest.raises(RuntimeError, match="database unavailable"):
        await main._cleanup_stale_label_assets()
    await main._cleanup_stale_label_assets()

    cleanup.assert_awaited_once()


@pytest.mark.asyncio
async def test_cleanup_failure_does_not_skip_driver_health_check(monkeypatch):
    sleeps = 0

    async def stop_after_one_cycle(_seconds):
        nonlocal sleeps
        sleeps += 1
        if sleeps > 1:
            raise asyncio.CancelledError

    cleanup = AsyncMock(side_effect=RuntimeError("database unavailable"))
    health_check = AsyncMock()
    monkeypatch.setattr(main, "_is_primary", True)
    monkeypatch.setattr(main, "_cleanup_stale_label_assets", cleanup)
    monkeypatch.setattr(main, "_watchdog_health_check", health_check)
    monkeypatch.setattr(main.asyncio, "sleep", stop_after_one_cycle)

    with pytest.raises(asyncio.CancelledError):
        await main._driver_watchdog()

    cleanup.assert_awaited_once()
    health_check.assert_awaited_once()


@pytest.mark.asyncio
async def test_standby_checks_for_takeover_before_sleeping(monkeypatch):
    takeover = AsyncMock()
    sleep = AsyncMock(side_effect=asyncio.CancelledError)
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main, "_watchdog_try_takeover", takeover)
    monkeypatch.setattr(main.asyncio, "sleep", sleep)

    with pytest.raises(asyncio.CancelledError):
        await main._driver_watchdog()

    takeover.assert_awaited_once()
    sleep.assert_awaited_once_with(1)


async def test_draining_standby_leaves_takeover_to_serving_workers(tmp_path, monkeypatch):
    startup_lock = tmp_path / "startup.lock"
    start_drivers = AsyncMock()
    monkeypatch.setattr(main, "_STARTUP_LOCK_PATH", startup_lock)
    monkeypatch.setattr(main, "_start_primary_drivers", start_drivers)
    with socket() as listener:
        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        assert not worker_reload.worker_is_draining()

    await main._watchdog_try_takeover()

    assert not startup_lock.exists()
    start_drivers.assert_not_awaited()


@pytest.mark.parametrize("drain_during", ["drivers", "socket"])
async def test_takeover_rolls_back_when_public_drain_starts(tmp_path, monkeypatch, drain_during):
    startup_lock = tmp_path / "startup.lock"
    stop_drivers = AsyncMock()
    close_private_socket = Mock()
    publish_private_socket = Mock()
    monkeypatch.setattr(main, "_STARTUP_LOCK_PATH", startup_lock)
    monkeypatch.setattr(main, "_lock_fd", None)
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main.plugin_manager, "stop_all", stop_drivers)

    with socket() as listener, startup_lock.open("a") as next_worker:
        async def start_drivers():
            if drain_during == "drivers":
                listener.close()

        @asynccontextmanager
        async def private_socket(_app):
            assert not main._is_primary
            if drain_during == "socket":
                listener.close()
            try:
                yield publish_private_socket
            finally:
                close_private_socket()

        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        monkeypatch.setattr(main.plugin_manager, "start_all", start_drivers)
        monkeypatch.setattr(main, "serve_primary_socket", private_socket)
        async with AsyncExitStack() as listeners:
            monkeypatch.setattr(main, "_primary_socket", listeners)
            await main._watchdog_try_takeover()

            assert not main._is_primary
            assert main._lock_fd is None
            main.fcntl.flock(next_worker, main.fcntl.LOCK_EX | main.fcntl.LOCK_NB)
            stop_drivers.assert_awaited_once()
            publish_private_socket.assert_not_called()
            assert close_private_socket.call_count == (drain_during == "socket")


async def test_cancelled_takeover_holds_election_lock_until_drivers_stop(tmp_path, monkeypatch):
    startup_lock = tmp_path / "startup.lock"
    stopping, stopped = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(main, "_STARTUP_LOCK_PATH", startup_lock)
    monkeypatch.setattr(main, "_lock_fd", None)
    monkeypatch.setattr(main, "_is_primary", False)

    async def stop_drivers():
        stopping.set()
        await stopped.wait()

    with socket() as listener, startup_lock.open("a") as next_worker:
        async def start_drivers():
            listener.close()

        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        monkeypatch.setattr(main.plugin_manager, "start_all", start_drivers)
        monkeypatch.setattr(main.plugin_manager, "stop_all", stop_drivers)
        takeover = asyncio.create_task(main._watchdog_try_takeover())
        await asyncio.wait_for(stopping.wait(), 2)
        takeover.cancel()
        try:
            await asyncio.sleep(0)
            with pytest.raises(BlockingIOError):
                main.fcntl.flock(next_worker, main.fcntl.LOCK_EX | main.fcntl.LOCK_NB)
        finally:
            stopped.set()
            with suppress(asyncio.CancelledError):
                await takeover

        assert takeover.cancelled()
        main.fcntl.flock(next_worker, main.fcntl.LOCK_EX | main.fcntl.LOCK_NB)


async def test_startup_collects_display_state_before_opening_driver_routes(monkeypatch):
    health = {1: {"connected": True}}
    publish_health = Mock()

    def get_display_state():
        publish_health.assert_called_once_with(health)
        return {}

    display_state = AsyncMock(side_effect=get_display_state)
    published = Mock()
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main.plugin_manager, "start_all", AsyncMock())
    monkeypatch.setattr(main.plugin_manager, "get_health", Mock(return_value=health))
    monkeypatch.setattr(main.plugin_manager, "get_display_states", display_state)
    monkeypatch.setattr(main.shared_health_store, "publish", publish_health)

    @asynccontextmanager
    async def private_socket(_app):
        display_state.assert_awaited_once()
        yield published

    monkeypatch.setattr(main, "serve_primary_socket", private_socket)
    async with AsyncExitStack() as listeners:
        monkeypatch.setattr(main, "_primary_socket", listeners)
        await main._start_primary_drivers(main.app, initial=True)

    published.assert_called_once()
