from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import event, select

from app.core.security import generate_token_secret, hash_token
from app.models import (
    Color,
    Filament,
    LabelPreset,
    LabelPrintRequest,
    Manufacturer,
    Spool,
    SpoolStatus,
    UserApiKey,
)
from app.models.label_preset import label_preset_name_key


@pytest.mark.asyncio
async def test_queue_permissions_are_resolved_once(db_session, normal_user):
    from app.api.v1.labels import _permitted_print_targets
    from app.core.security import Principal

    queries = []
    engine = db_session.bind.sync_engine

    def record_query(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(engine, "before_cursor_execute", record_query)
    try:
        await _permitted_print_targets(db_session, Principal(
            auth_type="session", user_id=normal_user.id, is_superadmin=False, scopes=None,
        ))
    finally:
        event.remove(engine, "before_cursor_execute", record_query)
    # One load of the user, roles and permissions; not one load per target type.
    assert len(queries) == 3


@pytest_asyncio.fixture
async def filament_labels(db_session, admin_user, normal_user):
    manufacturer = Manufacturer(name="Filament label maker")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation="Grüße PLA",
                        material_type="PLA", diameter_mm=1.75,
                        custom_fields={"article": "SKU-42"})
    db_session.add(filament)
    presets = []
    for kind, owner, name, size in (
        ("spool", admin_user.id, "Spool selected", (60, 40)),
        ("filament", admin_user.id, "Filament selected", (50, 25)),
        ("filament", normal_user.id, "Other filament", (40, 20)),
    ):
        preset = LabelPreset(user_id=owner, preset_type=kind, name=name,
                             name_key=label_preset_name_key(name), selected=True,
                             data={"version": 2, "design": {"version": 2,
                                   "label": {"widthMm": size[0], "heightMm": size[1], "marginMm": 1, "border": False},
                                   "elements": [{"id": "text", "type": "text", "x": 1, "y": 1,
                                                 "w": size[0] - 2, "h": size[1] - 2, "z": 0,
                                                 "template": "{filament.name} {extra.filament.article}",
                                                 "fontSizeMm": 3, "fontFamily": "Space Grotesk",
                                                 "fontWeight": 400, "wrap": True}]}})
        db_session.add(preset)
        presets.append(preset)
    await db_session.commit()
    return filament, presets


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
async def test_selection_by_type_drives_render_and_print_without_changing_other_type(
    auth_client, db_session, filament_labels, kind,
):
    client, csrf = auth_client
    filament, presets = filament_labels
    target = presets[0 if kind == "spool" else 1]
    other = presets[1 if kind == "spool" else 0]
    target.selected = False
    entity = filament
    if kind == "spool":
        status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
        entity = Spool(filament_id=filament.id, status_id=status.id)
        db_session.add(entity)
    await db_session.commit()
    headers = {"X-CSRF-Token": csrf}
    selection = "/api/v1/me/label-presets/selection"
    for preset_id in (target.id, None):
        response = await client.put(selection, headers=headers, json={"preset_id": preset_id, "preset_type": kind})
        assert response.status_code == 204, response.text
        await db_session.refresh(target)
        await db_session.refresh(other)
        assert target.selected is (preset_id is not None)
        assert other.selected is True
        render = await client.get(f"/api/v1/labels/{kind}/{entity.id}/render")
        assert render.status_code == 200, render.text
        assert render.headers["x-preset-id"] == str(preset_id or 0)
        queued = await client.post(f"/api/v1/labels/{kind}/{entity.id}/print-request", headers=headers)
        assert queued.status_code == 201, queued.text
        assert queued.json()["preset_id"] == preset_id


