import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.filament import Filament, Manufacturer
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_client import SpoolmanClient
from app.services.spoolman_contracts import ApprovedRepairMapping, RepairMode
from app.services.spoolman_extra_field_mapping import SpoolmanFieldError
from app.services.spoolman_import_repair_service import (
    LegacyImportRow,
    SpoolmanImportRepairService,
    SpoolmanRepairError,
)
from tests.support.spoolman_factories import create_imported_filament


async def _legacy_filament(db_session, custom_fields):
    return await create_imported_filament(
        db_session,
        spoolman_id=custom_fields.get("spoolman_id", 12),
        custom_fields=custom_fields,
        designation="Legacy PLA",
    )


def test_preview_conversion_examples_uses_execute_conversion_rules():
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "spool",
            "key": "dry",
            "label": "Dry",
            "field_type": "date",
            "source_field_type": "datetime",
            "action": "system",
        }
    )

    result = SpoolmanImportRepairService.preview_conversion_examples(
        mapping,
        ['"2026-07-27T15:45:30Z"', '"not a date"'],
    )

    assert result == {
        "conversion_examples": [
            {
                "source": '"2026-07-27T15:45:30Z"',
                "converted": "2026-07-27",
            }
        ],
        "invalid_sample_indexes": [1],
    }


def test_preview_conversion_examples_uses_submitted_dropdown_choices():
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "spool",
            "key": "material",
            "label": "Material",
            "field_type": "dropdown",
            "source_field_type": "choice",
            "options": ["PLA", "PETG"],
            "action": "system",
        }
    )

    result = SpoolmanImportRepairService.preview_conversion_examples(
        mapping,
        ['"PLA"', '"TPU"'],
    )

    assert result["conversion_examples"] == [
        {"source": '"PLA"', "converted": "PLA"}
    ]
    assert result["invalid_sample_indexes"] == [1]


async def test_execute_reuses_rows_loaded_for_fingerprint(db_session, monkeypatch):
    await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"dry": "true"}},
    )
    service = SpoolmanImportRepairService(db_session)
    original = service._imported_rows
    calls = 0

    async def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await original(*args, **kwargs)

    monkeypatch.setattr(service, "_imported_rows", counted)
    preview = await service.preview(RepairMode.OFFLINE)
    calls = 0
    approved = [
        ApprovedRepairMapping.model_validate(
            {**preview["mappings"][0], "action": "system"}
        )
    ]

    await service.execute(
        RepairMode.OFFLINE,
        preview["preview_fingerprint"],
        approved,
    )

    assert calls == 1


async def test_execute_assesses_and_creates_the_approved_manual_type(db_session):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"inspection": '"2026-07-27T15:45:30Z"'},
        },
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview(RepairMode.OFFLINE)
    source = next(item for item in preview["mappings"] if item["key"] == "inspection")
    approved = ApprovedRepairMapping.model_validate(
        {
            **source,
            "field_type": "date",
            "source_field_type": "datetime",
            "config": None,
            "default_value": None,
            "action": "system",
        }
    )

    await service.execute(
        RepairMode.OFFLINE,
        preview["preview_fingerprint"],
        [approved],
    )

    definition = await db_session.scalar(
        select(SystemExtraField).where(SystemExtraField.key == "inspection")
    )
    await db_session.refresh(filament)
    assert definition is not None
    assert definition.field_type == "date"
    assert filament.custom_fields["inspection"] == "2026-07-27"


async def test_system_promotion_rejects_same_type_local_definition_with_other_unit(
    db_session,
):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"temperature": "215"},
        },
    )
    filament.custom_field_definitions = {
        "temperature": {
            "label": "Temperature",
            "field_type": "number",
            "config": {"unit": "mm", "decimal_places": 0},
        }
    }
    await db_session.commit()

    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    mapping = next(item for item in preview["mappings"] if item["key"] == "temperature")
    approved = {
        **mapping,
        "config": {"unit": "°C", "decimal_places": 0},
        "action": "system",
    }

    with pytest.raises(SpoolmanRepairError) as error:
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [approved],
        )
    assert error.value.code == "retained_value_conflict"


