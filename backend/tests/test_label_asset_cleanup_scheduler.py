import asyncio
from unittest.mock import AsyncMock

import pytest

from app import main
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
