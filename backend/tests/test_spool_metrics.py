"""Native calculated metrics preserve the legacy spool wire contract."""

import os

import pytest

from tests.test_spools import (
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _get_status,
)


@pytest.fixture
async def metric_spool(db_session):
    maker = await _create_manufacturer(db_session)
    filament = await _create_filament(db_session, maker.id)
    filament.raw_material_weight_g = 1000
    filament.density_g_cm3 = 1.24
    status = await _get_status(db_session, "opened")
    spool = await _create_spool(
        db_session,
        filament.id,
        status.id,
        initial_total_weight_g=1250,
        empty_spool_weight_g=250,
        remaining_weight_g=500,
    )
    spool.filament = filament
    await db_session.commit()
    return spool


LEGACY_KEYS = {
    "id",
    "filament_id",
    "status_id",
    "lot_number",
    "rfid_uid",
    "rfid_uid_2",
    "external_id",
    "location_id",
    "purchase_date",
    "purchase_price",
    "stocked_in_at",
    "last_used_at",
    "initial_total_weight_g",
    "empty_spool_weight_g",
    "spool_core_weight_g",
    "remaining_weight_g",
    "spool_outer_diameter_mm",
    "spool_width_mm",
    "spool_material",
    "low_weight_threshold_g",
    "created_at",
    "custom_fields",
    "filament",
    "web_url",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status_key,stored,nominal,effective,percent",
    [
        ("new", None, 1000, 1000, 100),
        ("new", None, 500, 500, 100),
        ("new", 0, 1000, 0, 0),
        ("new", 200, 1000, 200, 20),
        ("opened", None, 1000, None, None),
        ("new", None, None, None, None),
        ("new", None, 0, None, None),
    ],
)
async def test_new_spool_missing_weight_uses_nominal_without_rewriting_import(
    auth_client,
    db_session,
    metric_spool,
    status_key,
    stored,
    nominal,
    effective,
    percent,
):
    metric_spool.status_id = (await _get_status(db_session, status_key)).id
    metric_spool.remaining_weight_g = stored
    metric_spool.filament.raw_material_weight_g = nominal
    await db_session.commit()
    client, _ = auth_client
    path = f"/api/v1/spools/{metric_spool.id}"
    ordinary = (await client.get(path)).json()
    expanded = (await client.get(path + "?include_metrics=true")).json()
    assert ordinary["remaining_weight_g"] == expanded["remaining_weight_g"] == stored
    assert "metrics" not in ordinary
    assert expanded["metrics"] == {
        "effective_remaining_weight_g": effective,
        "remaining_percent": percent,
        "remaining_length_m": pytest.approx(effective * 0.3352836194167644)
        if effective is not None
        else None,
    }
    page = (
        await client.get(
            "/api/v1/spools?include_metrics=true&sort_by=effective_remaining_weight_g&remaining_percent_min=99"
        )
    ).json()
    assert page["total"] == (1 if percent == 100 else 0)


@pytest.mark.asyncio
async def test_effective_weight_sort_pages_across_inferred_and_recorded_rows(
    auth_client, db_session, metric_spool
):
    metric_spool.status_id = (await _get_status(db_session, "new")).id
    metric_spool.remaining_weight_g = None
    opened = await _get_status(db_session, "opened")
    rows = [
        await _create_spool(
            db_session,
            metric_spool.filament_id,
            opened.id,
            remaining_weight_g=grams,
            initial_total_weight_g=1250,
            empty_spool_weight_g=250,
        )
        for grams in [500, None, 0]
    ]
    await db_session.commit()
    client, _ = auth_client
    path = "/api/v1/spools?include_metrics=true&sort_by=effective_remaining_weight_g&sort_order=desc&page_size=2"
    first = (await client.get(path)).json()
    second = (await client.get(path + "&page=2")).json()
    assert first["total"] == second["total"] == 4
    assert [row["id"] for row in first["items"] + second["items"]] == [
        metric_spool.id,
        rows[0].id,
        rows[2].id,
        rows[1].id,
    ]
    assert first["items"][0]["remaining_weight_g"] is None
    assert first["items"][0]["metrics"]["effective_remaining_weight_g"] == 1000


