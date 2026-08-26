"""Spoolman-Import-Service: Daten aus einer Spoolman-Instanz importieren."""

import hashlib
import hmac
import json
import logging
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.models.location import Location
from app.models.spool import Spool, SpoolStatus
from app.services.spoolman_client import SpoolmanClient
from app.services.spoolman_contracts import (
    ImportStorageMode,
    SpoolmanFieldAction,
    SpoolmanFieldCandidate,
)
from app.services.spoolman_errors import SpoolmanImportError
from app.services.spoolman_extra_field_mapping import (
    SpoolmanFieldError,
    canonicalize_definition_lists,
    convert_spoolman_value,
    fingerprint,
    map_spoolman_definition,
)
from app.services.spoolman_extra_field_planner import (
    DefinitionAssessment,
    SpoolmanExtraFieldPlanner,
)
from app.utils.colors import normalize_spoolmandb_hex_color
from app.utils.db import json_extract_cast_string

logger = logging.getLogger(__name__)


SpoolmanClientFactory = Callable[
    [str], AbstractAsyncContextManager[SpoolmanClient]
]


@dataclass
class ImportPreview:
    """Vorschau der zu importierenden Daten."""

    vendors: list[dict[str, Any]] = field(default_factory=list)
    filaments: list[dict[str, Any]] = field(default_factory=list)
    spools: list[dict[str, Any]] = field(default_factory=list)
    locations: list[dict[str, Any]] = field(default_factory=list)
    colors: list[dict[str, str]] = field(default_factory=list)
    field_definitions: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    available_field_targets: set[str] = field(default_factory=set)
    extra_fields: list[dict[str, Any]] = field(default_factory=list)
    extra_field_fingerprint: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def summary(self) -> dict[str, int]:
        return {
            "vendors": len(self.vendors),
            "filaments": len(self.filaments),
            "spools": len(self.spools),
            "locations": len(self.locations),
            "colors": len(self.colors),
        }


@dataclass
class ImportResult:
    """Ergebnis des Imports."""

    manufacturers_created: int = 0
    manufacturers_skipped: int = 0
    locations_created: int = 0
    locations_skipped: int = 0
    colors_created: int = 0
    colors_skipped: int = 0
    color_assignments_repaired: int = 0
    filaments_created: int = 0
    filaments_skipped: int = 0
    spools_created: int = 0
    spools_skipped: int = 0
    extra_fields_created: int = 0
    extra_fields_reused: int = 0
    extra_fields_conflicted: int = 0
    extra_values_promoted: int = 0
    extra_values_preserved: int = 0
    extra_local_definitions: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TransparencyRepairCandidate:
    """One source-backed alpha assignment that differs from local storage."""

    filament_id: int
    spoolman_id: str
    position: int
    target_hex: str
    current_hex: str | None


@dataclass(frozen=True, slots=True)
class SourceFieldInput:
    target_type: str
    key: str
    label: str
    order: int
    candidate: SpoolmanFieldCandidate | None
    error: str | None


def _source_field_inputs(
    definitions: dict[str, list[dict[str, Any]]],
) -> list[SourceFieldInput]:
    inputs: list[SourceFieldInput] = []
    for target in ("vendor", "filament", "spool"):
        ordered = sorted(
            definitions.get(target, []),
            key=lambda item: (item.get("order", 0), str(item.get("key", ""))),
        )
        for raw in ordered:
            raw_key = raw.get("key")
            key = raw_key if isinstance(raw_key, str) else ""
            raw_label = raw.get("name", key)
            label = raw_label if isinstance(raw_label, str) else key
            order = raw.get("order", 0) if isinstance(raw.get("order", 0), int) else 0
            try:
                mapped = map_spoolman_definition(raw, target)
            except ValueError as exc:
                inputs.append(
                    SourceFieldInput(
                        target_type=target,
                        key=key,
                        label=label,
                        order=order,
                        candidate=None,
                        error=str(exc),
                    )
                )
            else:
                inputs.append(
                    SourceFieldInput(
                        target_type=target,
                        key=mapped.key,
                        label=mapped.label,
                        order=mapped.order,
                        candidate=mapped,
                        error=None,
                    )
                )
    return inputs


