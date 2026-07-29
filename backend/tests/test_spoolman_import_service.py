import pytest
from app.models.filament import Color, Filament, FilamentColor, Manufacturer
from app.services.spoolman_import_service import ImportResult, SpoolmanImportService
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
        await service._import_filaments(
            [{"id": 208, "color_hex": "445566"}],
            {},
            {"#445566": 999},
            result,
        )

        assert assignment.color_id == existing_color.id
        assert result.color_assignments_repaired == 0