@pytest.mark.asyncio
async def test_metrics_are_opt_in_on_detail_and_collection(auth_client, metric_spool):
    client, _ = auth_client
    ordinary = (await client.get(f"/api/v1/spools/{metric_spool.id}")).json()
    assert set(ordinary) == LEGACY_KEYS
    expanded = (
        await client.get(f"/api/v1/spools/{metric_spool.id}?include_metrics=true")
    ).json()
    assert expanded.pop("metrics") == {
        "remaining_percent": 50,
        "remaining_length_m": pytest.approx(167.6418097083822),
        "effective_remaining_weight_g": 500,
    }
    assert expanded == ordinary
    for query in ["", "?include_metrics=false"]:
        assert (await client.get(f"/api/v1/spools{query}")).json()["items"] == [
            ordinary
        ]
    page = (await client.get("/api/v1/spools?include_metrics=true")).json()
    assert page["items"][0]["metrics"]["remaining_percent"] == 50


@pytest.mark.asyncio
async def test_populated_label_aliases_remain_available(
    auth_client, db_session, metric_spool
):
    metric_spool.label_field_aliases = {
        "min_temp": "extruder_temp_range_c.min",
        "bed": {"target": "bed_temp_range_c", "definition": {
            "field_type": "range", "config": {"unit": "°C"},
        }},
    }
    await db_session.commit()
    client, _ = auth_client
    for suffix in ["", "?include_metrics=true"]:
        detail = (await client.get(f"/api/v1/spools/{metric_spool.id}{suffix}")).json()
        collection = (await client.get(f"/api/v1/spools{suffix}")).json()
        assert detail["label_field_aliases"] == metric_spool.label_field_aliases
        assert collection["items"][0]["label_field_aliases"] == metric_spool.label_field_aliases


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "remaining,gross,tare,nominal,density,diameter,percent,length",
    [
        (0, 1250, 250, 1000, 1.24, 1.75, 0, 0),
        (None, 1250, 250, 1000, 1.24, 1.75, None, None),
        (-5, 1250, 250, 1000, 1.24, 1.75, None, None),
        (1500, 1250, 250, 1000, 1.24, 1.75, 100, 502.9254291251466),
        (500, None, 250, 1000, 1.24, 1.75, 50, 167.6418097083822),
        (500, 200, 250, 1000, 1.24, 1.75, 50, 167.6418097083822),
        (500, 1250, -250, 1000, 1.24, 1.75, 50, 167.6418097083822),
        (500, 250, 250, None, 1.24, 1.75, None, 167.6418097083822),
        (500, None, None, 0, 1.24, 1.75, None, 167.6418097083822),
        (500, 1250, 250, 1000, 0, 1.75, 50, None),
        (500, 1250, 250, 1000, None, 1.75, 50, None),
        (500, 1250, 250, 1000, 1.24, -1.75, 50, None),
        (1e-200, 1e200, 0, 1000, 1.24, 1.75, None, 3.352836194167644e-201),
    ],
)
async def test_unknown_zero_capacity_and_length_inputs(
    auth_client,
    db_session,
    metric_spool,
    remaining,
    gross,
    tare,
    nominal,
    density,
    diameter,
    percent,
    length,
):
    spool = metric_spool
    (
        spool.remaining_weight_g,
        spool.initial_total_weight_g,
        spool.empty_spool_weight_g,
    ) = remaining, gross, tare
    spool.filament.raw_material_weight_g = nominal
    spool.filament.density_g_cm3, spool.filament.diameter_mm = density, diameter
    await db_session.commit()
    client, _ = auth_client
    response = await client.get(f"/api/v1/spools/{spool.id}?include_metrics=true")
    assert response.status_code == 200
    assert response.json()["metrics"] == {
        "remaining_percent": percent,
        "remaining_length_m": pytest.approx(length) if length is not None else None,
        "effective_remaining_weight_g": remaining
        if remaining is not None and remaining >= 0
        else None,
    }
    assert response.json()["remaining_weight_g"] == remaining


@pytest.mark.asyncio
@pytest.mark.parametrize("core", [None, 0, 42])
async def test_metrics_do_not_subtract_core_or_tare_again(
    auth_client, db_session, metric_spool, core
):
    from app.models import AppSettings

    settings = await db_session.get(AppSettings, 1)
    if settings is None:
        settings = AppSettings(id=1)
        db_session.add(settings)
    settings.default_spool_core_weight_g = 75
    metric_spool.spool_core_weight_g = core
    await db_session.commit()
    client, _ = auth_client
    data = (
        await client.get(f"/api/v1/spools/{metric_spool.id}?include_metrics=true")
    ).json()
    assert data["metrics"]["remaining_percent"] == 50
    assert data["metrics"]["remaining_length_m"] == pytest.approx(167.6418097083822)
    assert data["remaining_weight_g"] == 500
    assert data["spool_core_weight_g"] == core


