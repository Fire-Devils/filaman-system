from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
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
from PIL import Image
from sqlalchemy import select


@pytest.fixture(autouse=True)
def chromium_renderer(monkeypatch):
    monkeypatch.setattr(labels.app_settings, "label_renderer", "chromium")


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
@pytest.mark.parametrize("version", [1, 2])
async def test_basic_range_tokens_use_system_definitions(auth_client, preview_spool, db_session, version):
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
        await db_session.commit()
        response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id={preset.id}")
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
    monkeypatch.setattr(labels, "render_preview_png", browser, raising=False)
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
    monkeypatch.setattr(labels, "render_preview_png", browser)

    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render"
        f"?preset_id={preset.id}&dpi=203&width=576&format=mono1"
    )

    assert response.status_code == 200
    assert browser.call_args.args[0]["pixelWidth"] == 160
    assert browser.call_args.args[0]["pixelHeight"] == 1598
    assert response.headers["x-image-height"] == "1598"


@pytest.mark.asyncio
async def test_oversized_logo_is_rejected_before_browser_decode(auth_client, preview_spool, monkeypatch, tmp_path):
    import struct
    import zlib

    client, _ = auth_client
    spool, _preset = preview_spool
    # PNG IHDR declares 80MP; generating its pixels would defeat the memory test.
    output = BytesIO()
    Image.new("L", (1, 1)).save(output, format="PNG")
    content = bytearray(output.getvalue())
    content[16:24] = struct.pack(">II", 10000, 8000)
    content[29:33] = struct.pack(">I", zlib.crc32(content[12:29]))
    (tmp_path / f"{spool.filament.manufacturer_id}_label.png").write_bytes(content)
    monkeypatch.setattr(labels, "MANUFACTURER_LOGO_DIR", Path(tmp_path))
    browser = AsyncMock()
    monkeypatch.setattr(labels, "render_preview_png", browser, raising=False)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id=0")
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
    monkeypatch.setattr(labels, "render_preview_png", browser)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert "12 megapixel" in response.json()["detail"]
    browser.assert_not_called()
    basic = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id={preset.id}"
    )
    assert basic.status_code == 422
    assert "12 megapixel" in basic.json()["detail"]


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
    monkeypatch.setattr(labels, "render_preview_png", browser)
    response = await client.get(f"/api/v1/labels/spool/{spool.id}/render?preset_id={preset.id}")
    assert response.status_code == 422
    assert "12 megapixel" in response.json()["detail"]
    browser.assert_not_called()


@pytest.mark.parametrize("width", [None, "", " "])
def test_legacy_empty_dimensions_match_preview_normalization(width):
    assert labels._label_size({"label": {"width": width, "height": 40}}) == (20, 40)
    assert labels._label_size({"label": {}}) == (60, 40)


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
    monkeypatch.setattr(labels, "render_preview_png", browser)
    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id={preset.id}"
    )
    assert response.status_code == 422
    browser.assert_not_called()


@pytest.mark.asyncio
async def test_basic_renderer_approximately_renders_saved_v2_presets(
    auth_client, preview_spool, db_session, monkeypatch,
):
    from fastapi import HTTPException

    client, _ = auth_client
    spool, preset = preview_spool
    preset.selected = True
    await db_session.commit()
    browser = AsyncMock(side_effect=HTTPException(503, "Chromium unavailable"))
    monkeypatch.setattr(labels, "render_preview_png", browser)

    default = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id=0&color=color"
    )
    assert default.status_code == 200
    assert default.headers["x-preset-id"] == "0"
    assert Image.open(BytesIO(default.content)).mode == "RGB"
    browser.assert_not_called()
    mono = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id=0"
        "&format=mono1&dpi=203&width=576&align=right&orientation=portrait"
    )
    assert mono.status_code == 200
    assert mono.headers["x-image-width"] == "576"
    assert mono.headers["x-image-height"] == "480"
    assert mono.headers["x-content-width"] == "320"
    assert mono.headers["x-row-bytes"] == "72"
    assert len(mono.content) == 72 * 480
    assert all(mono.content[row * 72:row * 72 + 32] == bytes(32) for row in range(480))

    for suffix in (f"renderer=basic&preset_id={preset.id}", "renderer=basic"):
        rendered = await client.get(f"/api/v1/labels/spool/{spool.id}/render?{suffix}")
        assert rendered.status_code == 200
        assert rendered.headers["x-preset-id"] == str(preset.id)
        assert Image.open(BytesIO(rendered.content)).size == (576, 144)
        browser.assert_not_called()

    monkeypatch.setattr(labels.app_settings, "label_renderer", "basic")
    configured = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?preset_id=0&color=color"
    )
    assert configured.status_code == 200
    overridden = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=chromium&preset_id=0"
    )
    assert overridden.status_code == 503
    assert "retry-after" not in overridden.headers
    assert (await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id=999999"
    )).status_code == 404
    assert (await client.get(
        f"/api/v1/labels/spool/{spool.id}/render?renderer=basic&preset_id=0"
        "&format=mono1&color=color"
    )).status_code == 422
    assert preset.selected is True


@pytest.mark.asyncio
async def test_basic_renderer_approximately_renders_saved_legacy_presets(
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
    await db_session.commit()

    response = await client.get(
        f"/api/v1/labels/spool/{spool.id}/render"
        f"?renderer=basic&preset_id={preset.id}&dpi=203&width=576&color=color"
    )

    assert response.status_code == 200
    assert response.headers["x-content-width"] == "320"
    assert response.headers["x-image-height"] == "240"
    assert Image.open(BytesIO(response.content)).convert("RGB").getpixel((0, 0)) == (0, 0, 0)
