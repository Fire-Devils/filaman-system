from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.spoolman_import_service import (
    ImportPreview,
    ImportResult,
    SpoolmanImportService,
)


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
                    "multi_color_hexes": "112233",
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
                    "multi_color_hexes": "112233",
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

        result = await service.repair_transparency("http://spoolman.test")
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