@pytest.mark.asyncio
async def test_metrics_are_read_only_and_omitted_on_mutations(
    auth_client, metric_spool
):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    response = await client.post(
        "/api/v1/spools",
        json={
            "filament_id": metric_spool.filament_id,
            "initial_total_weight_g": 1250,
            "remaining_weight_g": 500,
            "empty_spool_weight_g": 250,
            "metrics": {"remaining_percent": 99},
            "unrecognized_legacy_input": "ignored",
        },
        headers=headers,
    )
    assert response.status_code == 201
    assert set(response.json()) == LEGACY_KEYS
    spool_id = response.json()["id"]
    response = await client.patch(
        f"/api/v1/spools/{spool_id}",
        json={"lot_number": "Keep", "metrics": {"remaining_percent": 99}},
        headers=headers,
    )
    assert response.status_code == 200
    assert set(response.json()) == LEGACY_KEYS
    data = (await client.get(f"/api/v1/spools/{spool_id}?include_metrics=true")).json()
    assert data["lot_number"] == "Keep"
    assert data["metrics"]["remaining_percent"] == 50


@pytest.mark.asyncio
async def test_inventory_wide_metric_sort_filter_search_and_stable_nulls(
    auth_client, db_session, metric_spool
):
    ids = []
    for remaining in [100, None, 500, 750]:
        row = await _create_spool(
            db_session,
            metric_spool.filament_id,
            metric_spool.status_id,
            initial_total_weight_g=1250,
            empty_spool_weight_g=250,
            remaining_weight_g=remaining,
        )
        ids.append(row.id)
    client, _ = auth_client
    base = "/api/v1/spools?include_metrics=true&page_size=2"
    high = (
        await client.get(base + "&sort_by=remaining_percent&sort_order=desc")
    ).json()
    assert [s["id"] for s in high["items"]] == [ids[3], metric_spool.id]
    second = (
        await client.get(base + "&sort_by=remaining_percent&sort_order=desc&page=2")
    ).json()
    assert [s["id"] for s in second["items"]] == [ids[2], ids[0]]
    last = (
        await client.get(base + "&sort_by=remaining_percent&sort_order=desc&page=3")
    ).json()
    assert [s["id"] for s in last["items"]] == [ids[1]]
    filtered = (
        await client.get(base + "&remaining_percent_min=45&remaining_percent_max=55")
    ).json()
    assert filtered["total"] == 2
    assert {s["id"] for s in filtered["items"]} == {metric_spool.id, ids[2]}
    lengths = (
        await client.get(
            base
            + "&sort_by=remaining_length_m&sort_order=asc&remaining_length_m_min=150&remaining_length_m_max=200"
        )
    ).json()
    assert lengths["total"] == 2
    assert [s["id"] for s in lengths["items"]] == [metric_spool.id, ids[2]]
    last = (
        await client.get(base + "&sort_by=remaining_length_m&sort_order=asc&page=3")
    ).json()
    assert last["items"][0]["id"] == ids[1]
    ordinary = (
        await client.get(
            "/api/v1/spools?remaining_percent_min=70&sort_by=remaining_percent"
        )
    ).json()
    assert ordinary["total"] == 1
    assert "metrics" not in ordinary["items"][0]
    assert (await client.get("/api/v1/spools?search=168")).json()["total"] == 0
    assert (await client.get(base + "&search=168")).json()["total"] == 2