@pytest.mark.asyncio
async def test_filament_selection_enforces_scope_owner_and_type(client, db_session, admin_user, filament_labels):
    _, presets = filament_labels
    path = "/api/v1/me/label-presets/selection"
    for scope in ("spools:read", "filaments:read"):
        secret = generate_token_secret()
        key = UserApiKey(user_id=admin_user.id, name=scope, key_hash=hash_token(secret), scopes=[scope])
        db_session.add(key)
        await db_session.commit()
        headers = {"Authorization": f"ApiKey uak.{key.id}.{secret}"}
        response = await client.put(path, headers=headers, json={"preset_id": presets[1].id, "preset_type": "filament"})
        assert response.status_code == (204 if scope == "filaments:read" else 403), response.text
        if scope == "filaments:read":
            for invalid_id in (presets[0].id, presets[2].id, 999999):
                assert (await client.put(path, headers=headers, json={"preset_id": invalid_id, "preset_type": "filament"})).status_code == 404
            assert (await client.put(path, headers=headers, json={"preset_id": None})).status_code == 403
            assert (await client.put(path, headers=headers, json={"preset_id": None, "preset_type": "sheet"})).status_code == 422
    await db_session.refresh(presets[1])
    assert presets[1].selected is True


@pytest.mark.asyncio
async def test_filament_print_request_selects_own_preset_and_is_claimed_once(auth_client, filament_labels):
    client, csrf = auth_client
    filament, presets = filament_labels
    headers = {"X-CSRF-Token": csrf}
    path = f"/api/v1/labels/filament/{filament.id}/print-request"
    for query, preset_id in (("", presets[1].id), ("?preset_id=0", None),
                             (f"?preset_id={presets[1].id}", presets[1].id)):
        response = await client.post(path + query, headers=headers)
        assert response.status_code == 201, response.text
        expected = {"id": response.json()["id"], "filament_id": filament.id, "preset_id": preset_id}
        assert response.json() == expected
        assert (await client.get("/api/v1/labels/print-requests/pending")).json() == expected
        claim = f"/api/v1/labels/print-requests/{expected['id']}/claim"
        assert (await client.post(claim, headers=headers)).status_code == 204
        assert (await client.post(claim, headers=headers)).status_code == 409
        assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None


@pytest.mark.asyncio
async def test_filament_print_request_rejects_wrong_owner_type_missing_and_invalid_presets(
    auth_client, db_session, filament_labels,
):
    client, csrf = auth_client
    filament, presets = filament_labels
    headers = {"X-CSRF-Token": csrf}
    path = f"/api/v1/labels/filament/{filament.id}/print-request"
    for preset_id in (presets[0].id, presets[2].id, 999999):
        assert (await client.post(f"{path}?preset_id={preset_id}", headers=headers)).status_code == 404
    assert (await client.post(path + "?preset_id=-1", headers=headers)).status_code == 422
    assert (await client.post("/api/v1/labels/filament/999999/print-request", headers=headers)).status_code == 404
    presets[1].data = {"version": 2, "design": {}}
    await db_session.commit()
    assert (await client.post(path, headers=headers)).status_code == 422
    assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None


@pytest.mark.asyncio
async def test_filament_print_request_defaults_without_selection_and_expires(auth_client, db_session, filament_labels):
    client, csrf = auth_client
    filament, presets = filament_labels
    presets[1].selected = False
    await db_session.commit()
    response = await client.post(f"/api/v1/labels/filament/{filament.id}/print-request", headers={"X-CSRF-Token": csrf})
    assert response.status_code == 201, response.text
    assert response.json()["preset_id"] is None
    queued = await db_session.get(LabelPrintRequest, response.json()["id"])
    queued.created_at = datetime.now(UTC) - timedelta(minutes=6)
    await db_session.commit()
    assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None
    assert (await client.post(f"/api/v1/labels/print-requests/{queued.id}/claim", headers={"X-CSRF-Token": csrf})).status_code == 409