async def test_offline_preview_is_non_mutating(db_session):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"pressure_advance": "0.025", "dry": "true"},
        },
    )
    service = SpoolmanImportRepairService(db_session)

    preview = await service.preview("offline")

    assert preview["summary"] == {
        "imported_records": 1,
        "records_scanned": 1,
        "fields_found": 2,
        "promotable": 2,
        "collisions": 0,
        "invalid": 0,
        "unresolved": 0,
    }
    assert {item["field_type"] for item in preview["mappings"]} == {
        "number",
        "checkbox",
    }
    pressure = next(
        item for item in preview["mappings"] if item["key"] == "pressure_advance"
    )
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    assert pressure["confidence"] == "low"
    assert pressure["confidence_reason"] == "legacy_scalar"
    assert pressure["conversion_examples"] == [{"source": "0.025", "converted": 0.025}]
    assert dry["conversion_examples"] == [{"source": "true", "converted": True}]
    await db_session.refresh(filament)
    assert filament.custom_fields == {
        "spoolman_id": 12,
        "spoolman_extra": {"pressure_advance": "0.025", "dry": "true"},
    }


async def test_offline_execute_promotes_only_approved_values(db_session):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"pressure_advance": "0.025", "notes": "keep me"},
        },
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    approved = [
        item for item in preview["mappings"] if item["key"] == "pressure_advance"
    ]

    result = await service.execute(
        "offline",
        preview["preview_fingerprint"],
        approved,
    )

    assert result["definitions_created"] == 1
    assert result["records_updated"] == 1
    assert result["values_promoted"] == 1
    await db_session.refresh(filament)
    assert filament.custom_fields == {
        "spoolman_id": 12,
        "pressure_advance": 0.025,
        "spoolman_extra": {"notes": "keep me"},
    }
    definition = await db_session.scalar(
        select(SystemExtraField).where(SystemExtraField.key == "pressure_advance")
    )
    assert definition is not None
    assert definition.field_type == "number"
    assert definition.source is None


async def test_offline_repair_can_create_record_local_definition(db_session):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"drying_temperature": "55"},
        },
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    approved = [{**preview["mappings"][0], "action": "local"}]

    result = await service.execute("offline", preview["preview_fingerprint"], approved)

    assert result["definitions_created"] == 0
    assert result["local_definitions_created"] == 1
    await db_session.refresh(filament)
    assert filament.custom_fields["drying_temperature"] == 55
    assert (
        filament.custom_field_definitions["drying_temperature"]["field_type"]
        == "number"
    )
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_offline_repair_can_explicitly_preserve_value(db_session):
    filament = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"dry": "true"}},
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    approved = [{**preview["mappings"][0], "action": "preserve"}]

    result = await service.execute("offline", preview["preview_fingerprint"], approved)

    assert result["records_updated"] == 0
    assert result["values_promoted"] == 0
    await db_session.refresh(filament)
    assert filament.custom_fields["spoolman_extra"] == {"dry": "true"}


async def test_repair_never_overwrites_top_level_value(db_session):
    filament = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "pressure_advance": 0.04,
            "spoolman_extra": {"pressure_advance": "0.025"},
        },
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    assert preview["summary"]["collisions"] == 1
    assert preview["mappings"][0]["status"] == "no_promotable"

    result = await service.execute(
        "offline",
        preview["preview_fingerprint"],
        [],
    )

    assert result["values_promoted"] == 0
    await db_session.refresh(filament)
    assert filament.custom_fields["pressure_advance"] == 0.04
    assert filament.custom_fields["spoolman_extra"]["pressure_advance"] == "0.025"


