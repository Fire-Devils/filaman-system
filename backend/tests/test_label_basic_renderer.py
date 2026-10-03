from io import BytesIO

import pytest
from app.models import Filament, Manufacturer, Spool
from fastapi import HTTPException
from PIL import Image, ImageChops


def _spool(**filament_values):
    manufacturer = Manufacturer(name=filament_values.pop("manufacturer", "Müller"))
    filament = Filament(
        manufacturer=manufacturer,
        manufacturer_id=1,
        designation=filament_values.pop("designation", "Sehr langes glänzendes PLA"),
        material_type=filament_values.pop("material_type", "PLA"),
        diameter_mm=1.75,
        manufacturer_color_name=filament_values.pop("color_name", "Grün"),
        **filament_values,
    )
    return Spool(id=7, filament=filament, filament_id=1, status_id=1, remaining_weight_g=850)


def test_basic_label_has_fixed_fields_color_and_exact_qr():
    import qrcode
    from app.services.label_basic_renderer import render_basic_label

    width, height = 480, 320
    target = "http://test/spools/7"
    image = render_basic_label(_spool(), width, height, target, ["legacy", "#e02020", "#2040e0"])
    assert image.mode == "RGB"
    assert image.size == (width, height)
    assert image.getbbox() == (0, 0, width, height)
    assert any(r > g * 1.5 for r, g, _b in image.getdata())
    assert any(b > r * 1.5 for r, _g, b in image.getdata())

    margin, qr_size = max(4, width // 40), height // 2
    actual = image.crop((width - qr_size - margin, margin, width - margin, margin + qr_size))
    expected = qrcode.make(target).convert("RGB").resize((qr_size, qr_size), Image.Resampling.NEAREST)
    assert ImageChops.difference(actual, expected).getbbox() is None

    without_remaining = _spool()
    without_remaining.remaining_weight_g = None
    assert ImageChops.difference(
        image,
        render_basic_label(without_remaining, width, height, target, ["legacy", "#e02020", "#2040e0"]),
    ).getbbox() is not None


def test_basic_label_fits_long_and_unicode_text():
    from app.services.label_basic_renderer import render_basic_label

    long = _spool(designation="Ä" * 1000)
    assert render_basic_label(long, 240, 160, "http://test/spools/7", []).size == (240, 160)
    long.filament.designation = "PLA 🚀"
    assert render_basic_label(long, 240, 160, "http://test/spools/7", []).size == (240, 160)
    long.filament.designation = "PLA\x01"
    with pytest.raises(HTTPException):
        render_basic_label(long, 240, 160, "http://test/spools/7", [])


def test_basic_label_png_round_trip_is_rgb():
    from app.services.label_basic_renderer import render_basic_label

    output = BytesIO()
    render_basic_label(_spool(), 480, 320, "http://test/spools/7", []).save(output, format="PNG")
    assert Image.open(BytesIO(output.getvalue())).mode == "RGB"


def test_basic_label_rejects_oversized_qr_content():
    from app.services.label_basic_renderer import render_basic_label

    settings = {
        "label": {"width": 40},
        "logo": {"show": False},
        "title": {"show": False},
        "title2": {"show": False},
        "info": {"show": False},
        "info2": {"show": False},
        "qr": {"linkMode": "url", "urlTemplate": "https://example.test/" + "x" * 5000},
    }

    with pytest.raises(HTTPException) as rejected:
        render_basic_label(
            _spool(), 240, 160, "http://test/spools/7", [], settings=settings
        )
    assert rejected.value.status_code == 422


def test_basic_short_label_omits_border_that_does_not_fit():
    from app.services.label_basic_renderer import render_basic_label

    settings = {
        "label": {"width": 40, "height": 10, "marginMm": 6, "border": True},
        **{key: {"show": False} for key in ("logo", "title", "title2", "info", "info2", "qr")},
    }
    image = render_basic_label(_spool(), 576, 144, "http://test/spools/7", [], settings=settings)
    assert image.size == (576, 144)
    assert image.getextrema() == ((255, 255),) * 3


@pytest.mark.parametrize("key, identifier", [
    ("external_id", "batch__04"),
    ("external_id", "*batch==04@@__*"),
    ("extra.spool.batch__id", "LOT-7"),
])
def test_basic_v1_preserves_literal_field_markup(key, identifier):
    from app.services.label_basic_renderer import render_basic_label
    from PIL import ImageDraw, ImageFont

    settings = {
        "label": {"width": 40, "marginMm": 0},
        **{key: {"show": False} for key in ("logo", "title", "title2", "info2", "qr")},
        "info": {"template": "**{" + key + "}**", "sizeMm": 3, "fitToWidth": False},
    }
    image = render_basic_label(
        _spool(), 400, 300, "http://test/spools/7", [], settings,
        {key: identifier, "extra.spool.batchid": "OTHER"},
    )
    expected = Image.new("RGB", (400, 300), "white")
    ImageDraw.Draw(expected).text(
        (4, 4), identifier, font=ImageFont.load_default(size=30), fill="black"
    )
    assert ImageChops.difference(image, expected).getbbox() is None
