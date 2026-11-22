"""Real workers must share notices, including readers without SSE clients."""
import asyncio
import json
import multiprocessing
from pathlib import Path
from socket import socket

import pytest

from app.core import primary_socket, worker_reload
from app.core.event_bus import EventBus


def _worker(directory, barrier, results, producer, draining):
    primary_socket._runtime_dir = Path(directory)

    async def run():
        bus = EventBus()
        async with bus.run():
            if producer is None:
                await asyncio.to_thread(barrier.wait, 5)
                async with asyncio.timeout(5):
                    while bus._cursor < 4:
                        await asyncio.sleep(0.01)
                results.put((producer, "observed"))
                return
            async with bus.subscribe() as messages:
                listener = socket()
                if draining:
                    worker_reload._worker_listeners = (listener,)
                    listener.close()
                try:
                    await asyncio.to_thread(barrier.wait, 5)
                    for index in range(2):
                        await bus.publish({"event": "filaments_changed", "producer": producer, "index": index})
                    received = []
                    if not draining:
                        async with asyncio.timeout(5):
                            for _ in range(4):
                                received.append(json.loads(await anext(messages)))
                        try:
                            await asyncio.wait_for(anext(messages), 0.35)
                        except TimeoutError:
                            pass
                        else:
                            raise AssertionError("Unexpected replay after all notices were consumed")
                    else:
                        try:
                            await anext(messages)
                        except StopAsyncIteration:
                            pass
                        else:
                            raise AssertionError("Draining worker delivered a new notice")
                    results.put((producer, received))
                finally:
                    listener.close()
    try:
        asyncio.run(run())
    except BaseException as error:
        results.put((producer, repr(error)))
        raise


@pytest.mark.parametrize("draining", [False, True])
def test_workers_deliver_overlapping_committed_notices_once_and_in_order(tmp_path, draining):
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    context = multiprocessing.get_context("spawn")
    barrier, results = context.Barrier(4), context.Queue()
    processes = [context.Process(target=_worker, args=(str(directory), barrier, results, producer, draining and producer == 0))
                 for producer in (0, 1, None)]
    try:
        for process in processes:
            process.start()
        barrier.wait(10)
        received = dict(results.get(timeout=10) for _ in processes)
        assert received[None] == "observed"
        healthy = received[1]
        assert isinstance(healthy, list) and len(healthy) == 4, healthy
        assert {(event["producer"], event["index"]) for event in healthy} == {(p, i) for p in (0, 1) for i in (0, 1)}
        assert received[0] == ([] if draining else healthy)
        for producer in (0, 1):
            assert [event["index"] for event in healthy if event["producer"] == producer] == [0, 1]
        for process in processes:
            process.join(5)
            assert process.exitcode == 0
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
            process.join(5)
        results.close()


async def test_retention_gap_requests_one_resync(tmp_path, monkeypatch):
    from app.core.event_journal import EventJournal

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    bus = EventBus()
    async with bus.run(), bus.subscribe() as messages:
        journal = EventJournal()
        async with bus._exchange_lock:
            for index in range(70):
                await journal.exchange({"event": "slots_update", "printer_id": index})
        assert json.loads(await asyncio.wait_for(anext(messages), 2)) == {"event": "resync"}
        await bus.publish({"event": "after-gap"})
        assert json.loads(await asyncio.wait_for(anext(messages), 2)) == {"event": "after-gap"}