async def test_repair_blocks_system_storage_when_retained_value_is_incompatible(
    db_session,
):
    retained = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "pressure_advance": "not a number",
            "spoolman_extra": {"notes": "keep"},
        },
    )
    repairable = Filament(
        manufacturer_id=retained.manufacturer_id,
        designation="Repairable retained value",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={
            "spoolman_id": 13,
            "spoolman_extra": {"pressure_advance": "0.025"},
        },
    )
    db_session.add(repairable)
    await db_session.commit()
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    pressure = next(
        item for item in preview["mappings"] if item["key"] == "pressure_advance"
    )

    assert pressure["status"] == "ready"
    assert pressure["promotable_occurrences"] == 1
    assert pressure["system_conflict"]["count"] == 1
    with pytest.raises(SpoolmanRepairError, match="incompatible retained"):
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [{**pressure, "action": "system"}],
        )

    result = await service.execute(
        "offline",
        preview["preview_fingerprint"],
        [{**pressure, "action": "local"}],
    )
    assert result["local_definitions_created"] == 1
    assert result["values_promoted"] == 1
    await db_session.refresh(repairable)
    assert repairable.custom_fields["pressure_advance"] == 0.025


async def test_repair_rejects_overlapping_system_definition_paths(db_session):
    await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"pressure_advance": "0.025"},
        },
    )
    db_session.add(
        SystemExtraField(
            target_type="filament",
            key="pressure_advance.calibrated",
            label="Calibrated pressure advance",
            field_type="checkbox",
        )
    )
    await db_session.commit()
    service = SpoolmanImportRepairService(db_session)

    preview = await service.preview("offline")
    mapping = preview["mappings"][0]
    assert mapping["status"] == "conflict"
    assert mapping["conflicting_key"] == "pressure_advance.calibrated"

    with pytest.raises(SpoolmanRepairError, match="not repairable"):
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [mapping],
        )


def test_repair_date_conversion_accepts_date_or_datetime_only():
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "filament",
            "key": "inspection",
            "label": "Inspection",
            "field_type": "date",
            "source_field_type": "datetime",
        }
    )

    assert (
        SpoolmanImportRepairService._convert_approved('"2026-07-27T15:45:30Z"', mapping)
        == "2026-07-27"
    )
    assert (
        SpoolmanImportRepairService._convert_approved('"2026-07-28"', mapping)
        == "2026-07-28"
    )
    with pytest.raises(SpoolmanFieldError, match="ISO-8601"):
        SpoolmanImportRepairService._convert_approved('"someday"', mapping)


def test_repair_choice_mapping_requires_options():
    with pytest.raises(ValidationError, match="require choices"):
        ApprovedRepairMapping.model_validate(
            {
                "target_type": "filament",
                "key": "profile",
                "label": "Profile",
                "field_type": "dropdown",
                "options": [],
                "action": "system",
            }
        )


@pytest.mark.parametrize(
    ("field_type", "default_value"),
    [
        ("dropdown", "PLA, CF"),
        ("multiselect", '[" padded ",""]'),
    ],
)
def test_repair_choice_mapping_normalizes_options_and_defaults(
    field_type,
    default_value,
):
    options = ["PLA, CF", " padded ", ""]

    approved = ApprovedRepairMapping.model_validate(
        {
            "target_type": "filament",
            "key": "profile",
            "label": "Profile",
            "field_type": field_type,
            "options": options,
            "default_value": default_value,
            "action": "system",
        }
    )

    assert approved.options == ["PLA, CF", "padded"]
    assert approved.default_value == (
        "PLA, CF" if field_type == "dropdown" else '["padded"]'
    )


@pytest.mark.parametrize(
    ("field_type", "default_value"),
    [
        ("dropdown", "PLA, CF"),
        ("multiselect", '["PLA, CF",""]'),
    ],
)
def test_repair_choice_mapping_rejects_defaults_removed_by_real_edit(
    field_type,
    default_value,
):
    with pytest.raises(ValidationError, match="default"):
        ApprovedRepairMapping.model_validate(
            {
                "target_type": "filament",
                "key": "profile",
                "label": "Profile",
                "field_type": field_type,
                "options": ["PETG"],
                "default_value": default_value,
                "action": "system",
            }
        )


