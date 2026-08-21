from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.api.v1 import spoolman as spoolman_api
from app.core.file_lock import exclusive_file_lock
from app.main import app as fastapi_app
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.models.spool import Spool
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_contracts import ImportStorageMode, SpoolmanFieldAction
from app.services.spoolman_import_service import (
    ImportPreview,
    ImportResult,
    SpoolmanImportError,
    SpoolmanImportService,
)
from tests.support.spoolman_factories import source_definition


def test_spoolman_admin_routes_are_registered():
    paths = {route.path for route in fastapi_app.routes}
    assert {
        "/api/v1/admin/system/spoolman-import/test-connection",
        "/api/v1/admin/system/spoolman-import/preview",
        "/api/v1/admin/system/spoolman-import/execute",
        "/api/v1/admin/system/spoolman-import/repair-transparency",
        "/api/v1/admin/system/spoolman-import/repair/preview",
        "/api/v1/admin/system/spoolman-import/repair/examples",
        "/api/v1/admin/system/spoolman-import/repair/execute",
    } <= paths


async def test_repair_examples_endpoint_returns_backend_conversion(auth_client):
    client, csrf = auth_client
    response = await client.post(
        "/api/v1/admin/system/spoolman-import/repair/examples",
        json={
            "mapping": {
                "target_type": "spool",
                "key": "dry",
                "label": "Dry",
                "field_type": "date",
                "source_field_type": "datetime",
                "action": "system",
            },
            "samples": ['"2026-07-27T15:45:30Z"'],
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["conversion_examples"][0]["converted"] == "2026-07-27"


class TestSpoolmanImportColorSupport:
    def test_extract_colors_normalizes_alpha_hex_values(self):
        service = SpoolmanImportService(None)

        colors = service._extract_colors(
            [
                {
                    "color_hex": "00d4d488",
                    "multi_color_hexes": ["#00FFFFFF", "3C8AD77F", "be000022", "abc"],
                }
            ]
        )

        assert colors == [
            {"name": "#00D4D488", "hex_code": "#00D4D488"},
            {"name": "#FFFFFF00", "hex_code": "#FFFFFF00"},
            {"name": "#8AD77F3C", "hex_code": "#8AD77F3C"},
            {"name": "#BE000022", "hex_code": "#BE000022"},
            {"name": "#AABBCC", "hex_code": "#AABBCC"},
        ]

    def test_repeated_primary_is_deduplicated_and_source_positions_are_preserved(
        self,
    ):
        service = SpoolmanImportService(None)

        positions = service._filament_color_positions(
            {
                "color_hex": "D8100C",
                "multi_color_hexes": ["D8100C", "invalid", "11223380"],
            }
        )

        assert positions == [(1, "#D8100C"), (3, "#11223380")]

    def test_extract_colors_skips_invalid_values(self):
        service = SpoolmanImportService(None)

        colors = service._extract_colors(
            [{"color_hex": "not-a-color", "multi_color_hexes": ["12", "xyz"]}]
        )

        assert colors == []

    @pytest.mark.asyncio
    async def test_reimport_repairs_dropped_alpha_from_live_source(self, db_session):
        manufacturer = Manufacturer(name="Source repair vendor")
        opaque_color = Color(name="Legacy RGB", hex_code="#D8100C")
        unchanged_color = Color(name="Manual opaque", hex_code="#112233")
        target_color = Color(name="Source alpha", hex_code="#D8100C3C")
        db_session.add_all(
            [manufacturer, opaque_color, unchanged_color, target_color]
        )
        await db_session.flush()

        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Existing Spoolman filament",
            material_type="PLA",
            diameter_mm=1.75,
            color_mode="multi",
            custom_fields={"spoolman_id": 207},
        )
        db_session.add(filament)
        await db_session.flush()
        db_session.add_all(
            [
                FilamentColor(
                    filament_id=filament.id,
                    color_id=opaque_color.id,
                    position=1,
                ),
                FilamentColor(
                    filament_id=filament.id,
                    color_id=unchanged_color.id,
                    position=2,
                ),
            ]
        )
        await db_session.flush()

        result = ImportResult()
        service = SpoolmanImportService(db_session)
        candidates = await service.analyze_transparency_repairs(
            [
                {
                    "id": 207,
                    "color_hex": "3CD8100C",
                    "multi_color_hexes": "3CD8100C,112233",
                }
            ]
        )
        assert [
            (
                candidate.filament_id,
                candidate.position,
                candidate.current_hex,
                candidate.target_hex,
            )
            for candidate in candidates
        ] == [(filament.id, 1, "#D8100C", "#D8100C3C")]

        color_map = await service._import_colors(
            [{"name": "#D8100C3C", "hex_code": "#D8100C3C"}],
            result,
        )
        await service._apply_transparency_repairs(
            candidates,
            color_map,
            result,
        )
        filament_map = await service._import_filaments(
            [
                {
                    "id": 207,
                    "color_hex": "3CD8100C",
                    "multi_color_hexes": "3CD8100C,112233",
                }
            ],
            {},
            {
                target_color.hex_code.lower(): target_color.id,
                unchanged_color.hex_code.lower(): unchanged_color.id,
            },
            result,
            {},
        )

        assignments = (
            (
                await db_session.execute(
                    select(FilamentColor)
                    .where(FilamentColor.filament_id == filament.id)
                    .order_by(FilamentColor.position)
                )
            )
            .scalars()
            .all()
        )
        assert filament_map == {207: filament.id}
        assert [assignment.color_id for assignment in assignments] == [
            target_color.id,
            unchanged_color.id,
        ]
        assert result.color_assignments_repaired == 1
        assert result.filaments_skipped == 1

    @pytest.mark.asyncio
    async def test_reimport_does_not_replace_existing_opaque_source_color(
        self, db_session
    ):
        manufacturer = Manufacturer(name="Opaque source vendor")
        existing_color = Color(name="Existing", hex_code="#112233")
        db_session.add_all([manufacturer, existing_color])
        await db_session.flush()
        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Opaque source filament",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 208},
        )
        db_session.add(filament)
        await db_session.flush()
        assignment = FilamentColor(
            filament_id=filament.id,
            color_id=existing_color.id,
            position=1,
        )
        db_session.add(assignment)
        await db_session.flush()

        result = ImportResult()
        service = SpoolmanImportService(db_session)
        candidates = await service.analyze_transparency_repairs(
            [{"id": 208, "color_hex": "445566"}]
        )
        assert candidates == []
        await service._import_filaments(
            [{"id": 208, "color_hex": "445566"}],
            {},
            {"#445566": 999},
            result,
            {},
        )

        assert assignment.color_id == existing_color.id
        assert result.color_assignments_repaired == 0

    @pytest.mark.asyncio
    async def test_repair_transparency_changes_only_linked_color_assignments(
        self, db_session
    ):
        manufacturer = Manufacturer(name="Repair-only vendor")
        opaque_color = Color(name="Legacy RGB", hex_code="#D8100C")
        unrelated_color = Color(name="Unrelated", hex_code="#112233")
        db_session.add_all([manufacturer, opaque_color, unrelated_color])
        await db_session.flush()

        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Previously imported",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 207, "keep": "unchanged"},
        )
        unrelated_filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Manual filament",
            material_type="PETG",
            diameter_mm=1.75,
        )
        db_session.add_all([filament, unrelated_filament])
        await db_session.flush()
        linked_assignment = FilamentColor(
            filament_id=filament.id,
            color_id=opaque_color.id,
            position=1,
        )
        unrelated_assignment = FilamentColor(
            filament_id=unrelated_filament.id,
            color_id=unrelated_color.id,
            position=1,
        )
        db_session.add_all([linked_assignment, unrelated_assignment])
        await db_session.flush()

        service = SpoolmanImportService(db_session)
        service.preview = AsyncMock(
            return_value=ImportPreview(
                vendors=[{"id": 99, "name": "Must not import"}],
                filaments=[{"id": 207, "color_hex": "3CD8100C"}],
                spools=[{"id": 88}],
                locations=[{"id": 77, "name": "Must not import"}],
                colors=[{"name": "#D8100C3C", "hex_code": "#D8100C3C"}],
            )
        )

        candidates = await service.analyze_transparency_repairs(
            [{"id": 207, "color_hex": "3CD8100C"}]
        )
        result = await service.repair_transparency(
            "http://spoolman.test",
            service.transparency_repair_plan_digest(candidates),
        )
        repaired_color = (
            await db_session.execute(
                select(Color).where(Color.hex_code == "#D8100C3C")
            )
        ).scalar_one()

        assert linked_assignment.color_id == repaired_color.id
        assert unrelated_assignment.color_id == unrelated_color.id
        assert filament.custom_fields == {
            "spoolman_id": 207,
            "keep": "unchanged",
        }
        assert result.color_assignments_repaired == 1
        assert result.colors_created == 1
        assert result.manufacturers_created == 0
        assert result.locations_created == 0
        assert result.filaments_created == 0
        assert result.spools_created == 0

    @pytest.mark.asyncio
    async def test_repair_skips_different_rgb_and_missing_positions(
        self, db_session
    ):
        manufacturer = Manufacturer(name="Strict repair vendor")
        opaque_color = Color(name="Local RGB", hex_code="#112233")
        db_session.add_all([manufacturer, opaque_color])
        await db_session.flush()
        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Strict repair filament",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 300},
        )
        db_session.add(filament)
        await db_session.flush()
        db_session.add(
            FilamentColor(
                filament_id=filament.id,
                color_id=opaque_color.id,
                position=1,
            )
        )
        await db_session.flush()

        service = SpoolmanImportService(db_session)
        candidates = await service.analyze_transparency_repairs(
            [
                {
                    "id": 300,
                    "multi_color_hexes": ["AABBCC80", "44556680"],
                }
            ]
        )

        assert candidates == []

    @pytest.mark.asyncio
    async def test_repair_skips_assignment_that_changed_after_analysis(
        self, db_session
    ):
        manufacturer = Manufacturer(name="Repair race vendor")
        original = Color(name="Original", hex_code="#D8100C")
        changed = Color(name="Changed", hex_code="#112233")
        target = Color(name="Target alpha", hex_code="#D8100C3C")
        db_session.add_all([manufacturer, original, changed, target])
        await db_session.flush()
        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation="Repair race filament",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 350},
        )
        db_session.add(filament)
        await db_session.flush()
        assignment = FilamentColor(
            filament_id=filament.id,
            color_id=original.id,
            position=1,
        )
        db_session.add(assignment)
        await db_session.flush()

        service = SpoolmanImportService(db_session)
        candidates = await service.analyze_transparency_repairs(
            [{"id": 350, "color_hex": "3CD8100C"}]
        )
        assert len(candidates) == 1

        assignment.color_id = changed.id
        await db_session.flush()
        result = ImportResult()
        await service._apply_transparency_repairs(
            candidates,
            {target.hex_code.lower(): target.id},
            result,
        )

        assert assignment.color_id == changed.id
        assert result.color_assignments_repaired == 0
        assert len(result.warnings) == 1

    @pytest.mark.asyncio
    async def test_repair_rejects_preview_plan_drift(self, db_session):
        manufacturer = Manufacturer(name="Plan binding vendor")
        color_a = Color(name="Opaque A", hex_code="#D8100C")
        color_b = Color(name="Opaque B", hex_code="#8AD77F")
        db_session.add_all([manufacturer, color_a, color_b])
        await db_session.flush()
        filament_a = Filament(
            manufacturer_id=manufacturer.id,
            designation="Preview target",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 401},
        )
        filament_b = Filament(
            manufacturer_id=manufacturer.id,
            designation="Execution target",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"spoolman_id": 402},
        )
        db_session.add_all([filament_a, filament_b])
        await db_session.flush()
        assignment_a = FilamentColor(
            filament_id=filament_a.id,
            color_id=color_a.id,
            position=1,
        )
        assignment_b = FilamentColor(
            filament_id=filament_b.id,
            color_id=color_b.id,
            position=1,
        )
        db_session.add_all([assignment_a, assignment_b])
        await db_session.flush()

        service = SpoolmanImportService(db_session)
        service.preview = AsyncMock(
            side_effect=[
                ImportPreview(filaments=[{"id": 401, "color_hex": "3CD8100C"}]),
                ImportPreview(filaments=[{"id": 402, "color_hex": "3C8AD77F"}]),
            ]
        )
        _, count, digest = await service.preview_with_transparency_repairs(
            "http://spoolman.test"
        )
        assert count == 1

        with pytest.raises(SpoolmanImportError, match="changed after preview"):
            await service.repair_transparency(
                "http://spoolman.test",
                digest,
            )

        assert assignment_a.color_id == color_a.id
        assert assignment_b.color_id == color_b.id