async def test_journal_rejects_untrusted_runtime_directory(tmp_path, monkeypatch):
    directory = tmp_path / "public"
    directory.mkdir(mode=0o755)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    with pytest.raises(PermissionError):
        async with EventBus().run():
            pytest.fail("Untrusted runtime directory must not be used")


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
async def test_active_journal_reset_resyncs_both_workers(tmp_path, monkeypatch, damage):
    from app.core.event_journal import EventJournal

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    first, second = EventBus(), EventBus()
    async with first.run(), second.run(), first.subscribe() as local, second.subscribe() as peer:
        await first.publish({"event": "before"})
        assert json.loads(await anext(local)) == {"event": "before"}
        assert json.loads(await asyncio.wait_for(anext(peer), 2)) == {"event": "before"}
        path = EventJournal().path
        if damage == "missing":
            path.unlink()
        else:
            path.write_text("broken JSON")
        await first.publish({"event": "filaments_changed"})
        assert json.loads(await asyncio.wait_for(anext(local), 2)) == {"event": "resync"}
        assert json.loads(await asyncio.wait_for(anext(peer), 2)) == {"event": "resync"}
        await first.publish({"event": "after"})
        for messages in (local, peer):
            notice = json.loads(await asyncio.wait_for(anext(messages), 2))
            # A poll may observe the reset before the committed notice is appended.
            if notice == {"event": "filaments_changed"}:
                notice = json.loads(await asyncio.wait_for(anext(messages), 2))
            assert notice == {"event": "after"}


async def test_cancelled_committed_publish_settles_before_cancellation(tmp_path, monkeypatch):
    from app.core.event_journal import EventJournal

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    bus = EventBus()
    async with bus.run():
        async with bus._exchange_lock:
            pending = asyncio.create_task(bus.publish({"event": "committed"}))
            await asyncio.sleep(0)
            pending.cancel()
            await asyncio.sleep(0)
            assert not pending.done()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert 'committed' in EventJournal().path.read_text()


async def test_active_journal_refuses_replaced_public_directory(tmp_path, monkeypatch):
    from app.core.event_journal import EventJournal

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    journal = EventJournal()
    directory.rename(tmp_path / "old-private")
    directory.mkdir(mode=0o755)
    with pytest.raises(PermissionError):
        await journal.exchange({"event": "private"})
    assert not journal.path.exists()


@pytest.mark.parametrize("malformed", ["broken JSON", {"generation": "old", "records": [[1, {"event": []}]]}, {"generation": "old", "records": [[1, {"event": "first"}], [3, {"event": "gap"}]]}])
async def test_malformed_journal_at_startup_recovers_and_keeps_serving(tmp_path, monkeypatch, malformed):
    from app.core.event_journal import EventJournal

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    EventJournal().path.write_text(malformed if isinstance(malformed, str) else json.dumps(malformed))
    bus = EventBus()
    async with bus.run(), bus.subscribe() as messages:
        await bus.publish({"event": "recovered"})
        assert json.loads(await asyncio.wait_for(anext(messages), 2)) == {"event": "recovered"}


async def test_contended_publishers_share_one_bounded_wait_and_keep_local_delivery(tmp_path, monkeypatch, caplog):
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    bus = EventBus()
    async with bus.run(), bus.subscribe() as messages:
        async with bus._exchange_lock:
            async with asyncio.timeout(6):
                await asyncio.gather(*(bus.publish({"event": "filaments_changed", "index": index}) for index in range(3)))
        assert caplog.text.count("Could not share event notice") == 3
        assert [json.loads(await anext(messages))["index"] for _ in range(3)] == [0, 1, 2]


async def test_secondary_worker_lifespan_reads_notices_without_sse_clients(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from app import main

    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    monkeypatch.setenv("RUN_MIGRATIONS_IN_APP", "false")
    monkeypatch.setattr(main, "MANUFACTURER_LOGO_DIR", tmp_path / "logos")
    monkeypatch.setattr(main, "_try_primary_lock", lambda: False)
    monkeypatch.setattr(main, "_is_primary", False)
    monkeypatch.setattr(main, "_driver_watchdog", AsyncMock())
    monkeypatch.setattr(main, "_display_snapshot_loop", AsyncMock())
    async with main.lifespan(main.app):
        from app.core.event_journal import EventJournal
        await EventJournal().exchange({"event": "filaments_changed"})
        async with asyncio.timeout(2):
            while main.event_bus._cursor < 1:
                await asyncio.sleep(0.01)
        assert not main.event_bus._subscribers
    assert main.event_bus._journal is None