@pytest.mark.asyncio
async def test_print_request_queue_filters_by_scope_and_owner(client, db_session, admin_user, normal_user, filament_labels):
    filament, _ = filament_labels
    status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
    spool = Spool(filament_id=filament.id, status_id=status.id)
    db_session.add(spool)
    await db_session.flush()
    older = LabelPrintRequest(user_id=admin_user.id, spool_id=spool.id)
    db_session.add(older)
    await db_session.commit()
    headers = {}
    for kind, owner, scopes in (("filament", admin_user.id, ["filaments:read"]),
                                ("spool", admin_user.id, ["spools:read"]),
                                ("other", normal_user.id, ["filaments:read"]),
                                ("none", admin_user.id, [])):
        secret = generate_token_secret()
        key = UserApiKey(user_id=owner, name=kind, key_hash=hash_token(secret), scopes=scopes)
        db_session.add(key)
        await db_session.commit()
        headers[kind] = {"Authorization": f"ApiKey uak.{key.id}.{secret}"}
    path = f"/api/v1/labels/filament/{filament.id}/print-request"
    assert (await client.post(path, headers=headers["spool"])).status_code == 403
    response = await client.post(path, headers=headers["filament"])
    assert response.status_code == 201, response.text
    request_id = response.json()["id"]
    pending = "/api/v1/labels/print-requests/pending"
    assert (await client.get(pending, headers=headers["filament"])).json() == response.json()
    assert (await client.get(pending, headers=headers["spool"])).json()["spool_id"] == spool.id
    assert (await client.get(pending, headers=headers["other"])).json() is None
    assert (await client.get(pending, headers=headers["none"])).status_code == 403
    claim = f"/api/v1/labels/print-requests/{request_id}/claim"
    for kind in ("spool", "other"):
        assert (await client.post(claim, headers=headers[kind])).status_code == 409
    assert (await client.post(claim, headers=headers["none"])).status_code == 403
    assert (await client.post(claim, headers=headers["filament"])).status_code == 204
    assert (await client.post(f"/api/v1/labels/print-requests/{older.id}/claim", headers=headers["filament"])).status_code == 409


@pytest.mark.asyncio
async def test_filament_uses_own_selected_preset_and_default(auth_client, filament_labels):
    client, _ = auth_client
    filament, presets = filament_labels
    path = f"/api/v1/labels/filament/{filament.id}/render?width=481"
    selected = await client.get(path)
    assert selected.status_code == 200, selected.text
    assert selected.headers["x-preset-id"] == str(presets[1].id)
    assert "x-renderer" not in selected.headers
    assert Image.open(BytesIO(selected.content)).size == (481, 240)
    default = await client.get(path + "&preset_id=0")
    assert default.status_code == 200, default.text
    assert default.headers["x-preset-id"] == "0"
    assert Image.open(BytesIO(default.content)).size == (481, 321)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
async def test_label_swatch_colors_follow_position_not_request_order(
    auth_client, db_session, filament_labels, kind,
):
    client, csrf_token = auth_client
    filament, presets = filament_labels
    blue = Color(name="Second blue", hex_code="#0000FF")
    red = Color(name="First red", hex_code="#FF0000")
    db_session.add_all([blue, red])
    await db_session.flush()
    entity = filament
    if kind == "spool":
        status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
        entity = Spool(filament_id=filament.id, status_id=status.id)
        db_session.add(entity)
    preset = presets[0 if kind == "spool" else 1]
    preset.data = {"version": 2, "design": {"version": 2,
        "label": {"widthMm": 50, "heightMm": 25, "marginMm": 0, "border": False},
        "elements": [{"id": "swatch", "type": "swatch", "x": 0, "y": 0,
                      "w": 50, "h": 25, "z": 0}],
    }}
    await db_session.commit()
    saved = await client.put(f"/api/v1/filaments/{filament.id}/colors", headers={"X-CSRF-Token": csrf_token}, json={
        "color_mode": "multi", "multi_color_style": "striped",
        "colors": [{"color_id": blue.id, "position": 2}, {"color_id": red.id, "position": 1}],
    })
    assert saved.status_code == 200, saved.text

    response = await client.get(
        f"/api/v1/labels/{kind}/{entity.id}/render?width=500&color=color&preset_id={preset.id}"
    )

    assert response.status_code == 200, response.text
    image = Image.open(BytesIO(response.content)).convert("RGB")
    assert image.getpixel((100, 125)) == (255, 0, 0)
    assert image.getpixel((400, 125)) == (0, 0, 255)