async def test_repair_fingerprint_ignores_row_and_definition_list_order(
    db_session,
    monkeypatch,
):
    rows = [
        LegacyImportRow(
            target_type="filament",
            entity_id=2,
            custom_fields={
                "spoolman_id": 22,
                "spoolman_extra": {"second": '"B"'},
            },
            nested={"second": '"B"'},
        ),
        LegacyImportRow(
            target_type="filament",
            entity_id=1,
            custom_fields={
                "spoolman_id": 11,
                "spoolman_extra": {"first": '"A"'},
            },
            nested={"first": '"A"'},
        ),
    ]
    definitions = {
        "filament": [
            {
                "key": "second",
                "name": "Second",
                "field_type": "text",
                "order": 2,
            },
            {
                "key": "first",
                "name": "First",
                "field_type": "text",
                "order": 1,
            },
        ]
    }
    service = SpoolmanImportRepairService(db_session)
    monkeypatch.setattr(service, "_imported_rows", AsyncMock(return_value=rows))
    first = await service.preview("server", definitions)

    monkeypatch.setattr(
        service,
        "_imported_rows",
        AsyncMock(return_value=list(reversed(rows))),
    )
    second = await service.preview(
        "server",
        {"filament": list(reversed(definitions["filament"]))},
    )

    assert first["preview_fingerprint"] == second["preview_fingerprint"]


async def test_repair_rejects_edited_mapping_that_converts_no_values(db_session):
    await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"material_profile": '"PLA"'},
        },
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    mapping = preview["mappings"][0]

    with pytest.raises(SpoolmanRepairError, match="no values compatible"):
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [
                {
                    **mapping,
                    "field_type": "dropdown",
                    "options": ["PETG"],
                    "action": "system",
                }
            ],
        )

    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_repair_accepts_manual_type_for_unresolved_mixed_values(db_session):
    compatible = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"tensile_strength": 48.5},
        },
    )
    incompatible = Filament(
        manufacturer_id=compatible.manufacturer_id,
        designation="Legacy PLA with incompatible tensile strength",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={
            "spoolman_id": 13,
            "spoolman_extra": {"tensile_strength": {"measured": 48.5}},
        },
    )
    db_session.add(incompatible)
    await db_session.commit()
    service = SpoolmanImportRepairService(db_session)

    preview = await service.preview("offline")
    mapping = preview["mappings"][0]

    assert mapping["confidence"] == "unresolved"
    assert mapping["status"] == "no_promotable"

    result = await service.execute(
        "offline",
        preview["preview_fingerprint"],
        [{**mapping, "field_type": "number", "action": "system"}],
    )

    assert result["definitions_created"] == 1
    assert result["values_promoted"] == 1
    assert result["values_preserved"] == 1
    await db_session.refresh(compatible)
    assert compatible.custom_fields["tensile_strength"] == 48.5
    assert "spoolman_extra" not in compatible.custom_fields
    await db_session.refresh(incompatible)
    assert incompatible.custom_fields["spoolman_extra"] == {
        "tensile_strength": {"measured": 48.5}
    }


@pytest.mark.parametrize("action", ["system", "local"])
async def test_unresolved_repair_rejects_unchanged_fallback_type(
    db_session,
    action,
):
    first = await _legacy_filament(
        db_session,
        {
            "spoolman_id": 12,
            "spoolman_extra": {"tensile_strength": 48.5},
        },
    )
    db_session.add(
        Filament(
            manufacturer_id=first.manufacturer_id,
            designation="Legacy mixed tensile strength",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={
                "spoolman_id": 13,
                "spoolman_extra": {"tensile_strength": {"measured": 48.5}},
            },
        )
    )
    await db_session.commit()
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    mapping = preview["mappings"][0]
    assert mapping["confidence"] == "unresolved"
    assert mapping["field_type"] == "text"

    with pytest.raises(SpoolmanRepairError) as exc_info:
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [{**mapping, "action": action}],
        )

    assert exc_info.value.code == "manual_type_required"


