import json
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from PIL import Image, ImageChops, ImageDraw, ImageFont
from sqlalchemy import select

from app.api.v1 import labels
from app.models import (
    Filament,
    LabelAsset,
    LabelPreset,
    Manufacturer,
    Spool,
    SpoolStatus,
    SystemExtraField,
)
from app.models.label_preset import label_preset_name_key
from app.services.label_preset_v1 import convert_label_preset_data


@pytest_asyncio.fixture
async def preview_spool(db_session, admin_user):
    manufacturer = Manufacturer(name="Shared preview")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation="Preview PLA", material_type="PLA", diameter_mm=1.75, raw_material_weight_g=1000, custom_fields={"nozzle": {"min": 190, "max": 220}})
    db_session.add(filament)
    await db_session.flush()
    status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
    spool = Spool(filament=filament, status=status, initial_total_weight_g=1200, remaining_weight_g=850)
    db_session.add(spool)
    preset = LabelPreset(user_id=admin_user.id, preset_type="spool", name="Shared", name_key=label_preset_name_key("Shared"), data={"version": 2, "design": {"version": 2, "label": {"widthMm": 40, "heightMm": 10, "marginMm": 6, "border": False}, "elements": [{"id": "text", "type": "text", "x": 0, "y": 0, "w": 40, "h": 10, "template": "{filament.raw_material_weight_g}"}]}})
    db_session.add(preset)
    await db_session.commit()
    return spool, preset


@pytest.mark.asyncio
async def test_saved_null_preset_is_invalid_not_default(auth_client, preview_spool, db_session):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = None
    await db_session.commit()
    listing = await client.get("/api/v1/labels/presets")
    assert listing.status_code == 200
    assert listing.json()[0]["width_mm"] is None
    assert listing.json()[0]["height_mm"] is None
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_unconverted_legacy_record_is_preserved_but_not_rendered_or_queued(auth_client, preview_spool, db_session):
    client, csrf = auth_client
    spool, preset = preview_spool
    original = {"version": 9, "settings": {"label": {"width": 40, "height": 30}}}
    preset.data = original
    preset.selected = True
    await db_session.commit()
    listing = await client.get("/api/v1/labels/presets")
    assert listing.json()[0]["width_mm"] is None
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert "Label Designer" in response.json()["detail"]
    await db_session.refresh(preset)
    assert preset.data == original
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    for query in (f"?preset_id={preset.id}", ""):
        response = await client.post(f"/api/v1/labels/spool/{spool.id}/print-request{query}", headers={"X-CSRF-Token": csrf})
        assert response.status_code == 422
    assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [
    {"elements": [{"type": "unsupported"}]}, {"elements": None},
    {"elements": [{}] * 101}, {"version": 9},
])
async def test_invalid_designer_data_cannot_be_queued(auth_client, preview_spool, db_session, invalid):
    client, csrf = auth_client
    spool, preset = preview_spool
    preset.data = {**preset.data, "design": {**preset.data["design"], **invalid}}
    preset.selected = True
    await db_session.commit()
    for query in (f"?preset_id={preset.id}", ""):
        response = await client.post(f"/api/v1/labels/spool/{spool.id}/print-request{query}", headers={"X-CSRF-Token": csrf})
        assert response.status_code == 422
    assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
