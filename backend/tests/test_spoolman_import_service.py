from unittest.mock import AsyncMock

import pytest
from app.api.v1 import system as system_api
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.spoolman_import_service import (
    ImportPreview,
    ImportResult,
    SpoolmanImportError,
    SpoolmanImportService,
)
from sqlalchemy import select


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
    @pytest.mark.asyncio
    async def test_shared_mutation_guard_rejects_overlapping_import(
        self,
        auth_client,
    ):
        client, csrf_token = auth_client
        await system_api._spoolman_mutation_lock.acquire()
        try:
            response = await client.post(
                "/api/v1/admin/system/spoolman-import/execute",
                json={"url": "http://spoolman.test"},
                headers={"X-CSRF-Token": csrf_token},
            )
        finally:
            system_api._spoolman_mutation_lock.release()

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "spoolman_import_in_progress"

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

        async def execute(_service, _url):
            return ImportResult(color_assignments_repaired=2)

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
        assert response.json()["color_assignments_repaired"] == 2

    @pytest.mark.asyncio
    async def test_repair_requires_plan_digest(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/admin/system/spoolman-import/repair-transparency",
            json={"url": "http://spoolman.test"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
