from datetime import datetime, timezone

import pytest
from app.models import (
    Filament,
    Manufacturer,
    PrintJob,
    PrintJobUsage,
    PrintProject,
    Spool,
    SpoolEvent,
    SpoolStatus,
)
from sqlalchemy import select

URL = "/api/v1/analytics/summary"


def _dt(y, m, d=15):
    return datetime(y, m, d, 12, tzinfo=timezone.utc)


async def _spool(
    db,
    *,
    material="PLA",
    mfr="Acme",
    purchase_price=None,
    initial_total=None,
    filament_price=None,
    raw_weight=1000.0,
    purchase_date=None,
    stocked_in_at=None,
):
    manufacturer = await db.scalar(select(Manufacturer).where(Manufacturer.name == mfr))
    if manufacturer is None:
        manufacturer = Manufacturer(name=mfr)
        db.add(manufacturer)
        await db.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation=f"{material} Basic",
        material_type=material,
        diameter_mm=1.75,
        price=filament_price,
        raw_material_weight_g=raw_weight,
    )
    db.add(filament)
    await db.flush()
    status = await db.scalar(select(SpoolStatus).where(SpoolStatus.key == "new"))
    spool = Spool(
        filament_id=filament.id,
        status_id=status.id,
        remaining_weight_g=800.0,
        purchase_price=purchase_price,
        initial_total_weight_g=initial_total,
        purchase_date=purchase_date,
        stocked_in_at=stocked_in_at,
    )
    db.add(spool)
    await db.flush()
    return spool


def _event(spool, delta, when, event_type="print_consumption", meta=None):
    return SpoolEvent(
        spool_id=spool.id,
        event_type=event_type,
        event_at=when,
        delta_weight_g=delta,
        meta=meta,
    )


@pytest.mark.asyncio
async def test_requires_login(client):
    assert (await client.get(URL)).status_code == 401


@pytest.mark.asyncio
async def test_empty_database(auth_client):
    client, _ = auth_client
    resp = await client.get(URL, params={"from": "2026-01-01", "to": "2026-03-31"})
    assert resp.status_code == 200
    data = resp.json()
    assert [m["month"] for m in data["consumption_by_month"]] == ["2026-01", "2026-02", "2026-03"]
    assert all(m["weight_g"] == 0 for m in data["consumption_by_month"])
    assert data["consumption_by_material"] == []
    assert data["consumption_by_manufacturer"] == []
    assert data["print_jobs"]["count"] == 0
    assert data["print_jobs"]["success_rate"] is None
    assert data["totals"] == {"weight_g": 0, "cost": 0, "cost_unknown_weight_g": 0}


@pytest.mark.asyncio
async def test_default_range_is_twelve_months(auth_client):
    client, _ = auth_client
    data = (await client.get(URL)).json()
    assert len(data["consumption_by_month"]) == 12


