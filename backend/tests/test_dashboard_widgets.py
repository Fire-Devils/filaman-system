from datetime import datetime, timedelta, timezone

import pytest
from app.models import (
    Color,
    Filament,
    FilamentColor,
    Manufacturer,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    Spool,
    SpoolEvent,
    SpoolStatus,
)
from sqlalchemy import select

BASE = "/api/v1/dashboard"


def _ago(days):
    return datetime.now(timezone.utc) - timedelta(days=days)


async def _status(db, key):
    return (await db.execute(select(SpoolStatus).where(SpoolStatus.key == key))).scalar_one()


async def _filament(db, maker, designation="PLA Basic", material="PLA", hexes=()):
    filament = Filament(
        manufacturer_id=maker.id, designation=designation, material_type=material, diameter_mm=1.75
    )
    db.add(filament)
    await db.flush()
    for position, hex_code in enumerate(hexes):
        color = Color(name=f"c{filament.id}{position}", hex_code=hex_code)
        db.add(color)
        await db.flush()
        db.add(FilamentColor(filament_id=filament.id, color_id=color.id, position=position))
    await db.flush()
    return filament


async def _spool(db, filament, status="active", remaining=500.0, price=20.0, **fields):
    spool = Spool(
        filament_id=filament.id,
        status_id=(await _status(db, status)).id,
        purchase_price=price,
        initial_total_weight_g=1000.0,
        empty_spool_weight_g=0.0,
        remaining_weight_g=remaining,
        **fields,
    )
    db.add(spool)
    await db.flush()
    return spool


def _use(spool_id, days_ago, grams, filament_id=None):
    return SpoolEvent(
        spool_id=spool_id,
        filament_id=filament_id,
        event_type="print_consumption",
        event_at=_ago(days_ago),
        delta_weight_g=-grams,
    )


async def _maker(db):
    maker = Manufacturer(name="Acme")
    db.add(maker)
    await db.flush()
    return maker


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["stale-spools", "top-consumers", "stock-range", "printer-slots"])
async def test_requires_login(client, path):
    assert (await client.get(f"{BASE}/{path}")).status_code == 401


@pytest.mark.asyncio
async def test_stale_spools_threshold_never_used_and_archived(auth_client, db_session):
    client, _ = auth_client
    maker = await _maker(db_session)
    filament = await _filament(db_session, maker, hexes=["#FF0000"])
    # Used 8 months ago -> stale at 6 months, not at 12.
    old_use = await _spool(db_session, filament, remaining=400.0, price=20.0)
    # Used 2 months ago -> never stale.
    recent_use = await _spool(db_session, filament, remaining=300.0, purchase_date=_ago(400))
    # Never used, bought 300 days ago -> stale at 6 months only.
    never_old = await _spool(db_session, filament, remaining=1000.0, price=30.0, purchase_date=_ago(300))
    # Never used, bought yesterday -> not stale.
    never_new = await _spool(db_session, filament, remaining=1000.0, purchase_date=_ago(1))
    # Never used, no dates but created long ago -> falls back to created_at.
    created_old = await _spool(db_session, filament, remaining=100.0, price=None)
    created_old.created_at = _ago(500)
    # Stale but archived or empty -> excluded.
    archived = await _spool(db_session, filament, status="archived", remaining=500.0, purchase_date=_ago(900))
    empty = await _spool(db_session, filament, remaining=0.0, purchase_date=_ago(900))
    db_session.add_all(
        [
            _use(old_use.id, 240, 50),
            _use(old_use.id, 300, 80),
            _use(recent_use.id, 60, 10),
        ]
    )
    await db_session.commit()

    data = (await client.get(f"{BASE}/stale-spools", params={"months": 6})).json()
    ids = [item["spool_id"] for item in data["items"]]
    assert set(ids) == {old_use.id, never_old.id, created_old.id}
    assert archived.id not in ids and empty.id not in ids
    assert never_new.id not in ids and recent_use.id not in ids
    # Oldest reference first: created 500 d ago, then used 240 d ago... then bought 300 d ago.
    assert ids == [created_old.id, never_old.id, old_use.id]
    by_id = {item["spool_id"]: item for item in data["items"]}
    assert by_id[old_use.id]["last_used_at"] is not None
    assert by_id[never_old.id]["last_used_at"] is None
    assert by_id[old_use.id]["colors"] == ["#FF0000"]
    assert by_id[old_use.id]["manufacturer_name"] == "Acme"
    # Pro-rata value like the dashboard tile: 400/1000 * 20 and 1000/1000 * 30; one price unknown.
    assert by_id[old_use.id]["remaining_value"] == 8.0
    assert by_id[created_old.id]["remaining_value"] is None
    assert data["total_count"] == 3
    assert data["total_weight_g"] == 1500.0
    assert data["total_value"] == 38.0
    assert data["unknown_value_count"] == 1

    twelve = (await client.get(f"{BASE}/stale-spools", params={"months": 12})).json()
    assert {item["spool_id"] for item in twelve["items"]} == {created_old.id}
    assert (await client.get(f"{BASE}/stale-spools", params={"months": 0})).status_code == 422


