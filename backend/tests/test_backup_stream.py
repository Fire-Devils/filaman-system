from io import BytesIO
from pathlib import Path

import pytest
from app.services import backup_stream


def test_record_round_trip_uses_one_physical_line():
    stream = BytesIO()
    record = {"table": "users", "row": {"name": "line 1\nline 2"}}

    backup_stream.write_record(stream, record)

    assert stream.getvalue().count(b"\n") == 1
    stream.seek(0)
    assert backup_stream.read_record(stream) == record
    assert backup_stream.read_record(stream) is None


def test_reader_and_writer_share_the_record_limit(monkeypatch):
    monkeypatch.setattr(backup_stream, "MAX_BACKUP_RECORD_BYTES", 64)
    record = {"table": "users", "row": {"value": "x" * 64}}

    with pytest.raises(backup_stream.BackupStreamError, match="record exceeds"):
        backup_stream.write_record(BytesIO(), record)
    with pytest.raises(backup_stream.BackupStreamError, match="record exceeds"):
        backup_stream.read_record(BytesIO(b"{" + b" " * 64 + b"\n"))


def test_detection_preserves_position_and_recognizes_legacy_json():
    jsonl = BytesIO(
        b'{"format":"filaman-backup","version":1,"kind":"complete","metadata":{}}\n'
    )
    assert backup_stream.detect_backup_format(jsonl) == "jsonl"
    assert jsonl.tell() == 0

    legacy = BytesIO(b'{"metadata":{},"data":{}}')
    assert backup_stream.detect_backup_format(legacy) == "legacy-json"
    assert legacy.tell() == 0


def test_atomic_writer_replaces_only_after_success(tmp_path: Path):
    target = tmp_path / "backup.jsonl"
    target.write_bytes(b"old")

    with (
        pytest.raises(RuntimeError),
        backup_stream.atomic_binary_writer(target) as stream,
    ):
        stream.write(b"partial")
        raise RuntimeError("stop")

    assert target.read_bytes() == b"old"
    assert list(tmp_path.iterdir()) == [target]

    with backup_stream.atomic_binary_writer(target) as stream:
        stream.write(b"complete")
    assert target.read_bytes() == b"complete"
