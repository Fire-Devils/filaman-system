from datetime import date, datetime, timezone

import pytest
from app.models import Filament, InventorySnapshot, Manufacturer, Spool, SpoolEvent, SpoolStatus
from sqlalchemy import select

URL = "/api/v1/dashboard/history"
PREFS = "/api/v1/me/preferences"


def _month(offset):
    today = datetime.now(timezone.utc).date()
    index = today.year * 12 + today.month - 1 + offset
    return date(index // 12, index % 12 + 1, 1)


def _at(offset):
    start = _month(offset)
    return datetime(start.year, start.month, start.day, 6, tzinfo=timezone.utc)


async def _status(db, key):
    return (await db.execute(select(SpoolStatus).where(SpoolStatus.key == key))).scalar_one()


async def _fixture(db):
    maker = Manufacturer(name="Acme")
    db.add(maker)
    await db.flush()
    filament = Filament(
        manufacturer_id=maker.id, designation="PLA", material_type="PLA", diameter_mm=1.75
    )
    db.add(filament)
    await db.flush()
    active = await _status(db, "active")
    archived = await _status(db, "archived")
    # A: capacity 1000 g, price 20, bought two months ago, 600 g left now.
    a = Spool(
        filament_id=filament.id, status_id=active.id, purchase_price=20.0,
        initial_total_weight_g=1200.0, empty_spool_weight_g=200.0,
        remaining_weight_g=600.0, purchase_date=_at(-2),
    )
    # B: capacity 500 g, price 10, bought last month, archived this month.
    b = Spool(
        filament_id=filament.id, status_id=archived.id, purchase_price=10.0,
        initial_total_weight_g=500.0, empty_spool_weight_g=0.0,
        remaining_weight_g=500.0, purchase_date=_at(-1),
    )
    db.add_all([a, b])
    await db.flush()
    db.add_all(
        [
            SpoolEvent(spool_id=a.id, event_type="print_consumption", event_at=_at(-1), delta_weight_g=-100.0),
            SpoolEvent(spool_id=a.id, event_type="print_consumption", event_at=_at(0), delta_weight_g=-300.0),
            # Measurements carry no delta and must not disturb the rewind.
            SpoolEvent(spool_id=a.id, event_type="measurement", event_at=_at(0), measured_weight_g=800.0),
            SpoolEvent(
                spool_id=b.id, event_type="archived", event_at=_at(0),
                from_status_id=active.id, to_status_id=archived.id,
            ),
        ]
    )
    await db.commit()


def _row(m):
    return (m["spend"], m["consumption_g"], m["spool_count"], m["total_weight_g"], m["stock_value"])


@pytest.mark.asyncio
async def test_requires_login(client):
    assert (await client.get(URL)).status_code == 401


@pytest.mark.asyncio
async def test_months_bounds(auth_client):
    client, _ = auth_client
    assert len((await client.get(URL)).json()["months"]) == 12
    assert len((await client.get(URL, params={"months": 36})).json()["months"]) == 36
    assert (await client.get(URL, params={"months": 0})).status_code == 422
    assert (await client.get(URL, params={"months": 37})).status_code == 422


@pytest.mark.asyncio
async def test_empty_database_has_gaps_and_live_current_month(auth_client):
    client, _ = auth_client
    months = (await client.get(URL, params={"months": 3})).json()["months"]
    assert [m["month"] for m in months] == [_month(o).strftime("%Y-%m") for o in (-2, -1, 0)]
    assert [_row(m) for m in months] == [
        (0, 0, None, None, None),
        (0, 0, None, None, None),
        (0, 0, 0, 0, 0),
    ]


@pytest.mark.asyncio
async def test_stock_figures_come_from_snapshots_only(auth_client, db_session):
    client, _ = auth_client
    await _fixture(db_session)
    # Two snapshots in month -2 (the later day wins), none in month -1.
    for day, count, weight, value in ((_month(-2), 5, 900.0, 18.0), (_month(-2).replace(day=9), 7, 1100.0, 22.0)):
        db_session.add(InventorySnapshot(
            snapshot_date=day, spool_count=count, total_weight_g=weight, stock_value=value, purchase_value=50.0,
        ))
    await db_session.commit()
    months = (await client.get(URL, params={"months": 3})).json()["months"]
    # Spend and consumption are real data; stock never gets estimated from events.
    assert [_row(m) for m in months] == [
        (20.0, 0.0, 7, 1100.0, 22.0),
        (10.0, 100.0, None, None, None),
        # Current month = live tile values: spool A only (B is archived), 600 g, 600/1000 * 20.
        (0.0, 300.0, 1, 600.0, 12.0),
    ]


@pytest.mark.asyncio
async def test_current_month_ignores_its_own_snapshot(auth_client, db_session):
    client, _ = auth_client
    await _fixture(db_session)
    db_session.add(InventorySnapshot(
        snapshot_date=datetime.now(timezone.utc).date(), spool_count=99, total_weight_g=1.0, stock_value=1.0,
    ))
    await db_session.commit()
    months = (await client.get(URL, params={"months": 1})).json()["months"]
    assert _row(months[0])[2:] == (1, 600.0, 12.0)


@pytest.mark.asyncio
async def test_preferences_order_and_layout(auth_client):
    client, csrf = auth_client
    hdr = {"X-CSRF-Token": csrf}
    data = (await client.get(PREFS)).json()
    assert data["dashboard_widget_order"] == []
    assert data["dashboard_layout"] == "grid"

    resp = await client.patch(
        PREFS, json={"dashboard_widget_order": ["b", "a", "b", "c"], "dashboard_layout": "masonry"},
        headers=hdr,
    )
    assert resp.status_code == 200
    assert resp.json()["dashboard_widget_order"] == ["b", "a", "c"]
    assert resp.json()["dashboard_layout"] == "masonry"
    assert resp.json()["dashboard_hidden_widgets"] == []

    # Fields left out of a patch stay untouched.
    resp = await client.patch(PREFS, json={"dashboard_hidden_widgets": ["x"]}, headers=hdr)
    assert resp.json()["dashboard_widget_order"] == ["b", "a", "c"]
    assert resp.json()["dashboard_layout"] == "masonry"


@pytest.mark.asyncio
async def test_preferences_validation(auth_client):
    client, csrf = auth_client
    hdr = {"X-CSRF-Token": csrf}
    assert (await client.patch(PREFS, json={"dashboard_layout": "columns"}, headers=hdr)).status_code == 422
    assert (await client.patch(PREFS, json={"dashboard_widget_order": ["bad id"]}, headers=hdr)).status_code == 422
    too_many = [f"w{i}" for i in range(51)]
    assert (await client.patch(PREFS, json={"dashboard_widget_order": too_many}, headers=hdr)).status_code == 422


@pytest.mark.asyncio
async def test_preferences_widget_sizes(auth_client):
    client, csrf = auth_client
    hdr = {"X-CSRF-Token": csrf}
    assert (await client.get(PREFS)).json()["dashboard_widget_sizes"] == {}

    sizes = {"a": {"w": 2, "h": "m"}, "b": {"w": "full", "h": "auto"}, "c": {"w": 1, "h": "l"}}
    resp = await client.patch(PREFS, json={"dashboard_widget_sizes": sizes}, headers=hdr)
    assert resp.status_code == 200
    assert resp.json()["dashboard_widget_sizes"] == sizes
    assert (await client.get(PREFS)).json()["dashboard_widget_sizes"] == sizes

    # Fields left out of a patch stay untouched; an empty object resets the sizes.
    resp = await client.patch(PREFS, json={"dashboard_layout": "masonry"}, headers=hdr)
    assert resp.json()["dashboard_widget_sizes"] == sizes
    resp = await client.patch(PREFS, json={"dashboard_widget_sizes": {}}, headers=hdr)
    assert resp.json()["dashboard_widget_sizes"] == {}


@pytest.mark.asyncio
async def test_preferences_widget_sizes_validation(auth_client):
    client, csrf = auth_client
    hdr = {"X-CSRF-Token": csrf}
    bad = [
        {"a": {"w": 4, "h": "auto"}},
        {"a": {"w": "wide", "h": "auto"}},
        {"a": {"w": 1, "h": "xl"}},
        {"a": {"w": 1, "h": "auto", "extra": 1}},
        {"bad id": {"w": 1, "h": "auto"}},
        {"a": "full"},
        {f"w{i}": {"w": 1, "h": "auto"} for i in range(51)},
    ]
    for value in bad:
        resp = await client.patch(PREFS, json={"dashboard_widget_sizes": value}, headers=hdr)
        assert resp.status_code == 422, value
    assert (await client.get(PREFS)).json()["dashboard_widget_sizes"] == {}
