from abc import ABC, abstractmethod
from collections import deque
from datetime import datetime
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
        self._debug_log: deque[dict[str, Any]] = deque(maxlen=500)

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

    def log_debug(self, direction: str, topic: str, payload: Any) -> None:
        """Add a message to the debug ring buffer."""
        self._debug_log.append({
            "ts": datetime.utcnow().isoformat(),
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
        """Clear the debug ring buffer."""
        self._debug_log.clear()
