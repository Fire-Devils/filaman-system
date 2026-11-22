"""Bounded notices shared by workers in one private application runtime."""

import asyncio
import json
import logging
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from uuid import uuid4

from app.core import primary_socket
from app.core.file_lock import FileLockBusy, exclusive_file_lock

logger = logging.getLogger(__name__)


class EventJournal:
    def __init__(self) -> None:
        self.path = self._private_path()

    @staticmethod
    def _private_path() -> Path:
        primary_socket._runtime_dir.mkdir(mode=0o700, exist_ok=True)
        return primary_socket.primary_socket_path().with_suffix(".events.json")

    def _exchange(self, event: dict[str, Any] | None) -> dict:
        self._private_path()
        with exclusive_file_lock(self.path.with_suffix(".lock")):
            reset = False
            try:
                state = json.loads(self.path.read_text())
                if not isinstance(state, dict) or not isinstance(state.get("generation"), str) or not state["generation"]:
                    raise ValueError("Invalid event journal generation")
                records = state.get("records")
                if not isinstance(records, list) or len(records) > 64:
                    raise ValueError("Invalid event journal records")
                previous = 0
                for record in records:
                    if (
                        not isinstance(record, list) or len(record) != 2
                        or not isinstance(record[0], int) or record[0] <= previous
                        or (previous and record[0] != previous + 1)
                        or not isinstance(record[1], dict) or not isinstance(record[1].get("event"), str)
                    ):
                        raise ValueError("Invalid event journal record")
                    previous = record[0]
            except (FileNotFoundError, ValueError) as error:
                if not isinstance(error, FileNotFoundError):
                    logger.warning("Resetting malformed event journal: %s", error)
                state = {"generation": uuid4().hex, "records": []}
                records = state["records"]
                previous, reset = 0, True
            if event is not None:
                if not isinstance(event.get("event"), str):
                    raise ValueError("Invalid event name")
                records.append([previous + 1, event])
                state["records"] = records[-64:]
            if reset or event is not None:
                temporary = None
                try:
                    with NamedTemporaryFile(mode="w", dir=self.path.parent, encoding="utf-8", delete=False) as stream:
                        temporary = Path(stream.name)
                        json.dump(state, stream)
                    temporary.replace(self.path)
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
            return state

    async def exchange(self, event: dict[str, Any] | None = None) -> dict:
        deadline = asyncio.get_running_loop().time() + 5
        while True:
            try:
                return await asyncio.to_thread(self._exchange, event)
            except FileLockBusy:
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError("Event journal lock remained busy") from None
                await asyncio.sleep(0.01)
