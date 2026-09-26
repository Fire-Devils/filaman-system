"""Temporary exports belong to the complete response lifecycle."""

import asyncio
from pathlib import Path

import pytest
from app.api.v1 import system
from app.core.security import Principal


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["export_backup", "export_inventory_backup"])
@pytest.mark.parametrize(
    "range_header, status",
    [(None, 200), (b"bytes=0-9", 206), (b"invalid", 400), (b"bytes=999999999999-", 416)],
)
async def test_export_removes_file_after_success_or_rejected_range(
    db_session, tmp_path, monkeypatch, endpoint, range_header, status
):
    monkeypatch.setattr(system, "_temporary_backup_path", lambda: tmp_path / "backup.jsonl")
    response = await getattr(system, endpoint)(
        db_session, Principal(auth_type="session", user_id=1, is_superadmin=True)
    )
    path = Path(response.path)
    expected = path.read_bytes()
    messages = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    await response(
        {
            "type": "http",
            "method": "GET",
            "headers": [(b"range", range_header)] if range_header else [],
        },
        receive,
        send,
    )

    assert messages[0]["status"] == status
    body = b"".join(message.get("body", b"") for message in messages)
    if status == 200:
        assert body == expected
    elif status == 206:
        assert body == expected[:10]
    assert not path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["export_backup", "export_inventory_backup"])
@pytest.mark.parametrize("failure", [OSError, asyncio.CancelledError])
async def test_export_removes_file_when_sending_fails_or_is_cancelled(
    db_session, tmp_path, monkeypatch, endpoint, failure
):
    monkeypatch.setattr(system, "_temporary_backup_path", lambda: tmp_path / "backup.jsonl")
    response = await getattr(system, endpoint)(
        db_session, Principal(auth_type="session", user_id=1, is_superadmin=True)
    )
    path = Path(response.path)
    assert path.is_file()

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            raise failure("download interrupted")

    with pytest.raises(failure, match="download interrupted"):
        await response({"type": "http", "method": "GET", "headers": []}, receive, send)

    assert not path.exists()
