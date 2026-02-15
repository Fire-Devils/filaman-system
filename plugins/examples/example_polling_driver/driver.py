"""
Example Polling Driver Plugin fuer FilaMan.

Dieses Plugin demonstriert einen einfachen HTTP-Polling-Treiber,
der periodisch einen simulierten Drucker-Endpoint abfragt und
AMS-Events emittiert.

In einer echten Implementierung wuerde hier z.B. ein HTTP-Client
den tatsaechlichen Drucker-API-Endpoint abfragen.
"""

import asyncio
import logging
import random
from typing import Any, Callable

from app.plugins.base import BaseDriver

logger = logging.getLogger(__name__)


class Driver(BaseDriver):
    """Beispiel-Treiber mit HTTP-Polling-Muster."""

    driver_key = "example_polling_driver"

    def __init__(
        self,
        printer_id: int,
        config: dict[str, Any],
        emitter: Callable[[dict[str, Any]], None],
    ):
        super().__init__(printer_id, config, emitter)
        self._task: asyncio.Task | None = None
        self._poll_interval: int = config.get("poll_interval_seconds", 30)
        self._host: str = config.get("host", "localhost")
        self._port: int = config.get("port", 8080)
        self._connected: bool = False
        self._poll_count: int = 0

    def validate_config(self) -> None:
        """Konfiguration validieren.

        Wird vom PluginManager aufgerufen, bevor start() ausgefuehrt wird.
        Bei ungueliger Config eine ValueError werfen.
        """
        if not self.config.get("host"):
            raise ValueError("Config-Feld 'host' ist erforderlich")

        port = self.config.get("port", 8080)
        if not isinstance(port, int) or port < 1 or port > 65535:
            raise ValueError(f"Ungueltiger Port: {port} (muss 1-65535 sein)")

        interval = self.config.get("poll_interval_seconds", 30)
        if not isinstance(interval, int) or interval < 5:
            raise ValueError("poll_interval_seconds muss mindestens 5 sein")

    async def start(self) -> None:
        """Treiber starten und Polling-Loop beginnen."""
        self._running = True
        self._connected = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(
            f"Example driver gestartet fuer Drucker {self.printer_id} "
            f"(polling {self._host}:{self._port} alle {self._poll_interval}s)"
        )

    async def stop(self) -> None:
        """Treiber stoppen und Polling-Loop beenden."""
        self._running = False
        self._connected = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info(f"Example driver gestoppt fuer Drucker {self.printer_id}")

    def health(self) -> dict[str, Any]:
        """Aktuellen Health-Status zurueckgeben."""
        return {
            "driver_key": self.driver_key,
            "printer_id": self.printer_id,
            "running": self._running,
            "connected": self._connected,
            "status": "ok" if self._running and self._connected else "error",
            "poll_count": self._poll_count,
            "target": f"{self._host}:{self._port}",
        }

    async def _poll_loop(self) -> None:
        """Hauptschleife: Periodisch den Drucker abfragen.

        In einer echten Implementierung wuerde hier ein HTTP-Request
        an den Drucker gesendet werden. Dieses Beispiel simuliert
        die Antwort und emittiert entsprechende Events.
        """
        # Exponential Backoff Parameter
        delay = self._poll_interval
        max_delay = 60

        while self._running:
            try:
                # --- Simulierter API-Call ---
                # In echt: response = await http_client.get(f"http://{self._host}:{self._port}/api/ams")
                ams_state = self._simulate_ams_response()

                self._poll_count += 1
                self._connected = True
                delay = self._poll_interval  # Reset Backoff bei Erfolg

                # Event emittieren
                self.emit({
                    "event_type": "ams_state",
                    "ams_units": ams_state,
                })

                logger.debug(
                    f"Poll #{self._poll_count} fuer Drucker {self.printer_id}: "
                    f"{len(ams_state)} AMS-Einheiten"
                )

                await asyncio.sleep(self._poll_interval)

            except asyncio.CancelledError:
                break

            except Exception as e:
                self._connected = False
                logger.warning(
                    f"Poll-Fehler fuer Drucker {self.printer_id}: {e}, "
                    f"Retry in {delay}s"
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, max_delay)

    def _simulate_ams_response(self) -> list[dict[str, Any]]:
        """Simuliert eine AMS-Status-Antwort.

        In einer echten Implementierung wuerde diese Methode
        nicht existieren. Stattdessen wuerde die echte API-Antwort
        des Druckers geparst werden.
        """
        return [
            {
                "ams_unit_no": 1,
                "slots_total": 4,
                "slots": [
                    {
                        "slot_no": slot_no,
                        "present": random.random() > 0.3,
                        "identifiers": {
                            "rfid_uid": f"SIM_{self.printer_id}_{slot_no}",
                        } if random.random() > 0.3 else None,
                    }
                    for slot_no in range(1, 5)
                ],
            }
        ]
