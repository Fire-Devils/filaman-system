from typing import Any

import pytest
from sqlalchemy import event

from app.models.filament import Filament, Manufacturer
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_contracts import SpoolmanFieldCandidate
from app.services.spoolman_extra_field_mapping import SpoolmanFieldError
from app.services.spoolman_extra_field_planner import SpoolmanExtraFieldPlanner
from app.services.system_extra_field_compatibility import (
    find_definition_value_conflicts,
)
from tests.support.spoolman_factories import create_imported_filament


def candidate(
    target_type: str,
    key: str,
    field_type: str,
    *,
    options: list[str] | None = None,
    config: dict[str, Any] | None = None,
) -> SpoolmanFieldCandidate:
    return SpoolmanFieldCandidate.model_validate(
        {
            "target_type": target_type,
            "key": key,
            "label": key.replace("_", " ").title(),
            "field_type": field_type,
            "options": options,
            "config": config,
        }
    )


async def test_planner_assesses_create_reuse_and_conflict(db_session):
    db_session.add_all(
        [
            SystemExtraField(
                target_type="filament",
                key="temperature",
                label="Temperature",
                field_type="number",
                config={"unit": "°C"},
            ),
            SystemExtraField(
                target_type="spool",
                key="profile.child",
                label="Nested profile",
                field_type="text",
            ),
        ]
    )
    await db_session.commit()

    assessments = await SpoolmanExtraFieldPlanner(db_session).assess(
        [
            candidate("filament", "temperature", "number", config={"unit": "°C"}),
            candidate("filament", "dry", "checkbox"),
            candidate("spool", "profile", "text"),
        ]
    )

    assert assessments[("filament", "temperature")].status == "reuse"
    assert assessments[("filament", "dry")].status == "create"
    assert assessments[("spool", "profile")].status == "conflict"
    assert assessments[("spool", "profile")].conflicting_key == "profile.child"


async def test_planner_applies_create_and_reuse_once(db_session):
    db_session.add(
        SystemExtraField(
            target_type="filament",
            key="temperature",
            label="Temperature",
            field_type="number",
            config={"unit": "°C"},
        )
    )
    await db_session.commit()

    planner = SpoolmanExtraFieldPlanner(db_session)
    assessments = await planner.assess(
        [
            candidate("filament", "temperature", "number", config={"unit": "°C"}),
            candidate("spool", "dry", "checkbox"),
        ]
    )
    result = await planner.apply_system_definitions(assessments.values())

    assert result.created == 1
    assert result.reused == 1
    assert result.created_identities == (("spool", "dry"),)


async def test_planner_refuses_an_overlap_conflict(db_session):
    db_session.add(
        SystemExtraField(
            target_type="spool",
            key="profile.child",
            label="Nested profile",
            field_type="text",
        )
    )
    await db_session.commit()
    planner = SpoolmanExtraFieldPlanner(db_session)
    assessment = (
        await planner.assess([candidate("spool", "profile", "text")])
    )[("spool", "profile")]

    with pytest.raises(SpoolmanFieldError, match="conflicts"):
        await planner.apply_system_definitions([assessment])


async def test_planner_refuses_incompatible_retained_values(db_session):
    await create_imported_filament(
        db_session,
        spoolman_id=12,
        custom_fields={"temperature": "hot"},
        designation="Retained",
    )
    planner = SpoolmanExtraFieldPlanner(db_session)
    assessment = (
        await planner.assess([candidate("filament", "temperature", "number")])
    )[("filament", "temperature")]

    assert assessment.retained_conflict is not None
    with pytest.raises(SpoolmanFieldError, match="retained"):
        await planner.apply_system_definitions([assessment])


async def test_planner_revalidates_definition_state_before_apply(db_session):
    planner = SpoolmanExtraFieldPlanner(db_session)
    assessment = (
        await planner.assess([candidate("spool", "profile", "text")])
    )[("spool", "profile")]
    assert assessment.status == "create"

    db_session.add(
        SystemExtraField(
            target_type="spool",
            key="profile.child",
            label="Concurrent nested field",
            field_type="text",
        )
    )
    await db_session.commit()

    with pytest.raises(SpoolmanFieldError, match="conflicts"):
        await planner.apply_system_definitions([assessment])


async def test_batch_conflict_scan_reports_each_candidate(db_session):
    manufacturer = Manufacturer(name="Planner test")
    db_session.add(manufacturer)
    await db_session.flush()
    db_session.add_all(
        [
            Filament(
                manufacturer_id=manufacturer.id,
                designation="One",
                material_type="PLA",
                diameter_mm=1.75,
                custom_fields={"temperature": "hot", "profile": "PLA"},
            ),
            Filament(
                manufacturer_id=manufacturer.id,
                designation="Two",
                material_type="PLA",
                diameter_mm=1.75,
                custom_fields={"temperature": 215, "profile": "TPU"},
            ),
        ]
    )
    await db_session.commit()

    candidates = [
        {
            "target_type": "filament",
            "key": "temperature",
            "field_type": "number",
            "options": None,
            "config": {"unit": "°C"},
        },
        {
            "target_type": "filament",
            "key": "profile",
            "field_type": "dropdown",
            "options": ["PLA", "PETG"],
            "config": None,
        },
    ]

    conflicts = await find_definition_value_conflicts(db_session, candidates)

    assert conflicts[("filament", "temperature")].count == 1
    assert conflicts[("filament", "profile")].count == 1


async def test_batch_conflict_scan_queries_each_target_once(db_session):
    statements: list[str] = []

    def before_cursor_execute(_conn, _cursor, statement, *_args):
        if "FROM filaments" in statement or "FROM spools" in statement:
            statements.append(statement)

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    try:
        await find_definition_value_conflicts(
            db_session,
            [
                {
                    "target_type": "filament",
                    "key": f"field_{index}",
                    "field_type": "text",
                }
                for index in range(20)
            ]
            + [
                {
                    "target_type": "spool",
                    "key": f"field_{index}",
                    "field_type": "text",
                }
                for index in range(20)
            ],
        )
    finally:
        event.remove(engine, "before_cursor_execute", before_cursor_execute)

    assert sum("FROM filaments" in sql for sql in statements) == 1
    assert sum("FROM spools" in sql for sql in statements) == 1