@pytest.mark.parametrize("orientation,base", [("original", "http://test"), ("portrait", "https://labels.example/" + "long/" * 16)])
async def test_thermal_qr_final_raster_has_whole_modules(auth_client, preview_spool, db_session, orientation, base):
    import qrcode

    client, _ = auth_client
    spool, preset = preview_spool
    # The longer URL needs more modules; keep this success fixture above 3 dots/module.
    qr_size = 24.83 if orientation == "portrait" else 14.83
    preset.data = {"version": 2, "design": {
        "version": 2, "label": {"widthMm": 40, "heightMm": 30},
        "elements": [{"id": "qr", "type": "qr", "x": 2.13, "y": 3.17, "w": qr_size, "h": qr_size,
                      "mode": "logo", "linkMode": "url", "urlTemplate": base}],
    }}
    await db_session.commit()
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&format=mono1&dpi=203&width=385&align=right&orientation={orientation}")
    assert response.status_code == 200, response.text
    lighter = await client.get(str(response.request.url) + "&threshold=128")
    assert lighter.status_code == 200
    assert lighter.content == response.content  # QR dots are binary, not antialiased gray.
    height = int(response.headers["x-image-height"])
    # Invert wire bits: Pillow's one-bit representation uses white=1.
    image = Image.frombytes("1", (385, height), response.content.translate(bytes(range(255, -1, -1)))).convert("L")
    content_width = int(response.headers["x-content-width"])
    image = image.crop((385-content_width, 0, 385, height))
    if orientation == "portrait":
        image = image.transpose(Image.Transpose.ROTATE_270)
    assert image.size == (320, 240)
    black = image.point(lambda p: 255-p)
    left, top, right, bottom = black.getbbox()
    reference = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M)
    reference.add_data(base.rstrip("/") + f"/spools/{spool.id}")
    reference.make(fit=True)
    modules = reference.modules_count
    pitch = (right-left) // modules
    assert pitch >= 3
    assert right-left == bottom-top == modules*pitch
    # Every module is a solid pitch-by-pitch square, never a fractional rescale.
    for y in range(modules):
        for x in range(modules):
            assert image.crop((left+x*pitch, top+y*pitch, left+(x+1)*pitch, top+(y+1)*pitch)).getextrema() in ((0, 0), (255, 255))
    for box in ((left-4*pitch, top-4*pitch, right+4*pitch, top),
                (left-4*pitch, bottom, right+4*pitch, bottom+4*pitch),
                (left-4*pitch, top, left, bottom), (right, top, right+4*pitch, bottom)):
        assert image.crop(box).getextrema() == (255, 255)


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
@pytest.mark.parametrize("qr_size", [3, 6, 10])
async def test_thermal_qr_rejects_too_small_box_but_png_keeps_original(auth_client, preview_spool, db_session, qr_size):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        "version": 2, "label": {"widthMm": 40, "heightMm": 30},
        "elements": [{"id": "qr", "type": "qr", "x": 2, "y": 3, "w": qr_size, "h": qr_size, "mode": "logo"}],
    }}
    await db_session.commit()
    path = f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&dpi=203"
    rejected = await client.get(path + "&format=mono1")
    assert rejected.status_code == 422
    assert "dots per module" in rejected.json()["detail"]
    assert "requires at least 3" in rejected.json()["detail"]
    first = await client.get(path + "&threshold=1")
    second = await client.get(path + "&threshold=255")
    assert first.status_code == second.status_code == 200
    assert first.content == second.content


