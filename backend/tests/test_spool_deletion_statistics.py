"""Permanent deletion keeps statistics; daily snapshots equal the dashboard tiles."""

from datetime import date, datetime, timezone

import pytest
import pytest_asyncio
from app.models import (
    Filament,
    InventorySnapshot,
    Manufacturer,
    Spool,
    SpoolEvent,
    SpoolStatus,
)
from app.services.inventory_snapshots import current_inventory, record_inventory_snapshot
from app.services.spool_deletion import SPOOL_DELETED_EVENT
from sqlalchemy import func, select, text

ANALYTICS = "/api/v1/analytics/summary"
STATS = "/api/v1/dashboard/stats?include_totals=true&include_valuation=true"
PARAMS = {"from": "2026-01-01", "to": "2026-03-31"}


@pytest_asyncio.fixture
async def fk_on(db_session):
    """The test engine has no FK pragma; production enables it for every connection."""
    await db_session.commit()
    await db_session.execute(text("PRAGMA foreign_keys=ON"))
    yield
    await db_session.commit()
    await db_session.execute(text("PRAGMA foreign_keys=OFF"))


async def _spool(db, status_key="new", price=20.0, remaining=500.0, purchase=None, material="PLA"):
    maker = await db.scalar(select(Manufacturer).where(Manufacturer.name == "Acme"))
    if maker is None:
        maker = Manufacturer(name="Acme")
        db.add(maker)
        await db.flush()
    filament = Filament(
        manufacturer_id=maker.id, designation=material, material_type=material,
        diameter_mm=1.75, raw_material_weight_g=1000.0,
    )
    db.add(filament)
    await db.flush()
    status = await db.scalar(select(SpoolStatus).where(SpoolStatus.key == status_key))
    spool = Spool(
        filament_id=filament.id, status_id=status.id, purchase_price=price,
        initial_total_weight_g=1000.0, empty_spool_weight_g=0.0, remaining_weight_g=remaining,
        purchase_date=purchase,
    )
    db.add(spool)
    await db.flush()
    return spool


def _consumption(spool, grams, when):
    return SpoolEvent(
        spool_id=spool.id, filament_id=spool.filament_id, event_type="print_consumption",
        event_at=when, delta_weight_g=-grams,
    )


@pytest.mark.asyncio
async def test_snapshot_equals_dashboard_tiles(auth_client, db_session):
    client, _ = auth_client
    await _spool(db_session, price=20.0, remaining=500.0)
    await _spool(db_session, "active", price=10.0, remaining=250.0)
    await _spool(db_session, "archived", price=99.0, remaining=900.0)
    await db_session.commit()

    snap = await record_inventory_snapshot(db_session, date(2026, 5, 4))
    stats = (await client.get(STATS)).json()

    assert snap.spool_count == stats["spool_count_total"] == 2
    assert snap.stock_value == pytest.approx(stats["valuation"]["remaining_value"])
    assert snap.stock_value == pytest.approx(10.0 + 2.5)
    assert snap.total_weight_g == 750.0
    assert snap.purchase_value == pytest.approx(stats["total_value_available"])
    totals = await current_inventory(db_session)
    assert (totals.spool_count, totals.total_weight_g) == (2, 750.0)


@pytest.mark.asyncio
async def test_snapshot_is_upserted_per_day(db_session):
    spool = await _spool(db_session, remaining=500.0)
    await db_session.commit()
    day = date(2026, 5, 4)
    await record_inventory_snapshot(db_session, day)
    spool.remaining_weight_g = 100.0
    await db_session.commit()
    await record_inventory_snapshot(db_session, day)
    rows = (await db_session.execute(select(InventorySnapshot))).scalars().all()
    assert len(rows) == 1 and rows[0].total_weight_g == 100.0
    await record_inventory_snapshot(db_session, date(2026, 5, 5))
    assert await db_session.scalar(select(func.count(InventorySnapshot.id))) == 2