async def test_unresolved_repair_route_rejects_unchanged_fallback_type(
    auth_client,
    db_session,
):
    client, csrf = auth_client
    first = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"profile": 42}},
    )
    db_session.add(
        Filament(
            manufacturer_id=first.manufacturer_id,
            designation="Legacy mixed profile",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={
                "spoolman_id": 13,
                "spoolman_extra": {"profile": {"value": 42}},
            },
        )
    )
    await db_session.commit()
    preview = (
        await client.post(
            "/api/v1/admin/system/spoolman-import/repair/preview",
            json={"mode": "offline"},
            headers={"X-CSRF-Token": csrf},
        )
    ).json()

    response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/execute",
        json={
            "mode": "offline",
            "preview_fingerprint": preview["preview_fingerprint"],
            "approved_mappings": [
                {**preview["mappings"][0], "action": "system"}
            ],
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "manual_type_required"


@pytest.mark.parametrize("action", ["system", "local"])
@pytest.mark.parametrize(
    "key",
    [
        "__proto__",
        "constructor",
        "prototype",
        "spoolman_extra",
        "spoolman_id",
        "spoolman_external_id",
        "filamentdb_id",
    ],
)
async def test_repair_rejects_reserved_destination_identity(
    db_session,
    key,
    action,
):
    filament = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {key: "42"}},
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    mapping = preview["mappings"][0]

    with pytest.raises(SpoolmanRepairError) as exc_info:
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [{**mapping, "field_type": "number", "action": action}],
        )

    assert exc_info.value.code == "invalid_mapping"
    await db_session.refresh(filament)
    assert filament.custom_fields["spoolman_extra"][key] == "42"


async def test_local_repair_rejects_child_definition_overlapping_parent_mapping(
    db_session,
):
    filament = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"calibration": "42"}},
    )
    filament.custom_field_definitions = {
        "calibration.value": {"label": "Value", "field_type": "number"}
    }
    await db_session.commit()
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")

    with pytest.raises(SpoolmanRepairError) as exc_info:
        await service.execute(
            "offline",
            preview["preview_fingerprint"],
            [{**preview["mappings"][0], "action": "local"}],
        )

    assert exc_info.value.code == "field_conflict"


def test_local_repair_preflight_rejects_parent_definition_overlapping_child_mapping():
    model = type(
        "LocalModel",
        (),
        {
            "custom_field_definitions": {
                "calibration": {"label": "Calibration", "field_type": "number"}
            }
        },
    )()
    row = LegacyImportRow(
        target_type="filament",
        entity_id=1,
        nested={"calibration.value": "42"},
        custom_fields={
            "spoolman_id": 12,
            "spoolman_extra": {"calibration.value": "42"},
        },
        model=model,
    )
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "filament",
            "key": "calibration_value",
            "label": "Calibration value",
            "field_type": "number",
            "source_field_type": "integer",
            "options": None,
            "config": {"decimal_places": 0},
            "action": "local",
        }
    ).model_copy(update={"key": "calibration.value"})

    assert SpoolmanImportRepairService(AsyncMock())._can_promote_row(
        row,
        mapping,
    ) is False


def test_local_repair_checks_every_overlapping_definition():
    model = type(
        "LocalModel",
        (),
        {
            "custom_field_definitions": {
                "calibration": {
                    "label": "Calibration",
                    "field_type": "number",
                    "options": None,
                    "config": {"decimal_places": 0},
                },
                "calibration.value": {
                    "label": "Value",
                    "field_type": "number",
                },
            }
        },
    )()
    row = LegacyImportRow(
        target_type="filament",
        entity_id=1,
        nested={"calibration": "42"},
        custom_fields={
            "spoolman_id": 12,
            "spoolman_extra": {"calibration": "42"},
        },
        model=model,
    )
    mapping = ApprovedRepairMapping.model_validate(
        {
            "target_type": "filament",
            "key": "calibration",
            "label": "Calibration",
            "field_type": "number",
            "source_field_type": "integer",
            "options": None,
            "config": {"decimal_places": 0},
            "action": "local",
        }
    )

    assert SpoolmanImportRepairService(AsyncMock())._can_promote_row(
        row,
        mapping,
    ) is False


async def test_repair_is_idempotent(db_session):
    await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"dry": "true"}},
    )
    service = SpoolmanImportRepairService(db_session)
    preview = await service.preview("offline")
    await service.execute(
        "offline", preview["preview_fingerprint"], preview["mappings"]
    )

    second_preview = await service.preview("offline")

    assert second_preview["summary"]["imported_records"] == 1
    assert second_preview["summary"]["records_scanned"] == 0
    assert second_preview["summary"]["promotable"] == 0


