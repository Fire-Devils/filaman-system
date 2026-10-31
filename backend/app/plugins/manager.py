import asyncio
import importlib
import inspect
import json
import logging
import math
import shutil
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.core.cache import response_cache
from app.core.database import async_session_maker
from app.core.event_bus import event_bus
from app.models import Printer
from app.models.filament import Filament, FilamentColor
from app.models.plugin import InstalledPlugin
from app.models.printer import PrinterSlot, PrinterSlotAssignment
from app.models.printer_params import (
    FilamentPrinterInitialization,
    FilamentPrinterParam,
    SpoolPrinterParam,
)
from app.models.spool import Spool
from app.models.system_extra_field import SystemExtraField
from app.plugins.base import BaseDriver
from app.services.plugin_service import PLUGINS_DIR as USER_PLUGINS_DIR
from app.services.spoolman_extra_field_mapping import (
    SpoolmanFieldError,
    convert_spoolman_value,
)
from app.services.spoolman_projection import owns_retained_source
from app.utils.colors import visible_rgb_hex_or_legacy

logger = logging.getLogger(__name__)

# Built-in plugins ship with the image and live alongside this file
BUILTIN_PLUGINS_DIR = Path(__file__).parent

# Ensure user-installed plugins are discoverable under the app.plugins namespace
# so that imports like 'from app.plugins.bambulab.driver import Driver' resolve
# to /app/data/plugins/bambulab/driver.py in Docker.
if USER_PLUGINS_DIR != BUILTIN_PLUGINS_DIR:
    if str(USER_PLUGINS_DIR) not in sys.path:
        sys.path.insert(0, str(USER_PLUGINS_DIR))
    import app.plugins as _plugins_pkg

    if str(USER_PLUGINS_DIR) not in _plugins_pkg.__path__:
        _plugins_pkg.__path__.insert(0, str(USER_PLUGINS_DIR))


class EventEmitter:
    def __init__(self, printer_id: int, handler: Callable[[dict], None]):
        self.printer_id = printer_id
        self.handler = handler

    def emit(self, event_dict: dict[str, Any]) -> None:
        event_dict["printer_id"] = self.printer_id
        try:
            self.handler(event_dict)
        except Exception as e:
            logger.error(f"Error handling event for printer {self.printer_id}: {e}")