@pytest.mark.asyncio
@pytest.mark.parametrize("query,black", [("", True), ("&threshold=200", True), ("&threshold=150", False), ("&threshold=0", False)])
async def test_mono1_default_and_explicit_threshold(auth_client, preview_spool, monkeypatch, query, black):
    client, _ = auth_client
    spool, preset = preview_spool
    image = Image.new("RGB", (384, 96), (175, 175, 175))
    output = BytesIO()
    image.save(output, format="PNG")
    monkeypatch.setattr(labels, "render_svg_png", AsyncMock(return_value=output.getvalue()))
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&format=mono1&width=384{query}")
    assert response.status_code == 200, response.text
    assert response.content == bytes([255 if black else 0]) * 4608


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
async def test_svg_png_preserves_automatic_white_outline_outside_qr(auth_client, preview_spool, db_session):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        "version": 2, "label": {"widthMm": 40, "heightMm": 30},
        "elements": [
            {"id": "qr", "type": "qr", "x": 5, "y": 5, "w": 15, "h": 15, "z": 0, "mode": "simple"},
            {"id": "background", "type": "shape", "shape": "rectangle", "x": 0, "y": 0,
             "w": 40, "h": 30, "z": 10, "fill": "#000000", "stroke": "", "strokeWidthMm": 0},
        ],
    }}
    await db_session.commit()
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&dpi=203&format=png")
    assert response.status_code == 200
    image = Image.open(BytesIO(response.content)).convert("RGB")
    assert image.getpixel((32, 80)) == (255, 255, 255)
    assert image.getpixel((16, 80)) == (0, 0, 0)


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
async def test_thermal_qr_white_space_covers_other_layers(auth_client, preview_spool, db_session):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        "version": 2, "label": {"widthMm": 40, "heightMm": 30},
        "elements": [
            {"id": "qr", "type": "qr", "x": 2, "y": 3, "w": 15, "h": 15, "z": 0},
            {"id": "over", "type": "shape", "shape": "rectangle", "x": 2.2, "y": 3.2,
             "w": 1, "h": 1, "z": 10, "fill": "#000000", "stroke": "", "strokeWidthMm": 0},
        ],
    }}
    await db_session.commit()
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&dpi=203&format=mono1")
    assert response.status_code == 200
    image = Image.frombytes("1", (576, 240), response.content.translate(bytes(range(255, -1, -1))))
    assert image.getpixel((20, 28)) == 255
    assert image.crop((16, 24, 136, 144)).getextrema() == (0, 255)


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
@pytest.mark.parametrize("kind", ["default", "v1-left", "v1-right", "v1-columns", "v1-wrap", "v2"])
async def test_thermal_label_sample_matrix(auth_client, preview_spool, db_session, monkeypatch, tmp_path, kind):
    client, _ = auth_client
    spool, preset = preview_spool
    manufacturer_id = spool.filament.manufacturer_id
    spool.filament.designation = "Grün üöäßéè"

    logo = Image.new("RGBA", (280, 40), (0, 0, 0, 0))
    ImageDraw.Draw(logo).text((0, 0), "TEST FILAMENT", font=ImageFont.load_default(size=32), fill="black")
    logo.save(tmp_path / f"{manufacturer_id}_label.png")
    monkeypatch.setattr(labels, "MANUFACTURER_LOGO_DIR", tmp_path)
    if kind.startswith("v1"):
        preset.data = {"settings": {
            "label": {"width": 40, "height": 30, "marginMm": 1},
            "logo": {"show": True, "spaceMm": 5},
            "title": {"template": "{filament.name}", "sizeMm": 3},
            "info": {"template": "ID: {id}\nHinzugefügt éè\n850 g", "sizeMm": 2},
            "qr": {"sizeMm": 14, "position": "left" if kind == "v1-left" else "right", "mode": "logo"},
        }}
        if kind == "v1-columns":
            preset.data["settings"]["info"] = {"template": "ID: {id}\nPLA", "sizeMm": 1.8, "vAlign": "top"}
            preset.data["settings"]["info2"] = {"show": True, "template": "850 g\nGrün", "sizeMm": 1.8, "vAlign": "bottom", "vsep": True}
            preset.data["settings"]["qr"].update(sizeMm=13, vAlign="center")
        elif kind == "v1-wrap":
            preset.data["settings"]["info"] = {"template": "Farbe: Grün matt\nHinzugefügt am 06.10.2026", "sizeMm": 2, "vAlign": "top"}
            preset.data["settings"]["qr"]["vAlign"] = "top"
    else:
        preset.data = {"version": 2, "design": {
            "version": 2, "label": {"widthMm": 40, "heightMm": 30},
            "elements": [
                {"id": "logo", "type": "manufacturerLogo", "x": 2, "y": 0, "w": 30, "h": 5},
                {"id": "text", "type": "text", "x": 2, "y": 5, "w": 36, "h": 5,
                 "template": "{filament.name}", "fontSizeMm": 3, "fontWeight": 700},
                *[{"id": f"qr{i}", "type": "qr", "x": x, "y": 12, "w": 13.8, "h": 13.8,
                   "mode": "logo"} for i, x in enumerate((2, 22))],
            ],
        }}
    preset.data = convert_label_preset_data(preset.data, "spool")
    await db_session.commit()
    path = f"/api/v1/labels/spool/{spool.id}/render?preset_id={0 if kind == 'default' else preset.id}&dpi=203&width=576"
    png = await client.get(path)
    mono = await client.get(path + "&format=mono1")
    light = await client.get(path + "&format=mono1&threshold=128")
    assert png.status_code == mono.status_code == light.status_code == 200
    assert "x-renderer" not in png.headers and "x-renderer" not in mono.headers
    assert mono.headers["x-content-width"] == ("480" if kind == "default" else "320")
    height = 320 if kind == "default" else 240
    assert mono.headers["x-image-height"] == str(height)
    assert len(mono.content) == 72 * height
    assert all(low & ~high == 0 for low, high in zip(light.content, mono.content))
    Image.open(BytesIO(png.content)).save(tmp_path / f"{kind}-svg-png.png")
    image = Image.frombytes("1", (576, height), mono.content.translate(bytes(range(255, -1, -1))))
    image.save(tmp_path / f"{kind}-svg-mono1.png")
    (tmp_path / f"{kind}-svg-mono1.bin").write_bytes(mono.content)
    (tmp_path / f"{kind}-svg-headers.json").write_text(json.dumps(dict(mono.headers), indent=2))
    if kind.startswith("v1"):
        box = (8, 80, 120, 232) if kind == "v1-left" else (208, 80, 312, 232) if kind == "v1-columns" else (200, 80, 312, 232)
        slot = image.crop(box).convert("L")
        left, top, right, bottom = ImageChops.invert(slot).getbbox()
        pitch = 3
        assert right - left == bottom - top == 25 * pitch
        assert min(left, top, slot.width - right, slot.height - bottom) >= 4 * pitch
        for row in range(25):
            for column in range(25):
                assert slot.crop((left + column * pitch, top + row * pitch,
                                  left + (column + 1) * pitch, top + (row + 1) * pitch)).getextrema() in ((0, 0), (255, 255))
        light_image = Image.frombytes("1", (576, height), light.content.translate(bytes(range(255, -1, -1))))
        assert light_image.crop(box).tobytes() == image.crop(box).tobytes()
    if kind == "v2":
        # Fractional DOM slots may center a dot differently; the modules and
        # minimum quiet zone must remain identical, not the extra whitespace.
        codes = []
        for box in ((16, 96, 126, 206), (176, 96, 286, 206)):
            slot = image.crop(box).convert("L")
            left, top, right, bottom = ImageChops.invert(slot).getbbox()
            assert right-left == bottom-top == 75  # EC-M v2, 25 modules * 3 dots
            assert min(left, top, 110-right, 110-bottom) >= 12
            codes.append(slot.crop((left, top, right, bottom)).tobytes())
        assert codes[0] == codes[1]


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
@pytest.mark.parametrize("dpi", [203, 300])
@pytest.mark.parametrize("scenario", [
    "migrated-inverse", "migrated-sparse", "designer-fit", "designer-wrap-limit",
    "designer-overflow", "designer-literal", "designer-wide", "designer-overlap",
])
async def test_thermal_data_matrix(auth_client, preview_spool, db_session, monkeypatch, tmp_path, dpi, scenario):
    """Catch lost content, ignored thresholds, damaged QR modules and wire padding."""
    client, _ = auth_client
    spool, preset = preview_spool
    monkeypatch.setattr(labels, "MANUFACTURER_LOGO_DIR", tmp_path)  # deliberate missing logo
    spool.filament.designation = "Grün üöäßéè — extra long matte charcoal filament"
    spool.filament.manufacturer_color_name = "Charcoal (11101)"
    spool.filament.custom_fields = {"article": "11101"}
    spool.custom_fields = {"added": "2026-08-25 02:42:32+00:00"}
    info = "ID: {id}\nHinzugefügt: {extra.spool.added}\nFarbe: {filament.color}\nArtikel Nr: {extra.filament.article}\n{filament.name}"
    if scenario == "designer-fit":
        spool.filament.designation = "Grün üöäßéè"
        spool.custom_fields = {"added": "2026-08-25"}
    wide = scenario == "designer-wide"
    width_mm, qr_size = (60, 23) if wide else (40, 14)
    if scenario == "migrated-sparse":
        spool.filament.designation = "PLA"
        spool.filament.manufacturer_color_name = None
        spool.filament.custom_fields = {}
        spool.custom_fields = {}
        info = "ID: {id}\n{Farbe: {filament.color}}\n{Artikel Nr: {extra.filament.article}}"
    if scenario == "designer-literal":
        spool.filament.designation = "==PLA== **not bold** {id}"
        info = "{filament.name}\n{extra.filament.article}"
    if scenario == "designer-overlap":
        info = "ID: {id}\nArtikel Nr: {extra.filament.article}"
    if scenario.startswith("migrated"):
        preset.data = convert_label_preset_data({"settings": {
            "label": {"width": 40, "height": 30, "marginMm": 1},
            "logo": {"show": True, "spaceMm": 5},
            "title": {"template": "=={filament.type}==", "sizeMm": 3, "align": "center"},
            "info": {"template": info, "sizeMm": 2, "vAlign": "top"},
            "qr": {"sizeMm": qr_size, "mode": "logo", "vAlign": "bottom"},
        }}, "spool")
    else:
        preset.data = {"version": 2, "design": {
            "version": 2, "label": {"widthMm": width_mm, "heightMm": 30},
            "elements": [
                {"id": "title", "type": "text", "x": 1, "y": 1, "w": width_mm - 2, "h": 4,
                 "template": "=={filament.type}==", "fontSizeMm": 3, "fontWeight": 700,
                 "fontFamily": "Space Grotesk", "align": "center"},
                {"id": "info", "type": "text", "x": 1, "y": 6, "w": width_mm - qr_size - 4,
                 "h": 9 if scenario == "designer-overflow" else 23, "template": info,
                 "fontSizeMm": 2.4, "fontWeight": 400, "fontFamily": "Space Grotesk",
                 "minFontSizeMm": 1.2, "wrap": True,
                 "fitToWidth": scenario != "designer-overflow"},
                {"id": "qr", "type": "qr", "x": width_mm - qr_size - 1, "y": 29 - qr_size,
                 "w": qr_size, "h": qr_size, "mode": "colorLogo",
                 "linkMode": "url" if wide else "spool",
                 "urlTemplate": "https://filaman.example.test/printing/" + "long/" * 6 if wide else ""},
            ],
        }}
        if scenario == "designer-overlap":
            preset.data["design"]["elements"].append({
                "id": "underlay", "type": "shape", "shape": "rectangle", "fill": "#000000",
                "x": 24, "y": 14, "w": 16, "h": 16, "z": 99,
            })
    await db_session.commit()
    content_width = {(40, 203): 320, (40, 300): 472, (60, 203): 480, (60, 300): 709}[(width_mm, dpi)]
    height = {203: 240, 300: 354}[dpi]
    wire_width = 576 if dpi == 203 else 832
    path = f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&dpi={dpi}&width={wire_width}"
    responses = {}
    for threshold in (128, 150, 200, None):
        query = "" if threshold is None else f"&threshold={threshold}"
        response = await client.get(path + "&format=mono1" + query)
        if scenario in ("migrated-inverse", "designer-overflow"):
            assert response.status_code == 422, response.text
            assert "Text does not fit" in response.json()["detail"]
            continue
        assert response.status_code == 200, response.text
        assert "x-renderer" not in response.headers
        assert int(response.headers["x-content-width"]) == content_width
        assert int(response.headers["x-image-height"]) == height
        assert len(response.content) == wire_width // 8 * height
        image = Image.frombytes("1", (wire_width, height), response.content.translate(bytes(range(255, -1, -1))))
        assert image.crop((content_width, 0, wire_width, height)).getextrema() == (255, 255)
        assert image.crop((0, 0, content_width, height)).getextrema() == (0, 255)
        image.save(tmp_path / f"{scenario}-{dpi}-svg-{threshold or 'default'}.png")
        responses[threshold] = response.content
    if scenario in ("migrated-inverse", "designer-overflow"):
        return
    assert responses[None] == responses[200]
    for low, high in ((128, 150), (150, 200)):
        assert all(a & ~b == 0 for a, b in zip(responses[low], responses[high]))
    # The QR slot is bottom-right in both migrated and native designs.
    scale = content_width / width_mm
    box = tuple(round(v * scale) for v in (width_mm - qr_size - 1, 29 - qr_size, width_mm - 1, 29))
    slot = image.crop(box).convert("L")
    # Ignore a few pixels of CSS position rounding at the slot edge when
    # locating the code over a dark underlay. Quiet zones are >=12px here;
    # validate their complete extent against the original image below.
    left, top, right, bottom = (
        value + 4 for value in ImageChops.invert(slot.crop((4, 4, slot.width - 4, slot.height - 4))).getbbox()
    )
    assert right - left == bottom - top
    # Finder pattern: seven modules across, with a three-module solid center.
    row = [slot.getpixel((x, top)) for x in range(left, right)]
    pitch = row.index(255) // 7
    assert pitch >= 3
    # The contract is four white modules inside the label, not necessarily
    # inside the nominal element slot.
    x0, y0, x1, y1 = left + box[0], top + box[1], right + box[0], bottom + box[1]
    gap = 4 * pitch
    assert x0 >= gap and y0 >= gap and x1 + gap <= content_width and y1 + gap <= height
    for quiet in ((x0-gap, y0-gap, x1+gap, y0), (x0-gap, y1, x1+gap, y1+gap),
                  (x0-gap, y0, x0, y1), (x1, y0, x1+gap, y1)):
        assert image.crop(quiet).getextrema() == (255, 255)
    for y in range(top, bottom, pitch):
        for x in range(left, right, pitch):
            assert slot.crop((x, y, x + pitch, y + pitch)).getextrema() in ((0, 0), (255, 255))
    for threshold in (128, 150, 200):
        variant = Image.frombytes("1", (wire_width, height), responses[threshold].translate(bytes(range(255, -1, -1))))
        assert variant.crop(box).tobytes() == image.crop(box).tobytes()
    (tmp_path / "preset.json").write_text(json.dumps(preset.data, ensure_ascii=False, indent=2))
    (tmp_path / "mono1.bin").write_bytes(responses[None])
    (tmp_path / "headers.json").write_text(json.dumps(dict(response.headers), indent=2))


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [1, 2])
async def test_range_tokens_use_system_definitions(auth_client, preview_spool, db_session, version):
    client, _ = auth_client
    spool, preset = preview_spool
    spool.filament.custom_fields = {"drying": {"min": 40, "max": 50}}
    spool.filament.custom_field_definitions = {
        "drying": {"field_type": "range", "config": {"unit": "wrong"}},
    }
    db_session.add(SystemExtraField(
        target_type="filament", key="drying", label="Drying", field_type="range",
        config={"unit": "°C", "decimal_places": 1},
    ))

    async def render(template):
        if version == 2:
            preset.data = {"version": 2, "design": {
                "version": 2, "label": {"widthMm": 40, "heightMm": 30},
                "elements": [{"type": "text", "x": 1, "y": 1, "w": 38, "h": 10, "template": template}],
            }}
        else:
            preset.data = {"settings": {
                "label": {"width": 40, "height": 30}, "title": {"template": template},
                **{key: {"show": False} for key in ("logo", "title2", "info", "info2", "qr")},
            }}
        preset.data = convert_label_preset_data(preset.data, "spool")
        await db_session.commit()
        response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
        assert response.status_code == 200
        return response.content

    actual = await render("Dry: {extra.filament.drying}")
    expected = await render("Dry: 40.0–50.0 °C")
    assert actual == expected