@pytest.mark.asyncio
async def test_permanent_delete_keeps_events_and_records_deletion(auth_client, db_session, fk_on):
    client, csrf = auth_client
    spool = await _spool(db_session, purchase=datetime(2026, 2, 10, tzinfo=timezone.utc))
    spool_id, filament_id = spool.id, spool.filament_id
    db_session.add(SpoolEvent(
        spool_id=spool_id, event_type="print_consumption",  # no filament_id: legacy event
        event_at=datetime(2026, 2, 20, tzinfo=timezone.utc), delta_weight_g=-50.0,
    ))
    await db_session.commit()

    resp = await client.delete(f"/api/v1/spools/{spool_id}/permanent", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 204

    assert await db_session.scalar(select(Spool).where(Spool.id == spool_id)) is None
    events = (await db_session.execute(select(SpoolEvent).order_by(SpoolEvent.id))).scalars().all()
    assert {e.event_type for e in events} == {"print_consumption", SPOOL_DELETED_EVENT}
    assert all(e.spool_id is None and e.filament_id == filament_id for e in events)
    deleted = next(e for e in events if e.event_type == SPOOL_DELETED_EVENT)
    assert deleted.meta["purchase_price"] == 20.0
    assert deleted.meta["purchase_date"].startswith("2026-02-10")
    assert deleted.meta["remaining_weight_g"] == 500.0
    assert (deleted.meta["manufacturer"], deleted.meta["material"]) == ("Acme", "PLA")


@pytest.mark.asyncio
async def test_bulk_permanent_delete_keeps_events(auth_client, db_session, fk_on):
    client, csrf = auth_client
    one, two = await _spool(db_session), await _spool(db_session)
    ids = [one.id, two.id]
    db_session.add(_consumption(one, 10, datetime(2026, 2, 1, tzinfo=timezone.utc)))
    await db_session.commit()
    resp = await client.request(
        "DELETE", "/api/v1/spools/bulk", json={"spool_ids": ids, "permanent": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert resp.status_code == 200 and resp.json()["count"] == 2
    events = (await db_session.execute(select(SpoolEvent))).scalars().all()
    assert sorted(e.event_type for e in events) == ["print_consumption"] + [SPOOL_DELETED_EVENT] * 2
    assert all(e.spool_id is None for e in events)


@pytest.mark.asyncio
async def test_force_deleting_a_filament_keeps_spool_events(auth_client, db_session, fk_on):
    client, csrf = auth_client
    spool = await _spool(db_session)
    filament_id = spool.filament_id
    db_session.add(_consumption(spool, 10, datetime(2026, 2, 1, tzinfo=timezone.utc)))
    await db_session.commit()
    resp = await client.delete(
        f"/api/v1/filaments/{filament_id}", params={"force": "true"}, headers={"X-CSRF-Token": csrf}
    )
    assert resp.status_code == 204
    events = (await db_session.execute(select(SpoolEvent))).scalars().all()
    assert sorted(e.event_type for e in events) == ["print_consumption", SPOOL_DELETED_EVENT]
    assert all(e.spool_id is None and e.filament_id is None for e in events)


@pytest.mark.asyncio
async def test_analytics_counts_deleted_spools_exactly_once(auth_client, db_session, fk_on):
    client, csrf = auth_client
    keep = await _spool(db_session, price=10.0, material="PETG", purchase=datetime(2026, 2, 5, tzinfo=timezone.utc))
    gone = await _spool(db_session, price=30.0, purchase=datetime(2026, 2, 6, tzinfo=timezone.utc))
    db_session.add_all([
        _consumption(keep, 100, datetime(2026, 2, 7, tzinfo=timezone.utc)),
        _consumption(gone, 200, datetime(2026, 2, 8, tzinfo=timezone.utc)),
    ])
    await db_session.commit()
    before = (await client.get(ANALYTICS, params=PARAMS)).json()

    resp = await client.delete(f"/api/v1/spools/{gone.id}/permanent", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 204
    after = (await client.get(ANALYTICS, params=PARAMS)).json()

    assert after["totals"] == before["totals"]
    assert after["totals"]["weight_g"] == 300.0
    assert after["consumption_by_material"] == before["consumption_by_material"]
    assert {m["material_type"]: m["weight_g"] for m in after["consumption_by_material"]} == {
        "PLA": 200.0, "PETG": 100.0,
    }
    assert after["purchases"] == before["purchases"]
    assert after["purchases"]["total"] == 40.0
    assert after["purchases"]["by_material"] == {"PLA": 30.0, "PETG": 10.0}
    # Deleting again changes nothing; the keeper is still a normal spool purchase.
    assert (await client.get(ANALYTICS, params=PARAMS)).json()["purchases"]["total"] == 40.0
