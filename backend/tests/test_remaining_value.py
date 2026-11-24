import pytest
from sqlalchemy import select

from app.models import Filament, Manufacturer, Spool, SpoolStatus


async def _status(db, key):
    return (await db.execute(select(SpoolStatus).where(SpoolStatus.key == key))).scalar_one()


async def _setup(db):
    maker = Manufacturer(name="ValueMaker")
    db.add(maker)
    await db.commit()
    known = Filament(manufacturer_id=maker.id, designation="Known", material_type="PLA", diameter_mm=1.75)
    unknown = Filament(manufacturer_id=maker.id, designation="Unknown", material_type="PLA", diameter_mm=1.75)
    db.add_all([known, unknown])
    await db.commit()
    active = await _status(db, "active")
    archived = await _status(db, "archived")
    db.add_all(
        [
            # half used: capacity 1000, 500 left -> 10.0
            Spool(filament_id=known.id, status_id=active.id, initial_total_weight_g=1250.0,
                  empty_spool_weight_g=250.0, remaining_weight_g=500.0, purchase_price=20.0),
            # no price -> 0
            Spool(filament_id=known.id, status_id=active.id, initial_total_weight_g=1250.0,
                  empty_spool_weight_g=250.0, remaining_weight_g=500.0),
            # unknown capacity -> full price
            Spool(filament_id=unknown.id, status_id=active.id, remaining_weight_g=300.0, purchase_price=15.0),
            # archived -> ignored
            Spool(filament_id=known.id, status_id=archived.id, initial_total_weight_g=1250.0,
                  empty_spool_weight_g=250.0, remaining_weight_g=500.0, purchase_price=100.0),
        ]
    )
    await db.commit()
    return maker


@pytest.mark.asyncio
async def test_dashboard_remaining_value(auth_client, db_session):
    client, _ = auth_client
    await _setup(db_session)
    data = (await client.get("/api/v1/dashboard/stats")).json()
    assert data["total_value_available"] == pytest.approx(35.0)
    assert data["remaining_value_available"] == pytest.approx(25.0)


@pytest.mark.asyncio
async def test_manufacturer_remaining_price(auth_client, db_session):
    client, _ = auth_client
    maker = await _setup(db_session)
    items = (await client.get("/api/v1/manufacturers")).json()["items"]
    row = next(i for i in items if i["id"] == maker.id)
    assert row["total_price_available"] == pytest.approx(35.0)
    assert row["remaining_price_available"] == pytest.approx(25.0)
