"""SSE Event Bus — broadcasts events to connected frontend clients.

Usage:
    from app.core.event_bus import event_bus

    # Publish (from anywhere, e.g. PluginManager after DB commit):
    await event_bus.publish({"event": "slots_update", "printer_id": 1})

    # Subscribe (SSE endpoint):
    async with event_bus.subscribe() as events:
        async for data in events:
            yield f"data: {data}\\n\\n"
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from app.core.cache import response_cache
from app.core.worker_reload import worker_is_draining

logger = logging.getLogger(__name__)


class EventBus:
    """Simple in-process pub/sub using asyncio.Queue per subscriber."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    async def publish(self, event: dict[str, Any]) -> None:
        """Broadcast event to all connected SSE clients."""
        event_name = event.get("event")
        if event_name in {"filaments_changed", "manufacturers_changed", "colors_changed"}:
            response_cache.delete("filter_options:filaments")
            response_cache.delete("filter_options:spools")
        elif event_name in {"spools_changed", "locations_changed", "statuses_changed"}:
            response_cache.delete("filter_options:spools")
            if event_name == "spools_changed":
                response_cache.delete("filter_options:filaments")

        if worker_is_draining():
            return

        data = json.dumps(event)
        dead: list[asyncio.Queue[str]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(queue)
        # Drop full queues so slow clients cannot delay publishers or each other.
        for q in dead:
            self._subscribers.remove(q)
            logger.warning("Dropped slow SSE subscriber")

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[AsyncIterator[str]]:
        """Register a subscriber before it advertises that it is connected."""
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=64)

        async def messages() -> AsyncIterator[str]:
            while queue in self._subscribers:
                if worker_is_draining():
                    while not queue.empty():
                        yield queue.get_nowait()
                    return
                try:
                    # An idle subscription must wake up so Uvicorn can drain it.
                    async with asyncio.timeout(0.25):
                        data = await queue.get()
                except TimeoutError:
                    continue
                yield data

        # The response can yield its connected frame as soon as this queue is registered.
        self._subscribers.add(queue)
        try:
            yield messages()
        finally:
            self._subscribers.discard(queue)


event_bus = EventBus()