@pytest.mark.asyncio
async def test_opt_in_keeps_not_found_response(auth_client):
    client, _ = auth_client
    for suffix in ["", "?include_metrics=true"]:
        response = await client.get("/api/v1/spools/999999" + suffix)
        assert response.status_code == 404
        assert response.json() == {
            "detail": {"code": "not_found", "message": "Spool not found"}
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value,percent,length",
    [
        ("remaining_weight_g", float("inf"), None, None),
        ("remaining_weight_g", float("-inf"), None, None),
        ("remaining_weight_g", float("nan"), None, None),
        ("initial_total_weight_g", float("inf"), 50, 167.6418097083822),
        ("density_g_cm3", float("inf"), 50, None),
        ("diameter_mm", float("inf"), 50, None),
        ("density_g_cm3", -1, 50, None),
        ("diameter_mm", 0, 50, None),
    ],
)
async def test_nonfinite_legacy_inputs_have_unknown_sql_metrics(
    db_session,
    metric_spool,
    field,
    value,
    percent,
    length,
):
    from sqlalchemy import select

    from app.models import Filament, Spool
    from app.services.spool_metrics import spool_metric_expressions

    target = (
        metric_spool.filament
        if field in {"density_g_cm3", "diameter_mm"}
        else metric_spool
    )
    setattr(target, field, value)
    await db_session.commit()
    row = (
        await db_session.execute(
            select(*spool_metric_expressions().values())
            .select_from(Spool)
            .join(Filament)
            .where(Spool.id == metric_spool.id)
        )
    ).one()
    assert row.remaining_percent == percent
    assert row.remaining_length_m == (
        pytest.approx(length) if length is not None else None
    )


@pytest.mark.asyncio
async def test_metrics_preserve_authentication_and_reject_nonfinite_bounds(
    client, auth_client
):
    logged_in, _ = auth_client
    assert (
        await logged_in.get("/api/v1/spools?remaining_percent_min=nan")
    ).status_code == 422
    assert (
        await logged_in.get("/api/v1/spools?remaining_length_m_max=inf")
    ).status_code == 422
    client.cookies.clear()
    ordinary = await client.get("/api/v1/spools")
    expanded = await client.get("/api/v1/spools?include_metrics=true")
    assert ordinary.status_code == expanded.status_code == 401
    assert ordinary.json() == expanded.json()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url_env", ["TEST_POSTGRES_URL", "TEST_MYSQL_URL"], ids=["postgresql", "mysql"]
)
async def test_database_metric_extremes_do_not_coerce_before_numeric_guards(
    url_env,
):
    database_url = os.getenv(url_env)
    if not database_url:
        pytest.skip("Optional real PostgreSQL/MySQL metric projection check")
    from sqlalchemy import Column, Float, String, literal, select
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.sql.visitors import replacement_traverse

    from app.services.spool_metrics import spool_metric_expressions

    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            for grams, gross, diameter, density, percent, has_length in [
                (500, 1250, 1.75, 1.24, 50, True),
                (1e-200, 1e200, 1.75, 1.24, None, True),
                (500, 1250, 1e200, 1.24, 50, False),
                (500, 1250, 1e-200, 1.24, 50, False),
                (1.7976931348623157e308, 1250, 1.75, 1.24, 100, True),
                (0, 1250, 1.75, 1.24, 0, True),
                (None, 1250, 1.75, 1.24, None, False),
                (None, 1250, 1.75, 1.24, 100, True),
                (500, 1250, 1.75, 0, 50, False),
            ]:
                values = {
                    "remaining_weight_g": grams,
                    "initial_total_weight_g": gross,
                    "empty_spool_weight_g": 0 if gross == 1e200 else 250,
                    "diameter_mm": diameter,
                    "density_g_cm3": density,
                    "raw_material_weight_g": 1000,
                    "status_id": 1 if grams is None and percent == 100 else 0,
                    "id": 1,
                    "key": "new",
                }

                def replace(column, values=values):
                    if isinstance(column, Column) and column.name in values:
                        return literal(
                            values[column.name],
                            type_=String
                            if isinstance(values[column.name], str)
                            else Float,
                        )
                    return None

                expressions = [
                    replacement_traverse(expr, {}, replace)
                    for expr in spool_metric_expressions(engine.dialect.name).values()
                ]
                row = (await connection.execute(select(*expressions))).one()
                assert row.remaining_percent == percent
                assert (row.remaining_length_m is not None) == has_length
                assert row.effective_remaining_weight_g == (
                    1000 if grams is None and percent == 100 else grams
                )
                if grams is None and percent == 100:
                    assert row.remaining_length_m == pytest.approx(335.2836194167644)
                if grams == 500 and diameter == 1.75 and density == 1.24:
                    assert row.remaining_length_m == pytest.approx(167.6418097083822)
    finally:
        await engine.dispose()