class PluginManager:
    def __init__(self):
        self.drivers: dict[int, BaseDriver] = {}
        self.health_status: dict[int, dict[str, Any]] = {}

    def _create_event_handler(self, printer_id: int) -> Callable[[dict], None]:
        def handler(event: dict) -> None:
            import asyncio

            logger.debug(
                f"Event handler called for printer {printer_id}: {event.get('event_type')}"
            )
            try:
                asyncio.create_task(self._handle_event(printer_id, event))
            except Exception as e:
                logger.error(f"Failed to create task for event: {e}", exc_info=True)

        return handler

    async def _handle_event(self, printer_id: int, event: dict) -> None:
        event_type = event.get("event_type")
        slots_count = len(event.get("slots", []))
        logger.info(
            f"Received event {event_type} for printer {printer_id} (slots: {slots_count})"
        )

        if event_type == "slots_update":
            await self._handle_slots_update(
                printer_id,
                event.get("slots", []),
                event.get("ams_info"),
                event.get("active_spool_id"),
            )
        elif event_type == "printer_status":
            # Forward printer status to frontend (heartbeat)
            await event_bus.publish(
                {
                    "event": "printer_status",
                    "printer_id": printer_id,
                    "connected": event.get("connected", False),
                    "timestamp": event.get("timestamp"),
                }
            )

    @staticmethod
    def _canonicalize_slot_index(slot_index: str) -> str:
        """Collapse legacy external VT keys (``255-254`` / ``255-255``) to ``255-0`` / ``255-1``."""
        if not slot_index or "-" not in slot_index:
            return slot_index
        a, _, t = slot_index.partition("-")
        try:
            ams_id, tray = int(a), int(t)
        except ValueError:
            return slot_index
        if ams_id == 254:
            tray = 1 if tray in (1, 255) else 0
            ams_id = 255
        elif ams_id == 255:
            if tray == 254:
                tray = 0
            elif tray == 255:
                tray = 1
        return f"{ams_id}-{tray}"

    @staticmethod
    def _slot_index_to_no(slot_index: str) -> int:
        """Convert driver slot_index string (e.g. '0-1', '255-0') to integer slot_no."""
        slot_index = PluginManager._canonicalize_slot_index(slot_index)
        parts = slot_index.split("-", 1)
        if len(parts) == 2:
            try:
                unit, tray = int(parts[0]), int(parts[1])
                if unit >= 200:  # external tray
                    return 1000 + tray
                return unit * 4 + tray
            except ValueError:
                pass
        return hash(slot_index) % 10000

    @staticmethod
    def _parse_spool_id(raw: Any) -> int | None:
        """Coerce a driver-supplied spool id to a positive int, else None."""
        if raw is None or isinstance(raw, bool):
            return None
        try:
            parsed = int(raw)
        except Exception:
            return None
        return parsed if parsed > 0 else None

    async def _apply_spool_to_assignment(
        self,
        db: AsyncSession,
        assignment: PrinterSlotAssignment,
        spool_id: int | None,
        meta: dict,
    ) -> dict:
        """Point an assignment at a spool and mirror its material/color into meta."""
        assignment.spool_id = spool_id
        assignment.present = spool_id is not None
        assignment.updated_at = datetime.now(timezone.utc)

        meta = dict(meta or {})
        meta["active_spool_id"] = spool_id

        if spool_id is None:
            meta.pop("tray_type", None)
            meta.pop("tray_color", None)
            return meta

        spool_res = await db.execute(
            select(Spool)
            .options(
                selectinload(Spool.filament).selectinload(Filament.manufacturer),
                selectinload(Spool.filament)
                .selectinload(Filament.filament_colors)
                .selectinload(FilamentColor.color),
            )
            .where(Spool.id == spool_id)
        )
        spool = spool_res.scalar_one_or_none()
        if spool is None:
            return meta

        assignment.spool = spool
        filament = spool.filament
        if filament is not None:
            if filament.material_type:
                meta["tray_type"] = filament.material_type
            if filament.filament_colors:
                first_color = filament.filament_colors[0].color
                if first_color and first_color.hex_code:
                    meta["tray_color"] = visible_rgb_hex_or_legacy(
                        first_color.hex_code
                    ).replace("#", "")
        return meta

    async def _handle_slots_update(
        self,
        printer_id: int,
        slots_data: list[dict],
        ams_info: dict | None = None,
        active_spool_id_raw: Any | None = None,
    ) -> None:
        """Upsert PrinterSlot and PrinterSlotAssignment from driver slot events."""
        try:
            if active_spool_id_raw is None and isinstance(ams_info, dict):
                active_spool_id_raw = ams_info.get("active_spool_id")

            active_spool_id: int | None = None
            if active_spool_id_raw is not None:
                try:
                    parsed_active = int(active_spool_id_raw)
                    if parsed_active > 0:
                        active_spool_id = parsed_active
                except Exception:
                    active_spool_id = None

            async with async_session_maker() as db:
                # Set when the driver reports spool ownership per slot; suppresses
                # the printer-wide fallback below.
                per_slot_spools = False

                # Upsert slots if any
                if slots_data:
                    for slot_data in slots_data:
                        slot_index = self._canonicalize_slot_index(
                            slot_data.get("slot_index", "") or ""
                        )
                        slot_no = self._slot_index_to_no(slot_index)
                        slot_name = slot_data.get("slot_name", f"Slot {slot_no}")
                        present = slot_data.get("present", False)

                        # Upsert PrinterSlot — eager-load assignment to avoid MissingGreenlet
                        result = await db.execute(
                            select(PrinterSlot)
                            .options(selectinload(PrinterSlot.assignment))
                            .where(
                                PrinterSlot.printer_id == printer_id,
                                PrinterSlot.slot_no == slot_no,
                            )
                        )
                        printer_slot = result.scalar_one_or_none()

                        is_new = False
                        if not printer_slot:
                            printer_slot = PrinterSlot(
                                printer_id=printer_id,
                                slot_no=slot_no,
                                name=slot_name,
                                is_active=True,
                                custom_fields={"slot_index": slot_index},
                            )
                            db.add(printer_slot)
                            await db.flush()
                            is_new = True
                        else:
                            printer_slot.name = slot_name
                            printer_slot.custom_fields = {
                                **(printer_slot.custom_fields or {}),
                                "slot_index": slot_index,
                            }

                        # Build meta dict from driver-specific fields
                        meta = {}
                        for key in (
                            "tray_type",
                            "tray_color",
                            "tray_info_idx",
                            "nozzle_temp_min",
                            "nozzle_temp_max",
                            "setting_id",
                            "cali_idx",
                        ):
                            if key in slot_data:
                                meta[key] = slot_data[key]

                        # Upsert PrinterSlotAssignment
                        # For new slots, always create assignment (no lazy-load risk)
                        # For existing slots, assignment is eager-loaded via selectinload
                        if not is_new and printer_slot.assignment:
                            assignment = printer_slot.assignment
                            assignment.present = present
                            assignment.meta = meta
                        else:
                            assignment = PrinterSlotAssignment(
                                slot_id=printer_slot.id,
                                present=present,
                                meta=meta,
                            )
                            db.add(assignment)

                        # Drivers that track a spool per slot (e.g. multi-toolhead
                        # Moonraker) report it here; that beats the printer-wide
                        # active spool, which cannot say *which* slot it belongs to.
                        if "spool_id" in slot_data:
                            per_slot_spools = True
                            assignment.meta = await self._apply_spool_to_assignment(
                                db,
                                assignment,
                                self._parse_spool_id(slot_data["spool_id"]),
                                meta,
                            )

                    # Retire legacy external keys (255-254 / 255-255) once the
                    # canonical 255-0 / 255-1 rows exist, so AMS View and the
                    # printer page stop listing four External bays on H2C/H2D.
                    all_slots = (
                        (
                            await db.execute(
                                select(PrinterSlot).where(
                                    PrinterSlot.printer_id == printer_id
                                )
                            )
                        )
                        .scalars()
                        .all()
                    )
                    active_indexes = {
                        (s.custom_fields or {}).get("slot_index")
                        for s in all_slots
                        if s.is_active and (s.custom_fields or {}).get("slot_index")
                    }
                    for slot in all_slots:
                        raw = (slot.custom_fields or {}).get("slot_index") or ""
                        canon = self._canonicalize_slot_index(raw)
                        if (
                            slot.is_active
                            and raw
                            and canon != raw
                            and canon in active_indexes
                        ):
                            slot.is_active = False
                            logger.info(
                                f"Deactivated legacy external slot {raw!r} "
                                f"on printer {printer_id} (canonical {canon})"
                            )

                    await db.commit()
                    logger.info(
                        f"Updated {len(slots_data)} slots for printer {printer_id}"
                    )
                    # Broadcast to SSE clients
                    await event_bus.publish(
                        {"event": "slots_update", "printer_id": printer_id}
                    )

                active_spool_synced = False
                if active_spool_id_raw is not None and not per_slot_spools:
                    slot_result = await db.execute(
                        select(PrinterSlot)
                        .options(selectinload(PrinterSlot.assignment))
                        .where(PrinterSlot.printer_id == printer_id)
                        .order_by(PrinterSlot.slot_no)
                    )
                    printer_slots = slot_result.scalars().all()

                    active_slot: PrinterSlot | None = None
                    if len(printer_slots) > 1:
                        # A printer-wide active spool means "loaded in the toolhead"
                        # and cannot name a slot, so on AMS/MMU printers stamping it
                        # into 0-0 would overwrite that slot's real assignment.
                        # Callers passing an empty slot list (driver_health refresh,
                        # driver startup) reach here on every poll.
                        logger.debug(
                            f"Skipping active-spool fallback for printer {printer_id}: "
                            f"{len(printer_slots)} slots, active spool names none of them"
                        )
                    else:
                        for slot in printer_slots:
                            slot_index = (slot.custom_fields or {}).get("slot_index")
                            if slot_index == "0-0":
                                active_slot = slot
                                break
                        if active_slot is None and printer_slots:
                            active_slot = printer_slots[0]

                    if active_slot is not None:
                        assignment = active_slot.assignment
                        if assignment is None:
                            assignment = PrinterSlotAssignment(
                                slot_id=active_slot.id,
                                present=active_spool_id is not None,
                                meta={},
                            )
                            db.add(assignment)
                            await db.flush()

                        assignment.meta = await self._apply_spool_to_assignment(
                            db, assignment, active_spool_id, assignment.meta or {}
                        )
                        active_spool_synced = True

                if active_spool_synced:
                    await db.commit()
                    await event_bus.publish(
                        {"event": "slots_update", "printer_id": printer_id}
                    )
                    await event_bus.publish(
                        {"event": "printer_update", "printer_id": printer_id}
                    )

                # Persist AMS/slot summary to Printer.custom_fields
                if ams_info:
                    printer = await db.get(Printer, printer_id)
                    if printer:
                        if active_spool_id_raw is not None and isinstance(
                            ams_info, dict
                        ):
                            ams_info = {
                                **ams_info,
                                "active_spool_id": active_spool_id,
                            }
                        printer.custom_fields = {
                            **(printer.custom_fields or {}),
                            "slot_summary": ams_info,
                        }
                        flag_modified(printer, "custom_fields")
                        await db.commit()
                        logger.info(f"Persisted slot_summary for printer {printer_id}")
                        await event_bus.publish(
                            {"event": "printer_update", "printer_id": printer_id}
                        )
        except Exception as e:
            logger.error(
                f"Error in _handle_slots_update for printer {printer_id}: {e}",
                exc_info=True,
            )

    def load_driver(self, driver_key: str) -> type[BaseDriver] | None:
        # app.plugins.__path__ includes both USER_PLUGINS_DIR and BUILTIN_PLUGINS_DIR,
        # so a single import covers user-installed and built-in plugins.
        try:
            module = importlib.import_module(f"app.plugins.{driver_key}.driver")
            driver_class = getattr(module, "Driver", None)
            if driver_class and issubclass(driver_class, BaseDriver):
                return driver_class
        except ImportError as e:
            logger.warning(f"Could not load plugin {driver_key}: {e}")
        return None

    async def start_printer(self, printer: Printer) -> bool:
        if printer.id in self.drivers:
            return True

        driver_class = self.load_driver(printer.driver_key)
        if not driver_class:
            logger.error(f"Driver not found: {printer.driver_key}")
            self.health_status[printer.id] = {
                "status": "error",
                "message": f"Driver not found: {printer.driver_key}",
            }
            return False

        emitter = EventEmitter(printer.id, self._create_event_handler(printer.id))
        config = printer.driver_config or {}

        try:
            # Ensure plugin-specific extra fields exist before starting the driver
            await self._ensure_plugin_extra_fields(printer.driver_key)
            await self._migrate_spoolman_bambu_fields(printer.driver_key)
            await self._copy_params_to_new_printer(printer.driver_key, printer.id)

            driver = driver_class(
                printer_id=printer.id,
                config=config,
                emitter=emitter.emit,
            )
            driver.validate_config()
            await driver.start()

            # If supported, sync active spool immediately after startup so
            # the spool page can render Moonraker state on first load.
            refresh_status = getattr(driver, "refresh_status", None)
            if callable(refresh_status):
                try:
                    refresh_payload = refresh_status()
                    if asyncio.iscoroutine(refresh_payload):
                        refresh_payload = await refresh_payload
                    if isinstance(refresh_payload, dict):
                        active_spool_id = refresh_payload.get("active_spool_id")
                        await self._handle_slots_update(
                            printer.id,
                            [],
                            None,
                            active_spool_id,
                        )
                except Exception as refresh_exc:
                    logger.debug(
                        "Initial refresh_status failed for printer %s: %s",
                        printer.id,
                        refresh_exc,
                    )

            self.drivers[printer.id] = driver
            self.health_status[printer.id] = driver.health()
            logger.info(f"Started driver {printer.driver_key} for printer {printer.id}")
            return True
        except Exception as e:
            logger.error(f"Error starting driver for printer {printer.id}: {e}")
            self.health_status[printer.id] = {
                "status": "error",
                "message": str(e),
            }
            return False

    async def stop_printer(self, printer_id: int) -> None:
        driver = self.drivers.pop(printer_id, None)
        self.health_status.pop(printer_id, None)
        if driver:
            try:
                await driver.stop()
                logger.info(f"Stopped driver for printer {printer_id}")
            except Exception as e:
                logger.error(f"Error stopping driver for printer {printer_id}: {e}")

    async def _ensure_all_plugin_dependencies(self) -> None:
        """Install missing Python dependencies for all user-installed plugins.

        After a Docker image update the container filesystem is replaced but
        user-installed plugins persist on the volume.  Their pip dependencies
        may be gone, so we re-install them on every startup."""
        if USER_PLUGINS_DIR == BUILTIN_PLUGINS_DIR:
            return  # dev mode — no separate user dir

        for plugin_dir in USER_PLUGINS_DIR.iterdir():
            if not plugin_dir.is_dir():
                continue
            manifest_path = plugin_dir / "plugin.json"
            if not manifest_path.exists():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                dependencies = manifest.get("dependencies", [])
                if not dependencies:
                    continue
                await self._install_pip_packages(
                    dependencies, manifest.get("plugin_key", plugin_dir.name)
                )
            except Exception as e:
                logger.warning(
                    f"Could not ensure dependencies for {plugin_dir.name}: {e}"
                )

    @staticmethod
    async def _install_pip_packages(packages: list[str], plugin_key: str) -> None:
        """Install Python packages via uv (preferred) or pip."""
        commands: list[list[str]] = []
        uv_path = shutil.which("uv")
        if uv_path:
            commands.append(
                [
                    uv_path,
                    "pip",
                    "install",
                    "--python",
                    sys.executable,
                    "--quiet",
                    *packages,
                ]
            )
        commands.append([sys.executable, "-m", "pip", "install", "--quiet", *packages])

        for cmd in commands:
            try:
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=120
                )
                if process.returncode == 0:
                    logger.info(f"Dependencies for '{plugin_key}' ensured successfully")
                    return
                logger.warning(
                    f"Dependency install failed for '{plugin_key}' with {cmd[0]}: "
                    f"{stderr.decode().strip() if stderr else 'unknown error'}"
                )
            except FileNotFoundError:
                continue
            except asyncio.TimeoutError:
                logger.error(f"Timeout installing dependencies for '{plugin_key}'")
                return
        logger.error(
            f"Could not install dependencies for '{plugin_key}': all methods failed"
        )

    async def start_all(self) -> None:
        await self._ensure_all_plugin_dependencies()
        async with async_session_maker() as db:
            # Deaktivierte Plugins ermitteln (driver_key)
            disabled_result = await db.execute(
                select(InstalledPlugin.driver_key).where(
                    InstalledPlugin.is_active.is_(False),
                    InstalledPlugin.driver_key.isnot(None),
                )
            )
            disabled_drivers = {r for r in disabled_result.scalars().all()}

            result = await db.execute(
                select(Printer).where(
                    Printer.is_active.is_(True),
                    Printer.deleted_at.is_(None),
                )
            )
            printers = result.scalars().all()

            for printer in printers:
                if printer.driver_key in disabled_drivers:
                    logger.info(
                        f"Skipping printer {printer.id}: plugin '{printer.driver_key}' is deactivated"
                    )
                    continue
                await self.start_printer(printer)

    async def stop_all(self) -> None:
        for printer_id in list(self.drivers.keys()):
            await self.stop_printer(printer_id)

    async def reconnect_all(self) -> dict[int, str]:
        """Reconnect all active printers. Returns {printer_id: status} map."""
        results: dict[int, str] = {}
        async with async_session_maker() as db:
            result = await db.execute(
                select(Printer).where(
                    Printer.is_active.is_(True),
                    Printer.deleted_at.is_(None),
                )
            )
            printers = result.scalars().all()

        for printer in printers:
            driver = self.drivers.get(printer.id)
            if driver:
                try:
                    await driver.reconnect()
                    results[printer.id] = "reconnected"
                except Exception as e:
                    logger.error(f"Reconnect failed for printer {printer.id}: {e}")
                    results[printer.id] = f"error: {e}"
            else:
                started = await self.start_printer(printer)
                results[printer.id] = "started" if started else "start_failed"
        return results

    def get_health(self) -> dict[int, dict[str, Any]]:
        self.health_status = {
            printer_id: driver.health() for printer_id, driver in self.drivers.items()
        }
        return dict(self.health_status)

    async def get_display_states(self) -> dict[int, dict[str, Any]]:
        """Live state of every local driver, for the Display API.

        A driver without ``get_display_state()`` falls back to ``health()``:
        that already carries ``connected`` and the AMS ``ams_units``, which is
        what the display service needs for the online badge and the climate.
        """
        states: dict[int, dict[str, Any]] = {}
        for printer_id, driver in self.drivers.items():
            try:
                state = await self.get_display_state(printer_id)
            except Exception:
                logger.debug(
                    "get_display_state failed for printer %s", printer_id, exc_info=True
                )
                continue
            if state is not None:
                states[printer_id] = state
        return states

    async def get_display_state(self, printer_id: int) -> dict[str, Any] | None:
        """Live state of one local driver, or None when there is no driver here."""
        driver = self.drivers.get(printer_id)
        if driver is None:
            return None
        state: Any = None
        getter = getattr(driver, "get_display_state", None)
        if getter is not None:
            state = getter()
            if inspect.isawaitable(state):
                state = await state
        if not isinstance(state, dict):
            health = getattr(driver, "health", None)
            state = health() if callable(health) else None
        return state if isinstance(state, dict) else None

    # -- Plugin Extra-Field Management ----------------------------------------

    @staticmethod
    def _plugin_search_dirs() -> list[Path]:
        """Return plugin directories in search priority order (user-installed first)."""
        dirs = [USER_PLUGINS_DIR]
        if BUILTIN_PLUGINS_DIR != USER_PLUGINS_DIR:
            dirs.append(BUILTIN_PLUGINS_DIR)
        return dirs

    # -- Plugin Extra-Field Management ----------------------------------------

    def _load_plugin_json(self, driver_key: str) -> dict[str, Any] | None:
        """Load and return the parsed plugin.json for a given driver."""
        for base_dir in self._plugin_search_dirs():
            json_path = base_dir / driver_key / "plugin.json"
            try:
                return json.loads(json_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
        logger.warning(f"Could not load plugin.json for {driver_key}")
        return None

    def _resolve_options(
        self, driver_key: str, field_def: dict[str, Any]
    ) -> list[str] | None:
        """Resolve dropdown options for a field definition.

        If field_def has 'options_file', loads the JSON file from the plugin directory
        and returns the material names sorted alphabetically.  If field_def has static
        'options', returns those.
        """
        options_file = field_def.get("options_file")
        if options_file:
            for base_dir in self._plugin_search_dirs():
                file_path = base_dir / driver_key / options_file
                try:
                    raw = json.loads(file_path.read_text(encoding="utf-8"))
                    options: list[str] = []
                    for idx, info in raw.items():
                        if idx.startswith("_"):  # skip comments
                            continue
                        name = (
                            info.get("name", idx)
                            if isinstance(info, dict)
                            else str(info)
                        )
                        options.append(name)
                    options.sort()
                    return options
                except (OSError, json.JSONDecodeError):
                    continue
            logger.warning(
                f"{options_file} not found for {driver_key}; dropdown will have no options"
            )
            return []
        return field_def.get("options")

    def get_printer_parameter_fields(self, driver_key: str, target_type: str | None = None) -> list[dict[str, Any]]:
        """Read declared driver fields without global ownership or a running driver."""
        manifest = self._load_plugin_json(driver_key)
        config = (manifest or {}).get("printer_params", {})
        if target_type and target_type not in config.get("target_types", []):
            return []
        return [
            {
                "key": field["key"],
                "label": field["label"],
                "field_type": field.get("field_type", "text"),
                "options": self._resolve_options(driver_key, field),
                "config": field.get("config"),
            }
            for field in config.get("fields", [])
            if not target_type or field.get("target_type", target_type) == target_type
        ]

    async def _ensure_plugin_extra_fields(self, driver_key: str) -> None:
        """Create or update plugin-defined SystemExtraFields from plugin.json.

        Reads printer_params.fields from the plugin's plugin.json and creates/updates
        corresponding SystemExtraField entries for each target_type.  Also cleans up
        legacy fields listed in printer_params.migration.legacy_renames.
        Idempotent — safe to call on every start.
        """
        plugin_json = self._load_plugin_json(driver_key)
        if not plugin_json:
            return

        printer_params_cfg = plugin_json.get("printer_params")
        if not printer_params_cfg:
            return  # Plugin defines no printer params

        target_types = printer_params_cfg.get("target_types", [])
        field_defs = printer_params_cfg.get("fields", [])
        migration = printer_params_cfg.get("migration", {})
        legacy_renames = migration.get("legacy_renames", {})

        if not target_types or not field_defs:
            return

        resolved_fields = self.get_printer_parameter_fields(driver_key)

        async with async_session_maker() as db:
            # Create or update field definitions
            for target_type in target_types:
                for fdef in resolved_fields:
                    result = await db.execute(
                        select(SystemExtraField).where(
                            SystemExtraField.target_type == target_type,
                            SystemExtraField.key == fdef["key"],
                        )
                    )
                    field = result.scalar_one_or_none()

                    if field:
                        # Update options/label/field_type if changed (plugin may have been updated)
                        changed = False
                        if fdef["options"] is not None:
                            # JSON-safe comparison: always force-update options from options_file
                            # to avoid subtle SQLAlchemy JSON deserialization mismatches
                            db_options_json = json.dumps(
                                field.options or [], ensure_ascii=False, sort_keys=True
                            )
                            new_options_json = json.dumps(
                                fdef["options"], ensure_ascii=False, sort_keys=True
                            )
                            if db_options_json != new_options_json:
                                logger.info(
                                    f"Updating options for {target_type}/{fdef['key']} ({len(fdef['options'])} entries)"
                                )
                                field.options = fdef["options"]
                                flag_modified(field, "options")
                                changed = True
                        if field.label != fdef["label"]:
                            field.label = fdef["label"]
                            changed = True
                        if field.field_type != fdef["field_type"]:
                            field.field_type = fdef["field_type"]
                            changed = True
                        db_config_json = json.dumps(
                            field.config or {}, ensure_ascii=False, sort_keys=True
                        )
                        new_config_json = json.dumps(
                            fdef["config"] or {}, ensure_ascii=False, sort_keys=True
                        )
                        if db_config_json != new_config_json:
                            field.config = fdef["config"]
                            flag_modified(field, "config")
                            changed = True
                        if changed:
                            logger.info(
                                f"Updated {target_type}/{fdef['key']} field definition"
                            )
                    else:
                        db.add(
                            SystemExtraField(
                                target_type=target_type,
                                key=fdef["key"],
                                label=fdef["label"],
                                field_type=fdef["field_type"],
                                options=fdef["options"],
                                config=fdef["config"],
                                source=driver_key,
                            )
                        )
                        logger.info(
                            f"Created {target_type}/{fdef['key']} SystemExtraField"
                        )

            # Clean up legacy fields: renamed keys that now have new names
            current_keys = {f["key"] for f in resolved_fields}
            for old_key in legacy_renames:
                if old_key in current_keys:
                    continue  # Old key is still a valid current key, skip
                for target_type in target_types:
                    legacy = await db.execute(
                        select(SystemExtraField).where(
                            SystemExtraField.target_type == target_type,
                            SystemExtraField.key == old_key,
                            SystemExtraField.source == driver_key,
                        )
                    )
                    legacy_field = legacy.scalar_one_or_none()
                    if legacy_field:
                        await db.delete(legacy_field)
                        logger.info(
                            f"Removed legacy {target_type}/{old_key} SystemExtraField"
                        )

            # Clean up legacy fields with old target_type (e.g. 'filament' instead of 'filament_printer_param')
            legacy_target_cleanup = await db.execute(
                select(SystemExtraField).where(
                    SystemExtraField.source == driver_key,
                    SystemExtraField.target_type.notin_(target_types),
                )
            )
            for legacy_field in legacy_target_cleanup.scalars().all():
                await db.delete(legacy_field)
                logger.info(
                    f"Removed legacy {legacy_field.target_type}/{legacy_field.key} SystemExtraField (wrong target_type)"
                )

            await db.commit()

            # Invalidate extra_fields cache after plugin fields are created/updated
            for target_type in target_types:
                response_cache.delete(f"extra_fields:{target_type}:{driver_key}")
                response_cache.delete(f"extra_fields:{target_type}:all")
            response_cache.delete("extra_fields:all:all")

    async def _migrate_spoolman_bambu_fields(self, driver_key: str) -> None:
        """Migrate bambu_* calibration data from custom_fields into printer_params tables.

        Extracts per-printer calibration fields (bambu_setting_id, bambu_k_value, etc.)
        from custom_fields.spoolman_extra and top-level custom_fields, creates
        FilamentPrinterParam / SpoolPrinterParam entries for all existing printers of
        this driver, then removes the migrated keys from custom_fields.

        Uses legacy_renames from plugin.json to rename old field keys.
        Idempotent — upserts every entity/printer/parameter combination independently."""
        # Load legacy_renames from plugin.json
        plugin_json = self._load_plugin_json(driver_key)
        if not plugin_json:
            return
        printer_params_cfg = plugin_json.get("printer_params", {})
        migration = printer_params_cfg.get("migration", {})
        legacy_renames = migration.get("legacy_renames", {})
        allowed_keys = self._bambu_parameter_keys(driver_key, printer_params_cfg)
        if allowed_keys == set():
            return

        # Only BambuLab treats the legacy Spoolman material index as tray_info_idx.
        RENAME_KEYS = dict(legacy_renames)
        if driver_key == "bambulab":
            RENAME_KEYS["bambu_idx"] = "bambu_tray_idx"

        KEEP_IN_CUSTOM_FIELDS: set[str] = {
            # Bambuddy profile metadata — not printer calibration params.
            "bambu_profile_base_name",
            "bambu_profiles_by_model",
            "bambu_slicer_filament",
            "bambu_slicer_filament_name",
            "bambu_color_name",
            # Spool identity (RFID tag UIDs) written by the driver — not params.
            "bambu_rfid_tag_1",
            "bambu_rfid_tag_2",
        }

        async with async_session_maker() as db:
            # Find all active printers for this driver
            result = await db.execute(
                select(Printer).where(
                    Printer.driver_key == driver_key,
                    Printer.deleted_at.is_(None),
                )
            )
            printers = result.scalars().all()
            if not printers:
                return

            printer_ids = [p.id for p in printers]
            # Rename only this driver's rows; an existing destination is authoritative.
            for model, entity_key in (
                (FilamentPrinterParam, "filament_id"),
                (SpoolPrinterParam, "spool_id"),
            ):
                if not legacy_renames:
                    break
                rows = list(await db.scalars(select(model).where(
                    model.printer_id.in_(printer_ids),
                    model.param_key.in_([*legacy_renames, *legacy_renames.values()]),
                )))
                existing = {
                    (getattr(row, entity_key), row.printer_id, row.param_key)
                    for row in rows
                }
                for row in rows:
                    new_key = legacy_renames.get(row.param_key)
                    if not new_key or (allowed_keys is not None and new_key not in allowed_keys):
                        continue
                    identity = (getattr(row, entity_key), row.printer_id, new_key)
                    if identity in existing:
                        await db.delete(row)
                    else:
                        row.param_key = new_key
                        existing.add(identity)
            await db.commit()

            # --- Restore identity keys misfiled as printer params by older versions ---
            await self._restore_kept_keys_from_params(
                db,
                SpoolPrinterParam,
                SpoolPrinterParam.spool_id,
                Spool,
                KEEP_IN_CUSTOM_FIELDS,
                printer_ids,
            )
            await self._restore_kept_keys_from_params(
                db,
                FilamentPrinterParam,
                FilamentPrinterParam.filament_id,
                Filament,
                KEEP_IN_CUSTOM_FIELDS,
                printer_ids,
            )
            # Missing calibration rows can mean the user cleared them after initialization.
            result = await db.execute(
                select(
                    FilamentPrinterInitialization.filament_id,
                    FilamentPrinterInitialization.printer_id,
                ).where(FilamentPrinterInitialization.printer_id.in_(printer_ids))
            )
            initialized_temperatures = set(result.all())

            # --- Filaments ---
            result = await db.execute(select(Filament))
            filaments = result.scalars().all()
            if any(f.extruder_temp_range_c or f.bed_temp_range_c for f in filaments):
                await db.commit()
                # Native defaults must not hide inherited calibration on unstarted printers.
                for printer_id in printer_ids:
                    await self._copy_params_to_new_printer(driver_key, printer_id)
            filament_param_keys = {
                "bambu_nozzle_temp_min",
                "bambu_nozzle_temp_max",
                "bambu_bed_temp",
            }
            for filament in filaments:
                filament_param_keys.update(
                    self._extract_bambu_params(
                        self._bambu_migration_source_fields(filament, allowed_keys, RENAME_KEYS),
                        KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS
                    )
                )
            existing_filament_params = {
                (row.filament_id, row.printer_id, row.param_key): row
                for row in await db.scalars(
                    select(FilamentPrinterParam).where(
                        FilamentPrinterParam.printer_id.in_(printer_ids),
                        FilamentPrinterParam.param_key.in_(filament_param_keys),
                    )
                )
            }
            migrated_filaments = 0

            for filament in filaments:
                bambu_params, preserve_invalid_nozzle_range = (
                    self._extract_bambu_migration(
                        self._bambu_migration_source_fields(filament, allowed_keys, RENAME_KEYS),
                        KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS
                    )
                )
                if allowed_keys is not None:
                    bambu_params = {k: v for k, v in bambu_params.items() if k in allowed_keys}
                native_temperatures = self._native_bambu_temperature_params(filament, allowed_keys)
                if not bambu_params and not native_temperatures:
                    continue

                await self._upsert_bambu_params(
                    db,
                    FilamentPrinterParam,
                    existing_filament_params,
                    filament.id,
                    "filament_id",
                    printer_ids,
                    bambu_params,
                    fallback_params=native_temperatures,
                    fallback_printer_ids={
                        printer_id
                        for printer_id in printer_ids
                        if (filament.id, printer_id) not in initialized_temperatures
                    },
                )
                if native_temperatures:
                    for printer_id in printer_ids:
                        if (filament.id, printer_id) not in initialized_temperatures:
                            db.add(
                                FilamentPrinterInitialization(
                                    filament_id=filament.id, printer_id=printer_id
                                )
                            )
                            initialized_temperatures.add((filament.id, printer_id))
                if bambu_params:
                    self._clean_bambu_keys_from_cf(
                        filament,
                        KEEP_IN_CUSTOM_FIELDS,
                        preserve_nozzle_temperature=preserve_invalid_nozzle_range,
                        source_fields=self._bambu_migration_source_fields(
                            filament, allowed_keys, RENAME_KEYS, for_cleanup=True,
                        ),
                    )
                migrated_filaments += 1

            # --- Spools ---
            result = await db.execute(
                select(Spool).where(Spool.custom_fields.isnot(None))
            )
            spools = result.scalars().all()
            spool_param_keys = {
                key
                for spool in spools
                for key in self._extract_bambu_params(
                    self._bambu_migration_source_fields(spool, allowed_keys, RENAME_KEYS),
                    KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS
                )
            }
            existing_spool_params = {
                (row.spool_id, row.printer_id, row.param_key): row
                for row in await db.scalars(
                    select(SpoolPrinterParam).where(
                        SpoolPrinterParam.printer_id.in_(printer_ids),
                        SpoolPrinterParam.param_key.in_(spool_param_keys),
                    )
                )
            }
            migrated_spools = 0

            for spool in spools:
                bambu_params, preserve_invalid_nozzle_range = (
                    self._extract_bambu_migration(
                        self._bambu_migration_source_fields(spool, allowed_keys, RENAME_KEYS),
                        KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS
                    )
                )
                if allowed_keys is not None:
                    bambu_params = {k: v for k, v in bambu_params.items() if k in allowed_keys}
                if not bambu_params:
                    continue

                await self._upsert_bambu_params(
                    db,
                    SpoolPrinterParam,
                    existing_spool_params,
                    spool.id,
                    "spool_id",
                    printer_ids,
                    bambu_params,
                )
                self._clean_bambu_keys_from_cf(
                    spool,
                    KEEP_IN_CUSTOM_FIELDS,
                    preserve_nozzle_temperature=preserve_invalid_nozzle_range,
                    source_fields=self._bambu_migration_source_fields(
                        spool, allowed_keys, RENAME_KEYS, for_cleanup=True,
                    ),
                )
                migrated_spools += 1

            await db.commit()
            if migrated_filaments or migrated_spools:
                logger.info(
                    f"Migrated Spoolman fields to printer_params: "
                    f"{migrated_filaments} filaments, {migrated_spools} spools "
                    f"(for {len(printer_ids)} {driver_key} printers)"
                )

    @staticmethod
    async def _restore_kept_keys_from_params(
        db: AsyncSession,
        param_model: type[FilamentPrinterParam] | type[SpoolPrinterParam],
        entity_column: Any,
        entity_model: type[Filament] | type[Spool],
        keep_keys: set[str],
        printer_ids: list[int],
    ) -> None:
        """Move keep_keys back from printer_params into custom_fields.

        Existing custom_fields values win; the param rows are deleted either way."""
        result = await db.execute(
            select(param_model).where(
                param_model.param_key.in_(list(keep_keys)),
                param_model.printer_id.in_(printer_ids),
            )
        )
        rows = result.scalars().all()
        if not rows:
            return

        restored: dict[int, dict[str, str]] = {}
        for row in sorted(rows, key=lambda r: r.printer_id):
            entity_id = getattr(row, entity_column.key)
            if row.param_value:
                restored.setdefault(entity_id, {}).setdefault(
                    row.param_key, row.param_value
                )
            await db.delete(row)

        for entity_id, values in restored.items():
            entity = await db.get(entity_model, entity_id)
            if entity is None:
                continue
            cf = dict(entity.custom_fields or {})
            for key, value in values.items():
                if not cf.get(key):
                    cf[key] = value
            entity.custom_fields = cf
            flag_modified(entity, "custom_fields")

        await db.commit()
        logger.info(
            f"Restored {len(rows)} misfiled {param_model.__tablename__} rows "
            f"to custom_fields"
        )

    @staticmethod
    async def _upsert_bambu_params(
        db: AsyncSession,
        param_model: type[FilamentPrinterParam] | type[SpoolPrinterParam],
        existing_params: dict[tuple[int, int, str], Any],
        entity_id: int,
        entity_id_field: str,
        printer_ids: list[int],
        params: dict[str, str],
        *,
        fallback_params: dict[str, str] | None = None,
        fallback_printer_ids: set[int] | None = None,
    ) -> None:
        """Persist every desired entity/printer/parameter value before cleanup."""
        for printer_id in printer_ids:
            use_fallback = (
                fallback_printer_ids is None or printer_id in fallback_printer_ids
            )
            desired_params = params
            if use_fallback and fallback_params:
                calibrated_params = dict(params)
                for key in {*fallback_params, "bambu_nozzle_temp_min", "bambu_nozzle_temp_max"}:
                    existing = existing_params.get((entity_id, printer_id, key))
                    if existing is not None:
                        calibrated_params[key] = existing.param_value
                desired_params = {
                    **PluginManager._bambu_temperature_fallbacks(fallback_params, calibrated_params),
                    **params,
                }
            for param_key, param_value in desired_params.items():
                existing = existing_params.get((entity_id, printer_id, param_key))
                if existing is not None:
                    continue
                row = param_model(
                    **{
                        entity_id_field: entity_id,
                        "printer_id": printer_id,
                        "param_key": param_key,
                        "param_value": param_value,
                    }
                )
                db.add(row)
                existing_params[(entity_id, printer_id, param_key)] = row

        # Do not remove source values until every desired row has passed DB validation.
        await db.flush()

    def _bambu_parameter_keys(self, driver_key: str, config: dict | None = None) -> set[str] | None:
        if config is None:
            config = (self._load_plugin_json(driver_key) or {}).get("printer_params", {})
        fields = config.get("fields")
        if not fields and driver_key == "bambulab":
            return None  # Keep legacy BambuLab manifests working without declarations.
        return {field["key"] for field in fields or [] if field["key"].startswith("bambu_")}

    @staticmethod
    def _bambu_migration_source_fields(
        entity: Filament | Spool, allowed_keys: set[str] | None, rename_keys: dict[str, str],
        *, for_cleanup: bool = False,
    ) -> dict:
        """Retained promotion snapshots and undeclared extras are not calibration."""
        aliases = getattr(entity, "label_field_aliases", None) or {}
        definitions = entity.custom_field_definitions or {}
        temperature_keys = {
            "nozzle_temperature": {"bambu_nozzle_temp_min", "bambu_nozzle_temp_max"},
            "settings_extruder_temp": {"bambu_nozzle_temp_min", "bambu_nozzle_temp_max"},
            "settings_bed_temp": {"bambu_bed_temp"},
        }

        def eligible(key, value, prefix=""):
            targets = temperature_keys.get(key, {rename_keys.get(key, key)})
            return not owns_retained_source(
                aliases.get(prefix + key), value, definitions.get(prefix + key)
            ) and (
                allowed_keys is None
                or (targets <= allowed_keys if for_cleanup else bool(targets & allowed_keys))
            )

        cf = entity.custom_fields or {}
        source = {k: v for k, v in cf.items() if eligible(k, v)}
        extra = cf.get("spoolman_extra")
        if isinstance(extra, dict):
            source["spoolman_extra"] = {
                k: v for k, v in extra.items() if eligible(k, v, "spoolman_extra.")
            }
        return source

    @staticmethod
    def _bambu_temperature_fallbacks(
        native_params: dict[str, str], calibrated_params: dict[str, str | None],
        fallback_params: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        """Keep native endpoints only when compatible with the surviving opposite bound."""
        opposites = {
            "bambu_nozzle_temp_min": "bambu_nozzle_temp_max",
            "bambu_nozzle_temp_max": "bambu_nozzle_temp_min",
        }
        candidates = {key: value for key, value in native_params.items() if key not in calibrated_params}
        effective_params = {
            **(fallback_params or {}),
            **candidates,
            **{key: value for key, value in calibrated_params.items() if value not in (None, "")},
        }
        fallback = {}
        for key, value in candidates.items():
            try:
                opposite = float(effective_params.get(opposites.get(key)))
            except (TypeError, ValueError, OverflowError):
                pass
            else:
                if math.isfinite(opposite) and (
                    (key.endswith("_min") and float(value) > opposite)
                    or (key.endswith("_max") and float(value) < opposite)
                ):
                    continue
            fallback[key] = value
        return fallback

    @staticmethod
    def _native_bambu_temperature_params(
        filament: Filament, allowed_keys: set[str] | None = None
    ) -> dict[str, str]:
        """Use native temperatures only below legacy fields and printer overrides."""
        params = {}
        for raw_range, min_key, max_key in (
            (
                filament.extruder_temp_range_c,
                "bambu_nozzle_temp_min",
                "bambu_nozzle_temp_max",
            ),
            (filament.bed_temp_range_c, "bambu_bed_temp", None),
        ):
            if not isinstance(raw_range, dict):
                continue
            try:
                temperature_range = convert_spoolman_value(raw_range, "float_range")
            except SpoolmanFieldError:
                continue
            minimum, maximum = temperature_range["min"], temperature_range["max"]
            # Bambu has one bed target; prefer the lower available endpoint.
            if max_key is None and minimum is None:
                minimum = maximum
            if minimum is not None:
                params[min_key] = str(minimum).removesuffix(".0")
            if max_key is not None and maximum is not None:
                params[max_key] = str(maximum).removesuffix(".0")
        return {
            key: value for key, value in params.items()
            if allowed_keys is None or key in allowed_keys
        }

    @staticmethod
    def _extract_bambu_params(
        custom_fields: dict[str, Any] | None,
        keep_keys: set[str],
        rename_keys: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Extract bambu_* calibration params from custom_fields.

        Keys in rename_keys are mapped to new names (e.g. bambu_idx -> bambu_tray_idx)."""
        params, _ = PluginManager._extract_bambu_migration(
            custom_fields, keep_keys, rename_keys
        )
        return params

    @staticmethod
    def _extract_bambu_migration(
        custom_fields: dict[str, Any] | None,
        keep_keys: set[str],
        rename_keys: dict[str, str] | None = None,
    ) -> tuple[dict[str, str], bool]:
        """Extract params and report whether an invalid native range must be kept."""
        cf = custom_fields or {}
        spoolman_extra = cf.get("spoolman_extra", {})
        if not isinstance(spoolman_extra, dict):
            spoolman_extra = {}

        rename_keys = rename_keys or {}
        params: dict[str, str] = {}
        # From spoolman_extra (lower priority)
        for k, v in spoolman_extra.items():
            if k.startswith("bambu_") and k not in keep_keys and v is not None and v != "":
                mapped_key = str(rename_keys.get(k, k))
                params[mapped_key] = str(v)
        # From top-level (higher priority, overwrites spoolman_extra)
        for k, v in cf.items():
            if (
                k.startswith("bambu_")
                and k not in keep_keys
                and k != "spoolman_extra"
                and v is not None and v != ""
            ):
                mapped_key = str(rename_keys.get(k, k))
                params[mapped_key] = str(v)

        # Migrate settings_bed_temp -> bambu_bed_temp (low priority, bambu_* wins)
        if "bambu_bed_temp" not in params:
            bed_temp = cf.get("settings_bed_temp")
            if bed_temp is not None and bed_temp != "":
                params["bambu_bed_temp"] = str(bed_temp)

        # Migrate nozzle temperatures (priority: bambu_* > spoolman_extra.nozzle_temperature > settings_extruder_temp > old bambu_nozzle_temp)
        nozzle_range = cf.get(
            "nozzle_temperature", spoolman_extra.get("nozzle_temperature")
        )
        preserve_invalid_nozzle_range = False
        if isinstance(nozzle_range, dict):
            try:
                validated_range = convert_spoolman_value(nozzle_range, "float_range")
            except SpoolmanFieldError:
                nozzle_min = nozzle_max = None
                preserve_invalid_nozzle_range = True
            else:
                nozzle_min = validated_range["min"]
                nozzle_max = validated_range["max"]
        elif isinstance(nozzle_range, (list, tuple)) and len(nozzle_range) >= 2:
            nozzle_min, nozzle_max = nozzle_range[0], nozzle_range[1]
        elif isinstance(nozzle_range, (list, tuple)) and len(nozzle_range) == 1:
            nozzle_min = nozzle_max = nozzle_range[0]
        else:
            nozzle_min = nozzle_max = None

        if "bambu_nozzle_temp_min" not in params:
            if nozzle_min is not None:
                params["bambu_nozzle_temp_min"] = str(nozzle_min)
            elif cf.get("settings_extruder_temp") is not None and cf["settings_extruder_temp"] != "":
                params["bambu_nozzle_temp_min"] = str(cf["settings_extruder_temp"])
            else:
                # Fallback: old bambu_nozzle_temp value
                old_nozzle = params.pop("bambu_nozzle_temp", None)
                if old_nozzle:
                    params["bambu_nozzle_temp_min"] = old_nozzle
        else:
            params.pop("bambu_nozzle_temp", None)

        if "bambu_nozzle_temp_max" not in params:
            if nozzle_max is not None:
                params["bambu_nozzle_temp_max"] = str(nozzle_max)
            elif cf.get("settings_extruder_temp") is not None and cf["settings_extruder_temp"] != "":
                params["bambu_nozzle_temp_max"] = str(cf["settings_extruder_temp"])

        return params, preserve_invalid_nozzle_range

    @staticmethod
    def _clean_bambu_keys_from_cf(
        entity: Filament | Spool,
        keep_keys: set[str],
        *,
        preserve_nozzle_temperature: bool = False,
        source_fields: dict | None = None,
    ) -> None:
        """Remove migrated bambu_* keys from entity custom_fields."""
        cf = entity.custom_fields or {}
        source_fields = cf if source_fields is None else source_fields

        # Remove top-level bambu_* keys (except keep_keys)
        # Keys to remove after migration (bambu_* except keep_keys + settings_* temps)
        SETTINGS_MIGRATE_KEYS = {
            "nozzle_temperature",
            "settings_bed_temp",
            "settings_extruder_temp",
        }
        new_cf = {
            k: v
            for k, v in cf.items()
            if not (
                k in source_fields
                and (
                    (k.startswith("bambu_") and k not in keep_keys)
                    or (
                        k in SETTINGS_MIGRATE_KEYS
                        and not (preserve_nozzle_temperature and k == "nozzle_temperature")
                    )
                )
            )
        }

        # Clean bambu_* and nozzle_temperature from spoolman_extra
        spoolman_extra = new_cf.get("spoolman_extra")
        if isinstance(spoolman_extra, dict):
            SPOOLMAN_MIGRATE_KEYS = {"nozzle_temperature"}
            cleaned = {
                k: v
                for k, v in spoolman_extra.items()
                if k not in source_fields.get("spoolman_extra", {})
                or (
                    not (k.startswith("bambu_") and k not in keep_keys)
                    and (k not in SPOOLMAN_MIGRATE_KEYS or preserve_nozzle_temperature)
                )
            }
            if cleaned:
                new_cf["spoolman_extra"] = cleaned
            else:
                new_cf.pop("spoolman_extra", None)

        entity.custom_fields = new_cf if new_cf else None
        flag_modified(entity, "custom_fields")

    async def _copy_params_to_new_printer(
        self,
        driver_key: str,
        printer_id: int,
    ) -> None:
        """Copy printer_params from an existing printer of the same driver to a new one.

        Called on every printer start.  If this printer has no printer_params
        but another printer with the same driver_key does, copies all params.
        Also searches soft-deleted printers as fallback source (for 'data kept' scenario).
        Idempotent — skips if printer already has params.
        """
        async with async_session_maker() as db:
            # Check if this printer already has any params
            existing = await db.execute(
                select(FilamentPrinterParam.id)
                .where(
                    FilamentPrinterParam.printer_id == printer_id,
                )
                .limit(1)
            )
            has_filament_params = existing.scalar_one_or_none() is not None

            existing = await db.execute(
                select(SpoolPrinterParam.id)
                .where(
                    SpoolPrinterParam.printer_id == printer_id,
                )
                .limit(1)
            )
            has_spool_params = existing.scalar_one_or_none() is not None

            if has_filament_params and has_spool_params:
                return  # Already has params

            # Find source printer: first try active printers, then soft-deleted
            source_id: int | None = None
            for include_deleted in (False, True):
                query = select(Printer.id).where(
                    Printer.driver_key == driver_key,
                    Printer.id != printer_id,
                )
                if not include_deleted:
                    query = query.where(Printer.deleted_at.is_(None))
                result = await db.execute(query)
                candidate_ids = [row[0] for row in result.all()]

                for cid in candidate_ids:
                    check = await db.execute(
                        select(FilamentPrinterParam.id)
                        .where(
                            FilamentPrinterParam.printer_id == cid,
                        )
                        .limit(1)
                    )
                    if check.scalar_one_or_none() is not None:
                        source_id = cid
                        break
                if source_id is not None:
                    break

            if source_id is None:
                return  # No source printer with params found

            copied_filament = 0
            copied_spool = 0

            # Copy filament params, excluding pairs already initialized and then cleared.
            if not has_filament_params:
                initialized = select(FilamentPrinterInitialization.filament_id).where(
                    FilamentPrinterInitialization.printer_id == printer_id,
                )
                result = await db.execute(
                    select(FilamentPrinterParam).where(
                        FilamentPrinterParam.printer_id == source_id,
                        FilamentPrinterParam.filament_id.notin_(initialized),
                    )
                )
                for param in result.scalars().all():
                    db.add(
                        FilamentPrinterParam(
                            filament_id=param.filament_id,
                            printer_id=printer_id,
                            param_key=param.param_key,
                            param_value=param.param_value,
                        )
                    )
                    copied_filament += 1

            # Copy spool params
            if not has_spool_params:
                result = await db.execute(
                    select(SpoolPrinterParam).where(
                        SpoolPrinterParam.printer_id == source_id,
                    )
                )
                for param in result.scalars().all():
                    db.add(
                        SpoolPrinterParam(
                            spool_id=param.spool_id,
                            printer_id=printer_id,
                            param_key=param.param_key,
                            param_value=param.param_value,
                        )
                    )
                    copied_spool += 1

            if copied_filament or copied_spool:
                await db.commit()
                logger.info(
                    f"Copied printer_params from printer {source_id} to {printer_id}: "
                    f"{copied_filament} filament params, {copied_spool} spool params"
                )

    # -- Filament Data Enrichment (Fallback Logic) ----------------------------

    async def enrich_filament_data(
        self,
        spool_id: int,
        printer_id: int,
        filament_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Enrich filament_data dict with printer-specific params.

        Fallback order:
        1. Spool-level printer_params for this printer
        2. Filament-level printer_params for this printer
        3. Declared native temperatures for pairs not initialized or cleared
        4. Values already in filament_data
        """
        async with async_session_maker() as db:
            # 1. Get spool to find filament_id
            spool = await db.get(Spool, spool_id)
            if not spool:
                return filament_data

            filament_id = spool.filament_id
            initialized = await db.get(FilamentPrinterInitialization, (filament_id, printer_id))
            native_params = {}
            if initialized is None:
                printer = await db.get(Printer, printer_id)
                filament = await db.get(Filament, filament_id)
                if printer and filament:
                    allowed_keys = self._bambu_parameter_keys(printer.driver_key)
                    native_params = self._native_bambu_temperature_params(filament, allowed_keys)

            # 2. Load filament-level params for this printer
            result = await db.execute(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament_id,
                    FilamentPrinterParam.printer_id == printer_id,
                )
            )
            filament_params = {
                p.param_key: p.param_value for p in result.scalars().all()
            }

            # 3. Load spool-level params for this printer (overrides filament-level)
            result = await db.execute(
                select(SpoolPrinterParam).where(
                    SpoolPrinterParam.spool_id == spool_id,
                    SpoolPrinterParam.printer_id == printer_id,
                )
            )
            spool_params = {p.param_key: p.param_value for p in result.scalars().all()}

        # 4. Merge: spool_params override filament_params
        calibrated_params = {**filament_params, **spool_params}
        caller_params = {
            key: filament_data.get(key) if filament_data.get(key) not in (None, "")
            else filament_data.get(key.removeprefix("bambu_"))
            for key in ("bambu_nozzle_temp_min", "bambu_nozzle_temp_max")
        }
        merged_params = {
            **self._bambu_temperature_fallbacks(native_params, calibrated_params, caller_params),
            **calibrated_params,
        }

        # 5. Only set non-empty values into filament_data
        enriched = {**filament_data}
        for key, value in merged_params.items():
            if value is not None and value != "":
                enriched[key] = value

        # 6. Inject the FilaMan spool and filament IDs so plugin drivers can
        # resolve spool- AND filament-level config (e.g. per-model slicer
        # profiles stored in Filament.custom_fields) at assign time.
        enriched["id"] = spool_id
        enriched["filament_id"] = filament_id

        return enriched


plugin_manager = PluginManager()