@pytest.mark.asyncio
async def test_render_uses_shared_preview_with_native_data(auth_client, preview_spool, monkeypatch):
    client, _ = auth_client
    spool, preset = preview_spool
    output = BytesIO()
    Image.new("RGB", (320, 80), "red").save(output, format="PNG")
    browser = AsyncMock(return_value=output.getvalue())
    monkeypatch.setattr(labels, "render_svg_png", browser, raising=False)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&dpi=203&width=384&color=color")
    assert response.status_code == 200
    assert browser.call_count == 1
    payload = browser.call_args.args[0]
    assert payload["spool"]["initial_total_weight_g"] == 1200
    assert payload["spool"]["filament"]["raw_material_weight_g"] == 1000
    assert payload["spool"]["filament"]["custom_fields"]["nozzle"] == {"min": 190, "max": 220}
    assert payload["spool"]["status"]["label"]
    assert payload["preset"] == preset.data
    assert (payload["pixelWidth"], payload["pixelHeight"]) == (320, 80)
    assert "x-row-bytes" not in response.headers
    assert "x-bit-order" not in response.headers
    image = Image.open(BytesIO(response.content))
    assert image.size == (384, 80)
    assert image.getpixel((20, 20)) == (255, 0, 0)
    assert image.getpixel((383, 20)) == (255, 255, 255)


