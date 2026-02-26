import importlib
import json
import logging
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import select, update
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
                                    "nozzle_temp_min", "nozzle_temp_max",
                                    "setting_id", "cali_idx"):
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
            await self._copy_params_to_new_printer(printer.driver_key, printer.id)

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

    def _load_plugin_json(self, driver_key: str) -> dict[str, Any] | None:
        """Load and return the parsed plugin.json for a given driver."""
        json_path = Path(__file__).parent / driver_key / "plugin.json"
        try:
            return json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.warning(f"Could not load plugin.json for {driver_key}: {e}")
            return None

    def _resolve_options(self, driver_key: str, field_def: dict[str, Any]) -> list[str] | None:
        """Resolve dropdown options for a field definition.

        If field_def has 'options_file', loads the JSON file from the plugin directory
        and builds 'key — name' strings.  If field_def has static 'options', returns those.
        """
        options_file = field_def.get("options_file")
        if options_file:
            file_path = Path(__file__).parent / driver_key / options_file
            try:
                raw = json.loads(file_path.read_text(encoding="utf-8"))
                options: list[str] = []
                for idx, info in raw.items():
                    if idx.startswith("_"):  # skip comments
                        continue
                    name = info.get("name", idx) if isinstance(info, dict) else str(info)
                    options.append(f"{idx} \u2014 {name}")
                options.sort()
                return options
            except (OSError, json.JSONDecodeError) as e:
                logger.warning(f"{options_file} not found or invalid ({e}); dropdown will have no options")
                return []
        return field_def.get("options")

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

        # Build resolved field definitions (with dropdown options loaded)
        resolved_fields: list[dict[str, Any]] = []
        for fdef in field_defs:
            options = self._resolve_options(driver_key, fdef)
            resolved_fields.append({
                "key": fdef["key"],
                "label": fdef["label"],
                "field_type": fdef.get("field_type", "text"),
                "options": options,
            })

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
                        if field.options != fdef["options"]:
                            field.options = fdef["options"]
                            flag_modified(field, "options")
                            changed = True
                        if field.label != fdef["label"]:
                            field.label = fdef["label"]
                            changed = True
                        if field.field_type != fdef["field_type"]:
                            field.field_type = fdef["field_type"]
                            changed = True
                        if changed:
                            logger.info(f"Updated {target_type}/{fdef['key']} field definition")
                    else:
                        db.add(SystemExtraField(
                            target_type=target_type,
                            key=fdef["key"],
                            label=fdef["label"],
                            field_type=fdef["field_type"],
                            options=fdef["options"],
                            source=driver_key,
                        ))
                        logger.info(f"Created {target_type}/{fdef['key']} SystemExtraField")

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
                        logger.info(f"Removed legacy {target_type}/{old_key} SystemExtraField")

            # Clean up legacy fields with old target_type (e.g. 'filament' instead of 'filament_printer_param')
            legacy_target_cleanup = await db.execute(
                select(SystemExtraField).where(
                    SystemExtraField.source == driver_key,
                    SystemExtraField.target_type.notin_(target_types),
                )
            )
            for legacy_field in legacy_target_cleanup.scalars().all():
                await db.delete(legacy_field)
                logger.info(f"Removed legacy {legacy_field.target_type}/{legacy_field.key} SystemExtraField (wrong target_type)")

            await db.commit()

    async def _migrate_spoolman_bambu_fields(self, driver_key: str) -> None:
        """Migrate bambu_* calibration data from custom_fields into printer_params tables.

        Extracts per-printer calibration fields (bambu_setting_id, bambu_k_value, etc.)
        from custom_fields.spoolman_extra and top-level custom_fields, creates
        FilamentPrinterParam / SpoolPrinterParam entries for all existing printers of
        this driver, then removes the migrated keys from custom_fields.

        Uses legacy_renames from plugin.json to rename old field keys.
        Idempotent — skips entities that already have printer_params for any printer."""
        # Load legacy_renames from plugin.json
        plugin_json = self._load_plugin_json(driver_key)
        if not plugin_json:
            return
        printer_params_cfg = plugin_json.get("printer_params", {})
        migration = printer_params_cfg.get("migration", {})
        legacy_renames = migration.get("legacy_renames", {})

        # Build rename map: includes legacy_renames + spoolman-specific renames
        # (bambu_idx in spoolman is actually tray_info_idx)
        RENAME_KEYS = {**legacy_renames}
        if driver_key == "bambulab":
            RENAME_KEYS["bambu_idx"] = "bambu_tray_idx"  # spoolman-specific rename

        KEEP_IN_CUSTOM_FIELDS: set[str] = set()  # Nothing kept

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

            # --- Fix legacy param_key names from earlier migrations ---
            for old_key, new_key in legacy_renames.items():
                await db.execute(
                    update(FilamentPrinterParam)
                    .where(FilamentPrinterParam.param_key == old_key)
                    .values(param_key=new_key)
                )
                await db.execute(
                    update(SpoolPrinterParam)
                    .where(SpoolPrinterParam.param_key == old_key)
                    .values(param_key=new_key)
                )
            await db.commit()
            logger.debug("Legacy param_key renames applied (if any)")
            printer_ids = [p.id for p in printers]

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
                        FilamentPrinterParam.printer_id.in_(printer_ids),
                    ).limit(1)
                )
                if existing.scalar_one_or_none() is not None:
                    # Already migrated — still clean up custom_fields if needed
                    self._clean_bambu_keys_from_cf(filament, KEEP_IN_CUSTOM_FIELDS)
                    continue

                # Create printer_params for each printer of this driver
                for pid in printer_ids:
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
                        SpoolPrinterParam.printer_id.in_(printer_ids),
                    ).limit(1)
                )
                if existing.scalar_one_or_none() is not None:
                    self._clean_bambu_keys_from_cf(spool, KEEP_IN_CUSTOM_FIELDS)
                    continue

                for pid in printer_ids:
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
                    f"Migrated Spoolman fields to printer_params: "
                    f"{migrated_filaments} filaments, {migrated_spools} spools "
                    f"(for {len(printer_ids)} {driver_key} printers)"
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

        # Migrate settings_bed_temp -> bambu_bed_temp (low priority, bambu_* wins)
        if "bambu_bed_temp" not in params:
            bed_temp = cf.get("settings_bed_temp")
            if bed_temp:
                params["bambu_bed_temp"] = str(bed_temp)

        # Migrate nozzle temperatures (priority: bambu_* > spoolman_extra.nozzle_temperature > settings_extruder_temp > old bambu_nozzle_temp)
        nozzle_range = spoolman_extra.get("nozzle_temperature")
        if isinstance(nozzle_range, (list, tuple)) and len(nozzle_range) >= 2:
            nozzle_min, nozzle_max = nozzle_range[0], nozzle_range[1]
        elif isinstance(nozzle_range, (list, tuple)) and len(nozzle_range) == 1:
            nozzle_min = nozzle_max = nozzle_range[0]
        else:
            nozzle_min = nozzle_max = None

        if "bambu_nozzle_temp_min" not in params:
            if nozzle_min is not None:
                params["bambu_nozzle_temp_min"] = str(nozzle_min)
            elif cf.get("settings_extruder_temp"):
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
            elif cf.get("settings_extruder_temp"):
                params["bambu_nozzle_temp_max"] = str(cf["settings_extruder_temp"])

        return params

    @staticmethod
    def _clean_bambu_keys_from_cf(
        entity: Filament | Spool, keep_keys: set[str],
    ) -> None:
        """Remove migrated bambu_* keys from entity custom_fields."""
        cf = entity.custom_fields or {}

        # Remove top-level bambu_* keys (except keep_keys)
        # Keys to remove after migration (bambu_* except keep_keys + settings_* temps)
        SETTINGS_MIGRATE_KEYS = {"settings_bed_temp", "settings_extruder_temp"}
        new_cf = {k: v for k, v in cf.items()
                  if not ((k.startswith("bambu_") and k not in keep_keys) or k in SETTINGS_MIGRATE_KEYS)}

        # Clean bambu_* and nozzle_temperature from spoolman_extra
        spoolman_extra = new_cf.get("spoolman_extra")
        if isinstance(spoolman_extra, dict):
            SPOOLMAN_MIGRATE_KEYS = {"nozzle_temperature"}
            cleaned = {k: v for k, v in spoolman_extra.items()
                       if not k.startswith("bambu_") and k not in SPOOLMAN_MIGRATE_KEYS}
            if cleaned:
                new_cf["spoolman_extra"] = cleaned
            else:
                new_cf.pop("spoolman_extra", None)

        entity.custom_fields = new_cf if new_cf else None
        flag_modified(entity, "custom_fields")

    async def _copy_params_to_new_printer(
        self, driver_key: str, printer_id: int,
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
                        select(FilamentPrinterParam.id).where(
                            FilamentPrinterParam.printer_id == cid,
                        ).limit(1)
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
