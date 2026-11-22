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

from app.core.async_tasks import finish_on_cancel
from app.core.event_journal import EventJournal
from app.core.worker_reload import worker_is_draining

logger = logging.getLogger(__name__)


class EventBus:
    """Shared worker notices with bounded, process-local SSE subscriber queues."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._journal: EventJournal | None = None
        self._cursor = 0
        self._generation: str | None = None
        self._exchange_lock = asyncio.Lock()

    @asynccontextmanager
    async def run(self) -> AsyncIterator[None]:
        journal = EventJournal()
        try:
            state = await journal.exchange()
            self._generation = state["generation"]
            self._cursor = state["records"][-1][0] if state["records"] else 0
        except OSError as error:
            logger.warning("Could not initialize shared event notices: %s", error)
            self._generation, self._cursor = None, 0
        self._exchange_lock = asyncio.Lock()
        self._journal = journal
        reader = asyncio.create_task(self._poll())
        try:
            yield
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
            self._journal = None

    def _consume(self, state: dict) -> None:
        records = state["records"]
        if state["generation"] != self._generation or (records and records[0][0] > self._cursor + 1):
            self._deliver({"event": "resync"})
        else:
            for sequence, event in records:
                if sequence > self._cursor:
                    self._deliver(event)
        self._generation = state["generation"]
        self._cursor = records[-1][0] if records else 0

    async def _poll(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            async with self._exchange_lock:
                try:
                    self._consume(await self._journal.exchange())
                except (OSError, ValueError) as error:
                    logger.warning("Could not read shared event notices: %s", error)

    async def publish(self, event: dict[str, Any], *following: dict[str, Any]) -> None:
        """Settle a committed mutation's notices together before propagating cancellation."""
        events = (event, *following)
        if any(not isinstance(item.get("event"), str) for item in events):
            logger.warning("Ignored notice with invalid event name")
            return
        if self._journal is None:
            for item in events:
                self._deliver(item)
            return
        await finish_on_cancel(self._share(*events))

    async def _share(self, *events: dict[str, Any]) -> None:
        for event in events:
            try:
                async with asyncio.timeout(5):
                    async with self._exchange_lock:
                        self._consume(await self._journal.exchange(event))
            except (OSError, ValueError) as error:
                logger.warning("Could not share event notice: %r", error)
                self._deliver(event)

    def _deliver(self, event: dict[str, Any]) -> None:
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