class TestSpoolmanImportApiContract:
    @pytest.mark.parametrize(
        ("path", "payload"),
        [
            (
                "/api/v1/admin/system/spoolman-import/execute",
                {"url": "http://spoolman"},
            ),
            (
                "/api/v1/admin/system/spoolman-import/repair-transparency",
                {"url": "http://spoolman", "plan_digest": "a" * 64},
            ),
            (
                "/api/v1/admin/system/spoolman-import/repair/execute",
                {
                    "mode": "offline",
                    "preview_fingerprint": "a" * 64,
                    "approved_mappings": [],
                },
            ),
        ],
    )
    @pytest.mark.asyncio
    async def test_every_spoolman_mutation_rejects_an_existing_worker_lock(
        self,
        auth_client,
        monkeypatch,
        tmp_path,
        path,
        payload,
    ):
        client, csrf_token = auth_client
        lock_path = tmp_path / "spoolman-mutation.lock"
        monkeypatch.setattr(spoolman_api, "SPOOLMAN_MUTATION_LOCK_PATH", lock_path)

        with exclusive_file_lock(lock_path):
            response = await client.post(
                path,
                json=payload,
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "spoolman_import_in_progress",
            "message": "Another Spoolman import operation is already running",
        }

    @pytest.mark.asyncio
    async def test_preview_preserves_legacy_response_shape(
        self,
        auth_client,
        monkeypatch,
    ):
        client, csrf_token = auth_client

        async def preview(_service, _url):
            return ImportPreview(
                vendors=[{"id": 1, "name": "Vendor"}],
                filaments=[{"id": 2, "color_hex": "D8100C"}],
                colors=[{"name": "#D8100C", "hex_code": "#D8100C"}],
                available_field_targets={"filament", "spool"},
                extra_fields=[
                    {
                        "target_type": "filament",
                        "key": "dry",
                        "label": "Dry",
                        "field_type": "checkbox",
                        "status": "create",
                    }
                ],
                extra_field_fingerprint="capable-definitions",
                warnings=["rich warning"],
            )

        monkeypatch.setattr(SpoolmanImportService, "preview", preview)

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/preview",
            json={"url": "http://spoolman.test"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert set(response.json()) == {
            "summary",
            "vendors",
            "filaments",
            "spools",
            "locations",
            "colors",
        }

    @pytest.mark.asyncio
    async def test_preview_returns_repair_count_and_plan_digest(
        self,
        auth_client,
        monkeypatch,
    ):
        client, csrf_token = auth_client

        async def preview_with_repairs(_service, _url):
            return (
                ImportPreview(
                    vendors=[{"id": 1, "name": "Vendor"}],
                    filaments=[{"id": 2, "color_hex": "D8100C"}],
                    colors=[{"name": "#D8100C", "hex_code": "#D8100C"}],
                ),
                1,
                "a" * 64,
            )

        monkeypatch.setattr(
            SpoolmanImportService,
            "preview_with_transparency_repairs",
            preview_with_repairs,
        )

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/preview",
            json={
                "url": "http://spoolman.test",
                "include_transparency_repairs": True,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["transparency_repair_candidates"] == 1
        assert data["transparency_repair_plan_digest"] == "a" * 64
        assert data["summary"] == {
            "vendors": 1,
            "filaments": 1,
            "spools": 0,
            "locations": 0,
            "colors": 1,
        }

    @pytest.mark.asyncio
    async def test_execute_preserves_legacy_response_shape(
        self,
        auth_client,
        monkeypatch,
    ):
        client, csrf_token = auth_client

        async def execute(_service, _url, _expected_fingerprint=None):
            return ImportResult(
                color_assignments_repaired=2,
                extra_fields_created=3,
                extra_values_preserved=7,
            )

        monkeypatch.setattr(SpoolmanImportService, "execute", execute)

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/execute",
            json={"url": "http://spoolman.test"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert set(response.json()) == {
            "manufacturers_created",
            "manufacturers_skipped",
            "locations_created",
            "locations_skipped",
            "colors_created",
            "colors_skipped",
            "filaments_created",
            "filaments_skipped",
            "spools_created",
            "spools_skipped",
            "errors",
            "warnings",
        }

    @pytest.mark.asyncio
    async def test_repair_response_includes_repair_count(
        self,
        auth_client,
        monkeypatch,
    ):
        client, csrf_token = auth_client

        async def repair_transparency(_service, _url, _digest):
            return ImportResult(color_assignments_repaired=2)

        monkeypatch.setattr(
            SpoolmanImportService,
            "repair_transparency",
            repair_transparency,
        )

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/repair-transparency",
            json={"url": "http://spoolman.test", "plan_digest": "a" * 64},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert response.json() == {
            "manufacturers_created": 0,
            "manufacturers_skipped": 0,
            "locations_created": 0,
            "locations_skipped": 0,
            "colors_created": 0,
            "colors_skipped": 0,
            "filaments_created": 0,
            "filaments_skipped": 0,
            "spools_created": 0,
            "spools_skipped": 0,
            "errors": [],
            "warnings": [],
            "color_assignments_repaired": 2,
        }

    @pytest.mark.asyncio
    async def test_repair_requires_plan_digest(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/repair-transparency",
            json={"url": "http://spoolman.test"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422


def _definitions():
    return {
        "vendor": [{"key": "account", "name": "Account", "field_type": "text"}],
        "filament": [
            {
                "key": "nozzle_range",
                "name": "Nozzle range",
                "field_type": "integer_range",
                "unit": "°C",
                "order": 2,
            },
            {
                "key": "materials",
                "name": "Materials",
                "field_type": "choice",
                "choices": ["PLA", "PETG"],
                "multi_choice": True,
                "order": 1,
            },
        ],
        "spool": [],
    }


@pytest.mark.parametrize(
    ("mode", "system_count", "local_count", "promoted", "raw_preserved"),
    [
        (ImportStorageMode.SYSTEM, 2, 0, True, False),
        (ImportStorageMode.LOCAL, 0, 2, True, False),
        (ImportStorageMode.PRESERVE, 0, 0, False, True),
        (ImportStorageMode.LEGACY, 0, 0, False, False),
    ],
)
async def test_extra_field_modes_keep_existing_behavior(
    db_session,
    mode,
    system_count,
    local_count,
    promoted,
    raw_preserved,
):
    service = SpoolmanImportService(db_session)
    result = ImportResult()
    mappings = await service._plan_import_extra_fields(
        _definitions(),
        result,
        mode,
        [],
    )
    converted, local, preserved = service._promote_extra_values(
        "filament",
        {"nozzle_range": "[190,230]", "materials": '  ["PLA"]  '},
        set(),
        mappings,
        result,
    )

    assert result.extra_fields_created == system_count
    assert result.extra_local_definitions == local_count
    assert bool(converted) is promoted
    assert (preserved.get("materials") == '  ["PLA"]  ') is raw_preserved
    assert bool(local) is (mode is ImportStorageMode.LOCAL)


async def test_unsupported_definition_still_honors_legacy_override(db_session):
    definitions = {
        "vendor": [],
        "filament": [
            source_definition(key="profile", field_type="unsupported_type")
        ],
        "spool": [],
    }
    service = SpoolmanImportService(db_session)
    result = ImportResult()
    mappings = await service._plan_import_extra_fields(
        definitions,
        result,
        ImportStorageMode.SYSTEM,
        [
            SpoolmanFieldAction(
                target_type="filament",
                key="profile",
                action="legacy",
            )
        ],
    )
    promoted, local, preserved = service._promote_extra_values(
        "filament",
        {"profile": '"PLA"'},
        set(),
        mappings,
        result,
    )

    assert promoted == {}
    assert local == {}
    assert preserved == {"profile": "PLA"}
    assert result.extra_fields_conflicted == 0


async def test_import_creates_editable_definitions_and_promotes_values(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, ImportStorageMode.SYSTEM, []
    )
    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"nozzle_range": "[190,230]", "materials": '["PLA"]', "unknown": '"keep"'},
        set(),
        mappings,
        result,
    )

    assert promoted == {
        "nozzle_range": {"min": 190, "max": 230},
        "materials": ["PLA"],
    }
    assert preserved == {"unknown": '"keep"'}
    assert local_definitions == {}
    assert result.extra_fields_created == 2
    assert result.extra_values_promoted == 2
    assert result.extra_values_preserved == 1
    definitions = (await db_session.execute(select(SystemExtraField))).scalars().all()
    assert {item.key for item in definitions} == {"materials", "nozzle_range"}
    assert all(item.source is None for item in definitions)


async def test_existing_incompatible_definition_preserves_source_value(db_session):
    db_session.add(
        SystemExtraField(
            target_type="filament",
            key="nozzle_range",
            label="Local text",
            field_type="text",
        )
    )
    await db_session.flush()
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, ImportStorageMode.SYSTEM, []
    )
    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament", {"nozzle_range": "[190,230]"}, set(), mappings, result
    )

    assert promoted == {}
    assert local_definitions == {}
    assert preserved == {"nozzle_range": "[190,230]"}
    assert result.extra_fields_conflicted == 1


async def test_overlapping_system_definition_blocks_import_and_local_storage(
    db_session,
):
    db_session.add(
        SystemExtraField(
            target_type="filament",
            key="nozzle_range.min",
            label="Minimum nozzle temperature",
            field_type="number",
        )
    )
    await db_session.flush()
    service = SpoolmanImportService(db_session)

    preview = await service._preview_extra_field_definitions(_definitions())
    nozzle_preview = next(item for item in preview if item["key"] == "nozzle_range")
    assert nozzle_preview["status"] == "conflict"
    assert nozzle_preview["conflicting_key"] == "nozzle_range.min"

    for action in ("system", "local"):
        result = ImportResult()
        mappings = await service._plan_import_extra_fields(
            _definitions(),
            result,
            default_action="preserve",
            field_actions=[
                SpoolmanFieldAction(
                    target_type="filament",
                    key="nozzle_range",
                    action=action,
                )
            ],
        )
        assert ("filament", "nozzle_range") not in mappings
        assert result.extra_fields_conflicted == 1
        assert "nozzle_range.min" in result.warnings[0]


async def test_retained_incompatible_value_blocks_new_system_definition(db_session):
    manufacturer = Manufacturer(name="Retained Value Test")
    db_session.add(manufacturer)
    await db_session.flush()
    db_session.add(
        Filament(
            manufacturer_id=manufacturer.id,
            designation="Legacy retained value",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"nozzle_range": "not a range"},
        )
    )
    await db_session.commit()
    service = SpoolmanImportService(db_session)

    preview = await service._preview_extra_field_definitions(_definitions())
    nozzle_preview = next(item for item in preview if item["key"] == "nozzle_range")
    assert nozzle_preview["status"] == "create"
    assert nozzle_preview["system_conflict"]["count"] == 1

    result = ImportResult()
    mappings = await service._plan_import_extra_fields(
        _definitions(), result, ImportStorageMode.SYSTEM, []
    )

    assert ("filament", "nozzle_range") not in mappings
    assert result.extra_fields_conflicted == 1
    assert "incompatible with the requested System Extra Field" in result.warnings[0]
    assert await db_session.scalar(
        select(SystemExtraField).where(SystemExtraField.key == "nozzle_range")
    ) is None


