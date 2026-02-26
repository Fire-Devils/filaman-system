import importlib
import json
import logging
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.core.database import async_session_maker
from app.models import Printer
from app.models.filament import Filament
from app.models.spool import Spool
from app.models.printer import PrinterSlot, PrinterSlotAssignment
from app.models.system_extra_field import SystemExtraField
from app.models.printer_params import FilamentPrinterParam, SpoolPrinterParam
from app.plugins.base import BaseDriver

logger = logging.getLogger(__name__)


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
            logger.debug(f"Event handler called for printer {printer_id}: {event.get('event_type')}")
            try:
                asyncio.create_task(self._handle_event(printer_id, event))
            except Exception as e:
                logger.error(f"Failed to create task for event: {e}", exc_info=True)

        return handler

    async def _handle_event(self, printer_id: int, event: dict) -> None:
        event_type = event.get("event_type")
        slots_count = len(event.get("slots", []))
        logger.info(f"Received event {event_type} for printer {printer_id} (slots: {slots_count})")

        if event_type == "slots_update":
            await self._handle_slots_update(printer_id, event.get("slots", []), event.get("ams_info"))

    @staticmethod
    def _slot_index_to_no(slot_index: str) -> int:
        """Convert driver slot_index string (e.g. '0-1', '255-254') to integer slot_no."""
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

    async def _handle_slots_update(self, printer_id: int, slots_data: list[dict], ams_info: dict | None = None) -> None:
        """Upsert PrinterSlot and PrinterSlotAssignment from driver slot events."""
        try:
            async with async_session_maker() as db:
                # Upsert slots if any
                if slots_data:
                    for slot_data in slots_data:
                        slot_index = slot_data.get("slot_index", "")
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
                        for key in ("tray_type", "tray_color", "tray_info_idx",
                                    "nozzle_temp_min", "nozzle_temp_max"):
                            if key in slot_data:
                                meta[key] = slot_data[key]

                        # Upsert PrinterSlotAssignment
                        # For new slots, always create assignment (no lazy-load risk)
                        # For existing slots, assignment is eager-loaded via selectinload
                        if is_new:
                            assignment = PrinterSlotAssignment(
                                slot_id=printer_slot.id,
                                present=present,
                                meta=meta,
                            )
                            db.add(assignment)
                        elif printer_slot.assignment:
                            printer_slot.assignment.present = present
                            printer_slot.assignment.meta = meta
                        else:
                            assignment = PrinterSlotAssignment(
                                slot_id=printer_slot.id,
                                present=present,
                                meta=meta,
                            )
                            db.add(assignment)
                    await db.commit()
                    logger.info(f"Updated {len(slots_data)} slots for printer {printer_id}")

                # Persist AMS/slot summary to Printer.custom_fields
                if ams_info:
                    printer = await db.get(Printer, printer_id)
                    if printer:
                        printer.custom_fields = {**(printer.custom_fields or {}), "slot_summary": ams_info}
                        flag_modified(printer, "custom_fields")
                        await db.commit()
                        logger.info(f"Persisted slot_summary for printer {printer_id}")
        except Exception as e:
            logger.error(f"Error in _handle_slots_update for printer {printer_id}: {e}", exc_info=True)

    def load_driver(self, driver_key: str) -> type[BaseDriver] | None:
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
            await self._copy_bambu_params_to_new_printer(printer.driver_key, printer.id)

            driver = driver_class(
                printer_id=printer.id,
                config=config,
                emitter=emitter.emit,
            )
            driver.validate_config()
            await driver.start()
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
        if driver:
            try:
                await driver.stop()
                logger.info(f"Stopped driver for printer {printer_id}")
            except Exception as e:
                logger.error(f"Error stopping driver for printer {printer_id}: {e}")

    async def start_all(self) -> None:
        async with async_session_maker() as db:
            result = await db.execute(
                select(Printer).where(
                    Printer.is_active == True,
                    Printer.deleted_at.is_(None),
                )
            )
            printers = result.scalars().all()

            for printer in printers:
                await self.start_printer(printer)

    async def stop_all(self) -> None:
        for printer_id in list(self.drivers.keys()):
            await self.stop_printer(printer_id)

    def get_health(self) -> dict[int, dict[str, Any]]:
        for printer_id, driver in self.drivers.items():
            self.health_status[printer_id] = driver.health()
        return self.health_status

    # -- Plugin Extra-Field Management ----------------------------------------

    async def _ensure_plugin_extra_fields(self, driver_key: str) -> None:
        """Ensure plugin-specific SystemExtraFields exist. Idempotent — safe to call on every start."""
        if driver_key == "bambulab":
            await self._ensure_bambu_extra_fields()

    async def _ensure_bambu_extra_fields(self) -> None:
        """Create or update the bambu_idx dropdown field for filaments."""
        # Load filament index from plugin JSON
        json_path = Path(__file__).parent / "bambulab" / "bambu_filaments.json"
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to load bambu_filaments.json: {e}")
            return

        # Build dropdown options: "GFA00 — Bambu PLA Basic"
        options: list[str] = []
        for idx, info in raw.items():
            if idx.startswith("_"):  # skip comments
                continue
            name = info.get("name", idx)
            options.append(f"{idx} \u2014 {name}")
        options.sort()

        async with async_session_maker() as db:
            result = await db.execute(
                select(SystemExtraField).where(
                    SystemExtraField.target_type == "filament",
                    SystemExtraField.key == "bambu_idx",
                )
            )
            field = result.scalar_one_or_none()

            if field:
                # Update options from JSON (plugin may have been updated)
                if field.options != options:
                    field.options = options
                    flag_modified(field, "options")
                    await db.commit()
                    logger.info("Updated bambu_idx dropdown options")
            else:
                field = SystemExtraField(
                    target_type="filament",
                    key="bambu_idx",
                    label="Bambu Lab Material Index",
                    field_type="dropdown",
                    options=options,
                    source="bambulab",
                )
                db.add(field)
                await db.commit()
                logger.info("Created bambu_idx SystemExtraField (dropdown)")

    async def _migrate_spoolman_bambu_fields(self, driver_key: str) -> None:
        """Migrate bambu_* calibration data from custom_fields into printer_params tables.

        Extracts per-printer calibration fields (bambu_setting_id, bambu_k_value, etc.)
        from custom_fields.spoolman_extra and top-level custom_fields, creates
        FilamentPrinterParam / SpoolPrinterParam entries for all existing Bambu printers,
        then removes the migrated keys from custom_fields.

        Note: spoolman_extra.bambu_idx is actually tray_info_idx and is renamed to
        bambu_tray_idx during migration.
        Idempotent — skips entities that already have printer_params for any Bambu printer.
        """
        if driver_key != "bambulab":
            return

        KEEP_IN_CUSTOM_FIELDS: set[str] = set()  # Nothing kept — bambu_idx is actually tray_info_idx
        # Rename map: spoolman field name -> printer_param key
        RENAME_KEYS = {"bambu_idx": "bambu_tray_idx"}

        async with async_session_maker() as db:
            # Find all active Bambu printers
            result = await db.execute(
                select(Printer).where(
                    Printer.driver_key == "bambulab",
                    Printer.deleted_at.is_(None),
                )
            )
            bambu_printers = result.scalars().all()
            if not bambu_printers:
                return

            bambu_printer_ids = [p.id for p in bambu_printers]

            # --- Filaments ---
            result = await db.execute(select(Filament).where(Filament.custom_fields.isnot(None)))
            filaments = result.scalars().all()
            migrated_filaments = 0

            for filament in filaments:
                bambu_params = self._extract_bambu_params(filament.custom_fields, KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS)
                if not bambu_params:
                    continue

                # Skip if printer_params already exist for this filament + any Bambu printer
                existing = await db.execute(
                    select(FilamentPrinterParam.id).where(
                        FilamentPrinterParam.filament_id == filament.id,
                        FilamentPrinterParam.printer_id.in_(bambu_printer_ids),
                    ).limit(1)
                )
                if existing.scalar_one_or_none() is not None:
                    # Already migrated — still clean up custom_fields if needed
                    self._clean_bambu_keys_from_cf(filament, KEEP_IN_CUSTOM_FIELDS)
                    continue

                # Create printer_params for each Bambu printer
                for pid in bambu_printer_ids:
                    for param_key, param_value in bambu_params.items():
                        db.add(FilamentPrinterParam(
                            filament_id=filament.id,
                            printer_id=pid,
                            param_key=param_key,
                            param_value=param_value,
                        ))

                self._clean_bambu_keys_from_cf(filament, KEEP_IN_CUSTOM_FIELDS)
                migrated_filaments += 1

            # --- Spools ---
            result = await db.execute(select(Spool).where(Spool.custom_fields.isnot(None)))
            spools = result.scalars().all()
            migrated_spools = 0

            for spool in spools:
                bambu_params = self._extract_bambu_params(spool.custom_fields, KEEP_IN_CUSTOM_FIELDS, RENAME_KEYS)
                if not bambu_params:
                    continue

                existing = await db.execute(
                    select(SpoolPrinterParam.id).where(
                        SpoolPrinterParam.spool_id == spool.id,
                        SpoolPrinterParam.printer_id.in_(bambu_printer_ids),
                    ).limit(1)
                )
                if existing.scalar_one_or_none() is not None:
                    self._clean_bambu_keys_from_cf(spool, KEEP_IN_CUSTOM_FIELDS)
                    continue

                for pid in bambu_printer_ids:
                    for param_key, param_value in bambu_params.items():
                        db.add(SpoolPrinterParam(
                            spool_id=spool.id,
                            printer_id=pid,
                            param_key=param_key,
                            param_value=param_value,
                        ))

                self._clean_bambu_keys_from_cf(spool, KEEP_IN_CUSTOM_FIELDS)
                migrated_spools += 1

            await db.commit()
            if migrated_filaments or migrated_spools:
                logger.info(
                    f"Migrated Spoolman bambu_* fields to printer_params: "
                    f"{migrated_filaments} filaments, {migrated_spools} spools "
                    f"(for {len(bambu_printer_ids)} Bambu printers)"
                )

    @staticmethod
    def _extract_bambu_params(
        custom_fields: dict[str, Any] | None, keep_keys: set[str],
        rename_keys: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Extract bambu_* calibration params from custom_fields.

        Keys in rename_keys are mapped to new names (e.g. bambu_idx -> bambu_tray_idx)."""
        cf = custom_fields or {}
        spoolman_extra = cf.get("spoolman_extra", {})
        if not isinstance(spoolman_extra, dict):
            spoolman_extra = {}

        rename_keys = rename_keys or {}
        params: dict[str, str] = {}
        # From spoolman_extra (lower priority)
        for k, v in spoolman_extra.items():
            if k.startswith("bambu_") and k not in keep_keys and v:
                mapped_key = rename_keys.get(k, k)
                params[mapped_key] = str(v)
        # From top-level (higher priority, overwrites spoolman_extra)
        for k, v in cf.items():
            if k.startswith("bambu_") and k not in keep_keys and k != "spoolman_extra" and v:
                mapped_key = rename_keys.get(k, k)
                params[mapped_key] = str(v)
        return params

    @staticmethod
    def _clean_bambu_keys_from_cf(
        entity: Filament | Spool, keep_keys: set[str],
    ) -> None:
        """Remove migrated bambu_* keys from entity custom_fields."""
        cf = entity.custom_fields or {}

        # Remove top-level bambu_* keys (except keep_keys)
        new_cf = {k: v for k, v in cf.items()
                  if not (k.startswith("bambu_") and k not in keep_keys)}

        # Clean bambu_* from spoolman_extra
        spoolman_extra = new_cf.get("spoolman_extra")
        if isinstance(spoolman_extra, dict):
            cleaned = {k: v for k, v in spoolman_extra.items()
                       if not k.startswith("bambu_")}
            if cleaned:
                new_cf["spoolman_extra"] = cleaned
            else:
                new_cf.pop("spoolman_extra", None)

        entity.custom_fields = new_cf if new_cf else None
        flag_modified(entity, "custom_fields")

    async def _copy_bambu_params_to_new_printer(
        self, driver_key: str, printer_id: int,
    ) -> None:
        """Copy printer_params from an existing Bambu printer to a new one.

        Called on every Bambu printer start. If this printer has no printer_params
        but another Bambu printer does, copies all params to this printer.
        Idempotent — skips if printer already has params.
        """
        if driver_key != "bambulab":
            return

        async with async_session_maker() as db:
            # Check if this printer already has any filament params
            existing = await db.execute(
                select(FilamentPrinterParam.id).where(
                    FilamentPrinterParam.printer_id == printer_id,
                ).limit(1)
            )
            has_filament_params = existing.scalar_one_or_none() is not None

            existing = await db.execute(
                select(SpoolPrinterParam.id).where(
                    SpoolPrinterParam.printer_id == printer_id,
                ).limit(1)
            )
            has_spool_params = existing.scalar_one_or_none() is not None

            if has_filament_params and has_spool_params:
                return  # Already has params

            # Find another Bambu printer that has params
            result = await db.execute(
                select(Printer.id).where(
                    Printer.driver_key == "bambulab",
                    Printer.id != printer_id,
                    Printer.deleted_at.is_(None),
                )
            )
            other_printer_ids = [row[0] for row in result.all()]

            source_id: int | None = None
            for other_id in other_printer_ids:
                check = await db.execute(
                    select(FilamentPrinterParam.id).where(
                        FilamentPrinterParam.printer_id == other_id,
                    ).limit(1)
                )
                if check.scalar_one_or_none() is not None:
                    source_id = other_id
                    break

            if source_id is None:
                return  # No source printer with params found

            copied_filament = 0
            copied_spool = 0

            # Copy filament params
            if not has_filament_params:
                result = await db.execute(
                    select(FilamentPrinterParam).where(
                        FilamentPrinterParam.printer_id == source_id,
                    )
                )
                for param in result.scalars().all():
                    db.add(FilamentPrinterParam(
                        filament_id=param.filament_id,
                        printer_id=printer_id,
                        param_key=param.param_key,
                        param_value=param.param_value,
                    ))
                    copied_filament += 1

            # Copy spool params
            if not has_spool_params:
                result = await db.execute(
                    select(SpoolPrinterParam).where(
                        SpoolPrinterParam.printer_id == source_id,
                    )
                )
                for param in result.scalars().all():
                    db.add(SpoolPrinterParam(
                        spool_id=param.spool_id,
                        printer_id=printer_id,
                        param_key=param.param_key,
                        param_value=param.param_value,
                    ))
                    copied_spool += 1

            if copied_filament or copied_spool:
                await db.commit()
                logger.info(
                    f"Copied printer_params from printer {source_id} to {printer_id}: "
                    f"{copied_filament} filament params, {copied_spool} spool params"
                )
    # -- Filament Data Enrichment (Fallback Logic) ----------------------------

    async def enrich_filament_data(
        self, spool_id: int, printer_id: int, filament_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Enrich filament_data dict with printer-specific params.

        Fallback order:
        1. Spool-level printer_params for this printer
        2. Filament-level printer_params for this printer
        3. Values already in filament_data (unchanged)
        """
        async with async_session_maker() as db:
            # 1. Get spool to find filament_id
            spool = await db.get(Spool, spool_id)
            if not spool:
                return filament_data

            filament_id = spool.filament_id

            # 2. Load filament-level params for this printer
            result = await db.execute(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament_id,
                    FilamentPrinterParam.printer_id == printer_id,
                )
            )
            filament_params = {p.param_key: p.param_value for p in result.scalars().all()}

            # 3. Load spool-level params for this printer (overrides filament-level)
            result = await db.execute(
                select(SpoolPrinterParam).where(
                    SpoolPrinterParam.spool_id == spool_id,
                    SpoolPrinterParam.printer_id == printer_id,
                )
            )
            spool_params = {p.param_key: p.param_value for p in result.scalars().all()}

        # 4. Merge: spool_params override filament_params
        merged_params = {**filament_params, **spool_params}

        # 5. Only set non-empty values into filament_data
        enriched = {**filament_data}
        for key, value in merged_params.items():
            if value is not None and value != "":
                enriched[key] = value

        return enriched

plugin_manager = PluginManager()