@pytest.mark.asyncio
async def test_dpi_converts_both_physical_dimensions_independently(
    auth_client, preview_spool, db_session, monkeypatch,
):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {
        "version": 2,
        "design": {
            **preset.data["design"],
            "label": {"widthMm": 20, "heightMm": 200},
        },
    }
    await db_session.commit()
    output = BytesIO()
    Image.new("RGB", (1, 1), "white").save(output, format="PNG")
    browser = AsyncMock(return_value=output.getvalue())
    monkeypatch.setattr(labels, "render_svg_png", browser)

    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render"
        f"?preset_id={preset.id}&dpi=203&width=576&format=mono1"
    )

    assert response.status_code == 200
    assert browser.call_args.args[0]["pixelWidth"] == 160
    assert browser.call_args.args[0]["pixelHeight"] == 1598
    assert response.headers["x-image-height"] == "1598"


@pytest.mark.asyncio
@pytest.mark.parametrize("designer", [False, True])
async def test_oversized_logo_is_rejected_only_when_rendered(auth_client, preview_spool, db_session, monkeypatch, tmp_path, designer):
    import struct
    import zlib

    client, _ = auth_client
    spool, preset = preview_spool
    if designer:
        preset.data = {**preset.data, "design": {**preset.data["design"], "elements": [
            {"id": "logo", "type": "manufacturerLogo", "x": 0, "y": 0, "w": 40, "h": 6},
        ]}}
        await db_session.commit()
    # PNG IHDR declares 80MP; generating its pixels would defeat the memory test.
    output = BytesIO()
    Image.new("L", (1, 1)).save(output, format="PNG")
    content = bytearray(output.getvalue())
    content[16:24] = struct.pack(">II", 10000, 8000)
    content[29:33] = struct.pack(">I", zlib.crc32(content[12:29]))
    (tmp_path / f"{spool.filament.manufacturer_id}_label.png").write_bytes(content)
    monkeypatch.setattr(labels, "MANUFACTURER_LOGO_DIR", Path(tmp_path))
    browser = AsyncMock()
    monkeypatch.setattr(labels, "render_svg_png", browser, raising=False)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id if designer else 0}")
    assert response.status_code == 422
    browser.assert_not_called()


