"""Cross-worker shared driver state via multiprocessing.shared_memory.

The primary Gunicorn worker publishes per-printer dicts into a named
shared-memory block.  Secondary workers (which have no drivers loaded)
read from the same block so they can return accurate information
to the frontend — preventing the "button toggling" issue caused by
load-balanced requests hitting workers without drivers.

Two blocks use this:

* ``shared_health_store`` - driver health for the Printers page.
* ``shared_display_store`` - live state for the Display API.  It carries
  every tray of every AMS, so it gets its own, larger block and a shorter
  staleness window: a board showing a dead printer as connected is worse
  than one showing nothing.

Memory layout:
  [4 bytes uint32 LE — JSON payload length]
  [N bytes — JSON payload: {"<printer_id>": {...state}, ...}]
  [8 bytes float64 LE — UNIX timestamp of last write]
"""

from __future__ import annotations

import json
import logging
import struct
import time
from multiprocessing import shared_memory
from typing import Any

logger = logging.getLogger(__name__)

_SHM_NAME = "filaman_health"
_SHM_SIZE = 65536  # 64 KiB – plenty for dozens of printers
_HEADER_FMT = "<I"  # uint32 LE (payload length)
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)
_TS_FMT = "<d"  # float64 LE (timestamp)
_TS_SIZE = struct.calcsize(_TS_FMT)
_STALE_SECONDS = 120  # data older than this is considered stale

_DISPLAY_SHM_NAME = "filaman_display"
_DISPLAY_SHM_SIZE = 262144  # 256 KiB - live state carries every tray
_DISPLAY_STALE_SECONDS = 45  # a board must not keep a dead driver alive


