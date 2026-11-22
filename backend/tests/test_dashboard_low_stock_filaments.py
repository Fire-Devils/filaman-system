import pytest
from sqlalchemy import select

from app.models import Filament, Manufacturer, Spool, SpoolStatus


async def _status(db, key):
    return (await db.execute(select(SpoolStatus).where(SpoolStatus.key == key))).scalar_one()


async def _filament(db, manufacturer_id, designation, threshold):
    filament = Filament(
        manufacturer_id=manufacturer_id,
        designation=designation,
        material_type="PETG",
        diameter_mm=1.75,
        low_stock_threshold_g=threshold,
    )
    db.add(filament)
    await db.commit()
    await db.refresh(filament)
    return filament


async def _spool(db, filament_id, status_key, remaining):
    status = await _status(db, status_key)
    db.add(
        Spool(
            filament_id=filament_id,
            status_id=status.id,
            initial_total_weight_g=1000.0,
            empty_spool_weight_g=250.0,
            remaining_weight_g=remaining,
        )
    )
    await db.commit()


async def _low(client):
    return (await client.get("/api/v1/dashboard/stats")).json()["low_stock_filaments"]


@pytest.mark.asyncio
async def test_low_stock_filaments_rules(auth_client, db_session):
    client, _ = auth_client
    maker = Manufacturer(name="Maker")
    db_session.add(maker)
    await db_session.commit()

    below = await _filament(db_session, maker.id, "Black PETG", 700)
    await _spool(db_session, below.id, "active", 300)
    await _spool(db_session, below.id, "active", 300)
    await _spool(db_session, below.id, "archived", 5000)
    await _spool(db_session, below.id, "empty", 5000)

    enough = await _filament(db_session, maker.id, "Enough", 700)
    await _spool(db_session, enough.id, "active", 400)
    await _spool(db_session, enough.id, "active", 300)

    off = await _filament(db_session, maker.id, "Off", None)
    await _spool(db_session, off.id, "active", 1)

    zero_threshold = await _filament(db_session, maker.id, "Zero threshold", 0)

    sealed = await _filament(db_session, maker.id, "Sealed", 700)
    await _spool(db_session, sealed.id, "new", 1000)

    no_spools = await _filament(db_session, maker.id, "No spools", 500)

    null_weight = await _filament(db_session, maker.id, "Null weight", 100)
    await _spool(db_session, null_weight.id, "active", None)

    items = await _low(client)
    by_id = {item["filament_id"]: item for item in items}
    assert set(by_id) == {below.id, no_spools.id, null_weight.id}
    assert zero_threshold.id not in by_id
    assert by_id[below.id]["total_remaining_g"] == 600
    assert by_id[below.id]["low_stock_threshold_g"] == 700
    assert by_id[below.id]["spool_count"] == 2
    assert by_id[below.id]["manufacturer_name"] == "Maker"
    assert by_id[no_spools.id]["total_remaining_g"] == 0
    assert by_id[no_spools.id]["spool_count"] == 0
    # ordered by ratio ascending: 0/500, 0/100 (ties by id), then 600/700
    assert items[-1]["filament_id"] == below.id


@pytest.mark.asyncio
async def test_low_stock_filaments_respects_limit(auth_client, db_session):
    client, _ = auth_client
    maker = Manufacturer(name="Maker")
    db_session.add(maker)
    await db_session.commit()
    for i in range(3):
        await _filament(db_session, maker.id, f"F{i}", 100)
    response = await client.get("/api/v1/dashboard/stats", params={"limit": 2})
    assert len(response.json()["low_stock_filaments"]) == 2


@pytest.mark.asyncio
async def test_low_stock_threshold_validation(auth_client, db_session):
    client, csrf = auth_client
    h = {"X-CSRF-Token": csrf}
    maker = Manufacturer(name="Maker")
    db_session.add(maker)
    await db_session.commit()
    body = {
        "manufacturer_id": maker.id,
        "designation": "X",
        "material_type": "PLA",
        "diameter_mm": 1.75,
    }
    assert (await client.post("/api/v1/filaments", headers=h, json={**body, "low_stock_threshold_g": -1})).status_code == 422
    created = await client.post("/api/v1/filaments", headers=h, json={**body, "low_stock_threshold_g": 700})
    assert created.status_code == 201, created.text
    assert created.json()["low_stock_threshold_g"] == 700
    fid = created.json()["id"]
    assert (await client.patch(f"/api/v1/filaments/{fid}", headers=h, json={"low_stock_threshold_g": -5})).status_code == 422
    cleared = await client.patch(f"/api/v1/filaments/{fid}", headers=h, json={"low_stock_threshold_g": None})
    assert cleared.status_code == 200
    assert cleared.json()["low_stock_threshold_g"] is None
