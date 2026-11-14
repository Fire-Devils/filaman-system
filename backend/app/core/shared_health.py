"""Read-only standbys share the primary's latest printer health and Display state.

Only the worker holding election writes these files. Readers open by name so
they see the successor's state after handoff, even if the old file was deleted.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from app.core.primary_socket import primary_socket_path

logger = logging.getLogger(__name__)


class SharedStateStore:
    def __init__(self, path: Callable[[], Path], *, stale_seconds: float = 120) -> None:
        self._path = path
        self._stale_seconds = stale_seconds

    @staticmethod
    def _load(path: Path) -> dict[str, dict[str, Any]]:
        try:
            printers = json.loads(path.read_bytes())
            if not isinstance(printers, dict):
                raise TypeError("Invalid printer snapshot")
            return printers
        except FileNotFoundError:
            return {}
        except (OSError, TypeError, ValueError):
            logger.warning("Could not read printer snapshot %s", path, exc_info=True)
            return {}

    @staticmethod
    def _write(path: Path, state: dict[str, dict[str, Any]]) -> None:
        temporary = None
        try:
            with NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(json.dumps(state).encode())
            # Rename on the same filesystem so readers see one complete snapshot.
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _is_fresh(self, value: dict[str, Any], now: float) -> bool:
        return now - value["timestamp"] <= self._stale_seconds

    def publish(self, state: dict[int, dict[str, Any]], *, replace: bool = False) -> None:
        """Merge fresh entries, or replace the full snapshot after election.

        Each entry keeps its own timestamp so updating one printer cannot keep
        another printer's stale state alive.
        """
        try:
            path = self._path()
            now = time.time()
            printers = {} if replace else {
                key: value for key, value in self._load(path).items() if self._is_fresh(value, now)
            }
            for printer_id, value in state.items():
                try:
                    snapshot = json.loads(json.dumps(value, allow_nan=False))
                except (TypeError, ValueError, RecursionError):
                    logger.warning("Ignoring invalid snapshot for printer %s", printer_id)
                    continue
                printers[str(printer_id)] = {"state": snapshot, "timestamp": now}
            self._write(path, printers)
        except (OSError, KeyError, TypeError, ValueError):
            logger.warning("Could not publish printer snapshot", exc_info=True)

    def read_all(self) -> dict[int, dict[str, Any]]:
        try:
            now = time.time()
            return {
                int(key): value["state"]
                for key, value in self._load(self._path()).items()
                if self._is_fresh(value, now)
            }
        except FileNotFoundError:
            return {}
        except (OSError, KeyError, TypeError, ValueError):
            logger.warning("Could not open printer snapshot", exc_info=True)
            return {}

    def read(self, printer_id: int) -> dict[str, Any] | None:
        try:
            value = self._load(self._path()).get(str(printer_id))
            if value is not None and self._is_fresh(value, time.time()):
                return value["state"]
        except FileNotFoundError:
            pass
        except (OSError, KeyError, TypeError):
            logger.warning("Could not open printer snapshot", exc_info=True)
        return None

    def clear(self, printer_id: int) -> None:
        try:
            path = self._path()
            printers = self._load(path)
            if printers.pop(str(printer_id), None) is not None:
                self._write(path, printers)
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("Could not clear printer snapshot", exc_info=True)

    def cleanup(self) -> None:
        try:
            self._path().unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("Could not remove printer snapshot", exc_info=True)


shared_health_store = SharedStateStore(lambda: primary_socket_path().with_suffix(".health.json"))
shared_display_store = SharedStateStore(lambda: primary_socket_path().with_suffix(".display.json"), stale_seconds=45)
