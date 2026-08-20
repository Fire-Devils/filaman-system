"""Shared planning and application of Spoolman extra-field definitions."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import response_cache
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_contracts import SpoolmanFieldCandidate
from app.services.spoolman_extra_field_mapping import SpoolmanFieldError
from app.services.system_extra_field_compatibility import (
    DefinitionConflict,
    definition_can_receive,
    find_definition_value_conflicts,
    find_overlapping_definition,
)

Identity = tuple[str, str]
AssessmentStatus = Literal["create", "reuse", "conflict"]


@dataclass(frozen=True, slots=True)
class DefinitionAssessment:
    candidate: SpoolmanFieldCandidate
    status: AssessmentStatus
    existing: SystemExtraField | None = None
    conflicting_key: str | None = None
    retained_conflict: DefinitionConflict | None = None

    @property
    def identity(self) -> Identity:
        return (self.candidate.target_type.value, self.candidate.key)


@dataclass(frozen=True, slots=True)
class DefinitionApplyResult:
    created: int
    reused: int
    created_identities: tuple[Identity, ...]


class SpoolmanExtraFieldPlanner:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def assess(
        self,
        candidates: Iterable[SpoolmanFieldCandidate],
    ) -> dict[Identity, DefinitionAssessment]:
        candidate_list = list(candidates)
        identities = [
            (item.target_type.value, item.key)
            for item in candidate_list
        ]
        if len(identities) != len(set(identities)):
            raise SpoolmanFieldError("duplicate extra-field definition identity")

        existing_result = await self.db.execute(select(SystemExtraField))
        existing = list(existing_result.scalars())
        no_overlap: list[SpoolmanFieldCandidate] = []
        assessments: dict[Identity, DefinitionAssessment] = {}

        for item in candidate_list:
            identity = (item.target_type.value, item.key)
            overlap = find_overlapping_definition(existing, *identity)
            if overlap is None:
                no_overlap.append(item)
                continue
            exact = overlap.key == item.key
            compatible = exact and definition_can_receive(overlap, item)
            assessments[identity] = DefinitionAssessment(
                candidate=item,
                status="reuse" if compatible else "conflict",
                existing=overlap if compatible else None,
                conflicting_key=None if exact else overlap.key,
            )

        conflicts = await find_definition_value_conflicts(
            self.db,
            [item.model_dump(mode="json") for item in no_overlap],
        )
        for item in no_overlap:
            identity = (item.target_type.value, item.key)
            assessments[identity] = DefinitionAssessment(
                candidate=item,
                status="create",
                retained_conflict=conflicts.get(identity),
            )
        return assessments

    async def apply_system_definitions(
        self,
        assessments: Iterable[DefinitionAssessment],
    ) -> DefinitionApplyResult:
        requested = list(assessments)
        current = await self.assess(
            [assessment.candidate for assessment in requested]
        )
        created_identities: list[Identity] = []
        reused = 0
        touched_targets: set[str] = set()

        for assessment in sorted(current.values(), key=lambda item: item.identity):
            if assessment.status == "conflict":
                raise SpoolmanFieldError(
                    f"field {assessment.identity} conflicts with an existing definition"
                )
            if assessment.retained_conflict is not None:
                raise SpoolmanFieldError(
                    f"field {assessment.identity} has incompatible retained values"
                )
            if assessment.status == "reuse":
                reused += 1
                continue

            item = assessment.candidate
            self.db.add(
                SystemExtraField(
                    target_type=item.target_type.value,
                    key=item.key,
                    label=item.label,
                    field_type=item.field_type.value,
                    options=item.options,
                    config=item.config,
                    default_value=item.default_value,
                    source=None,
                )
            )
            created_identities.append(assessment.identity)
            touched_targets.add(item.target_type.value)

        await self.db.flush()
        for target in touched_targets:
            response_cache.delete(f"extra_fields:{target}:all")
        if touched_targets:
            response_cache.delete("extra_fields:all:all")

        return DefinitionApplyResult(
            created=len(created_identities),
            reused=reused,
            created_identities=tuple(created_identities),
        )
