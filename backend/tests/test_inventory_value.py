"""Opt-in purchase-cost inventory valuation and legacy response preservation."""

import pytest

from tests.test_spool_metrics import metric_spool as _metric_spool
from tests.test_spools import _create_spool, _get_status

metric_spool = _metric_spool


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "price,remaining,status,expected",
    [
        (20, 400, "opened", 8),
        (20, 1000, "opened", 20),
        (20, 0, "opened", 0),
        (0, 400, "opened", 0),
        (None, 400, "opened", None),
        (20, None, "opened", None),
        (20, None, "new", 20),
        (20, 1500, "opened", 20),
        (20, -1, "opened", None),
    ],
)
async def test_spool_value_is_opt_in(
    auth_client, db_session, metric_spool, price, remaining, status, expected
):
    metric_spool.purchase_price = price
    metric_spool.remaining_weight_g = remaining
    metric_spool.status_id = (await _get_status(db_session, status)).id
    await db_session.commit()
    client, _ = auth_client
    path = f"/api/v1/spools/{metric_spool.id}"
    legacy = (await client.get(path + "?include_metrics=true")).json()
    assert "valuation" not in legacy
    response = await client.get(path + "?include_metrics=true&include_valuation=true")
    assert response.status_code == 200
    expanded = response.json()
    assert expanded.pop("valuation") == {"remaining_value": expected}
    assert expanded == legacy
    page = (
        await client.get("/api/v1/spools?include_metrics=true&include_valuation=true")
    ).json()
    assert page["items"][0] == response.json()


@pytest.mark.asyncio
async def test_inventory_value_totals_and_sorting(
    auth_client, db_session, metric_spool
):
    metric_spool.purchase_price = 20
    metric_spool.remaining_weight_g = 400
    archived = await _get_status(db_session, "archived")
    await _create_spool(
        db_session,
        metric_spool.filament_id,
        archived.id,
        purchase_price=100,
        remaining_weight_g=1000,
    )
    await _create_spool(
        db_session,
        metric_spool.filament_id,
        metric_spool.status_id,
        purchase_price=None,
        remaining_weight_g=300,
    )
    unknown = await _create_spool(
        db_session,
        metric_spool.filament_id,
        metric_spool.status_id,
        purchase_price=30,
        remaining_weight_g=None,
    )
    await db_session.commit()
    client, _ = auth_client
    legacy = (await client.get("/api/v1/dashboard/stats")).json()
    assert "valuation" not in legacy
    expanded = (
        await client.get("/api/v1/dashboard/stats?include_valuation=true")
    ).json()
    assert expanded.pop("valuation") == {"remaining_value": 8, "unknown_spool_count": 2}
    assert expanded == legacy
    page = await client.get(
        "/api/v1/spools?include_valuation=true&sort_by=remaining_value&sort_order=desc&page_size=1"
    )
    assert page.status_code == 200
    assert page.json()["items"][0]["id"] == metric_spool.id
    last = (
        await client.get(
            "/api/v1/spools?include_valuation=true&sort_by=remaining_value&sort_order=desc&page_size=1&page=3"
        )
    ).json()
    assert last["items"][0]["id"] == unknown.id