@pytest.mark.asyncio
async def test_invalid_range(auth_client):
    client, _ = auth_client
    resp = await client.get(URL, params={"from": "2026-05-01", "to": "2026-01-01"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_consumption_by_month_material_and_cost_sources(auth_client, db_session):
    client, _ = auth_client
    # Spool price: 20 / (1200 - 0) net start weight = 0.0166.. per g
    own = await _spool(db_session, purchase_price=20.0, initial_total=1000.0, material="PLA")
    # Filament list price: 30 / 1000 g = 0.03 per g
    listed = await _spool(db_session, filament_price=30.0, material="PETG", mfr="Beta")
    db_session.add_all(
        [
            _event(own, -100.0, _dt(2026, 1)),
            _event(listed, -50.0, _dt(2026, 2)),
            _event(listed, -10.0, _dt(2026, 2, 20)),
        ]
    )
    await db_session.commit()

    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-03-31"})).json()
    months = {m["month"]: m for m in data["consumption_by_month"]}
    assert months["2026-01"]["weight_g"] == 100.0
    assert months["2026-01"]["cost"] == pytest.approx(2.0)
    assert months["2026-02"]["weight_g"] == 60.0
    assert months["2026-02"]["cost"] == pytest.approx(1.8)
    assert months["2026-03"]["weight_g"] == 0
    materials = data["consumption_by_material"]
    assert [m["material_type"] for m in materials] == ["PLA", "PETG"]
    assert [m["manufacturer"] for m in data["consumption_by_manufacturer"]] == ["Acme", "Beta"]
    assert data["totals"]["weight_g"] == 160.0
    assert data["totals"]["cost"] == pytest.approx(3.8)
    assert data["totals"]["cost_unknown_weight_g"] == 0


@pytest.mark.asyncio
async def test_job_snapshot_cost_preferred(auth_client, db_session):
    client, _ = auth_client
    spool = await _spool(db_session, filament_price=30.0)
    event = _event(spool, -100.0, _dt(2026, 1), meta={"print_job_id": 1})
    db_session.add(event)
    await db_session.flush()
    job = PrintJob(name="Benchy", status="completed", finished_at=_dt(2026, 1))
    job.usages = [
        PrintJobUsage(spool_id=spool.id, used_weight_g=100.0, cost=7.0, spool_event_id=event.id)
    ]
    db_session.add(job)
    await db_session.commit()

    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    # snapshot (7.0) wins over the current price (3.0)
    assert data["totals"]["cost"] == pytest.approx(7.0)
    assert data["print_jobs"]["total_cost"] == pytest.approx(7.0)


@pytest.mark.asyncio
async def test_measurements_and_corrections_do_not_count(auth_client, db_session):
    client, _ = auth_client
    spool = await _spool(db_session, filament_price=30.0)
    db_session.add_all(
        [
            _event(spool, -40.0, _dt(2026, 1), event_type="manual_adjust"),
            _event(spool, -25.0, _dt(2026, 1), event_type="measurement"),
            _event(spool, None, _dt(2026, 1), event_type="print_consumption"),
            _event(spool, -5.0, _dt(2026, 1), event_type="print_consumption"),
        ]
    )
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    assert data["totals"]["weight_g"] == 5.0


@pytest.mark.asyncio
async def test_cost_unknown_weight(auth_client, db_session):
    client, _ = auth_client
    priced = await _spool(db_session, filament_price=30.0)
    unpriced = await _spool(db_session, material="ABS")
    db_session.add_all([_event(priced, -10.0, _dt(2026, 1)), _event(unpriced, -70.0, _dt(2026, 1))])
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    assert data["totals"]["weight_g"] == 80.0
    assert data["totals"]["cost"] == pytest.approx(0.3)
    assert data["totals"]["cost_unknown_weight_g"] == 70.0


@pytest.mark.asyncio
async def test_period_filter(auth_client, db_session):
    client, _ = auth_client
    spool = await _spool(db_session, filament_price=30.0)
    db_session.add_all(
        [
            _event(spool, -10.0, _dt(2025, 12, 31)),
            _event(spool, -20.0, _dt(2026, 1, 1)),
            _event(spool, -30.0, _dt(2026, 1, 31)),
            _event(spool, -40.0, _dt(2026, 2, 1)),
        ]
    )
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    assert data["totals"]["weight_g"] == 50.0


@pytest.mark.asyncio
async def test_manufacturer_top_ten_plus_other(auth_client, db_session):
    client, _ = auth_client
    for i in range(12):
        spool = await _spool(db_session, mfr=f"M{i:02d}", filament_price=10.0)
        db_session.add(_event(spool, -(100.0 - i), _dt(2026, 1)))
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    mfrs = data["consumption_by_manufacturer"]
    assert len(mfrs) == 11
    assert mfrs[-1]["manufacturer"] == "other"
    assert mfrs[-1]["weight_g"] == (100.0 - 10) + (100.0 - 11)


@pytest.mark.asyncio
async def test_purchases_by_purchase_date_or_stocked_in(auth_client, db_session):
    client, _ = auth_client
    await _spool(db_session, purchase_price=20.0, purchase_date=_dt(2026, 1), material="PLA")
    await _spool(db_session, purchase_price=25.0, stocked_in_at=_dt(2026, 2), material="PETG")
    # purchase_date outside the range wins over stocked_in_at inside it
    await _spool(
        db_session,
        purchase_price=99.0,
        purchase_date=_dt(2025, 6),
        stocked_in_at=_dt(2026, 1),
    )
    await _spool(db_session, purchase_price=None, purchase_date=_dt(2026, 1))
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-02-28"})).json()
    purchases = data["purchases"]
    assert purchases["total"] == 45.0
    by_month = {m["month"]: m for m in purchases["by_month"]}
    assert by_month["2026-01"]["by_material"] == {"PLA": 20.0}
    assert by_month["2026-02"]["by_material"] == {"PETG": 25.0}
    assert purchases["by_material"] == {"PETG": 25.0, "PLA": 20.0}


@pytest.mark.asyncio
async def test_print_jobs_and_top_projects(auth_client, db_session):
    client, _ = auth_client
    spool = await _spool(db_session, filament_price=30.0)
    vase = PrintProject(name="Vase")
    shelf = PrintProject(name="Shelf")
    db_session.add_all([vase, shelf])
    await db_session.flush()

    def job(name, status, project, cost, grams, secs):
        j = PrintJob(
            name=name,
            status=status,
            project_id=project.id if project else None,
            finished_at=_dt(2026, 1),
            print_time_s=secs,
        )
        j.usages = [PrintJobUsage(spool_id=spool.id, used_weight_g=grams, cost=cost)]
        return j

    db_session.add_all(
        [
            job("a", "completed", vase, 4.0, 100.0, 3600),
            job("b", "completed", shelf, 10.0, 300.0, 7200),
            job("c", "failed", vase, 2.0, 50.0, 600),
            job("d", "cancelled", vase, None, 0.0, None),
            PrintJob(name="old", status="completed", finished_at=_dt(2025, 1)),
        ]
    )
    await db_session.commit()
    data = (await client.get(URL, params={"from": "2026-01-01", "to": "2026-01-31"})).json()
    pj = data["print_jobs"]
    assert (pj["count"], pj["completed"], pj["failed"], pj["cancelled"]) == (4, 2, 1, 1)
    assert pj["success_rate"] == pytest.approx(2 / 3, abs=1e-3)
    assert pj["total_weight_g"] == 450.0
    assert pj["total_cost"] == pytest.approx(16.0)
    assert pj["avg_cost_per_job"] == pytest.approx(16.0 / 3, abs=1e-3)
    assert pj["total_print_time_s"] == 11400
    assert [p["name"] for p in data["top_projects"]] == ["Shelf", "Vase"]
    assert data["top_projects"][1]["job_count"] == 2
    assert data["top_projects"][1]["cost"] == pytest.approx(6.0)
