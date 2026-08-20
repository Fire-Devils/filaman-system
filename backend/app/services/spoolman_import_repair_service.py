"""Preview and repair legacy values created by the Spoolman importer."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import response_cache
from app.models.filament import Filament
from app.models.spool import Spool
from app.services.spoolman_contracts import (
    ApprovedRepairMapping,
    RepairMode,
    RepairStorageAction,
    SpoolmanFieldCandidate,
)
from app.services.spoolman_errors import SpoolmanRepairError
from app.services.spoolman_extra_field_mapping import (
    RepairFieldProposal,
    SpoolmanFieldError,
    canonicalize_definition_lists,
    convert_spoolman_value,
    decode_spoolman_value,
    fingerprint,
    infer_definition,
    map_spoolman_definition,
)
from app.services.spoolman_extra_field_planner import (
    DefinitionAssessment,
    SpoolmanExtraFieldPlanner,
)
from app.services.system_extra_field_compatibility import (
    definition_can_receive,
    field_paths_overlap,
)
from app.utils.db import json_extract_cast_string


@dataclass(slots=True)
class LegacyImportRow:
    target_type: str
    entity_id: int
    custom_fields: dict[str, Any]
    nested: dict[str, Any]
    model: Filament | Spool | None = None


@dataclass(slots=True)
class RepairEvaluation:
    response: dict[str, Any]
    rows: list[LegacyImportRow]
    proposals: dict[tuple[str, str], RepairFieldProposal]
    assessments: dict[tuple[str, str], DefinitionAssessment]


def _repair_proposals(
    mode: RepairMode,
    grouped: dict[tuple[str, str], list[Any]],
    source_definitions: dict[str, list[dict[str, Any]]],
) -> dict[tuple[str, str], RepairFieldProposal]:
    proposals: dict[tuple[str, str], RepairFieldProposal] = {}
    if mode is RepairMode.OFFLINE:
        for (target, key), values in sorted(grouped.items()):
            proposal = infer_definition(target, key, values)
            proposals[proposal.identity] = proposal
        return proposals

    canonical = canonicalize_definition_lists(source_definitions)
    for target in ("filament", "spool"):
        for raw in canonical.get(target, []):
            try:
                definition = map_spoolman_definition(raw, target)
            except ValueError:
                continue
            identity = (definition.target_type.value, definition.key)
            values = grouped.get(identity)
            if not values:
                continue
            proposals[identity] = RepairFieldProposal(
                target_type=identity[0],
                key=identity[1],
                label=definition.label,
                definition=definition,
                confidence="authoritative",
                confidence_reason="source_definition",
                samples=tuple(values[:5]),
                occurrences=len(values),
            )
    return proposals


class SpoolmanImportRepairService:
    """Safely promote nested legacy Spoolman values into native fields."""

    def __init__(self, db: AsyncSession):
        self.db = db

    @staticmethod
    def preview_conversion_examples(
        mapping: ApprovedRepairMapping,
        samples: list[Any],
    ) -> dict[str, Any]:
        """Convert samples through the same authoritative path as execution."""
        examples: list[dict[str, Any]] = []
        invalid_indexes: list[int] = []
        for index, raw in enumerate(samples):
            try:
                converted = SpoolmanImportRepairService._convert_approved(
                    raw,
                    mapping,
                )
            except SpoolmanFieldError:
                invalid_indexes.append(index)
                continue
            examples.append({"source": raw, "converted": converted})
        return {
            "conversion_examples": examples,
            "invalid_sample_indexes": invalid_indexes,
        }

    async def preview(
        self,
        mode: RepairMode | str,
        source_definitions: dict[str, list[dict[str, Any]]] | None = None,
    ) -> dict[str, Any]:
        return (await self._evaluate(mode, source_definitions)).response

    async def _evaluate(
        self,
        mode: RepairMode | str,
        source_definitions: dict[str, list[dict[str, Any]]] | None = None,
        *,
        include_models: bool = False,
    ) -> RepairEvaluation:
        try:
            repair_mode = RepairMode(mode)
        except ValueError as exc:
            raise SpoolmanRepairError(
                "mode must be 'server' or 'offline'", "invalid_mode"
            ) from exc

        imported_rows = await self._imported_rows(
            include_model=include_models,
            lock_for_update=include_models,
        )
        rows = [row for row in imported_rows if row.nested]
        grouped: dict[tuple[str, str], list[Any]] = defaultdict(list)
        for row in rows:
            for key, value in row.nested.items():
                grouped[(row.target_type, key)].append(value)

        definitions = source_definitions or {}
        proposals = _repair_proposals(repair_mode, grouped, definitions)
        valid_definitions = [
            proposal.definition
            for proposal in proposals.values()
            if proposal.definition is not None
        ]
        planner = SpoolmanExtraFieldPlanner(self.db)
        assessments = await planner.assess(valid_definitions)

        mappings: list[dict[str, Any]] = []
        mappings_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
        for identity, proposal in proposals.items():
            if proposal.definition is None:
                item = {
                    "target_type": proposal.target_type,
                    "key": proposal.key,
                    "label": proposal.label,
                    "field_type": "text",
                    "source_field_type": None,
                    "options": None,
                    "config": None,
                    "default_value": None,
                    "confidence": "unresolved",
                    "confidence_reason": proposal.confidence_reason,
                    "samples": [
                        self._preview_sample(value) for value in proposal.samples
                    ],
                    "occurrences": proposal.occurrences,
                    "existing": False,
                    "status": "no_promotable",
                    "suggested_action": "system",
                }
            else:
                assessment = assessments[identity]
                item = proposal.definition.model_dump(mode="json")
                item.update(
                    confidence=proposal.confidence,
                    confidence_reason=proposal.confidence_reason,
                    samples=[
                        self._preview_sample(value) for value in proposal.samples
                    ],
                    occurrences=proposal.occurrences,
                    existing=assessment.status == "reuse",
                    status=(
                        "conflict" if assessment.status == "conflict" else "ready"
                    ),
                    suggested_action="system",
                )
                if assessment.conflicting_key is not None:
                    item["conflicting_key"] = assessment.conflicting_key
                if assessment.retained_conflict is not None:
                    item["system_conflict"] = {
                        "count": assessment.retained_conflict.count,
                        "sample_record_ids": list(
                            assessment.retained_conflict.sample_record_ids
                        ),
                    }
            mappings.append(item)
            mappings_by_identity[identity] = item

        counts: dict[str, int] = defaultdict(int)
        mapping_counts: dict[tuple[str, str], dict[str, int]] = defaultdict(
            lambda: defaultdict(int)
        )
        examples: list[dict[str, Any]] = []
        converted_examples: dict[
            tuple[str, str], list[dict[str, Any]]
        ] = defaultdict(list)
        seen_examples: dict[tuple[str, str], set[str]] = defaultdict(set)

        for row in rows:
            for key, raw in row.nested.items():
                identity = (row.target_type, key)
                proposal = proposals.get(identity)
                assessment = assessments.get(identity)
                reason = self._classify(
                    row.custom_fields,
                    key,
                    raw,
                    proposal,
                    assessment,
                )
                counts[reason] += 1
                mapping_counts[identity][reason] += 1
                if reason == "promotable" and proposal and proposal.definition:
                    converted = self._convert_approved(raw, proposal.definition)
                    example = {
                        "source": self._preview_sample(raw),
                        "converted": self._preview_sample(converted),
                    }
                    encoded = json.dumps(
                        example,
                        sort_keys=True,
                        separators=(",", ":"),
                        default=str,
                    )
                    if (
                        len(converted_examples[identity]) < 3
                        and encoded not in seen_examples[identity]
                    ):
                        seen_examples[identity].add(encoded)
                        converted_examples[identity].append(example)
                elif reason != "promotable" and len(examples) < 50:
                    examples.append(
                        {
                            "target_type": row.target_type,
                            "entity_id": row.entity_id,
                            "spoolman_id": row.custom_fields.get("spoolman_id"),
                            "key": key,
                            "reason": reason,
                        }
                    )

        for identity, item in mappings_by_identity.items():
            item_counts = mapping_counts[identity]
            item["promotable_occurrences"] = item_counts["promotable"]
            item["preserved_occurrences"] = sum(
                count
                for reason, count in item_counts.items()
                if reason != "promotable"
            )
            item["conversion_examples"] = converted_examples[identity]
            if item["status"] == "ready" and not item["promotable_occurrences"]:
                item["status"] = "no_promotable"

        snapshot = {
            "rows": sorted(
                [
                    {
                        "target_type": row.target_type,
                        "entity_id": row.entity_id,
                        "spoolman_id": row.custom_fields.get("spoolman_id"),
                        "nested": row.nested,
                    }
                    for row in rows
                ],
                key=lambda row: (row["target_type"], row["entity_id"]),
            ),
            "source_definitions": canonicalize_definition_lists(definitions),
        }
        response = {
            "mode": repair_mode.value,
            "preview_fingerprint": fingerprint(snapshot),
            "summary": {
                "imported_records": len(imported_rows),
                "records_scanned": len(rows),
                "fields_found": len(grouped),
                "promotable": counts["promotable"],
                "collisions": counts["collision"],
                "invalid": counts["invalid"],
                "unresolved": counts["unresolved"] + counts["conflict"],
            },
            "mappings": mappings,
            "examples": examples,
        }
        return RepairEvaluation(
            response=response,
            rows=rows,
            proposals=proposals,
            assessments=assessments,
        )

    async def execute(
        self,
        mode: RepairMode | str,
        expected_fingerprint: str,
        approved_mappings: list[ApprovedRepairMapping | dict[str, Any]],
        source_definitions: dict[str, list[dict[str, Any]]] | None = None,
    ) -> dict[str, Any]:
        try:
            repair_mode = RepairMode(mode)
        except ValueError as exc:
            raise SpoolmanRepairError(
                "mode must be 'server' or 'offline'", "invalid_mode"
            ) from exc
        try:
            selected = [
                item
                if isinstance(item, ApprovedRepairMapping)
                else ApprovedRepairMapping.model_validate(item)
                for item in approved_mappings
            ]
        except ValueError as exc:
            raise SpoolmanRepairError(
                "Approved mapping is invalid.", "invalid_mapping"
            ) from exc
        try:
            await self._begin_atomic_execute()
            return await self._execute_locked(
                repair_mode,
                expected_fingerprint,
                selected,
                source_definitions,
            )
        except Exception as exc:
            await self.db.rollback()
            if self._is_concurrency_conflict(exc):
                raise SpoolmanRepairError(
                    "Stored values changed during repair; load a new preview.",
                    "preview_changed",
                ) from exc
            raise

    async def _execute_locked(
        self,
        mode: RepairMode,
        expected_fingerprint: str,
        selected: list[ApprovedRepairMapping],
        source_definitions: dict[str, list[dict[str, Any]]] | None,
    ) -> dict[str, Any]:
        evaluation = await self._evaluate(
            mode,
            source_definitions,
            include_models=True,
        )
        current = evaluation.response
        if current["preview_fingerprint"] != expected_fingerprint:
            raise SpoolmanRepairError(
                "Stored values or source definitions changed; load a new preview.",
                "preview_changed",
            )

        repairable = {
            (item["target_type"], item["key"]): item
            for item in current["mappings"]
            if item["status"] in {"ready", "no_promotable"}
        }
        selected_by_identity: dict[
            tuple[str, str], ApprovedRepairMapping
        ] = {}
        for mapping in selected:
            identity = (mapping.target_type.value, mapping.key)
            if identity in selected_by_identity:
                raise SpoolmanRepairError(
                    f"Field {identity[0]}.{identity[1]} was approved more than once.",
                    "invalid_mapping",
                )
            current_mapping = repairable.get(identity)
            if current_mapping is None:
                raise SpoolmanRepairError(
                    f"Field {identity[0]}.{identity[1]} is not repairable.",
                    "invalid_mapping",
                )
            if (
                mapping.action is not RepairStorageAction.PRESERVE
                and current_mapping.get("confidence") == "unresolved"
                and mapping.field_type.value == current_mapping["field_type"]
            ):
                raise SpoolmanRepairError(
                    f"Field {identity[0]}.{identity[1]} requires an explicit "
                    "manual type change before approval.",
                    "manual_type_required",
                )
            selected_by_identity[identity] = mapping

        rows = evaluation.rows
        for mapping in selected_by_identity.values():
            if mapping.action is RepairStorageAction.PRESERVE:
                continue
            if mapping.action is RepairStorageAction.LOCAL:
                conflict_key = None
                for row in rows:
                    if (
                        row.target_type != mapping.target_type.value
                        or mapping.key not in row.nested
                    ):
                        continue
                    conflict_key = self._local_definition_conflict(row, mapping)
                    if conflict_key is not None:
                        break
                if conflict_key is not None:
                    raise SpoolmanRepairError(
                        f"Field {mapping.target_type.value}.{mapping.key} conflicts "
                        f"with record-local field {conflict_key}.",
                        "field_conflict",
                    )
            if not any(self._can_promote_row(row, mapping) for row in rows):
                raise SpoolmanRepairError(
                    f"Field {mapping.target_type.value}.{mapping.key} has no values "
                    "compatible with the approved mapping.",
                    "no_promotable_values",
                )

        planner = SpoolmanExtraFieldPlanner(self.db)
        non_preserved = [
            mapping
            for mapping in selected_by_identity.values()
            if mapping.action is not RepairStorageAction.PRESERVE
        ]
        approved_assessments = await planner.assess(
            [mapping.as_candidate() for mapping in non_preserved]
        )
        system_assessments: list[DefinitionAssessment] = []

        for mapping in non_preserved:
            identity = (mapping.target_type.value, mapping.key)
            assessment = approved_assessments[identity]
            if mapping.action is RepairStorageAction.LOCAL:
                if assessment.status != "create":
                    raise SpoolmanRepairError(
                        f"Field {identity[0]}.{identity[1]} overlaps a System "
                        "Extra Field.",
                        "field_conflict",
                    )
                continue
            if assessment.status == "conflict":
                raise SpoolmanRepairError(
                    f"Field {identity[0]}.{identity[1]} conflicts with a System "
                    "Extra Field.",
                    "field_conflict",
                )
            if assessment.retained_conflict is not None:
                raise SpoolmanRepairError(
                    f"Field {identity[0]}.{identity[1]} has incompatible retained "
                    "record values.",
                    "retained_value_conflict",
                )
            system_assessments.append(assessment)

        try:
            applied = await planner.apply_system_definitions(system_assessments)
        except SpoolmanFieldError as exc:
            raise SpoolmanRepairError(str(exc), "field_conflict") from exc

        local_definitions_created = 0
        values_promoted = 0
        records_updated = 0
        values_preserved = 0
        report: list[dict[str, Any]] = []

        for row in rows:
            if row.model is None:
                raise RuntimeError("repair execution requires loaded models")
            custom = dict(row.custom_fields)
            nested = dict(row.nested)
            changed = False
            for key, raw in list(nested.items()):
                mapping = selected_by_identity.get((row.target_type, key))
                if mapping is None or key in custom:
                    values_preserved += 1
                    continue
                if mapping.action is RepairStorageAction.PRESERVE:
                    values_preserved += 1
                    continue
                if (
                    mapping.action is RepairStorageAction.LOCAL
                    and self._local_definition_conflict(row, mapping) is not None
                ):
                    values_preserved += 1
                    continue
                try:
                    custom[key] = self._convert_approved(raw, mapping)
                except SpoolmanFieldError:
                    values_preserved += 1
                    continue
                del nested[key]
                if mapping.action is RepairStorageAction.LOCAL:
                    definitions = dict(row.model.custom_field_definitions or {})
                    if key not in definitions:
                        candidate = mapping.as_candidate()
                        definitions[key] = {
                            "label": candidate.label,
                            "field_type": candidate.field_type.value,
                            "options": candidate.options,
                            "config": candidate.config,
                        }
                        local_definitions_created += 1
                    row.model.custom_field_definitions = definitions
                changed = True
                values_promoted += 1
            if not changed:
                continue
            if nested:
                custom["spoolman_extra"] = nested
            else:
                custom.pop("spoolman_extra", None)
            row.model.custom_fields = custom
            records_updated += 1
            if len(report) < 100:
                report.append(
                    {
                        "target_type": row.target_type,
                        "entity_id": row.entity_id,
                        "spoolman_id": custom.get("spoolman_id"),
                    }
                )

        await self.db.commit()
        touched_targets = {
            mapping.target_type.value for mapping in selected_by_identity.values()
        }
        for target in touched_targets:
            response_cache.delete(f"extra_fields:{target}:all")
        if touched_targets:
            response_cache.delete("extra_fields:all:all")

        return {
            "definitions_created": applied.created,
            "local_definitions_created": local_definitions_created,
            "records_updated": records_updated,
            "values_promoted": values_promoted,
            "values_preserved": values_preserved,
            "report": report,
        }

    async def _begin_atomic_execute(self) -> None:
        """Start the strongest transaction each supported database provides."""
        if self.db.in_transaction():
            if self.db.new or self.db.dirty or self.db.deleted:
                raise SpoolmanRepairError(
                    "Repair execution requires a clean database transaction.",
                    "transaction_not_clean",
                )
            await self.db.rollback()

        dialect = self.db.get_bind().dialect.name
        if dialect == "sqlite":
            await self.db.execute(text("BEGIN IMMEDIATE"))
        elif dialect == "postgresql":
            await self.db.connection(
                execution_options={"isolation_level": "SERIALIZABLE"}
            )

    @staticmethod
    def _is_concurrency_conflict(exc: Exception) -> bool:
        original = getattr(exc, "orig", exc)
        code = getattr(original, "sqlstate", None) or getattr(
            original, "pgcode", None
        )
        return code in {"40001", "40P01"} or "database is locked" in str(
            original
        ).lower()

    async def _imported_rows(
        self,
        include_model: bool = False,
        *,
        lock_for_update: bool = False,
    ) -> list[LegacyImportRow]:
        rows: list[LegacyImportRow] = []
        for target_type, model in (("filament", Filament), ("spool", Spool)):
            dialect = self.db.get_bind().dialect
            statement = (
                select(model)
                .where(
                    json_extract_cast_string(
                        model.custom_fields,
                        "$.spoolman_id",
                        dialect,
                    ).is_not(None)
                )
                .order_by(model.id)
            )
            if lock_for_update and dialect.name != "sqlite":
                statement = statement.with_for_update()
            result = await self.db.execute(statement)
            for entity in result.scalars():
                custom = entity.custom_fields
                if not isinstance(custom, dict) or custom.get("spoolman_id") is None:
                    continue
                nested = custom.get("spoolman_extra")
                rows.append(
                    LegacyImportRow(
                        target_type=target_type,
                        entity_id=entity.id,
                        custom_fields=custom,
                        nested=nested if isinstance(nested, dict) else {},
                        model=entity if include_model else None,
                    )
                )
        return sorted(rows, key=lambda row: (row.target_type, row.entity_id))

    @staticmethod
    def _preview_sample(value: Any) -> Any:
        """Bound user-facing samples without changing the repair fingerprint."""
        if isinstance(value, str) and len(value) > 200:
            return f"{value[:197]}..."
        if isinstance(value, (dict, list)):
            encoded = json.dumps(value, separators=(",", ":"), default=str)
            if len(encoded) > 200:
                return f"{encoded[:197]}..."
        return value

    @staticmethod
    def _classify(
        custom: dict[str, Any],
        key: str,
        raw: Any,
        proposal: RepairFieldProposal | None,
        assessment: DefinitionAssessment | None,
    ) -> str:
        if key in custom:
            return "collision"
        if proposal is None or proposal.definition is None:
            return "unresolved"
        if assessment is None or assessment.status == "conflict":
            return "conflict"
        try:
            SpoolmanImportRepairService._convert_approved(raw, proposal.definition)
        except SpoolmanFieldError:
            return "invalid"
        return "promotable"

    def _local_definition_conflict(
        self,
        row: LegacyImportRow,
        mapping: ApprovedRepairMapping,
    ) -> str | None:
        if row.model is None:
            raise RuntimeError("repair preflight requires loaded models")
        definitions = row.model.custom_field_definitions or {}
        for local_key, local_definition in definitions.items():
            if not field_paths_overlap(local_key, mapping.key):
                continue
            if local_key != mapping.key:
                return local_key
            if not definition_can_receive(
                local_definition or {}, mapping.as_candidate()
            ):
                return local_key
        return None

    def _can_promote_row(
        self,
        row: LegacyImportRow,
        mapping: ApprovedRepairMapping,
    ) -> bool:
        if row.target_type != mapping.target_type.value:
            return False
        key = mapping.key
        if key not in row.nested or key in row.custom_fields:
            return False
        if row.model is None:
            raise RuntimeError("repair preflight requires loaded models")
        if (
            mapping.action is RepairStorageAction.LOCAL
            and self._local_definition_conflict(row, mapping) is not None
        ):
            return False
        try:
            self._convert_approved(row.nested[key], mapping)
        except SpoolmanFieldError:
            return False
        return True

    @staticmethod
    def _convert_approved(
        raw: Any,
        mapping: SpoolmanFieldCandidate,
    ) -> Any:
        native_type = mapping.field_type.value
        source_type = (
            mapping.source_field_type.value
            if mapping.source_field_type is not None
            else None
        )
        config = mapping.config or {}

        if native_type == "date":
            value = decode_spoolman_value(raw, "text")
            if not isinstance(value, str):
                raise SpoolmanFieldError("expected an ISO-8601 date or datetime")
            try:
                return date.fromisoformat(value).isoformat()
            except ValueError:
                try:
                    return datetime.fromisoformat(value).date().isoformat()
                except ValueError as exc:
                    raise SpoolmanFieldError(
                        "expected an ISO-8601 date or datetime"
                    ) from exc

        if native_type in {"text", "textarea", "url"}:
            source_type = "text"
        elif native_type == "datetime":
            source_type = "datetime"
        elif native_type == "number" and source_type not in {"integer", "float"}:
            source_type = (
                "integer" if config.get("decimal_places") == 0 else "float"
            )
        elif native_type == "range" and source_type not in {
            "integer_range",
            "float_range",
        }:
            source_type = (
                "integer_range"
                if config.get("decimal_places") == 0
                else "float_range"
            )
        elif native_type == "checkbox":
            source_type = "boolean"
        elif native_type in {"dropdown", "multiselect"}:
            source_type = "choice"

        if source_type is None:
            raise SpoolmanFieldError(
                f"cannot determine source conversion for {native_type}"
            )
        return convert_spoolman_value(
            raw,
            source_type,
            mapping.options,
            native_type == "multiselect" if source_type == "choice" else None,
        )