@pytest.mark.asyncio
async def test_filament_mono1_shares_finishing_contract(auth_client, filament_labels):
    client, _ = auth_client
    filament, presets = filament_labels
    path = (f"/api/v1/labels/filament/{filament.id}/render?width=481&format=mono1"
            f"&dpi=100&orientation=portrait&align=right")
    response = await client.get(path + "&threshold=0")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-image-width"] == "481"
    assert response.headers["x-image-height"] == "197"
    assert response.headers["x-content-width"] == "98"
    assert response.headers["x-rotated"] == "1"
    assert response.headers["x-row-bytes"] == "61"
    assert response.headers["x-bit-order"] == "msb-black-1"
    assert response.headers["x-preset-id"] == str(presets[1].id)
    assert len(response.content) == 61 * 197
    assert not any(response.content)
    black = await client.get(path + "&threshold=255")
    assert black.status_code == 200, black.text
    assert any(black.content)
    assert all(value & 127 == 0 for value in black.content[60::61])
    assert "no-store" in black.headers["cache-control"]


@pytest.mark.asyncio
async def test_filament_rejects_spool_or_other_users_presets(auth_client, filament_labels):
    client, _ = auth_client
    filament, presets = filament_labels
    for preset in (presets[0], presets[2]):
        response = await client.get(f"/api/v1/labels/filament/{filament.id}/render?preset_id={preset.id}")
        assert response.status_code == 404
        assert "no-store" in response.headers["cache-control"]


@pytest.mark.asyncio
@pytest.mark.parametrize("query,status", [("", 404), ("?width=1", 422), ("?threshold=256", 422),
                                          ("?format=mono1&color=color", 422)])
async def test_filament_errors_are_not_cached(auth_client, query, status):
    client, _ = auth_client
    response = await client.get("/api/v1/labels/filament/999999/render" + query)
    assert response.status_code == status
    assert "no-store" in response.headers["cache-control"]


@pytest.mark.asyncio
async def test_filament_requires_auth(client):
    response = await client.get("/api/v1/labels/filament/1/render")
    assert response.status_code == 401
    assert "no-store" in response.headers["cache-control"]


@pytest.mark.asyncio
async def test_filament_presets_and_render_require_filament_scope(client, db_session, admin_user, filament_labels):
    filament, presets = filament_labels
    for scopes in (["filaments:read"], ["spools:read"]):
        secret = generate_token_secret()
        key = UserApiKey(user_id=admin_user.id, name="Labels", key_hash=hash_token(secret), scopes=scopes)
        db_session.add(key)
        await db_session.commit()
        headers = {"Authorization": f"ApiKey uak.{key.id}.{secret}"}
        listing = await client.get("/api/v1/labels/presets?preset_type=filament", headers=headers)
        rendered = await client.get(f"/api/v1/labels/filament/{filament.id}/render", headers=headers)
        if scopes == ["filaments:read"]:
            assert listing.status_code == rendered.status_code == 200
            assert listing.json() == [{"id": presets[1].id, "name": "Filament selected", "selected": True,
                                       "width_mm": 50, "height_mm": 25}]
            assert (await client.get("/api/v1/labels/presets", headers=headers)).status_code == 403
        else:
            assert listing.status_code == rendered.status_code == 403
            assert (await client.get("/api/v1/labels/presets", headers=headers)).json() == [
                {"id": presets[0].id, "name": "Spool selected", "selected": True, "width_mm": 60, "height_mm": 40}]