@pytest.mark.asyncio
async def test_stale_spools_empty(auth_client):
    client, _ = auth_client
    data = (await client.get(f"{BASE}/stale-spools")).json()
    assert data["items"] == [] and data["total_count"] == 0 and data["total_weight_g"] == 0


@pytest.mark.asyncio
async def test_top_consumers_includes_deleted_spool_and_window(auth_client, db_session):
    client, _ = auth_client
    maker = await _maker(db_session)
    red = await _filament(db_session, maker, "Red", hexes=["#FF0000"])
    blue = await _filament(db_session, maker, "Blue", "PETG", hexes=["#0000FF"])
    green = await _filament(db_session, maker, "Green")
    red_spool = await _spool(db_session, red)
    await _spool(db_session, red, status="archived")
    blue_spool = await _spool(db_session, blue)
    db_session.add_all(
        [
            _use(red_spool.id, 10, 100),
            _use(red_spool.id, 40, 50),
            # Deleted spool: spool_id gone, filament_id kept on the event.
            _use(None, 20, 400, filament_id=red.id),
            _use(blue_spool.id, 5, 300),
            # Outside the 90 day window and a non-consumption event.
            _use(blue_spool.id, 120, 9999),
            SpoolEvent(
                spool_id=blue_spool.id, event_type="manual_adjust",
                event_at=_ago(1), delta_weight_g=-9999.0,
            ),
            # Deleted spool whose filament is gone too cannot be attributed.
            _use(None, 3, 777),
        ]
    )
    await db_session.commit()

    data = (await client.get(f"{BASE}/top-consumers")).json()
    assert data["days"] == 90
    assert [(i["filament_designation"], i["consumed_g"]) for i in data["items"]] == [
        ("Red", 550.0),
        ("Blue", 300.0),
    ]
    red_item = data["items"][0]
    assert red_item["colors"] == ["#FF0000"]
    assert red_item["material_type"] == "PLA"
    assert red_item["manufacturer_name"] == "Acme"
    # Only the active spool counts as stock; the archived one does not.
    assert red_item["spools_in_stock"] == 1
    assert green.id not in {i["filament_id"] for i in data["items"]}

    short = (await client.get(f"{BASE}/top-consumers", params={"days": 7})).json()
    assert [i["filament_designation"] for i in short["items"]] == ["Blue"]
    limited = (await client.get(f"{BASE}/top-consumers", params={"limit": 1})).json()
    assert len(limited["items"]) == 1


