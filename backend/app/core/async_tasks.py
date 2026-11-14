"""Cancellation helpers for work that must settle before ownership changes."""

import asyncio
import logging
import os
from collections.abc import Awaitable

logger = logging.getLogger(__name__)
_DRIVER_CANCEL_GRACE = 5


async def _wait_for_cleanup(task: asyncio.Future, timeout: float | None) -> bool:
    caller = asyncio.current_task()
    assert caller is not None
    initial_cancellations = caller.cancelling()
    loop = asyncio.get_running_loop()
    deadline = None if timeout is None else loop.time() + timeout
    while not task.done():
        remaining = None if deadline is None else deadline - loop.time()
        try:
            done, _ = await asyncio.wait({task}, timeout=remaining)
        except asyncio.CancelledError:
            continue
        if not done:
            # Keep election until process exit so an old driver cannot overlap its replacement.
            logger.critical("Driver cleanup timed out. Exiting worker while it owns election.")
            os._exit(1)
    return caller.cancelling() > initial_cancellations


async def finish_on_cancel(work: Awaitable[object], *, timeout: float | None = None) -> None:
    """Wait for cleanup to settle, then propagate cancellation of the caller."""
    task = asyncio.ensure_future(work)
    if await _wait_for_cleanup(task, timeout):
        _log_cancel_failure(task)
        raise asyncio.CancelledError
    if task.cancelled():
        raise RuntimeError("Cleanup cancelled itself")
    task.result()


def _log_cancel_failure(task: asyncio.Future) -> None:
    if not task.cancelled() and (exc := task.exception()) is not None:
        logger.error("Cleanup failed during cancellation", exc_info=exc)


async def await_driver_startup(work: Awaitable[object], timeout: float) -> object:
    """Bound plugin startup and distinguish child cancellation from worker shutdown."""
    task = asyncio.ensure_future(work)
    try:
        done, _ = await asyncio.wait({task}, timeout=timeout)
    except asyncio.CancelledError:
        task.cancel()
        await _wait_for_cleanup(task, _DRIVER_CANCEL_GRACE)
        _log_cancel_failure(task)
        raise
    if not done:
        task.cancel()
        cancelled = await _wait_for_cleanup(task, _DRIVER_CANCEL_GRACE)
        _log_cancel_failure(task)
        if cancelled:
            raise asyncio.CancelledError
        raise TimeoutError
    if task.cancelled():
        raise RuntimeError("Driver startup cancelled itself")
    return task.result()