async def test_retained_value_does_not_block_record_local_import(db_session):
    manufacturer = Manufacturer(name="Record Local Test")
    db_session.add(manufacturer)
    await db_session.flush()
    db_session.add(
        Filament(
            manufacturer_id=manufacturer.id,
            designation="Legacy retained value",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={"nozzle_range": "not a range"},
        )
    )
    await db_session.commit()
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, default_action="local", field_actions=[]
    )

    assert mappings[("filament", "nozzle_range")]["storage"] == "local"
    assert await db_session.scalar(select(SystemExtraField)) is None


def test_unavailable_field_endpoint_preserves_legacy_cleaned_extra_shape(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"profile": '"PLA"', "numeric_text": "00123"},
        set(),
        {},
        result,
        clean_unmapped_values=True,
    )

    assert promoted == {}
    assert local_definitions == {}
    assert preserved == {"profile": "PLA", "numeric_text": "00123"}


def test_unavailable_field_endpoint_can_preserve_raw_extra_shape(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"profile": '"PLA"', "numeric_text": "00123"},
        set(),
        {},
        result,
    )

    assert promoted == {}
    assert local_definitions == {}
    assert preserved == {"profile": '"PLA"', "numeric_text": "00123"}


async def test_local_mode_promotes_values_without_system_definitions(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, default_action="local", field_actions=[]
    )
    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"nozzle_range": "[190,230]", "unknown": '"keep"'},
        set(),
        mappings,
        result,
    )

    assert promoted == {"nozzle_range": {"min": 190, "max": 230}}
    assert local_definitions["nozzle_range"]["field_type"] == "range"
    assert local_definitions["nozzle_range"]["config"]["unit"] == "°C"
    assert preserved == {"unknown": '"keep"'}
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_legacy_mode_preserves_values_and_creates_no_definitions(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, default_action="legacy", field_actions=[]
    )
    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"nozzle_range": '"[190,230]"', "unknown": '"keep"'},
        set(),
        mappings,
        result,
        clean_unmapped_values=True,
    )

    assert promoted == {}
    assert local_definitions == {}
    assert preserved == {"nozzle_range": "[190,230]", "unknown": "keep"}
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_preserve_mode_keeps_raw_values(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(), result, default_action="preserve", field_actions=[]
    )
    promoted, local_definitions, preserved = service._promote_extra_values(
        "filament",
        {"nozzle_range": '"[190,230]"'},
        set(),
        mappings,
        result,
    )

    assert promoted == {}
    assert local_definitions == {}
    assert preserved == {"nozzle_range": '"[190,230]"'}
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_per_field_action_overrides_global_mode(db_session):
    service = SpoolmanImportService(db_session)
    result = ImportResult()

    mappings = await service._plan_import_extra_fields(
        _definitions(),
        result,
        default_action="preserve",
        field_actions=[
            SpoolmanFieldAction(
                target_type="filament",
                key="nozzle_range",
                action="system",
            )
        ],
    )

    assert mappings[("filament", "nozzle_range")]["storage"] == "system"
    assert mappings[("filament", "materials")] == {"storage": "preserve"}
    definition = await db_session.scalar(
        select(SystemExtraField).where(SystemExtraField.key == "nozzle_range")
    )
    assert definition is not None


