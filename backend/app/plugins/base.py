from abc import ABC, abstractmethod
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

    @abstractmethod
    async def start(self) -> None:
        pass

    @abstractmethod
    async def stop(self) -> None:
        pass

    def health(self) -> dict[str, Any]:
        return {
            "driver_key": self.driver_key,
            "printer_id": self.printer_id,
            "running": self._running,
        }

    def validate_config(self) -> None:
        pass
