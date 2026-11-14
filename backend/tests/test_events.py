import asyncio
from socket import socket
from unittest.mock import Mock

import pytest
from app.api.v1.events import event_stream
from app.core import worker_reload
from app.core.event_bus import event_bus
from app.core.gunicorn_worker import FilaManWorker
from app.main import app
from fastapi import FastAPI
from starlette.requests import Request
from uvicorn import Config
from uvicorn.server import ServerState


@pytest.mark.asyncio
async def test_idle_event_stream_closes_when_worker_drains(monkeypatch):
    with socket() as listener:
        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        stream = (await event_stream(Request({"type": "http"}))).body_iterator
        try:
            assert await anext(stream) == ": connected\n\n"
            next_message = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            assert not next_message.done()
            listener.close()
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(next_message, timeout=2)
        finally:
            await stream.aclose()
        assert not event_bus._subscribers


async def test_slow_event_subscriber_is_closed_without_affecting_others():
    from app.core.event_bus import EventBus

    bus = EventBus()
    async with bus.subscribe() as slow, bus.subscribe() as fast:
        await bus.publish({"event": "first"})
        assert await anext(slow) == await anext(fast)

        for index in range(65):
            await bus.publish({"event": "update", "index": index})
            assert '"index":' in await anext(fast)

        with pytest.raises(StopAsyncIteration):
            await anext(slow)


async def test_connected_stream_is_already_subscribed():
    async def receive():
        await asyncio.Future()

    request = Request({"type": "http"}, receive)
    stream = (await event_stream(request)).body_iterator
    try:
        assert await anext(stream) == ": connected\n\n"
        await event_bus.publish({"event": "after-connect"})
        assert await asyncio.wait_for(anext(stream), 0.1) == 'data: {"event": "after-connect"}\n\n'
    finally:
        await stream.aclose()


async def test_disconnect_during_connected_frame_unregisters_stream():
    from starlette.requests import ClientDisconnect

    scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
    request = Request(scope)
    response = await event_stream(request)

    async def send(message):
        if message["type"] == "http.response.body":
            assert event_bus._subscribers
            raise OSError("fixture disconnected")

    try:
        with pytest.raises(ClientDisconnect):
            await response(scope, request.receive, send)
        assert not event_bus._subscribers
    finally:
        await response.body_iterator.aclose()


async def test_event_stream_flushes_queued_updates_on_drain(monkeypatch):
    async def receive():
        await asyncio.Future()

    with socket() as listener:
        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        stream = (await event_stream(Request({"type": "http"}, receive))).body_iterator
        try:
            assert await anext(stream) == ": connected\n\n"
            next_message = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            await event_bus.publish({"event": "first"})
            await event_bus.publish({"event": "second"})
            listener.close()

            assert await asyncio.wait_for(next_message, 1) == 'data: {"event": "first"}\n\n'
            assert await anext(stream) == 'data: {"event": "second"}\n\n'
            await event_bus.publish({"event": "after-drain"})
            with pytest.raises(StopAsyncIteration):
                await anext(stream)
        finally:
            await stream.aclose()
        assert not event_bus._subscribers


async def test_worker_drain_aborts_stalled_event_stream_only(monkeypatch):
    server_state = ServerState()
    public_response_paused = asyncio.Event()
    event_aborted = asyncio.Event()
    release_command = asyncio.Event()
    command_started = asyncio.Event()
    commands = FastAPI()

    @commands.post("/fixture-command")
    async def command():
        command_started.set()
        await release_command.wait()
        return {"completed": True}

    async def dispatch(scope, receive, send):
        await (commands if scope["path"] == "/fixture-command" else app)(scope, receive, send)

    config = Config(dispatch, log_config=None, **FilaManWorker.CONFIG_KWARGS)
    config.load()
    event_protocol = config.http_protocol_class(config, server_state, {})
    command_protocol = config.http_protocol_class(config, server_state, {})
    event_transport = Mock(spec=asyncio.Transport, get_extra_info=Mock(return_value=None))
    command_transport = Mock(spec=asyncio.Transport, get_extra_info=Mock(return_value=None))

    def abort_event():
        event_protocol.connection_lost(None)
        event_aborted.set()

    event_transport.abort.side_effect = abort_event

    def write_event(data):
        if b": connected" in data:
            event_protocol.pause_writing()
            public_response_paused.set()

    event_transport.write.side_effect = write_event
    with socket() as listener:
        monkeypatch.setattr(worker_reload, "_worker_listeners", (listener,))
        event_protocol.connection_made(event_transport)
        command_protocol.connection_made(command_transport)
        event_protocol.data_received(b"GET /api/v1/events/stream HTTP/1.1\r\nHost: test\r\n\r\n")
        command_protocol.data_received(b"POST /fixture-command HTTP/1.1\r\nHost: test\r\n\r\n")
        try:
            await asyncio.wait_for(public_response_paused.wait(), 1)
            await asyncio.wait_for(command_started.wait(), 1)
            listener.close()
            event_protocol.shutdown()
            command_protocol.shutdown()

            await asyncio.wait_for(event_aborted.wait(), 2)
            event_transport.abort.assert_called_once_with()
            command_transport.abort.assert_not_called()
            release_command.set()
            await asyncio.wait_for(asyncio.gather(*server_state.tasks), 1)
            assert not event_bus._subscribers
            assert any(b'"completed":true' in call.args[0] for call in command_transport.write.call_args_list)
        finally:
            if event_protocol in server_state.connections:
                event_protocol.connection_lost(None)
            release_command.set()
            await asyncio.gather(*server_state.tasks, return_exceptions=True)