@pytest.mark.asyncio
async def test_repeated_images_share_the_render_pixel_budget(
    auth_client, preview_spool, db_session, admin_user, monkeypatch,
):
    client, _ = auth_client
    spool, preset = preview_spool
    output = BytesIO()
    Image.new("RGB", (1000, 1000), "black").save(output, format="PNG")
    content = output.getvalue()
    db_session.add(LabelAsset(
        id="repeated", user_id=admin_user.id, display_name="Repeated.png", sha256="a" * 64,
        media_type="image/png", width=1000, height=1000, byte_size=len(content), content=content,
    ))
    preset.data = {"version": 2, "design": {
        **preset.data["design"], "elements": [
            {"id": str(index), "type": "image", "assetId": "repeated", "x": index, "y": 0, "w": 1, "h": 1}
            for index in range(13)
        ],
    }}
    await db_session.commit()
    browser = AsyncMock(return_value=content)
    monkeypatch.setattr(labels, "render_svg_png", browser)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert "12 megapixel" in response.json()["detail"]
    browser.assert_not_called()


@pytest.mark.asyncio
async def test_qr_canvases_share_the_render_pixel_budget(
    auth_client, preview_spool, db_session, monkeypatch,
):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        **preset.data["design"], "elements": [
            {"id": str(index), "type": "qr", "x": 0, "y": 0, "w": 10, "h": 10}
            for index in range(12)
        ],
    }}
    await db_session.commit()
    browser = AsyncMock()
    monkeypatch.setattr(labels, "render_svg_png", browser)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert "12 megapixel" in response.json()["detail"]
    browser.assert_not_called()


