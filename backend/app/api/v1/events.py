"""SSE stream endpoint — pushes real-time events to connected frontends."""

import anyio
from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import StreamingResponse
from starlette.types import Send

from app.core.event_bus import event_bus

router = APIRouter(prefix="/events", tags=["Events"])



class EventStreamResponse(StreamingResponse):
    async def stream_response(self, send: Send) -> None:
        # A send can fail while the generator is suspended at a yielded frame.
        try:
            await super().stream_response(send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


@router.get("/stream")
async def event_stream(request: Request) -> StreamingResponse:
    """Server-Sent Events endpoint.

    Frontend connects via EventSource('/api/v1/events/stream').
    Receives JSON events like: {"event": "slots_update", "printer_id": 1}
    """

    async def generate():
        async with event_bus.subscribe() as subscription:
            yield ": connected\n\n"
            async for data in subscription:
                if await request.is_disconnected():
                    break
                yield f"data: {data}\n\n"

    return EventStreamResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )
