"""Bound shutdown of dashboard HTTP streams on the public worker listener."""

import asyncio
from typing import Any, ClassVar

from starlette.types import Receive, Scope, Send
from uvicorn.protocols.http.auto import AutoHTTPProtocol
from uvicorn.workers import UvicornWorker


class _EventStreamProtocol(AutoHTTPProtocol):
    _event_stream = False
    _draining = False
    _abort_handle: asyncio.TimerHandle | None = None

    def connection_made(self, transport: asyncio.Transport) -> None:
        super().connection_made(transport)
        app = self.app

        async def track_event_stream(scope: Scope, receive: Receive, send: Send) -> None:
            # The parser's latest scope may belong to a queued pipelined request.
            self._event_stream = (
                scope["method"] == "GET"
                and scope["path"].removeprefix(self.root_path) == "/api/v1/events/stream"
            )
            if self._draining:
                self._schedule_abort()
            await app(scope, receive, send)

        self.app = track_event_stream

    def shutdown(self) -> None:
        super().shutdown()
        self._draining = True
        self._schedule_abort()

    def _schedule_abort(self) -> None:
        if self._event_stream and self._abort_handle is None:
            # A graceful close can wait indefinitely for a peer to read queued bytes.
            self._abort_handle = self.loop.call_later(0.5, self.transport.abort)
        elif not self._event_stream and self._abort_handle is not None:
            self._abort_handle.cancel()
            self._abort_handle = None

    def connection_lost(self, exc: Exception | None) -> None:
        if self._abort_handle is not None:
            self._abort_handle.cancel()
        super().connection_lost(exc)


class FilaManWorker(UvicornWorker):
    CONFIG_KWARGS: ClassVar[dict[str, Any]] = {
        **UvicornWorker.CONFIG_KWARGS,
        "http": _EventStreamProtocol,
    }
