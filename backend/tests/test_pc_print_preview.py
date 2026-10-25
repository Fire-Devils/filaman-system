from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import select

from app.core.security import generate_token_secret, hash_token
from app.models import Filament, LabelPreset, LabelPrintRequest, Manufacturer, Spool, SpoolStatus, UserApiKey
from app.models.label_preset import label_preset_name_key
from app.services.label_preset_v1 import convert_label_preset_data


@pytest_asyncio.fixture
async def print_targets(db_session):
    manufacturer = Manufacturer(name="Print preview")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation="Grüße", material_type="PLA", diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    status = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "active"))
    spool = Spool(filament_id=filament.id, status_id=status.id)
    db_session.add(spool)
    await db_session.commit()
    return {"spool": spool.id, "filament": filament.id}


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
async def test_request_lasts_one_hour(auth_client, db_session, print_targets, kind):
    client, csrf = auth_client
    response = await client.post(f"/api/v1/labels/{kind}/{print_targets[kind]}/print-request", headers={"X-CSRF-Token": csrf})
    assert response.status_code == 201
    data = response.json()
    created = datetime.fromisoformat(data["created_at"].replace("Z", "+00:00"))
    expires = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
    assert expires - created == timedelta(hours=1)
    row = await db_session.get(LabelPrintRequest, data["id"])
    row.created_at = datetime.now(UTC) - timedelta(minutes=59)
    await db_session.commit()
    assert (await client.get("/api/v1/labels/print-requests/pending")).json()["id"] == row.id
    row.created_at = datetime.now(UTC) - timedelta(hours=1)
    await db_session.commit()
    assert (await client.get("/api/v1/labels/print-requests/pending")).json() is None
    assert (await client.get(f"/api/v1/labels/print-requests/{row.id}/preview")).status_code == 409
    assert (await client.post(f"/api/v1/labels/print-requests/{row.id}/claim", headers={"X-CSRF-Token": csrf})).status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
@pytest.mark.parametrize("size", [(40, 30), (30, 40), (100, 30)])
async def test_request_preview_matches_print_dimensions(auth_client, db_session, admin_user, print_targets, kind, size):
    client, csrf = auth_client
    data = convert_label_preset_data({"label": {"width": size[0], "height": size[1]}}, kind)
    preset = LabelPreset(user_id=admin_user.id, preset_type=kind, name="Preview", name_key=label_preset_name_key("Preview"), data=data)
    db_session.add(preset)
    await db_session.commit()
    response = await client.post(f"/api/v1/labels/{kind}/{print_targets[kind]}/print-request?preset_id={preset.id}", headers={"X-CSRF-Token": csrf})
    row_id = response.json()["id"]
    preview = await client.get(f"/api/v1/labels/print-requests/{row_id}/preview")
    assert preview.status_code == 200, preview.text[:200] if preview.status_code != 200 else ""
    assert preview.headers["content-type"] == "image/png"
    assert preview.headers["cache-control"] == "no-store"
    assert float(preview.headers["X-Label-Width-Mm"]) == size[0]
    assert float(preview.headers["X-Label-Height-Mm"]) == size[1]
    image = Image.open(BytesIO(preview.content))
    assert image.size == tuple(round(mm * 600 / 25.4) for mm in size)
    assert image.convert("L").getextrema()[0] < 200
    assert (await client.get("/api/v1/labels/print-requests/pending")).json()["id"] == row_id


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["spool", "filament"])
async def test_preview_is_owner_and_scope_restricted(auth_client, db_session, admin_user, normal_user, print_targets, kind):
    client, csrf = auth_client
    row = (await client.post(f"/api/v1/labels/{kind}/{print_targets[kind]}/print-request", headers={"X-CSRF-Token": csrf})).json()
    client.cookies.clear()
    for user, scope in [(normal_user, f"{kind}s:read"), (admin_user, "filaments:read" if kind == "spool" else "spools:read")]:
        secret = generate_token_secret()
        key = UserApiKey(user_id=user.id, name="Preview access", key_hash=hash_token(secret), scopes=[scope])
        db_session.add(key)
        await db_session.commit()
        response = await client.get(f'/api/v1/labels/print-requests/{row["id"]}/preview', headers={"Authorization": f"ApiKey uak.{key.id}.{secret}"})
        assert response.status_code == 409


@pytest.mark.asyncio
async def test_preview_rejects_oversized_output(auth_client, db_session, admin_user, print_targets):
    client, csrf = auth_client
    preset = LabelPreset(user_id=admin_user.id, preset_type="spool", name="Large", name_key=label_preset_name_key("Large"), data=convert_label_preset_data({"label": {"width": 300, "height": 200}}, "spool"))
    db_session.add(preset)
    await db_session.commit()
    row = (await client.post(f'/api/v1/labels/spool/{print_targets["spool"]}/print-request?preset_id={preset.id}', headers={"X-CSRF-Token": csrf})).json()
    response = await client.get(f'/api/v1/labels/print-requests/{row["id"]}/preview')
    assert response.status_code == 422
    assert "600 DPI" in response.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['spool', 'filament'])
async def test_pending_reports_waiting_labels_without_consuming_them(auth_client, print_targets, kind):
    client, csrf = auth_client
    first = (await client.post(f'/api/v1/labels/{kind}/{print_targets[kind]}/print-request', headers={'X-CSRF-Token': csrf})).json()
    assert (await client.get('/api/v1/labels/print-requests/pending')).json()['has_more'] is False
    other = 'filament' if kind == 'spool' else 'spool'
    second = (await client.post(f'/api/v1/labels/{other}/{print_targets[other]}/print-request', headers={'X-CSRF-Token': csrf})).json()
    pending = (await client.get('/api/v1/labels/print-requests/pending')).json()
    assert pending['id'] == first['id']
    assert pending['has_more'] is True
    await client.post(f"/api/v1/labels/print-requests/{first['id']}/claim", headers={'X-CSRF-Token': csrf})
    pending = (await client.get('/api/v1/labels/print-requests/pending')).json()
    assert pending['id'] == second['id']
    assert pending['has_more'] is False


@pytest.mark.asyncio
async def test_waiting_indicator_ignores_expired_unowned_and_unpermitted_requests(auth_client, db_session, admin_user, normal_user, print_targets):
    client, csrf = auth_client
    first = (await client.post(f"/api/v1/labels/spool/{print_targets['spool']}/print-request", headers={'X-CSRF-Token': csrf})).json()
    db_session.add_all([
        LabelPrintRequest(user_id=normal_user.id, spool_id=print_targets['spool']),
        LabelPrintRequest(user_id=admin_user.id, spool_id=print_targets['spool'], created_at=datetime.now(UTC) - timedelta(hours=2)),
        LabelPrintRequest(user_id=admin_user.id, filament_id=print_targets['filament']),
    ])
    secret = generate_token_secret()
    key = UserApiKey(user_id=admin_user.id, name='Spool queue', key_hash=hash_token(secret), scopes=['spools:read'])
    db_session.add(key)
    await db_session.commit()
    client.cookies.clear()
    headers = {'Authorization': f'ApiKey uak.{key.id}.{secret}'}
    pending = (await client.get('/api/v1/labels/print-requests/pending', headers=headers)).json()
    assert pending['id'] == first['id']
    assert pending['has_more'] is False
    db_session.add(LabelPrintRequest(user_id=admin_user.id, spool_id=print_targets['spool']))
    await db_session.commit()
    assert (await client.get('/api/v1/labels/print-requests/pending', headers=headers)).json()['has_more'] is True