class SpoolmanImportService:
    """Service fuer den Import aus einer Spoolman-Instanz."""

    def __init__(
        self,
        db: AsyncSession,
        client_factory: SpoolmanClientFactory = SpoolmanClient,
    ):
        self.db = db
        self._client_factory = client_factory

    @property
    def dialect(self):
        """Get the database dialect for JSON operations."""
        return self.db.bind.dialect

    @staticmethod
    def _normalize_hex_code(value: Any) -> str | None:
        try:
            return normalize_spoolmandb_hex_color(value)
        except ValueError:
            return None

    # ------------------------------------------------------------------ #
    #  Verbindungstest
    # ------------------------------------------------------------------ #

    async def test_connection(self, base_url: str) -> dict[str, Any]:
        """Test the source connection and return normalized server info."""
        async with self._client_factory(base_url) as client:
            info = await client.get_info()
        return {
            "status": "ok",
            "url": base_url.rstrip("/"),
            "info": info,
        }

    # ------------------------------------------------------------------ #
    #  Vorschau
    # ------------------------------------------------------------------ #

    async def preview(self, base_url: str) -> ImportPreview:
        """Vorschau: Welche Daten wuerden importiert?"""
        async with self._client_factory(base_url) as client:
            params = {"allow_archived": "true"}

            vendors = await client.fetch_all("vendor", params)
            filaments = await client.fetch_all("filament", params)
            spools = await client.fetch_all("spool", params)

            # 4. Locations aus dem /location Endpoint laden
            # Die Spulen werden später den importierten Standorten zugeordnet
            locations = []
            try:
                locations = await client.fetch_all("location")
            except SpoolmanImportError as exc:
                logger.warning("Could not fetch locations: %s", exc)

            (
                field_definitions,
                field_warnings,
                available_field_targets,
            ) = await client.fetch_field_definitions()

            # Deduplizierung nach name (case-insensitive)
            # Spoolman kann Locations als String-Array oder als Objekte zurückgeben
            seen_names: set[str] = set()
            unique_locations: list[dict[str, Any]] = []
            temp_id = 1  # Temporäre ID für Standorte ohne spoolman_id
            for loc in locations:
                if isinstance(loc, str):
                    # String-Standort behandeln (z.B. ["Regal", "Neuer Ort"])
                    name = loc.strip()
                    if name:
                        name_lower = name.lower()
                        if name_lower not in seen_names:
                            seen_names.add(name_lower)
                            # Temporäre ID vergeben, da Spoolman keine ID liefert
                            unique_locations.append(
                                {"id": f"temp_{temp_id}", "name": name}
                            )
                            temp_id += 1
                elif isinstance(loc, dict) and loc.get("name"):
                    # Objekt-Standort behandeln (z.B. [{"id": 1, "name": "Regal"}])
                    name = str(loc.get("name")).strip()
                    if name:
                        name_lower = name.lower()
                        if name_lower not in seen_names:
                            seen_names.add(name_lower)
                            unique_locations.append(loc)
            locations = unique_locations

        colors = self._extract_colors(filaments)

        extra_fields = await self._preview_extra_field_definitions(field_definitions)
        return ImportPreview(
            vendors=vendors,
            filaments=filaments,
            spools=spools,
            locations=locations,
            colors=colors,
            field_definitions=field_definitions,
            available_field_targets=available_field_targets,
            extra_fields=extra_fields,
            extra_field_fingerprint=self.extra_field_definition_fingerprint(
                field_definitions,
                available_field_targets,
            ),
            warnings=field_warnings,
        )

    @staticmethod
    def extra_field_definition_fingerprint(
        definitions: dict[str, list[dict[str, Any]]],
        available_targets: set[str],
    ) -> str:
        """Bind rich import execution to semantic endpoint definitions."""
        return fingerprint(
            {
                "definitions": canonicalize_definition_lists(definitions),
                "available_targets": sorted(available_targets),
            }
        )

    def _extract_colors(self, filaments: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Eindeutige Farben aus Spoolman-Filamenten extrahieren."""
        seen: set[str] = set()
        colors: list[dict[str, str]] = []

        for fil in filaments:
            for normalized in self._filament_hex_codes(fil):
                if normalized.lower() not in seen:
                    seen.add(normalized.lower())
                    colors.append({"name": normalized, "hex_code": normalized})

        return colors

    def _filament_hex_codes(self, filament: dict[str, Any]) -> list[str]:
        """Return normalized primary and multi-color values in display order."""
        return [
            normalized
            for _, normalized in self._filament_color_positions(filament)
        ]

    def _filament_hex_positions(
        self,
        values: list[Any],
    ) -> list[tuple[int, str]]:
        """Normalize colors without compacting invalid source positions."""
        normalized_values: list[tuple[int, str]] = []
        for position, value in enumerate(values, start=1):
            normalized = self._normalize_hex_code(value)
            if normalized is not None:
                normalized_values.append((position, normalized))
        return normalized_values

    def _filament_color_positions(
        self,
        filament: dict[str, Any],
    ) -> list[tuple[int, str]]:
        """Return ordered colors for both full-list and secondary-list APIs."""
        primary = self._normalize_hex_code(filament.get("color_hex"))
        multi = filament.get("multi_color_hexes")
        if multi:
            values = multi if isinstance(multi, list) else str(multi).split(",")
            positions = self._filament_hex_positions(values)
            first_multi = self._normalize_hex_code(values[0]) if values else None
            if primary is not None and first_multi != primary:
                return [(1, primary)] + [
                    (position + 1, normalized)
                    for position, normalized in positions
                ]
            return positions
        return [(1, primary)] if primary is not None else []

    # ------------------------------------------------------------------ #
    #  Import ausfuehren
    # ------------------------------------------------------------------ #

    async def execute(
        self,
        base_url: str,
        expected_extra_field_fingerprint: str | None = None,
        extra_field_mode: ImportStorageMode | str | None = None,
        field_actions: list[SpoolmanFieldAction | dict[str, Any]] | None = None,
    ) -> ImportResult:
        """Vollstaendigen Import aus Spoolman ausfuehren."""
        rich_options_supplied = extra_field_mode is not None or field_actions is not None
        if rich_options_supplied and not expected_extra_field_fingerprint:
            raise SpoolmanImportError(
                "Load a rich-field preview before executing an import with "
                "extra-field options.",
                "preview_required",
            )
        try:
            mode = ImportStorageMode(extra_field_mode or ImportStorageMode.LEGACY)
        except ValueError as exc:
            raise SpoolmanImportError(
                f"Unsupported extra field import mode: {extra_field_mode}",
                "invalid_extra_field_mode",
            ) from exc
        try:
            actions = [
                item
                if isinstance(item, SpoolmanFieldAction)
                else SpoolmanFieldAction.model_validate(item)
                for item in (field_actions or [])
            ]
        except ValueError as exc:
            raise SpoolmanImportError(
                "Invalid per-field extra field action.",
                "invalid_extra_field_action",
            ) from exc
        result = ImportResult()
        preview = await self.preview(base_url)
        repair_candidates = await self.analyze_transparency_repairs(
            preview.filaments
        )
        if (
            expected_extra_field_fingerprint is not None
            and preview.extra_field_fingerprint != expected_extra_field_fingerprint
        ):
            raise SpoolmanImportError(
                "Spoolman field definitions changed; load a new preview.",
                "preview_changed",
            )
        result.warnings.extend(preview.warnings)

        field_mappings = await self._plan_import_extra_fields(
            preview.field_definitions,
            result,
            mode,
            actions,
        )

        # 1. Spool-Status-Mapping laden
        status_map = await self._load_status_map()

        # 2. Locations importieren
        location_map, name_map = await self._import_locations(preview.locations, result)

        # 3. Manufacturers importieren
        manufacturer_map = await self._import_manufacturers(preview.vendors, result)

        # 4. Colors importieren
        color_map = await self._import_colors(preview.colors, result)
        await self._apply_transparency_repairs(
            repair_candidates,
            color_map,
            result,
        )

        # 5. Filaments importieren
        filament_map = await self._import_filaments(
            preview.filaments,
            manufacturer_map,
            color_map,
            result,
            field_mappings,
            mode is ImportStorageMode.LEGACY
            or (
                mode in {ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL}
                and "filament" not in preview.available_field_targets
            ),
        )

        # 6. Spools importieren
        await self._import_spools(
            preview.spools,
            filament_map,
            location_map,
            name_map,
            status_map,
            result,
            field_mappings,
            mode is ImportStorageMode.LEGACY
            or (
                mode in {ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL}
                and "spool" not in preview.available_field_targets
            ),
        )

        await self.db.commit()

        logger.info(
            f"Spoolman-Import abgeschlossen: "
            f"{result.manufacturers_created} Hersteller, "
            f"{result.filaments_created} Filamente, "
            f"{result.spools_created} Spulen, "
            f"{result.locations_created} Standorte, "
            f"{result.colors_created} Farben"
        )

        return result

    async def preview_with_transparency_repairs(
        self, base_url: str
    ) -> tuple[ImportPreview, int, str]:
        """Load the normal preview plus source-backed transparency repair count."""
        preview = await self.preview(base_url)
        candidates = await self.analyze_transparency_repairs(preview.filaments)
        return (
            preview,
            len(candidates),
            self.transparency_repair_plan_digest(candidates),
        )

    async def repair_transparency(
        self,
        base_url: str,
        expected_plan_digest: str,
    ) -> ImportResult:
        """Repair only linked Spoolman alpha assignments and required colors."""
        result = ImportResult()
        preview = await self.preview(base_url)
        candidates = await self.analyze_transparency_repairs(preview.filaments)
        actual_plan_digest = self.transparency_repair_plan_digest(candidates)
        if not hmac.compare_digest(actual_plan_digest, expected_plan_digest.lower()):
            raise SpoolmanImportError(
                "Transparency repair data changed after preview; load a new preview",
                "repair_plan_changed",
            )

        repair_colors = [
            {"name": target_hex, "hex_code": target_hex}
            for target_hex in sorted(
                {candidate.target_hex for candidate in candidates}
            )
        ]
        color_map = await self._import_colors(repair_colors, result)
        await self._apply_transparency_repairs(candidates, color_map, result)
        await self.db.commit()
        return result

    @staticmethod
    def transparency_repair_plan_digest(
        candidates: list[TransparencyRepairCandidate],
    ) -> str:
        """Bind execution to the exact candidate set shown by preview."""
        plan = sorted(
            (
                {
                    "filament_id": candidate.filament_id,
                    "spoolman_id": candidate.spoolman_id,
                    "position": candidate.position,
                    "current_hex": candidate.current_hex,
                    "target_hex": candidate.target_hex,
                }
                for candidate in candidates
            ),
            key=lambda item: (
                item["filament_id"],
                item["position"],
                item["spoolman_id"],
            ),
        )
        payload = json.dumps(
            plan,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(payload).hexdigest()

    # ------------------------------------------------------------------ #
    #  Hilfs-Methoden fuer den Import
    # ------------------------------------------------------------------ #

    async def analyze_transparency_repairs(
        self,
        filaments: list[dict[str, Any]],
    ) -> list[TransparencyRepairCandidate]:
        """Find linked existing assignments that differ from Spoolman alpha."""
        local_filaments = await self.db.execute(
            select(Filament.id, Filament.custom_fields)
        )
        local_by_spoolman_id = {
            str(custom_fields["spoolman_id"]): filament_id
            for filament_id, custom_fields in local_filaments.all()
            if isinstance(custom_fields, dict)
            and custom_fields.get("spoolman_id") is not None
        }
        if not local_by_spoolman_id:
            return []

        linked_ids = set(local_by_spoolman_id.values())
        assignment_rows = await self.db.execute(
            select(
                FilamentColor.filament_id,
                FilamentColor.position,
                Color.hex_code,
            )
            .join(Color, Color.id == FilamentColor.color_id)
            .where(FilamentColor.filament_id.in_(linked_ids))
        )
        current_by_position = {
            (filament_id, position): hex_code.upper()
            for filament_id, position, hex_code in assignment_rows.all()
        }

        candidates: list[TransparencyRepairCandidate] = []
        for filament in filaments:
            if not isinstance(filament, dict) or filament.get("id") is None:
                continue

            spoolman_id = str(filament["id"])
            filament_id = local_by_spoolman_id.get(spoolman_id)
            if filament_id is None:
                continue

            for position, target_hex in self._filament_color_positions(filament):
                if len(target_hex) != 9:
                    continue

                current_hex = current_by_position.get(
                    (filament_id, position)
                )
                if (
                    current_hex is None
                    or len(current_hex) != 7
                    or current_hex != target_hex[:7].upper()
                ):
                    continue

                candidates.append(
                    TransparencyRepairCandidate(
                        filament_id=filament_id,
                        spoolman_id=spoolman_id,
                        position=position,
                        target_hex=target_hex,
                        current_hex=current_hex,
                    )
                )

        return candidates

    async def _apply_transparency_repairs(
        self,
        candidates: list[TransparencyRepairCandidate],
        color_map: dict[str, int],
        result: ImportResult,
    ) -> None:
        """Apply analyzed repairs without changing unrelated imported data."""
        if not candidates:
            return

        linked_ids = {candidate.filament_id for candidate in candidates}
        assignment_result = await self.db.execute(
            select(FilamentColor, Color.hex_code)
            .join(Color, Color.id == FilamentColor.color_id)
            .where(FilamentColor.filament_id.in_(linked_ids))
        )
        assignments = {
            (assignment.filament_id, assignment.position): (
                assignment,
                current_hex.upper(),
            )
            for assignment, current_hex in assignment_result.all()
        }

        for candidate in candidates:
            target_color_id = color_map.get(candidate.target_hex.lower())
            if target_color_id is None:
                result.warnings.append(
                    "Transparenzfarbe "
                    f"{candidate.target_hex} für Spoolman-Filament "
                    f"#{candidate.spoolman_id} konnte nicht aufgelöst werden"
                )
                continue

            key = (candidate.filament_id, candidate.position)
            current = assignments.get(key)
            if current is None or current[1] != candidate.current_hex:
                result.warnings.append(
                    "Transparenzzuordnung für Spoolman-Filament "
                    f"#{candidate.spoolman_id} Position {candidate.position} "
                    "hat sich seit der Vorschau geändert"
                )
                continue

            assignment, _ = current
            assignment.color_id = target_color_id
            result.color_assignments_repaired += 1

    async def _load_status_map(self) -> dict[str, int]:
        """Spool-Status-Mapping laden (key -> id)."""
        result = await self.db.execute(select(SpoolStatus))
        statuses = result.scalars().all()
        return {s.key: s.id for s in statuses}

    async def _preview_extra_field_definitions(
        self,
        definitions: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        inputs = _source_field_inputs(definitions)
        planner = SpoolmanExtraFieldPlanner(self.db)
        candidates = [item.candidate for item in inputs if item.candidate is not None]
        assessments = await planner.assess(candidates)
        preview: list[dict[str, Any]] = []

        for source in inputs:
            if source.candidate is None:
                preview.append(
                    {
                        "target_type": source.target_type,
                        "key": source.key,
                        "label": source.label,
                        "status": "unsupported",
                        "reason": source.error,
                    }
                )
                continue
            assessment = assessments[
                (source.candidate.target_type.value, source.candidate.key)
            ]
            item = source.candidate.model_dump(mode="json")
            item["status"] = assessment.status
            if assessment.conflicting_key is not None:
                item["conflicting_key"] = assessment.conflicting_key
            if assessment.retained_conflict is not None:
                item["system_conflict"] = {
                    "count": assessment.retained_conflict.count,
                    "sample_record_ids": list(
                        assessment.retained_conflict.sample_record_ids
                    ),
                }
            preview.append(item)
        return preview

    async def _plan_import_extra_fields(
        self,
        definitions: dict[str, list[dict[str, Any]]],
        result: ImportResult,
        default_action: ImportStorageMode | str,
        field_actions: list[SpoolmanFieldAction],
    ) -> dict[tuple[str, str], dict[str, Any]]:
        try:
            default_mode = ImportStorageMode(default_action)
        except ValueError as exc:
            raise SpoolmanImportError(
                f"Unsupported extra field import mode: {default_action}",
                "invalid_extra_field_mode",
            ) from exc
        inputs = _source_field_inputs(definitions)
        candidates = [item.candidate for item in inputs if item.candidate is not None]
        planner = SpoolmanExtraFieldPlanner(self.db)
        assessments = await planner.assess(candidates)
        overrides = {
            (item.target_type.value, item.key): item.action
            for item in field_actions
        }
        system_assessments: list[DefinitionAssessment] = []
        mappings: dict[tuple[str, str], dict[str, Any]] = {}

        for source in inputs:
            if source.target_type == "vendor":
                continue
            if not source.key:
                result.extra_fields_conflicted += 1
                result.warnings.append(
                    f"Extra field {source.target_type}.?: "
                    f"{source.error or 'invalid key'}"
                )
                continue

            identity = (source.target_type, source.key)
            action = overrides.get(identity, default_mode)
            if action in {ImportStorageMode.LEGACY, ImportStorageMode.PRESERVE}:
                mappings[identity] = {"storage": action.value}
                continue

            if source.candidate is None:
                result.extra_fields_conflicted += 1
                result.warnings.append(
                    f"Extra field {identity[0]}.{identity[1]}: {source.error}"
                )
                continue

            assessment = assessments[identity]
            if assessment.status == "conflict":
                result.extra_fields_conflicted += 1
                result.warnings.append(
                    f"Extra field {identity[0]}.{identity[1]} conflicts with "
                    f"System Extra Field "
                    f"{assessment.conflicting_key or identity[1]}."
                )
                continue

            if action is ImportStorageMode.LOCAL:
                if assessment.status == "reuse":
                    result.extra_fields_conflicted += 1
                    result.warnings.append(
                        f"Extra field {identity[0]}.{identity[1]} already has a "
                        "System Extra Field and cannot become record-local."
                    )
                    continue
                mappings[identity] = {
                    **source.candidate.model_dump(mode="json"),
                    "storage": ImportStorageMode.LOCAL.value,
                }
                result.extra_local_definitions += 1
                continue

            if assessment.retained_conflict is not None:
                conflict = assessment.retained_conflict
                result.extra_fields_conflicted += 1
                result.warnings.append(
                    f"Extra field {identity[0]}.{identity[1]} was preserved: "
                    f"{conflict.count} existing record value(s) are incompatible "
                    "with the requested System Extra Field "
                    f"(example record IDs: {list(conflict.sample_record_ids)})."
                )
                continue

            system_assessments.append(assessment)
            mappings[identity] = {
                **source.candidate.model_dump(mode="json"),
                "storage": ImportStorageMode.SYSTEM.value,
            }

        applied = await planner.apply_system_definitions(system_assessments)
        result.extra_fields_created += applied.created
        result.extra_fields_reused += applied.reused
        if any(item.target_type == "vendor" for item in inputs):
            result.warnings.append(
                "Vendor extra fields remain under manufacturer spoolman_extra because "
                "manufacturer rich fields are not supported yet."
            )
        return mappings

    async def _import_locations(
        self, locations: list[dict[str, Any]], result: ImportResult
    ) -> tuple[dict[Any, int], dict[str, int]]:
        """Locations importieren. Gibt (Spoolman-ID -> FilaMan-ID, Name -> FilaMan-ID) zurueck."""
        loc_map: dict[Any, int] = {}
        name_map: dict[str, int] = {}

        for loc_data in locations:
            # Safety Check: Falls loc_data kein Dict ist
            if not isinstance(loc_data, dict):
                continue

            spoolman_id = loc_data.get("id")
            name = self._clean(loc_data.get("name"))

            # Fallback name if missing but ID exists
            if not name and spoolman_id:
                name = f"Spoolman Location #{spoolman_id}"

            if not name:
                continue

            # Pruefen ob Location mit gleichem Namen existiert
            # Case-insensitive Vergleich fuer Namen
            # Nur echte spoolman_ids verwenden (keine temporären IDs)
            is_temp_id = spoolman_id and str(spoolman_id).startswith("temp_")

            name_lower = name.lower()
            if is_temp_id:
                # Temporaere ID - nur nach Namen suchen
                existing = await self.db.execute(
                    select(Location).where(func.lower(Location.name) == name_lower)
                )
            else:
                # Echte spoolman_id - nach Namen oder ID suchen
                existing = await self.db.execute(
                    select(Location).where(
                        (func.lower(Location.name) == name_lower)
                        | (
                            json_extract_cast_string(
                                Location.custom_fields, "$.spoolman_id", self.dialect
                            )
                            == str(spoolman_id)
                        )
                    )
                )
            existing_loc = existing.scalar_one_or_none()

            final_id: int
            if existing_loc:
                final_id = existing_loc.id
                result.locations_skipped += 1
            else:
                # Keine temporaere ID speichern
                store_spoolman_id = (
                    spoolman_id if spoolman_id and not is_temp_id else None
                )
                new_loc = Location(
                    name=name,
                    custom_fields={"spoolman_id": store_spoolman_id}
                    if store_spoolman_id
                    else None,
                )
                self.db.add(new_loc)
                await self.db.flush()  # ID erhalten
                final_id = new_loc.id
                result.locations_created += 1

            # Mapping pflegen (nur fuer echte spoolman_ids)
            if spoolman_id and not is_temp_id:
                # Store ID as is
                loc_map[spoolman_id] = final_id

                # Try storing int/str variants
                try:
                    loc_map[int(spoolman_id)] = final_id
                except (ValueError, TypeError):
                    pass
                try:
                    loc_map[str(spoolman_id)] = final_id
                except (ValueError, TypeError):
                    pass

            # Map name (normalized for better hit rate?)
            name_map[name] = final_id
            # Also map lower case for robust lookup
            name_map[name.lower()] = final_id

        return loc_map, name_map

    async def _import_manufacturers(
        self, vendors: list[dict[str, Any]], result: ImportResult
    ) -> dict[int, int]:
        """Vendors als Manufacturers importieren. Gibt Spoolman-Vendor-ID -> FilaMan-ID."""
        mfr_map: dict[int, int] = {}

        for vendor in vendors:
            # Safety Check
            if not isinstance(vendor, dict):
                continue

            spoolman_id = vendor.get("id")
            name = self._clean(vendor.get("name"))
            if not name:
                continue

            # Pruefen ob Manufacturer mit gleichem Namen oder Spoolman-ID existiert
            existing = await self.db.execute(
                select(Manufacturer).where(
                    (Manufacturer.name == name)
                    | (
                        json_extract_cast_string(
                            Manufacturer.custom_fields, "$.spoolman_id", self.dialect
                        )
                        == str(spoolman_id)
                    )
                )
            )
            existing_mfr = existing.scalar_one_or_none()

            if existing_mfr:
                if spoolman_id:
                    mfr_map[spoolman_id] = existing_mfr.id
                result.manufacturers_skipped += 1
                continue

            # custom_fields fuer Extra-Daten
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            comment = self._clean(vendor.get("comment"))
            if comment:
                custom["comment"] = comment
            extra = vendor.get("extra")
            if extra and isinstance(extra, dict):
                custom["spoolman_extra"] = self._clean_dict(extra)

            new_mfr = Manufacturer(
                name=name,
                url=self._clean(vendor.get("url")),
                custom_fields=custom if custom else None,
            )
            self.db.add(new_mfr)
            await self.db.flush()

            if spoolman_id:
                mfr_map[spoolman_id] = new_mfr.id
            result.manufacturers_created += 1

        return mfr_map

    async def _import_colors(
        self, colors: list[dict[str, str]], result: ImportResult
    ) -> dict[str, int]:
        """Farben importieren. Gibt hex_code (lowercase) -> FilaMan-Color-ID."""
        color_map: dict[str, int] = {}

        # Existierende Farben laden
        existing_result = await self.db.execute(select(Color))
        for color in existing_result.scalars().all():
            color_map[color.hex_code.lower()] = color.id

        for color_data in colors:
            # Safety Check
            if not isinstance(color_data, dict):
                continue

            normalized_hex = self._normalize_hex_code(color_data.get("hex_code"))
            if not normalized_hex:
                continue

            hex_key = normalized_hex.lower()
            if hex_key in color_map:
                result.colors_skipped += 1
                continue

            name = color_data.get("name", normalized_hex)
            new_color = Color(
                name=name,
                hex_code=normalized_hex,
            )
            self.db.add(new_color)
            await self.db.flush()

            color_map[hex_key] = new_color.id
            result.colors_created += 1

        return color_map

    async def _import_filaments(
        self,
        filaments: list[dict[str, Any]],
        manufacturer_map: dict[int, int],
        color_map: dict[str, int],
        result: ImportResult,
        field_mappings: dict[tuple[str, str], dict[str, Any]],
        clean_unmapped_extra_values: bool = False,
    ) -> dict[int, int]:
        """Filamente importieren. Gibt Spoolman-Filament-ID -> FilaMan-ID."""
        fil_map: dict[int, int] = {}

        for fil_data in filaments:
            # Safety Check
            if not isinstance(fil_data, dict):
                continue

            spoolman_id = fil_data.get("id")

            # Pruefen ob Filament mit dieser Spoolman-ID bereits existiert
            if spoolman_id:
                existing_fil_res = await self.db.execute(
                    select(Filament).where(
                        json_extract_cast_string(
                            Filament.custom_fields, "$.spoolman_id", self.dialect
                        )
                        == str(spoolman_id)
                    )
                )
                existing_fil = existing_fil_res.scalar_one_or_none()
                if existing_fil:
                    fil_map[spoolman_id] = existing_fil.id
                    result.filaments_skipped += 1
                    continue

            # Manufacturer auflösen
            vendor = fil_data.get("vendor")
            # Safety: Ensure vendor is a dict
            vendor_id = (
                vendor.get("id") if vendor and isinstance(vendor, dict) else None
            )
            filaman_mfr_id = manufacturer_map.get(vendor_id) if vendor_id else None

            if not filaman_mfr_id:
                # Unbekannter Hersteller - "Unknown" anlegen oder finden
                filaman_mfr_id = await self._get_or_create_unknown_manufacturer()
                result.warnings.append(
                    f"Filament '{fil_data.get('name', '?')}' (ID {spoolman_id}): "
                    "Kein Hersteller zugeordnet, verwende 'Unknown'"
                )

            # Mapping: Spoolman -> FilaMan Felder
            material = self._clean(fil_data.get("material")) or "PLA"
            name = self._clean(fil_data.get("name")) or ""
            designation = name if name else f"{material} (Spoolman #{spoolman_id})"
            diameter = fil_data.get("diameter", 1.75) or 1.75

            # Gewichte
            raw_weight = fil_data.get("weight")  # Net filament weight in g
            spool_weight = fil_data.get("spool_weight")  # Empty spool weight
            # Vendor empty_spool_weight -> filament default_spool_weight_g
            if not spool_weight and vendor and isinstance(vendor, dict):
                spool_weight = vendor.get("empty_spool_weight")
            # Default to 250g if not provided
            if not spool_weight:
                spool_weight = 250

            # Farb-Modus erkennen
            multi_hexes = fil_data.get("multi_color_hexes")
            color_mode = "multi" if multi_hexes else "single"
            multi_color_style = None
            if multi_hexes:
                direction = fil_data.get("multi_color_direction", "")
                if direction == "coaxial":
                    multi_color_style = "gradient"
                else:
                    multi_color_style = "striped"

            # Extra-Felder -> custom_fields
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            fil_comment = self._clean(fil_data.get("comment"))
            if fil_comment:
                custom["comment"] = fil_comment
            article_nr = self._clean(fil_data.get("article_number"))
            if article_nr:
                custom["article_number"] = article_nr
            ext_id = self._clean(fil_data.get("external_id"))
            if ext_id:
                custom["spoolman_external_id"] = ext_id
            if fil_data.get("settings_extruder_temp"):
                custom["settings_extruder_temp"] = fil_data["settings_extruder_temp"]
            if fil_data.get("settings_bed_temp"):
                custom["settings_bed_temp"] = fil_data["settings_bed_temp"]
            # Extra-Dict: bekannte Felder mappen, Rest als spoolman_extra
            local_definitions: dict[str, Any] = {}
            extra = fil_data.get("extra")
            if extra and isinstance(extra, dict):
                extracted_keys: set[str] = set()
                # Extruder-Temp aus Extra (falls nicht direkt vorhanden)
                if not fil_data.get("settings_extruder_temp"):
                    et = self._extract_extra(
                        extra,
                        extracted_keys,
                        [
                            "extruder_temp",
                            "nozzle_temp",
                            "print_temp",
                        ],
                    )
                    if et:
                        custom["settings_extruder_temp"] = et
                # Bed-Temp aus Extra
                if not fil_data.get("settings_bed_temp"):
                    bt = self._extract_extra(
                        extra,
                        extracted_keys,
                        [
                            "bed_temp",
                            "heatbed_temp",
                        ],
                    )
                    if bt:
                        custom["settings_bed_temp"] = bt
                # Restliche Extra-Felder als JSON speichern
                promoted, local_definitions, remaining = self._promote_extra_values(
                    "filament",
                    extra,
                    extracted_keys,
                    field_mappings,
                    result,
                    set(custom),
                    clean_unmapped_extra_values,
                )
                custom.update(promoted)
                if remaining:
                    custom["spoolman_extra"] = remaining

            try:
                new_fil = Filament(
                    manufacturer_id=filaman_mfr_id,
                    designation=designation,
                    material_type=material,
                    diameter_mm=diameter,
                    raw_material_weight_g=raw_weight,
                    default_spool_weight_g=spool_weight,
                    density_g_cm3=fil_data.get("density"),
                    price=fil_data.get("price"),
                    shop_url=self._shop_url(fil_data.get("article_number")),
                    manufacturer_color_name=self._clean(fil_data.get("color_hex")),
                    color_mode=color_mode,
                    multi_color_style=multi_color_style,
                    custom_fields=custom if custom else None,
                    custom_field_definitions=local_definitions or None,
                )
                self.db.add(new_fil)
                await self.db.flush()

                if spoolman_id:
                    fil_map[spoolman_id] = new_fil.id

                # Farb-Zuordnungen erstellen
                await self._create_filament_colors(new_fil.id, fil_data, color_map)

                result.filaments_created += 1

            except Exception as e:
                result.errors.append(
                    f"Fehler beim Import von Filament '{designation}' "
                    f"(Spoolman ID {spoolman_id}): {e}"
                )
                logger.warning(f"Filament-Import fehlgeschlagen: {e}", exc_info=True)

        return fil_map

    async def _create_filament_colors(
        self,
        filament_id: int,
        fil_data: dict[str, Any],
        color_map: dict[str, int],
    ) -> None:
        """Farb-Zuordnungen fuer ein Filament erstellen."""
        for position, color_hex in enumerate(
            self._filament_hex_codes(fil_data),
            start=1,
        ):
            color_id = color_map.get(color_hex.lower())
            if color_id:
                self.db.add(
                    FilamentColor(
                        filament_id=filament_id,
                        color_id=color_id,
                        position=position,
                    )
                )

    async def _import_spools(
        self,
        spools: list[dict[str, Any]],
        filament_map: dict[int, int],
        location_map: dict[Any, int],
        location_name_map: dict[str, int],
        status_map: dict[str, int],
        result: ImportResult,
        field_mappings: dict[tuple[str, str], dict[str, Any]],
        clean_unmapped_extra_values: bool = False,
    ) -> None:
        """Spools importieren."""
        for spool_data in spools:
            spoolman_id = spool_data.get("id")

            # Filament auflösen
            fil = spool_data.get("filament")
            fil_spoolman_id = fil.get("id") if fil and isinstance(fil, dict) else None
            filaman_fil_id = (
                filament_map.get(fil_spoolman_id) if fil_spoolman_id else None
            )

            if not filaman_fil_id:
                result.errors.append(
                    f"Spule Spoolman #{spoolman_id}: "
                    f"Filament (Spoolman #{fil_spoolman_id}) nicht gefunden, uebersprungen"
                )
                result.spools_skipped += 1
                continue

            # Status bestimmen
            is_archived = spool_data.get("archived", False)
            if is_archived:
                status_key = "archived"
            else:
                # Heuristik: remaining_weight bestimmt Status
                remaining = spool_data.get("remaining_weight")
                used = spool_data.get("used_weight", 0)
                if remaining is not None and remaining <= 0:
                    status_key = "empty"
                elif used and used > 0:
                    status_key = "active"
                else:
                    status_key = "new"

            status_id = status_map.get(status_key, status_map.get("active", 1))

            # Location auflösen
            # Location kann ein Objekt {id: 1, name: "Regal"} oder ein String "Regal" sein
            loc = spool_data.get("location")
            location_id = None

            if loc:
                if isinstance(loc, dict):
                    loc_spoolman_id = loc.get("id")
                    if loc_spoolman_id is not None:
                        # Try exact match (int)
                        location_id = location_map.get(loc_spoolman_id)
                        # Try string/int conversion mismatch
                        if not location_id:
                            try:
                                location_id = location_map.get(int(loc_spoolman_id))
                            except (ValueError, TypeError):
                                pass
                        if not location_id:
                            try:
                                location_id = location_map.get(str(loc_spoolman_id))
                            except (ValueError, TypeError):
                                pass

                    # Fallback auf Name, falls ID nicht gefunden (z.B. neu erstellt ohne ID)
                    if not location_id:
                        loc_name = self._clean(loc.get("name"))
                        if loc_name:
                            location_id = location_name_map.get(loc_name)
                            if not location_id:
                                location_id = location_name_map.get(loc_name.lower())

                elif isinstance(loc, str):
                    loc_name = self._clean(loc)
                    if loc_name:
                        location_id = location_name_map.get(loc_name)
                        if not location_id:
                            location_id = location_name_map.get(loc_name.lower())

                if not location_id:
                    result.warnings.append(
                        f"Spule Spoolman #{spoolman_id}: Location '{loc}' konnte nicht zugeordnet werden."
                    )

            # Gewichte berechnen

            initial_weight = spool_data.get("initial_weight")  # Net filament
            spool_weight = spool_data.get("spool_weight")
            remaining_weight = spool_data.get("remaining_weight")

            # initial_total_weight_g = filament + spool
            initial_total = None
            if initial_weight is not None:
                initial_total = initial_weight + (spool_weight or 0)

            # Extra-Felder auswerten
            extra = spool_data.get("extra")
            rfid_uid = None
            extracted_keys: set[str] = set()

            if extra and isinstance(extra, dict):
                # RFID / NFC ID extrahieren — Spoolman nennt es "NFC ID"
                rfid_uid = self._extract_extra(
                    extra,
                    extracted_keys,
                    [
                        "nfc_id",
                        "NFC ID",
                        "nfc",
                        "NFC",
                        "rfid_uid",
                        "rfid",
                        "RFID",
                        "rfid_id",
                        "tag_uid",
                        "tag_id",
                        "uid",
                    ],
                )

                # Normalize: pad each hex segment to 2 chars (legacy leading-zero bug)
                if rfid_uid:
                    rfid_uid = ":".join(s.zfill(2) for s in rfid_uid.split(":"))

            # external_id: Spoolman-ID als Referenz
            external_id = f"spoolman:{spoolman_id}" if spoolman_id else None

            # Pruefen ob Spule bereits existiert (via external_id oder spoolman_id in custom_fields)
            if spoolman_id:
                dup_check = await self.db.execute(
                    select(Spool).where(
                        (Spool.external_id == external_id)
                        | (
                            json_extract_cast_string(
                                Spool.custom_fields, "$.spoolman_id", self.dialect
                            )
                            == str(spoolman_id)
                        )
                    )
                )
                if dup_check.scalar_one_or_none():
                    result.spools_skipped += 1
                    continue

            # Pruefen ob rfid_uid schon existiert
            if rfid_uid:
                dup_rfid = await self.db.execute(
                    select(Spool).where(Spool.rfid_uid == rfid_uid)
                )
                if dup_rfid.scalar_one_or_none():
                    result.warnings.append(
                        f"Spule Spoolman #{spoolman_id}: RFID '{rfid_uid}' existiert bereits, wird ohne RFID importiert"
                    )
                    rfid_uid = None

            # custom_fields: Spoolman-Meta + ungemappte Extra-Felder
            custom: dict[str, Any] = {}
            if spoolman_id:
                custom["spoolman_id"] = spoolman_id
            spool_comment = self._clean(spool_data.get("comment"))
            if spool_comment:
                custom["comment"] = spool_comment
            local_definitions: dict[str, Any] = {}
            if extra and isinstance(extra, dict):
                (
                    promoted,
                    local_definitions,
                    remaining_extra,
                ) = self._promote_extra_values(
                    "spool",
                    extra,
                    extracted_keys,
                    field_mappings,
                    result,
                    set(custom),
                    clean_unmapped_extra_values,
                )
                custom.update(promoted)
                if remaining_extra:
                    custom["spoolman_extra"] = remaining_extra

            try:
                # Nested transaction damit ein Fehler nicht den ganzen Import abbricht
                async with self.db.begin_nested():
                    new_spool = Spool(
                        filament_id=filaman_fil_id,
                        status_id=status_id,
                        lot_number=self._clean(spool_data.get("lot_nr")),
                        rfid_uid=rfid_uid,
                        external_id=external_id,
                        location_id=location_id,
                        purchase_price=spool_data.get("price")
                        or (
                            fil.get("price") if fil and isinstance(fil, dict) else None
                        ),
                        initial_total_weight_g=initial_total,
                        empty_spool_weight_g=spool_weight,
                        remaining_weight_g=remaining_weight,
                        custom_fields=custom if custom else None,
                        custom_field_definitions=local_definitions or None,
                    )
                    self.db.add(new_spool)
                    await self.db.flush()

                result.spools_created += 1

            except Exception as e:
                result.errors.append(
                    f"Fehler beim Import von Spule Spoolman #{spoolman_id}: {e}"
                )
                logger.warning(f"Spool-Import fehlgeschlagen: {e}", exc_info=True)

    async def _get_or_create_unknown_manufacturer(self) -> int:
        """'Unknown'-Hersteller finden oder erstellen."""
        existing = await self.db.execute(
            select(Manufacturer).where(Manufacturer.name == "Unknown")
        )
        mfr = existing.scalar_one_or_none()
        if mfr:
            return mfr.id

        new_mfr = Manufacturer(name="Unknown")
        self.db.add(new_mfr)
        await self.db.flush()
        return new_mfr.id

    @classmethod
    def _shop_url(cls, value: Any) -> str | None:
        """Keep a bare article number out of the shop URL column.

        Spoolman has no URL field on a filament. Its `article_number` documents
        itself as "Vendor article number, e.g. EAN, QR code", so importing that
        value into `shop_url` stores something that is not a link: the filament
        form renders the field as <input type="url"> and refuses to save such a
        record, and any code that fills an empty shop_url later finds the field
        occupied. Some users do keep a real link there, so a value that parses
        as one is still imported; everything else stays where it belongs, in
        custom_fields["article_number"].
        """
        cleaned = cls._clean(value)
        if not cleaned:
            return None
        parsed = urlparse(cleaned)
        if parsed.scheme in ("http", "https") and parsed.netloc:
            return cleaned
        return None

    @staticmethod
    def _clean(value: Any) -> str | None:
        """String-Wert bereinigen: Anführungszeichen, Whitespace etc. entfernen.

        Gibt None zurueck wenn der Wert leer oder kein String ist.
        """
        if value is None:
            return None
        s = str(value).strip().strip('"').strip("'").strip()
        return s if s else None

    @staticmethod
    def _clean_dict(d: dict[str, Any]) -> dict[str, Any]:
        """Alle String-Werte in einem Dict bereinigen (rekursiv)."""
        cleaned: dict[str, Any] = {}
        for k, v in d.items():
            if isinstance(v, str):
                v = v.strip().strip('"').strip("'").strip()
            elif isinstance(v, dict):
                v = SpoolmanImportService._clean_dict(v)
            cleaned[k] = v
        return cleaned

    @staticmethod
    def _extract_extra(
        extra: dict[str, Any],
        extracted: set[str],
        candidate_keys: list[str],
    ) -> str | None:
        """Einen Wert aus dem extra-Dict extrahieren.

        Probiert alle candidate_keys (case-insensitive) und merkt sich den
        gefundenen Key in ``extracted``, damit er spaeter herausgefiltert wird.
        Gibt None zurueck wenn der Wert nach Bereinigung leer ist.
        """
        # Schneller exakter Match
        for key in candidate_keys:
            val = extra.get(key)
            if val is not None:
                cleaned = str(val).strip().strip('"').strip("'").strip()
                if cleaned:
                    extracted.add(key)
                    return cleaned
                # Key merken auch wenn leer (damit er nicht in spoolman_extra landet)
                extracted.add(key)

        # Case-insensitive Fallback
        lower_map = {k.lower().replace(" ", "_"): k for k in extra}
        for key in candidate_keys:
            normalized = key.lower().replace(" ", "_")
            original_key = lower_map.get(normalized)
            if original_key and original_key not in extracted:
                val = extra.get(original_key)
                if val is not None:
                    cleaned = str(val).strip().strip('"').strip("'").strip()
                    if cleaned:
                        extracted.add(original_key)
                        return cleaned
                    extracted.add(original_key)

        return None

    @staticmethod
    def _promote_extra_values(
        target_type: str,
        extra: dict[str, Any],
        extracted: set[str],
        mappings: dict[tuple[str, str], dict[str, Any]],
        result: ImportResult,
        reserved_keys: set[str] | None = None,
        clean_unmapped_values: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        promoted: dict[str, Any] = {}
        local_definitions: dict[str, Any] = {}
        preserved: dict[str, Any] = {}
        for key, raw in extra.items():
            if key in extracted:
                continue
            mapping = mappings.get((target_type, key))
            if mapping is None:
                preserved[key] = (
                    SpoolmanImportService._clean_dict({key: raw})[key]
                    if clean_unmapped_values
                    else raw
                )
                result.extra_values_preserved += 1
                continue
            storage = mapping.get("storage")
            if storage in {"legacy", "preserve"}:
                preserved[key] = (
                    SpoolmanImportService._clean_dict({key: raw})[key]
                    if storage == "legacy"
                    else raw
                )
                result.extra_values_preserved += 1
                continue
            destination_key = mapping.get("destination_key", key)
            if (
                destination_key in (reserved_keys or set())
                or destination_key in promoted
            ):
                preserved[key] = raw
                result.extra_values_preserved += 1
                continue
            try:
                promoted[destination_key] = convert_spoolman_value(
                    raw,
                    mapping["source_field_type"],
                    mapping.get("options"),
                    mapping["field_type"] == "multiselect"
                    if mapping["source_field_type"] == "choice"
                    else None,
                )
                if mapping.get("storage") == "local":
                    local_definitions[destination_key] = {
                        "label": mapping["label"],
                        "field_type": mapping["field_type"],
                        "options": mapping.get("options"),
                        "config": mapping.get("config"),
                    }
                result.extra_values_promoted += 1
            except SpoolmanFieldError:
                preserved[key] = raw
                result.extra_values_preserved += 1
        return promoted, local_definitions, preserved