@pytest.mark.asyncio
async def test_stock_range_calculation(auth_client, db_session):
    client, _ = auth_client
    maker = await _maker(db_session)
    pla = await _filament(db_session, maker, "PLA", "PLA")
    petg = await _filament(db_session, maker, "PETG", "PETG")
    asa = await _filament(db_session, maker, "ASA", "ASA")
    pla_spool = await _spool(db_session, pla, remaining=900.0)
    await _spool(db_session, pla, remaining=100.0)
    await _spool(db_session, pla, status="archived", remaining=5000.0)
    await _spool(db_session, petg, remaining=250.0)
    await _spool(db_session, asa, remaining=800.0)
    db_session.add_all(
        [
            # PLA: 900 g used in 90 d = 10 g/day, 1000 g left -> 100 days.
            _use(pla_spool.id, 10, 500),
            _use(None, 30, 400, filament_id=pla.id),
            # PETG: 90 g used -> 1 g/day, 250 g left -> 250 days.
            _use(pla_spool.id, 5, 90, filament_id=petg.id),
            # Outside the window, must not count.
            _use(pla_spool.id, 200, 5000),
        ]
    )
    # A spool of petg gets the PETG consumption, ASA has none.
    await db_session.commit()
    petg_spool = (await db_session.execute(select(Spool).where(Spool.filament_id == petg.id))).scalar_one()
    event = (
        await db_session.execute(select(SpoolEvent).where(SpoolEvent.delta_weight_g == -90.0))
    ).scalar_one()
    event.spool_id = petg_spool.id
    await db_session.commit()

    data = (await client.get(f"{BASE}/stock-range")).json()
    assert data["days"] == 90
    rows = {i["material_type"]: i for i in data["items"]}
    assert rows["PLA"] == {"material_type": "PLA", "remaining_g": 1000.0, "consumed_g": 900.0, "days_left": 100.0}
    assert rows["PETG"]["days_left"] == 250.0
    assert rows["ASA"] == {"material_type": "ASA", "remaining_g": 800.0, "consumed_g": 0.0, "days_left": None}
    # Shortest range first, no consumption last.
    assert [i["material_type"] for i in data["items"]] == ["PLA", "PETG", "ASA"]


@pytest.mark.asyncio
async def test_stock_range_without_stock_but_consumption(auth_client, db_session):
    client, _ = auth_client
    maker = await _maker(db_session)
    filament = await _filament(db_session, maker, "Nylon", "PA")
    spool = await _spool(db_session, filament, remaining=0.0)
    db_session.add(_use(spool.id, 10, 90))
    await db_session.commit()
    (item,) = (await client.get(f"{BASE}/stock-range")).json()["items"]
    assert item["remaining_g"] == 0.0 and item["days_left"] == 0.0


@pytest.mark.asyncio
async def test_printer_slots(auth_client, db_session):
    client, _ = auth_client
    assert (await client.get(f"{BASE}/printer-slots")).json() == {"printers": []}

    maker = await _maker(db_session)
    filament = await _filament(db_session, maker, "Silk", "PLA", hexes=["#112233", "#445566"])
    spool = await _spool(db_session, filament, remaining=640.0)
    printer = Printer(name="Alpha", driver_key="bambu_mqtt")
    gone = Printer(name="Removed", driver_key="bambu_mqtt", deleted_at=_ago(1))
    db_session.add_all([printer, gone])
    await db_session.flush()
    full = PrinterSlot(printer_id=printer.id, slot_no=1, name="AMS A1")
    empty = PrinterSlot(printer_id=printer.id, slot_no=2)
    unassigned = PrinterSlot(printer_id=printer.id, slot_no=3)
    inactive = PrinterSlot(printer_id=printer.id, slot_no=4, is_active=False)
    hidden = PrinterSlot(printer_id=gone.id, slot_no=1)
    db_session.add_all([full, empty, unassigned, inactive, hidden])
    await db_session.flush()
    db_session.add_all(
        [
            PrinterSlotAssignment(slot_id=full.id, spool_id=spool.id, present=True),
            PrinterSlotAssignment(slot_id=empty.id, spool_id=None, present=False),
        ]
    )
    await db_session.commit()

    data = (await client.get(f"{BASE}/printer-slots")).json()
    assert [p["printer_name"] for p in data["printers"]] == ["Alpha"]
    slots = data["printers"][0]["slots"]
    assert [s["slot_no"] for s in slots] == [1, 2, 3]
    assert slots[0]["spool_id"] == spool.id
    assert slots[0]["name"] == "AMS A1"
    assert slots[0]["colors"] == ["#112233", "#445566"]
    assert slots[0]["material_type"] == "PLA"
    assert slots[0]["manufacturer_name"] == "Acme"
    assert slots[0]["remaining_weight_g"] == 640.0
    for slot in slots[1:]:
        assert slot["spool_id"] is None and slot["colors"] == [] and slot["remaining_weight_g"] is None
