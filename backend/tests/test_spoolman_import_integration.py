"""Deterministic integration coverage for rich-field imports and repairs.

Coverage matrix:
- Pure conversion/inference -> test_spoolman_extra_field_mapping.py
- Definition compatibility/planning/query count -> test_spoolman_extra_field_planner.py
- Import entity orchestration/API compatibility -> test_spoolman_import_service.py
- Repair fingerprint/no-overwrite/idempotency -> test_spoolman_import_repair_service.py
- Cross-layer mode and repair workflows -> test_spoolman_import_integration.py
- Real server capability smoke -> test_spoolman_live_smoke.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models.filament import Filament
from app.models.spool import Spool
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_contracts import (
    ApprovedRepairMapping,
    ImportStorageMode,
    SpoolmanFieldAction,
)
from app.services.spoolman_import_repair_service import SpoolmanImportRepairService
from app.services.spoolman_import_service import (
    SpoolmanImportError,
    SpoolmanImportService,
)
from tests.support.spoolman_fixture_server import SpoolmanFixtureServer

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "spoolman" / "rich_fields.json"


async def _imported_spool(db_session, spoolman_id: int) -> Spool | None:
    return await db_session.scalar(
        select(Spool).where(Spool.external_id == f"spoolman:{spoolman_id}")
    )


@pytest.mark.parametrize("mode", list(ImportStorageMode))
async def test_fixture_import_supports_every_storage_mode(db_session, mode):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
    )

    assert result.errors == []
    assert result.filaments_created == 2
    assert result.spools_created == 2

    spool = await _imported_spool(db_session, 20)
    assert spool is not None
    nested = (spool.custom_fields or {}).get("spoolman_extra", {})
    if mode in {ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL}:
        assert spool.custom_fields["tag"] == "rack-a"
        assert spool.custom_fields["dry"] == "2026-07-20T10:30:00Z"
        assert "tag" not in nested
    elif mode is ImportStorageMode.PRESERVE:
        assert nested["tag"] == '"rack-a"'
    else:
        assert nested["tag"] == "rack-a"


async def test_url_only_old_client_keeps_legacy_storage(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    result = await service.execute("http://spoolman")
    spool = await _imported_spool(db_session, 20)

    assert result.errors == []
    assert spool is not None
    assert spool.custom_fields["spoolman_extra"]["tag"] == "rack-a"
    assert spool.custom_field_definitions is None
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_per_field_override_mixes_system_local_and_preserve(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.PRESERVE,
        field_actions=[
            SpoolmanFieldAction(target_type="spool", key="tag", action="local"),
            SpoolmanFieldAction(target_type="spool", key="dry", action="system"),
        ],
    )
    spool = await _imported_spool(db_session, 20)
    definitions = (await db_session.execute(select(SystemExtraField))).scalars().all()

    assert result.errors == []
    assert {(item.target_type, item.key) for item in definitions} == {
        ("spool", "dry")
    }
    assert spool is not None
    assert spool.custom_field_definitions["tag"]["field_type"] == "text"
    assert spool.custom_fields["tag"] == "rack-a"
    assert spool.custom_fields["dry"] == "2026-07-20T10:30:00Z"


async def test_stale_fingerprint_is_rejected_before_writes(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    with pytest.raises(SpoolmanImportError) as error:
        await service.execute(
            "http://spoolman",
            "0" * 64,
            extra_field_mode=ImportStorageMode.SYSTEM,
        )

    assert error.value.code == "preview_changed"
    assert await db_session.scalar(select(func.count()).select_from(Filament)) == 0


async def test_second_import_is_idempotent_and_reuses_definitions(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    first = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )
    second = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )

    assert first.extra_fields_created == 4
    assert second.extra_fields_created == 0
    assert second.extra_fields_reused == 4
    assert second.filaments_created == 0
    assert second.spools_created == 0


async def test_invalid_authoritative_value_is_preserved(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )
    invalid_spool = await _imported_spool(db_session, 21)

    assert invalid_spool is not None
    assert "dry" not in invalid_spool.custom_fields
    assert invalid_spool.custom_fields["spoolman_extra"]["dry"] == '"invalid-date"'


async def test_server_repair_promotes_valid_values_and_keeps_invalid_values(
    db_session,
):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(
        db_session, client_factory=server.client_factory
    )
    await importer.execute("http://spoolman")
    repair = SpoolmanImportRepairService(db_session)
    source = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["field_definitions"]
    preview = await repair.preview("server", source)
    tag = next(item for item in preview["mappings"] if item["key"] == "tag")
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    result = await repair.execute(
        "server",
        preview["preview_fingerprint"],
        [
            ApprovedRepairMapping.model_validate({**tag, "action": "system"}),
            ApprovedRepairMapping.model_validate({**dry, "action": "system"}),
        ],
        source,
    )

    assert result["values_promoted"] == 3
    assert result["values_preserved"] >= 1


async def test_offline_repair_supports_system_and_local_actions(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(
        db_session, client_factory=server.client_factory
    )
    import_preview = await importer.preview("http://spoolman")
    await importer.execute(
        "http://spoolman",
        import_preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.PRESERVE,
    )
    repair = SpoolmanImportRepairService(db_session)
    preview = await repair.preview("offline")
    tag = next(item for item in preview["mappings"] if item["key"] == "tag")
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    result = await repair.execute(
        "offline",
        preview["preview_fingerprint"],
        [
            ApprovedRepairMapping.model_validate({**tag, "action": "system"}),
            ApprovedRepairMapping.model_validate(
                {
                    **dry,
                    "field_type": "date",
                    "source_field_type": "datetime",
                    "config": None,
                    "default_value": None,
                    "action": "local",
                }
            ),
        ],
    )

    assert result["definitions_created"] == 1
    assert result["local_definitions_created"] == 1
    assert result["values_preserved"] >= 1


async def test_datetime_can_be_repaired_to_date(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(
        db_session, client_factory=server.client_factory
    )
    await importer.execute("http://spoolman")
    source = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["field_definitions"]
    repair = SpoolmanImportRepairService(db_session)
    preview = await repair.preview("server", source)
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    mapping = ApprovedRepairMapping.model_validate(
        {
            **dry,
            "field_type": "date",
            "config": None,
            "default_value": None,
        }
    )
    result = await repair.execute(
        "server", preview["preview_fingerprint"], [mapping], source
    )

    assert result["values_promoted"] == 1
    spool = await _imported_spool(db_session, 20)
    assert spool is not None
    assert spool.custom_fields["dry"] == "2026-07-20"
