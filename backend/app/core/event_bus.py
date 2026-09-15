"""SSE Event Bus — broadcasts events to connected frontend clients.

Usage:
    from app.core.event_bus import event_bus

    # Publish (from anywhere, e.g. PluginManager after DB commit):
    await event_bus.publish({"event": "slots_update", "printer_id": 1})

    # Subscribe (SSE endpoint):
    async for data in event_bus.subscribe():
        yield f"data: {data}\\n\\n"
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from app.core.cache import response_cache

logger = logging.getLogger(__name__)


class EventBus:
    """Simple in-process pub/sub using asyncio.Queue per subscriber."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[str]] = []

    async def publish(self, event: dict[str, Any]) -> None:
        """Broadcast event to all connected SSE clients."""
        event_name = event.get("event")
        if event_name in {"filaments_changed", "manufacturers_changed"}:
            response_cache.delete("filter_options:filaments")
            response_cache.delete("filter_options:spools")
        elif event_name == "colors_changed":
            response_cache.delete("filter_options:filaments")
        elif event_name in {"spools_changed", "locations_changed", "statuses_changed"}:
            response_cache.delete("filter_options:spools")
            if event_name == "spools_changed":
                response_cache.delete("filter_options:filaments")

        data = json.dumps(event)
        dead: list[asyncio.Queue[str]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(queue)
        # Remove slow consumers
        for q in dead:
            self._subscribers.remove(q)
            logger.warning("Dropped slow SSE subscriber")

    async def subscribe(self) -> AsyncGenerator[str, None]:
        """Yield SSE-formatted messages for one client connection."""
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        self._subscribers.append(queue)
        try:
            while True:
                data = await queue.get()
                yield data
        finally:
            self._subscribers.remove(queue)


event_bus = EventBus()