class SharedStateStore:
    """Read/write per-printer driver state across Gunicorn workers."""

    def __init__(
        self,
        *,
        name: str = _SHM_NAME,
        size: int = _SHM_SIZE,
        stale_seconds: float = _STALE_SECONDS,
    ) -> None:
        self._name = name
        self._size = size
        self._stale_seconds = stale_seconds
        self._shm: shared_memory.SharedMemory | None = None
        self._is_owner = False

    # -- attach / create ------------------------------------------------

    def _ensure_shm(self, *, create: bool = False) -> shared_memory.SharedMemory | None:
        """Attach to (or create) the shared-memory block.

        Returns the block or ``None`` if it does not exist yet and
        *create* is False.
        """
        if self._shm is not None:
            return self._shm

        if create:
            # Try to create; if it already exists (previous crash), attach.
            try:
                self._shm = shared_memory.SharedMemory(
                    name=self._name,
                    create=True,
                    size=self._size,
                )
                self._is_owner = True
                logger.debug("%s: created shared memory block", self._name)
            except FileExistsError:
                self._shm = shared_memory.SharedMemory(
                    name=self._name,
                    create=False,
                )
                logger.debug("%s: attached to existing block", self._name)
        else:
            try:
                self._shm = shared_memory.SharedMemory(
                    name=self._name,
                    create=False,
                )
                logger.debug("%s: attached to existing block", self._name)
            except FileNotFoundError:
                return None

        return self._shm

    # -- public API -----------------------------------------------------

    def publish(self, state: dict[int, dict[str, Any]]) -> None:
        """Merge state for one or more printers into shared memory.

        Callers may pass a full snapshot (all printers) or just the
        printer(s) they have fresh data for — existing entries for other
        printers are preserved rather than being wiped out.
        """
        shm = self._ensure_shm(create=True)
        if shm is None:
            return

        current = self._read_raw(shm) or {}
        current.update({str(k): v for k, v in state.items()})
        self._write(shm, current)

    def _read_raw(self, shm: shared_memory.SharedMemory) -> dict[str, Any] | None:
        """Read the raw (string-keyed) payload, ignoring staleness."""
        try:
            buf = shm.buf
            (length,) = struct.unpack_from(_HEADER_FMT, buf, 0)
            if length == 0 or length > self._size - _HEADER_SIZE - _TS_SIZE:
                return None
            payload_bytes = bytes(buf[_HEADER_SIZE : _HEADER_SIZE + length])
            return json.loads(payload_bytes)
        except Exception:
            logger.debug("%s: failed to read raw payload", self._name, exc_info=True)
            return None

    def _write(self, shm: shared_memory.SharedMemory, payload_dict: dict[str, Any]) -> None:
        payload = json.dumps(payload_dict).encode()
        ts = time.time()

        total = _HEADER_SIZE + len(payload) + _TS_SIZE
        if total > self._size:
            logger.warning(
                "%s: payload too large (%d bytes), skipping",
                self._name,
                total,
            )
            return

        buf = shm.buf
        struct.pack_into(_HEADER_FMT, buf, 0, len(payload))
        buf[_HEADER_SIZE : _HEADER_SIZE + len(payload)] = payload
        struct.pack_into(_TS_FMT, buf, _HEADER_SIZE + len(payload), ts)

    def read(self, printer_id: int) -> dict[str, Any] | None:
        """Read state for a single printer.  Returns None if the block
        doesn't exist, has no data for this printer, or the data is stale.
        """
        shm = self._ensure_shm(create=False)
        if shm is None:
            return None

        try:
            buf = shm.buf
            (length,) = struct.unpack_from(_HEADER_FMT, buf, 0)
            if length == 0 or length > self._size - _HEADER_SIZE - _TS_SIZE:
                return None

            payload_bytes = bytes(buf[_HEADER_SIZE : _HEADER_SIZE + length])
            (ts,) = struct.unpack_from(
                _TS_FMT,
                buf,
                _HEADER_SIZE + length,
            )

            if time.time() - ts > self._stale_seconds:
                return None

            data: dict[str, Any] = json.loads(payload_bytes)
            return data.get(str(printer_id))
        except Exception:
            logger.debug("%s: failed to read state", self._name, exc_info=True)
            return None

    def read_all(self) -> dict[int, dict[str, Any]] | None:
        """Read state for all printers.  Returns None if stale/missing."""
        shm = self._ensure_shm(create=False)
        if shm is None:
            return None

        try:
            buf = shm.buf
            (length,) = struct.unpack_from(_HEADER_FMT, buf, 0)
            if length == 0 or length > self._size - _HEADER_SIZE - _TS_SIZE:
                return None

            payload_bytes = bytes(buf[_HEADER_SIZE : _HEADER_SIZE + length])
            (ts,) = struct.unpack_from(
                _TS_FMT,
                buf,
                _HEADER_SIZE + length,
            )

            if time.time() - ts > self._stale_seconds:
                return None

            raw: dict[str, Any] = json.loads(payload_bytes)
            return {int(k): v for k, v in raw.items()}
        except Exception:
            logger.debug("%s: failed to read_all", self._name, exc_info=True)
            return None

    def clear(self, printer_id: int) -> None:
        """Remove a printer from the block (e.g. after a driver stop)."""
        shm = self._ensure_shm(create=False)
        if shm is None:
            return
        current = self._read_raw(shm)
        if current is None:
            return
        if current.pop(str(printer_id), None) is None:
            return
        self._write(shm, current)

    def cleanup(self) -> None:
        """Close and unlink the shared-memory block.

        Should be called once during shutdown — only by the owner
        (primary worker).
        """
        if self._shm is not None:
            try:
                self._shm.close()
            except Exception:
                pass
            if self._is_owner:
                try:
                    self._shm.unlink()
                    logger.debug("%s: unlinked shared memory", self._name)
                except Exception:
                    pass
            self._shm = None
            self._is_owner = False

    def close(self) -> None:
        """Close handle without unlinking (for secondary workers)."""
        if self._shm is not None:
            try:
                self._shm.close()
            except Exception:
                pass
            self._shm = None


# Module-level singletons — imported by printers.py, display.py and main.py
shared_health_store = SharedStateStore()
shared_display_store = SharedStateStore(
    name=_DISPLAY_SHM_NAME,
    size=_DISPLAY_SHM_SIZE,
    stale_seconds=_DISPLAY_STALE_SECONDS,
)
