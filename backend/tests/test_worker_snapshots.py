from app.core.shared_health import SharedStateStore


def test_standby_reads_successor_snapshot_after_primary_cleanup(tmp_path):
    primary, standby, successor = (SharedStateStore(lambda: tmp_path / "snapshot.json") for _ in range(3))
    primary.publish({1: {"connected": True}, 2: {"connected": True}})
    assert standby.read(1) == {"connected": True}
    primary.cleanup()
    assert standby.read(1) is None

    successor.publish({1: {"connected": False}})
    assert standby.read(1) == {"connected": False}
    assert standby.read(2) is None


def test_snapshot_replacement_discards_old_printers(tmp_path):
    store = SharedStateStore(lambda: tmp_path / "snapshot.json")
    store.publish({1: {"connected": True}, 2: {"connected": True}})
    store.publish({1: {"connected": False}})
    assert store.read(2) == {"connected": True}

    store.clear(2)
    assert store.read(2) is None
    store.publish({}, replace=True)
    assert store.read(1) is None


def test_failed_snapshot_replacement_preserves_last_publication(tmp_path, monkeypatch):
    from pathlib import Path

    def fail_replace(*args):
        raise OSError("write failed")

    store = SharedStateStore(lambda: tmp_path / "snapshot.json")
    store.publish({1: {"connected": True}})
    monkeypatch.setattr(Path, "replace", fail_replace)
    store.publish({1: {"connected": False}}, replace=True)

    assert store.read(1) == {"connected": True}
    assert [path.name for path in tmp_path.iterdir()] == ["snapshot.json"]


def test_snapshot_is_readable_until_expiry(tmp_path, monkeypatch):
    from app.core import shared_health

    now = 1_000.0
    monkeypatch.setattr(shared_health.time, "time", lambda: now)
    store = SharedStateStore(lambda: tmp_path / "snapshot.json", stale_seconds=45)
    store.publish({1: {"connected": True}})

    now += 45
    assert store.read(1) == {"connected": True}
    store.publish({2: {"connected": True}})
    now += 1
    assert store.read(1) is None
    assert store.read(2) == {"connected": True}


def test_bad_health_entry_does_not_block_healthy_replacement(tmp_path):
    store = SharedStateStore(lambda: tmp_path / "snapshot.json")
    store.publish({1: {"connected": True}, 2: {"connected": False}})
    store.publish({1: {"invalid": object()}, 2: {"connected": True}}, replace=True)

    assert store.read(1) is None
    assert store.read(2) == {"connected": True}
