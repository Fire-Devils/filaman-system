import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import select

from app.models import Filament, LabelPreset, Manufacturer, Spool, SpoolStatus
from app.models.label_preset import label_preset_name_key


@pytest_asyncio.fixture
async def label_entity_id(db_session, kind):
    maker = Manufacturer(name="Portrait maker")
    db_session.add(maker)
    await db_session.flush()
    filament = Filament(manufacturer_id=maker.id, designation="Grüße",
                        material_type="PLA", diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    entity_id = filament.id
    if kind == "spool":
        status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
        spool = Spool(filament_id=filament.id, status_id=status.id)
        db_session.add(spool)
        await db_session.flush()
        entity_id = spool.id
    return entity_id


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
@pytest.mark.parametrize("align", ["left", "right"])
async def test_portrait_thermal_rotates_before_padding_without_changing_pixels(
    auth_client, db_session, admin_user, kind, align, label_entity_id,
):
    """A 30x40 design must become 40x30 content, not a rotated padded row."""
    client, _ = auth_client
    preset = LabelPreset(user_id=admin_user.id, preset_type=kind, name="Portrait",
                         name_key=label_preset_name_key("Portrait"), data={"version": 2, "design": {
                             "version": 2,
                             "label": {"widthMm": 30, "heightMm": 40, "marginMm": 1},
                             "elements": [
                                 {"id": "text", "type": "text", "x": 1, "y": 1,
                                  "w": 28, "h": 8, "template": "TOP {filament.name}",
                                  "fontSizeMm": 3, "fontFamily": "Space Grotesk", "wrap": True},
                                 {"id": "qr", "type": "qr", "x": 5, "y": 17,
                                  "w": 20, "h": 20, "mode": "simple", "linkMode": "spool"},
                             ],
                         }})
    db_session.add(preset)
    await db_session.commit()
    path = (f"/api/v1/labels/{kind}/{label_entity_id}/render?format=mono1"
            f"&dpi=203&width=576&preset_id={preset.id}&align={align}")
    original = await client.get(path)
    landscape = await client.get(path + "&orientation=landscape")
    assert original.status_code == landscape.status_code == 200
    assert original.headers["x-content-width"] == "240"
    assert original.headers["x-image-height"] == "320"
    assert original.headers["x-rotated"] == "0"
    assert landscape.headers["x-content-width"] == "320"
    assert landscape.headers["x-image-height"] == "240"
    assert landscape.headers["x-rotated"] == "1"
    assert landscape.headers["x-row-bytes"] == "72"
    assert landscape.headers["x-bit-order"] == "msb-black-1"
    assert len(landscape.content) == 17280
    before = Image.frombytes("1", (576, 320), original.content)
    after = Image.frombytes("1", (576, 240), landscape.content)
    x_before, x_after = (0, 0) if align == "left" else (336, 256)
    design = before.crop((x_before, 0, x_before + 240, 320))
    actual = after.crop((x_after, 0, x_after + 320, 240))
    assert actual.tobytes() == design.transpose(Image.Transpose.ROTATE_90).tobytes()
    assert actual.getbbox() is not None
    padding = after.crop((320, 0, 576, 240) if align == "left" else (0, 0, 256, 240))
    assert padding.getbbox() is None  # mono1 zero bits are white.


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
@pytest.mark.parametrize("size,orientation,height,rotated", [
    ((30, 40), "landscape", 432, "1"),
    ((40, 30), "portrait", 768, "1"),
    ((30, 40), "original", 768, "0"),
    ((40, 30), "landscape", 432, "0"),
])
async def test_without_dpi_fills_requested_width_after_orientation(
    auth_client, db_session, admin_user, kind, size, orientation, height, rotated, label_entity_id,
):
    client, _ = auth_client
    preset = LabelPreset(user_id=admin_user.id, preset_type=kind, name="Scaled",
                         name_key=label_preset_name_key("Scaled"), data={"version": 2, "design": {
                             "version": 2,
                             "label": {"widthMm": size[0], "heightMm": size[1], "marginMm": 1},
                             "elements": [],
                         }})
    db_session.add(preset)
    await db_session.commit()
    response = await client.get(
        f"/api/v1/labels/{kind}/{label_entity_id}/render?format=mono1"
        f"&width=576&preset_id={preset.id}&orientation={orientation}"
    )
    assert response.status_code == 200, response.text
    assert response.headers["x-content-width"] == "576"
    assert response.headers["x-image-height"] == str(height)
    assert response.headers["x-rotated"] == rotated
    assert len(response.content) == 72 * height
