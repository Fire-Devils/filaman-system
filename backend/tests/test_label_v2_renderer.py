from datetime import datetime, timezone

import pytest
from app.api.v1.labels import _label_values
from app.models import Color, Filament, FilamentColor, Manufacturer, Spool
from app.services.label_v2_renderer import render_v2_label, resolve_v2_text
from fastapi import HTTPException


def test_v2_text_renders_explicit_conditions():
    assert resolve_v2_text(
        "[if={id}]ID: {id}[/if] [if={missing}]missing[/if]",
        {"id": "7", "missing": ""},
    ) == "ID: 7 "


def test_v2_text_renders_date_modifier():
    assert resolve_v2_text(
        "{stocked_in_at|date}",
        {"stocked_in_at": datetime(2026, 9, 7, 14, 30, tzinfo=timezone.utc)},
    ) == "09/07/26"


def test_v2_text_prefers_a_literal_key_that_ends_with_date_modifier_syntax():
    assert resolve_v2_text(
        "{extra.spool.inspection|date}",
        {"extra.spool.inspection|date": "Literal field value"},
    ) == "Literal field value"


def test_v2_text_does_not_treat_field_data_as_template_markup():
    assert resolve_v2_text(
        "^^{external_id}^^",
        {"external_id": "batch__04"},
    ) == "BATCH__04"


@pytest.mark.parametrize("identifier", ["batch{A}", "batch{id}", "batch__{A}"])
def test_v2_optional_field_preserves_literal_braces(identifier):
    assert resolve_v2_text(
        "{Lot: {external_id}}", {"external_id": identifier, "id": "7"}
    ) == f"Lot: {identifier}"


def test_v2_short_label_omits_border_that_does_not_fit():
    image = render_v2_label(
        {"version": 2, "label": {"widthMm": 40, "heightMm": 10, "marginMm": 6, "border": True}, "elements": []},
        576, {"id": "7"}, [], "http://test/spools/7", None, {}, False,
    )
    assert image.size == (576, 144)
    assert image.getextrema() == ((255, 255),) * 3


def test_v2_swatch_skips_legacy_colors_and_uses_visible_rgb():
    image = render_v2_label(
        {"version": 2, "label": {"widthMm": 40, "heightMm": 30}, "elements": [
            {"type": "swatch", "x": 0, "y": 0, "w": 40, "h": 30, "z": 0},
        ]},
        400, {"id": "7"}, ["legacy", "#FF000000", "#00FF00"], "http://test/spools/7", None, {}, True,
    )
    assert image.getpixel((100, 150)) == (255, 0, 0)
    assert image.getpixel((300, 150)) == (0, 255, 0)


def test_v2_text_strips_unsupported_rich_text_markup():
    assert resolve_v2_text(
        "[b]**Bold**[/b] [i]*italic*[/i] [font=Fraunces]^^blue^^[/font] "
        "[size=120%]__under__[/size] ==inverse== @@color@@",
        {},
    ) == "Bold italic BLUE under inverse color"


def test_v2_text_receives_fields_used_by_shipped_spool_presets():
    spool = Spool(
        id=7,
        filament_id=3,
        status_id=1,
        stocked_in_at=datetime(2026, 9, 7, 14, 30, tzinfo=timezone.utc),
        filament=Filament(
            id=3,
            manufacturer_id=2,
            manufacturer=Manufacturer(id=2, name="FilaWorks"),
            designation="Aurora",
            material_type="PLA",
            diameter_mm=1.75,
            custom_fields={
                "settings_extruder_temp": 215,
                "settings_bed_temp": 60,
                "storage": {"inspection": "2026-09-08T12:00:00Z"},
            },
        ),
    )

    assert resolve_v2_text(
        "[if={stocked_in_at}]Stocked in:[/if] {stocked_in_at|date}",
        _label_values(spool, []),
    ) == "Stocked in: 09/07/26"
    assert resolve_v2_text(
        "{filament.extruder_temp}/{filament.bed_temp} "
        "{extra.filament.storage.inspection|date}",
        _label_values(spool, []),
    ) == "215/60 09/08/26"


def test_label_values_use_linked_color_names_when_manufacturer_name_is_missing():
    filament = Filament(
        id=3,
        manufacturer_id=2,
        manufacturer=Manufacturer(id=2, name="FilaWorks"),
        designation="Aurora",
        material_type="PLA",
        diameter_mm=1.75,
        filament_colors=[
            FilamentColor(position=1, display_name_override="Ocean", color=Color(name="Blue", hex_code="#0000FF")),
            FilamentColor(position=2, color=Color(name="Green", hex_code="#00FF00")),
        ],
    )

    values = _label_values(Spool(id=7, filament_id=3, filament=filament), [])

    assert values["filament.color"] == "Ocean"
    assert values["filament.colors"] == "Ocean, Green"