async def test_repair_serializes_a_real_two_session_sqlite_writer(tmp_path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'repair-concurrency.db'}",
        connect_args={"timeout": 2},
    )
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with session_maker() as setup_session:
            manufacturer = Manufacturer(name="Concurrent repair")
            setup_session.add(manufacturer)
            await setup_session.flush()
            filament = Filament(
                manufacturer_id=manufacturer.id,
                designation="Concurrent legacy PLA",
                material_type="PLA",
                diameter_mm=1.75,
                custom_fields={
                    "spoolman_id": 12,
                    "spoolman_extra": {"pressure_advance": "0.025"},
                },
            )
            setup_session.add(filament)
            await setup_session.commit()
            filament_id = filament.id

        async with session_maker() as preview_session:
            preview = await SpoolmanImportRepairService(preview_session).preview(
                "offline"
            )

        execute_rows_loaded = asyncio.Event()
        release_execute = asyncio.Event()
        writer_started = asyncio.Event()
        async with session_maker() as execute_session:
            service = SpoolmanImportRepairService(execute_session)
            original_imported_rows = service._imported_rows

            async def gated_imported_rows(
                include_model=False,
                lock_for_update=False,
            ):
                rows = await original_imported_rows(
                    include_model,
                    lock_for_update=lock_for_update,
                )
                if lock_for_update:
                    execute_rows_loaded.set()
                    await release_execute.wait()
                return rows

            service._imported_rows = gated_imported_rows
            execute_task = asyncio.create_task(
                service.execute(
                    "offline",
                    preview["preview_fingerprint"],
                    preview["mappings"],
                )
            )
            await asyncio.wait_for(execute_rows_loaded.wait(), timeout=1)

            async def concurrent_writer():
                async with session_maker() as writer_session:
                    writer_started.set()
                    await writer_session.execute(text("BEGIN IMMEDIATE"))
                    current = await writer_session.get(Filament, filament_id)
                    custom_fields = dict(current.custom_fields)
                    custom_fields["concurrent_sentinel"] = "kept"
                    current.custom_fields = custom_fields
                    await writer_session.commit()

            writer_task = asyncio.create_task(concurrent_writer())
            await writer_started.wait()
            release_execute.set()
            result = await execute_task
            await writer_task

        async with session_maker() as verify_session:
            repaired = await verify_session.get(Filament, filament_id)
            assert result["values_promoted"] == 1
            assert repaired.custom_fields == {
                "spoolman_id": 12,
                "pressure_advance": 0.025,
                "concurrent_sentinel": "kept",
            }
    finally:
        await engine.dispose()


async def test_preview_distinguishes_typed_imports_from_no_imports(db_session):
    filament = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "dry": True},
    )
    service = SpoolmanImportRepairService(db_session)

    typed_preview = await service.preview("offline")

    assert typed_preview["summary"]["imported_records"] == 1
    assert typed_preview["summary"]["records_scanned"] == 0
    assert typed_preview["mappings"] == []

    filament.custom_fields = {"dry": True}
    await db_session.commit()
    no_import_preview = await service.preview("offline")

    assert no_import_preview["summary"]["imported_records"] == 0
    assert no_import_preview["summary"]["records_scanned"] == 0
    assert no_import_preview["mappings"] == []


async def test_preview_samples_are_bounded_without_changing_stored_data(db_session):
    long_value = "x" * 500
    filament = await _legacy_filament(
        db_session,
        {"spoolman_id": 12, "spoolman_extra": {"notes": long_value}},
    )
    service = SpoolmanImportRepairService(db_session)

    preview = await service.preview("offline")

    assert len(preview["mappings"][0]["samples"][0]) == 200
    assert preview["mappings"][0]["samples"][0].endswith("...")
    await db_session.refresh(filament)
    assert filament.custom_fields["spoolman_extra"]["notes"] == long_value


