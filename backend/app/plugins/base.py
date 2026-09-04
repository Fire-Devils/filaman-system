from abc import ABC, abstractmethod
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable


class BaseDriver(ABC):
    driver_key: str = ""

    def __init__(
        self,
        printer_id: int,
        config: dict[str, Any],
        emitter: Callable[[dict[str, Any]], None],
    ):
        self.printer_id = printer_id
        self.config = config
        self.emit = emitter
        self._running = False
        self._debug_log: deque[dict[str, Any]] = deque(maxlen=50)
        self._debug_enabled = False

    @abstractmethod
    async def start(self) -> None:
        pass

    @abstractmethod
    async def stop(self) -> None:
        pass

    async def reconnect(self) -> None:
        """Force reconnect. Default: stop + start cycle."""
        await self.stop()
        await self.start()

    def health(self) -> dict[str, Any]:
        return {
            "driver_key": self.driver_key,
            "printer_id": self.printer_id,
            "running": self._running,
        }

    def validate_config(self) -> None:
        pass

    async def get_display_state(self) -> dict[str, Any] | None:
        """Live printer/AMS state for the Display API (GET /api/v1/display).

        Optional.  Return None (default) and the display still shows the
        spools FilaMan has assigned to this printer's slots.  Return a dict to
        add live tray contents, job progress, temperatures and the active
        slot; see app.services.display_service.normalize_driver_state for
        the accepted keys (Bambu/Bambuddy status dicts are accepted as-is).
        Must be cheap: it is called on every poll of the display feed, so
        return cached state rather than querying the printer.
        """
        return None

    def log_debug(self, direction: str, topic: str, payload: Any) -> None:
        """Add a message to the debug ring buffer (only when debug console is open)."""
        if not self._debug_enabled:
            return
        self._debug_log.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "dir": direction,
            "topic": topic,
            "payload": payload,
        })

    def get_debug_log(self, since_ts: str | None = None) -> list[dict[str, Any]]:
        """Return debug log entries, optionally filtered by timestamp."""
        if since_ts:
            return [e for e in self._debug_log if e["ts"] > since_ts]
        return list(self._debug_log)

    def clear_debug_log(self) -> None:
        """Clear the debug ring buffer and disable logging."""
        self._debug_log.clear()
        self._debug_enabled = False

    def enable_debug_log(self) -> None:
        """Enable debug logging (called when console is opened)."""
        self._debug_enabled = True

    def disable_debug_log(self) -> None:
        """Disable debug logging and clear buffer."""
        self._debug_enabled = False
        self._debug_log.clear()