@pytest.mark.parametrize("width", [None, "", " "])
def test_legacy_empty_dimensions_match_preview_normalization(width):
    assert labels._validated_preset_size(convert_label_preset_data({"settings": {"label": {"width": width, "height": 40}}}, "spool")) == (20, 40)
    assert labels._validated_preset_size(convert_label_preset_data({"settings": {"label": {}}}, "spool")) == (60, 40)


@pytest.mark.asyncio
@pytest.mark.usefixtures("label_render_runtime")
async def test_maximum_height_capture_has_exact_pixels(auth_client, preview_spool, db_session):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        **preset.data["design"], "label": {"widthMm": 35, "heightMm": 70, "marginMm": 0, "border": False},
    }}
    await db_session.commit()
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}&width=1024")
    assert response.status_code == 200, response.text
    assert Image.open(BytesIO(response.content)).size == (1024, 2048)


@pytest.mark.asyncio
@pytest.mark.parametrize("element_type", [[], {}])
async def test_unknown_unhashable_element_types_are_rejected(auth_client, preview_spool, db_session, monkeypatch, element_type):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"version": 2, "design": {
        **preset.data["design"], "elements": [*preset.data["design"]["elements"], {"type": element_type}],
    }}
    await db_session.commit()
    browser = AsyncMock()
    monkeypatch.setattr(labels, "render_svg_png", browser)
    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}"
    )
    assert response.status_code == 422
    browser.assert_not_called()


@pytest.mark.asyncio
async def test_svg_renders_migrated_legacy_presets(
    auth_client, preview_spool, db_session,
):
    client, _ = auth_client
    spool, preset = preview_spool
    preset.data = {"settings": {
        "label": {"width": 40, "height": 30, "marginMm": 0, "border": True},
        "logo": {"show": False},
        "title": {"show": True, "template": "{filament.name}"},
        "title2": {"show": False},
        "info": {"show": False},
        "info2": {"show": False},
        "qr": {"show": False},
    }}
    preset.data = convert_label_preset_data(preset.data, "spool")
    await db_session.commit()

    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render"
        f"?preset_id={preset.id}&dpi=203&width=576&color=color"
    )

    assert response.status_code == 200
    assert response.headers["x-content-width"] == "320"
    assert response.headers["x-image-height"] == "240"
    assert Image.open(BytesIO(response.content)).convert("RGB").getpixel((0, 0)) == (0, 0, 0)
