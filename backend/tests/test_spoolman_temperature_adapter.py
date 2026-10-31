"""Exercise the tracked adapter without requiring the separately installed plugin."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from pydantic import BaseModel, ConfigDict

from app.models.filament import Filament, Manufacturer


class WireFilament(BaseModel):
    # Only the temperature/extra boundary is relevant; other plugin fields pass through.
    model_config = ConfigDict(extra="allow")
    settings_extruder_temp: int | None = None
    settings_bed_temp: int | None = None
    extra: dict


@pytest.fixture
def adapter(monkeypatch, db_session):
    package = ModuleType("temperature_adapter_fixture")
    package.__path__ = []
    schemas = ModuleType(f"{package.__name__}.schemas")
    schemas.Filament = WireFilament
    schemas.Vendor = WireFilament
    monkeypatch.setitem(sys.modules, package.__name__, package)
    monkeypatch.setitem(sys.modules, schemas.__name__, schemas)
    path = Path(__file__).parents[1] / "app/plugins/spoolmanapi/service.py"
    spec = importlib.util.spec_from_file_location(f"{package.__name__}.service", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SpoolmanService(db_session)


@pytest.mark.parametrize(
    "native,legacy,expected",
    [
        ({"min": 210, "max": 230}, 190, 210),
        ({"min": 210.6, "max": None}, 190, 211),
        ({"min": None, "max": 215.5}, 190, 216),
        ({"min": 0, "max": 10}, 190, 0),
        ({"min": None, "max": None}, 190, None),
        (None, 190, 190),
        (None, None, None),
    ],
)
def test_native_projection_and_legacy_fallback(adapter, native, legacy, expected):
    filament = Filament(
        id=1,
        designation="PLA",
        manufacturer=None,
        filament_colors=[],
        extruder_temp_range_c=native,
        bed_temp_range_c=native,
        custom_fields={
            "settings_extruder_temp": legacy,
            "settings_bed_temp": legacy,
            "note": "keep",
        },
    )
    wire = adapter._filament_to_schema(filament)
    assert wire.settings_extruder_temp == expected
    assert wire.settings_bed_temp == expected
    assert expected is None or type(wire.settings_extruder_temp) is int
    assert wire.extra == {"note": "keep"}
    assert ("settings_bed_temp" in wire.model_dump(exclude_none=True)) == (
        expected is not None
    )


@pytest.mark.asyncio
async def test_imported_native_temperatures_and_compatibility_updates(
    adapter, db_session
):
    manufacturer = Manufacturer(name="Adapter test")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        designation="Imported",
        material_type="PLA",
        diameter_mm=1.75,
        manufacturer_id=manufacturer.id,
        extruder_temp_range_c={"min": 210, "max": 210},
        bed_temp_range_c={"min": 60, "max": 60},
        custom_fields={"note": "keep"},
    )
    db_session.add(filament)
    await db_session.commit()
    wire = await adapter.get_filament(filament.id)
    assert (wire.settings_extruder_temp, wire.settings_bed_temp) == (210, 60)
    update = {"settings_extruder_temp": 220, "settings_bed_temp": 65}
    wire = await adapter.update_filament(
        filament.id, SimpleNamespace(model_dump=lambda **kw: update)
    )
    assert filament.extruder_temp_range_c == {"min": 220, "max": 220}
    assert filament.bed_temp_range_c == {"min": 65, "max": 65}
    assert (wire.settings_extruder_temp, wire.settings_bed_temp) == (220, 65)
    assert filament.custom_fields == {"note": "keep"}
    filament.extruder_temp_range_c = {"min": 230, "max": 240}
    filament.custom_fields = {"note": "keep", "settings_extruder_temp": 190}
    await db_session.commit()
    assert (await adapter.get_filament(filament.id)).settings_extruder_temp == 230
    update = {"comment": "unchanged temperatures"}
    await adapter.update_filament(
        filament.id, SimpleNamespace(model_dump=lambda **kw: update)
    )
    assert filament.extruder_temp_range_c == {"min": 230, "max": 240}
    update = {"settings_extruder_temp": None, "settings_bed_temp": None}
    wire = await adapter.update_filament(
        filament.id, SimpleNamespace(model_dump=lambda **kw: update)
    )
    assert filament.extruder_temp_range_c is None
    assert filament.bed_temp_range_c is None
    assert wire.settings_extruder_temp is None
    assert wire.settings_bed_temp is None
    assert wire.extra == {"note": "keep"}
    assert filament.custom_fields == {
        "note": "keep",
        "comment": "unchanged temperatures",
    }


@pytest.mark.asyncio
async def test_compatibility_create_sets_native_ranges(adapter, db_session):
    manufacturer = Manufacturer(name="Adapter test")
    db_session.add(manufacturer)
    await db_session.flush()
    data = dict.fromkeys(
        (
            "article_number",
            "comment",
            "external_id",
            "multi_color_hexes",
            "vendor_id",
            "density",
            "diameter",
            "weight",
            "spool_weight",
            "price",
            "multi_color_direction",
            "color_hex",
        )
    )
    data.update(
        name="Compatible",
        material="PLA",
        vendor_id=manufacturer.id,
        settings_extruder_temp=210,
        settings_bed_temp=60,
        extra={"note": "keep"},
    )
    wire = await adapter.create_filament(SimpleNamespace(**data))
    filament = await db_session.get(Filament, wire.id)
    assert filament.extruder_temp_range_c == {"min": 210, "max": 210}
    assert filament.bed_temp_range_c == {"min": 60, "max": 60}
    assert (wire.settings_extruder_temp, wire.settings_bed_temp) == (210, 60)
    assert wire.extra == {"note": "keep"}
    assert filament.custom_fields == {"note": "keep"}


@pytest.mark.parametrize("remaining", [500, 0, -5])
def test_spool_lengths_keep_legacy_millimetres_and_negative_values(adapter, monkeypatch, remaining):
    from app.models.spool import Spool

    schemas = sys.modules[f"{type(adapter).__module__.rsplit('.', 1)[0]}.schemas"]
    monkeypatch.setattr(schemas, "Spool", WireFilament, raising=False)
    filament = Filament(id=1, designation="PLA", manufacturer=None, filament_colors=[],
                        diameter_mm=1.75, density_g_cm3=1.24, custom_fields={})
    spool = Spool(id=1, filament=filament, initial_total_weight_g=1250,
                  empty_spool_weight_g=250, remaining_weight_g=remaining,
                  spool_core_weight_g=40, custom_fields={}, location=None, status=None)
    wire = adapter._spool_to_schema(spool)
    expected_per_gram_mm = 335.2836194167644
    assert wire.remaining_length == pytest.approx(remaining * expected_per_gram_mm)
    assert wire.used_length == pytest.approx((1000 - remaining) * expected_per_gram_mm)
    assert wire.remaining_weight == remaining
    assert wire.initial_weight == 1000


def test_tracked_adapter_uses_the_same_promoted_extra_projection(adapter):
    filament = Filament(id=1, designation='PLA', manufacturer=None, filament_colors=[],
                        drying_temp_c=0, pressure_advance_k=0.025,
                        custom_fields={'article_number': 'ARTICLE'})
    wire = adapter._filament_to_schema(filament)
    assert wire.extra == {'dry_temp': 0, 'k_value': 0.025}
    assert wire.article_number == 'ARTICLE'