@pytest.mark.asyncio
async def test_total_rounding_and_unknown_capacity(
    auth_client, db_session, metric_spool
):
    metric_spool.purchase_price = 0.03
    metric_spool.remaining_weight_g = 500
    await _create_spool(
        db_session,
        metric_spool.filament_id,
        metric_spool.status_id,
        purchase_price=0.03,
        remaining_weight_g=500,
        initial_total_weight_g=1250,
        empty_spool_weight_g=250,
    )
    await db_session.commit()
    client, _ = auth_client
    path = "/api/v1/dashboard/stats?include_valuation=true&limit=1"
    response = (await client.get(path)).json()
    assert response["valuation"] == {
        "remaining_value": pytest.approx(0.03),
        "unknown_spool_count": 0,
    }
    metric_spool.initial_total_weight_g = None
    metric_spool.filament.raw_material_weight_g = None
    await db_session.commit()
    response = (await client.get(path)).json()
    assert response["valuation"] == {
        "remaining_value": pytest.approx(0.015),
        "unknown_spool_count": 1,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("price", [-1, float("inf"), float("-inf")])
async def test_invalid_legacy_prices_have_unknown_value(
    db_session, metric_spool, price
):
    from app.models import Filament, Spool
    from app.services.spool_metrics import spool_metric_expressions
    from sqlalchemy import select

    metric_spool.purchase_price = price
    await db_session.commit()
    value = spool_metric_expressions(include_valuation=True)["remaining_value"]
    assert (
        await db_session.scalar(select(value).select_from(Spool).join(Filament)) is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "direction,values", [("asc", [4, 8, 16, None]), ("desc", [16, 8, 4, None])]
)
async def test_value_sorting_pages_known_and_unknown_values(
    auth_client, db_session, metric_spool, direction, values
):
    metric_spool.purchase_price = 20
    metric_spool.remaining_weight_g = 400
    for grams in [800, None, 200]:
        await _create_spool(
            db_session,
            metric_spool.filament_id,
            metric_spool.status_id,
            purchase_price=20,
            remaining_weight_g=grams,
            initial_total_weight_g=1250,
            empty_spool_weight_g=250,
        )
    await db_session.commit()
    client, _ = auth_client
    actual = []
    for page in range(1, 5):
        response = await client.get(
            f"/api/v1/spools?include_valuation=true&sort_by=remaining_value&sort_order={direction}&page_size=1&page={page}"
        )
        assert response.status_code == 200
        actual.append(response.json()["items"][0]["valuation"]["remaining_value"])
    assert actual == values
    legacy = (
        await client.get("/api/v1/spools?include_metrics=true&sort_by=remaining_value")
    ).json()
    assert all("valuation" not in item for item in legacy["items"])


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["mixed", "unknown", "empty"])
async def test_known_manufacturer_value_and_legacy_shapes(
    auth_client, db_session, metric_spool, kind
):
    from app.models import Spool
    from sqlalchemy import delete

    metric_spool.purchase_price = 20
    metric_spool.remaining_weight_g = 400
    archived = await _get_status(db_session, "archived")
    await _create_spool(
        db_session,
        metric_spool.filament_id,
        archived.id,
        purchase_price=100,
        remaining_weight_g=None,
    )
    if kind == "mixed":
        await _create_spool(
            db_session,
            metric_spool.filament_id,
            metric_spool.status_id,
            purchase_price=None,
            remaining_weight_g=300,
        )
    elif kind == "unknown":
        metric_spool.remaining_weight_g = None
    else:
        await db_session.execute(delete(Spool))
    await db_session.commit()
    client, _ = auth_client
    manufacturer_id = metric_spool.filament.manufacturer_id
    expected = {
        "remaining_value": {"mixed": 8, "unknown": None, "empty": 0}[kind],
        "unknown_spool_count": 1 if kind != "empty" else 0,
    }
    path = "/api/v1/manufacturers"
    legacy = (await client.get(path)).json()["items"][0]
    assert "valuation" not in legacy
    expanded = (await client.get(path + "?include_valuation=true")).json()["items"][0]
    assert expanded.pop("valuation") == expected
    assert expanded == legacy
    detail = f"{path}/{manufacturer_id}"
    legacy_detail = (await client.get(detail)).json()
    expanded_detail = (await client.get(detail + "?include_valuation=true")).json()
    assert expanded_detail.pop("valuation") == expected
    assert expanded_detail == legacy_detail
    dashboard = (
        await client.get("/api/v1/dashboard/stats?include_valuation=true")
    ).json()
    assert dashboard["valuation"] == expected