async def test_preview_includes_up_to_three_distinct_real_conversion_examples(
    db_session,
):
    first = await _legacy_filament(
        db_session,
        {"spoolman_id": 1, "spoolman_extra": {"temperature": "[190,230]"}},
    )
    for spoolman_id, value in enumerate(
        ("[195,235]", "[200,240]", "[205,245]"),
        start=2,
    ):
        db_session.add(
            Filament(
                manufacturer_id=first.manufacturer_id,
                designation=f"Legacy PLA {spoolman_id}",
                material_type="PLA",
                diameter_mm=1.75,
                custom_fields={
                    "spoolman_id": spoolman_id,
                    "spoolman_extra": {"temperature": value},
                },
            )
        )
    await db_session.commit()

    preview = await SpoolmanImportRepairService(db_session).preview("offline")
    mapping = preview["mappings"][0]

    assert mapping["confidence"] == "high"
    assert mapping["promotable_occurrences"] == 4
    assert mapping["conversion_examples"] == [
        {"source": "[190,230]", "converted": {"min": 190, "max": 230}},
        {"source": "[195,235]", "converted": {"min": 195, "max": 235}},
        {"source": "[200,240]", "converted": {"min": 200, "max": 240}},
    ]


async def test_offline_repair_admin_api_requires_preview_and_approval(
    auth_client, db_session
):
    client, csrf = auth_client
    await _legacy_filament(
        db_session,
        {"spoolman_id": 44, "spoolman_extra": {"dry": "true"}},
    )

    preview_response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/preview",
        json={"mode": "offline"},
        headers={"X-CSRF-Token": csrf},
    )
    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["summary"]["promotable"] == 1

    missing_approval = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/execute",
        json={
            "mode": "offline",
            "preview_fingerprint": preview["preview_fingerprint"],
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert missing_approval.status_code == 422

    execute_response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/execute",
        json={
            "mode": "offline",
            "preview_fingerprint": preview["preview_fingerprint"],
            "approved_mappings": preview["mappings"],
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert execute_response.status_code == 200
    assert execute_response.json()["values_promoted"] == 1


async def test_server_repair_preview_reports_partial_definition_availability(
    auth_client,
    db_session,
    monkeypatch,
):
    client, csrf = auth_client
    await _legacy_filament(
        db_session,
        {"spoolman_id": 45, "spoolman_extra": {"dry": "true"}},
    )

    async def partial_definitions(self):
        return (
            {
                "vendor": [],
                "filament": [
                    {
                        "key": "dry",
                        "name": "Dry",
                        "field_type": "boolean",
                    }
                ],
                "spool": [],
            },
            ["Spoolman field definitions for spool are unavailable."],
            {"filament"},
        )

    monkeypatch.setattr(
        SpoolmanClient,
        "fetch_field_definitions",
        partial_definitions,
    )

    response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/preview",
        json={"mode": "server", "url": "http://spoolman.test"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["warnings"] == [
        "Spoolman field definitions for spool are unavailable."
    ]
    assert body["extra_field_targets"] == ["filament"]
    assert [mapping["key"] for mapping in body["mappings"]] == ["dry"]


async def test_server_repair_preview_accepts_available_empty_definition_target(
    auth_client,
    monkeypatch,
):
    client, csrf = auth_client

    async def empty_available_definitions(self):
        return (
            {"vendor": [], "filament": [], "spool": []},
            ["Spoolman field definitions for spool are unavailable."],
            {"filament"},
        )

    monkeypatch.setattr(
        SpoolmanClient,
        "fetch_field_definitions",
        empty_available_definitions,
    )

    response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/preview",
        json={"mode": "server", "url": "http://spoolman.test"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["extra_field_targets"] == ["filament"]


async def test_server_repair_preview_rejects_when_no_repair_target_is_available(
    auth_client,
    monkeypatch,
):
    client, csrf = auth_client

    async def unavailable_definitions(self):
        return (
            {"vendor": [], "filament": [], "spool": []},
            [
                "Spoolman field definitions for filament are unavailable.",
                "Spoolman field definitions for spool are unavailable.",
            ],
            {"vendor"},
        )

    monkeypatch.setattr(
        SpoolmanClient,
        "fetch_field_definitions",
        unavailable_definitions,
    )

    response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/preview",
        json={"mode": "server", "url": "http://spoolman.test"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "definitions_unavailable"