async def test_supported_empty_field_endpoints_still_return_preview_fingerprint(
    auth_client, monkeypatch
):
    client, csrf = auth_client

    async def preview_with_supported_empty_fields(self, url):
        return ImportPreview(
            available_field_targets={"vendor", "filament", "spool"},
            extra_field_fingerprint="stable",
        )

    monkeypatch.setattr(
        SpoolmanImportService, "preview", preview_with_supported_empty_fields
    )
    response = await client.post(
        "/api/v1/admin/system/spoolman-import/preview",
        json={"url": "http://spoolman", "include_extra_fields": True},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["extra_fields"] == []
    assert response.json()["extra_field_targets"] == ["filament", "spool", "vendor"]
    assert response.json()["extra_field_fingerprint"] == "stable"


async def test_legacy_admin_preview_shape_is_unchanged_without_definitions(
    auth_client, monkeypatch
):
    client, csrf = auth_client

    async def preview_without_fields(self, url):
        return ImportPreview()

    monkeypatch.setattr(SpoolmanImportService, "preview", preview_without_fields)
    response = await client.post(
        "/api/v1/admin/system/spoolman-import/preview",
        json={"url": "http://spoolman"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert set(response.json()) == {
        "summary",
        "vendors",
        "filaments",
        "spools",
        "locations",
        "colors",
    }


async def test_legacy_admin_execute_shape_is_unchanged_without_field_changes(
    auth_client, monkeypatch
):
    client, csrf = auth_client

    async def execute_without_fields(self, url, expected_extra_field_fingerprint=None):
        return ImportResult()

    monkeypatch.setattr(SpoolmanImportService, "execute", execute_without_fields)
    response = await client.post(
        "/api/v1/admin/system/spoolman-import/execute",
        json={"url": "http://spoolman"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert set(response.json()) == {
        "manufacturers_created",
        "manufacturers_skipped",
        "locations_created",
        "locations_skipped",
        "colors_created",
        "colors_skipped",
        "filaments_created",
        "filaments_skipped",
        "spools_created",
        "spools_skipped",
        "errors",
        "warnings",
    }


async def test_admin_execute_passes_explicit_extra_field_choices(
    auth_client, monkeypatch
):
    client, csrf = auth_client
    captured = {}

    async def execute_with_fields(
        self,
        url,
        expected_extra_field_fingerprint=None,
        extra_field_mode="legacy",
        field_actions=None,
    ):
        captured.update(
            {
                "url": url,
                "fingerprint": expected_extra_field_fingerprint,
                "mode": extra_field_mode,
                "actions": field_actions,
            }
        )
        return ImportResult()

    monkeypatch.setattr(SpoolmanImportService, "execute", execute_with_fields)
    response = await client.post(
        "/api/v1/admin/system/spoolman-import/execute",
        json={
            "url": "http://spoolman",
            "include_extra_fields": True,
            "extra_field_fingerprint": "current",
            "extra_field_mode": "local",
            "field_actions": [
                {
                    "target_type": "filament",
                    "key": "nozzle_range",
                    "action": "system",
                }
            ],
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert captured["url"] == "http://spoolman"
    assert captured["fingerprint"] == "current"
    assert captured["mode"].value == "local"
    assert [item.model_dump(mode="json") for item in captured["actions"]] == [
        {
            "target_type": "filament",
            "key": "nozzle_range",
            "action": "system",
        }
    ]


@pytest.mark.parametrize(
    "rich_fields",
    [
        {"extra_field_mode": "system"},
        {"field_actions": []},
        {"include_extra_fields": True},
    ],
)
async def test_admin_execute_requires_fingerprint_for_explicit_rich_fields(
    auth_client,
    monkeypatch,
    rich_fields,
):
    client, csrf = auth_client
    execute = AsyncMock(return_value=ImportResult())
    monkeypatch.setattr(SpoolmanImportService, "execute", execute)

    response = await client.post(
        "/api/v1/admin/system/spoolman-import/execute",
        json={"url": "http://spoolman", **rich_fields},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "preview_required"
    execute.assert_not_awaited()


async def test_service_requires_fingerprint_for_explicit_rich_import(db_session):
    service = SpoolmanImportService(db_session)
    service.preview = AsyncMock(return_value=ImportPreview())

    with pytest.raises(SpoolmanImportError) as exc_info:
        await service.execute(
            "http://spoolman",
            extra_field_mode="system",
        )

    assert exc_info.value.code == "preview_required"


def test_import_definition_fingerprint_ignores_endpoint_list_order():
    definitions = {
        "vendor": [],
        "filament": [
            {
                "key": "profile",
                "name": "Profile",
                "field_type": "choice",
                "choices": ["PLA, CF", "PLA"],
                "order": 2,
            },
            {
                "key": "dry",
                "name": "Dry",
                "field_type": "boolean",
                "order": 1,
            },
        ],
        "spool": [],
    }

    first = SpoolmanImportService.extra_field_definition_fingerprint(
        definitions,
        {"vendor", "filament", "spool"},
    )
    permuted = SpoolmanImportService.extra_field_definition_fingerprint(
        {
            **definitions,
            "filament": list(reversed(definitions["filament"])),
        },
        {"spool", "filament", "vendor"},
    )
    changed_content = SpoolmanImportService.extra_field_definition_fingerprint(
        {
            **definitions,
            "filament": [
                {**definitions["filament"][0], "choices": ["PLA", "PLA, CF"]},
                definitions["filament"][1],
            ],
        },
        {"vendor", "filament", "spool"},
    )

    assert first == permuted
    assert first != changed_content


async def test_import_entities_without_extra_objects(db_session):
    preview = ImportPreview(
        vendors=[{"id": 1, "name": "No Extra Vendor"}],
        filaments=[
            {
                "id": 1,
                "name": "No Extra PLA",
                "vendor": {"id": 1},
                "material": "PLA",
                "diameter": 1.75,
                "weight": 1000,
                "spool_weight": 200,
            }
        ],
        spools=[
            {
                "id": 1,
                "filament": {"id": 1},
                "remaining_weight": 1000,
                "used_weight": 0,
                "archived": False,
            }
        ],
        field_definitions={"vendor": [], "filament": [], "spool": []},
    )
    service = SpoolmanImportService(db_session)

    async def cached_preview(_base_url):
        return preview

    service.preview = cached_preview
    result = await service.execute("http://spoolman")

    assert result.errors == []
    assert result.filaments_created == 1
    assert result.spools_created == 1
    filament = await db_session.scalar(select(Filament))
    spool = await db_session.scalar(select(Spool))
    assert filament.custom_field_definitions is None
    assert spool.custom_field_definitions is None