def test_v2_label_rejects_oversized_qr_content():
    design = {
        "version": 2,
        "label": {"widthMm": 40, "heightMm": 30},
        "elements": [{
            "type": "qr", "x": 1, "y": 1, "w": 20, "h": 20, "z": 0,
            "linkMode": "url", "urlTemplate": "https://example.test/" + "x" * 5000,
        }],
    }

    with pytest.raises(HTTPException) as rejected:
        render_v2_label(
            design, 400, {"id": "7"}, [], "http://test/spools/7", None, {}, False
        )
    assert rejected.value.status_code == 422


@pytest.mark.parametrize("level, expected", [
    ("spool", ("250", "80", "plastic")),
    ("filament", ("200", "60", "cardboard")),
    ("manufacturer", ("190", "55", "metal")),
])
def test_label_values_resolve_physical_spool_fields(level, expected):
    manufacturer = Manufacturer(name="Maker", spool_outer_diameter_mm=190, spool_width_mm=55, spool_material="metal")
    filament = Filament(manufacturer=manufacturer, designation="PLA", material_type="PLA", diameter_mm=1.75)
    spool = Spool(id=7, filament=filament)
    if level in {"spool", "filament"}:
        filament.spool_outer_diameter_mm, filament.spool_width_mm, filament.spool_material = 200, 60, "cardboard"
    if level == "spool":
        spool.spool_outer_diameter_mm, spool.spool_width_mm, spool.spool_material = 250, 80, "plastic"
    values = _label_values(spool, [])
    assert tuple(values[f"filament.{key}"] for key in (
        "spool_outer_diameter_mm", "spool_width_mm", "spool_material",
    )) == expected


@pytest.mark.parametrize("raw, expected", [
    ({"min": 40, "max": 50}, "40.0–50.0 °C"),
    ({"min": 0}, "0.0– °C"),
    ({"max": 50}, "–50.0 °C"),
    (None, ""),
])
def test_label_values_preserve_defined_nested_ranges(raw, expected):
    filament = Filament(manufacturer=Manufacturer(name="Maker"), designation="PLA", material_type="PLA", diameter_mm=1.75)
    spool = Spool(id=7, filament=filament)
    for entity in (spool, filament):
        entity.custom_fields = {"drying": {"temperature": raw}, "other": {"min": 2}}
        entity.custom_field_definitions = {
            "drying.temperature": {"field_type": "range", "config": {"unit": "°C", "decimal_places": 1}},
        }
    values = _label_values(spool, [])
    for source in ("spool", "filament"):
        assert values[f"extra.{source}.drying.temperature"] == expected
        assert values[f"extra.{source}.other.min"] == "2"


def test_v2_migrated_qr_is_clipped_to_short_label():
    from app.services.label_basic_renderer import render_qr_image
    from PIL import ImageChops

    design = {"version": 2, "label": {"widthMm": 60, "heightMm": 10}, "elements": [
        {"type": "qr", "x": 1, "y": -4, "w": 18, "h": 18, "z": 0, "legacyVAlign": "center"},
    ]}
    image = render_v2_label(design, 600, {"id": "7"}, [], "http://test/spools/7", None, {}, False)
    expected = render_qr_image("http://test/spools/7", 180).crop((0, 40, 180, 140))
    assert image.size == (600, 100)
    assert ImageChops.difference(image.crop((10, 0, 190, 100)), expected).getbbox() is None
    design["elements"][0].update(w=41, h=41)
    with pytest.raises(HTTPException) as rejected:
        render_v2_label(design, 600, {"id": "7"}, [], "http://test/spools/7", None, {}, False)
    assert rejected.value.status_code == 422


@pytest.mark.parametrize("box", [
    {"x": 0, "y": 0, "w": 0, "h": 40},
    {"x": 0, "y": 0, "w": 20, "h": 0},
    {"x": 20, "y": 40, "w": 0, "h": 0},
])
def test_v2_accepts_zero_sized_legacy_text_at_label_edges(box):
    design = {"version": 2, "label": {"widthMm": 20, "heightMm": 40}, "elements": [
        {"type": "text", "template": "{id}", "legacyTextRole": "info", **box},
        {"type": "qr", "x": 0, "y": 0, "w": 20, "h": 20, "z": 1},
    ]}
    image = render_v2_label(design, 400, {"id": "7"}, [], "http://test/spools/7", None, {}, False)
    assert image.size == (400, 800)
    assert image.crop((0, 0, 400, 400)).getextrema() == ((0, 255),) * 3
    design["elements"][0]["x"] = 21
    with pytest.raises(HTTPException) as rejected:
        render_v2_label(design, 400, {"id": "7"}, [], "http://test/spools/7", None, {}, False)
    assert rejected.value.status_code == 422
