"""Spool Log queries must cover the complete history, before pagination."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from app.models import Filament, Manufacturer, Spool, SpoolEvent, SpoolStatus
from sqlalchemy import select


@pytest.fixture
async def log_events(db_session):
    manufacturer = Manufacturer(name="Acme München")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Silk",
        material_type="PLA",
        manufacturer_color_name="Gold",
        diameter_mm=1.75,
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "new")
    )
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.flush()
    events = [
        SpoolEvent(
            spool_id=spool.id,
            event_type="measurement" if index < 5 else "move_location",
            event_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=index),
            measured_weight_g=60.1 + index if index < 5 else None,
            note="München <lot> 100%" if index < 5 else "Moved",
        )
        for index in range(30)
    ]
    events[-1].event_at = events[-2].event_at
    db_session.add_all(events)
    await db_session.commit()
    return spool, events


@pytest.mark.asyncio
async def test_log_search_filters_and_count_before_pagination(auth_client, log_events):
    client, _ = auth_client
    spool, events = log_events
    filters = {
        "spool": {
            "type": "number",
            "operator": "eq",
            "value": str(spool.id),
            "valueTo": "",
        },
        "manufacturer": {"type": "text", "operator": "contains", "value": "Acme"},
        "material": {"type": "text", "operator": "equals", "value": "PLA"},
        "mfr_color": {"type": "text", "operator": "equals", "value": "Gold"},
        "event_type": {"type": "text", "operator": "equals", "value": "measurement"},
        "event_at": {
            "type": "date",
            "operator": "between",
            "value": "2026-01-01",
            "valueTo": "2026-01-05",
        },
        "weight": {"type": "number", "operator": "gte", "value": "60.1", "valueTo": ""},
    }
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "search": "München <lot>",
            "filters": json.dumps(filters),
            "sort_by": "weight",
            "sort_order": "asc",
            "page": 2,
            "page_size": 2,
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["total"] == 5
    assert [item["id"] for item in result["items"]] == [events[2].id, events[3].id]
    assert set(result) == {"items", "total", "page", "page_size"}
    assert result["items"][0]["manufacturer_name"] == "Acme München"


@pytest.mark.asyncio
async def test_log_matches_both_displayed_weights_on_an_accepted_adjustment(
    auth_client, db_session, log_events
):
    client, csrf_token = auth_client
    spool, _ = log_events
    spool.remaining_weight_g = 500
    spool.status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "opened")
    )
    await db_session.commit()
    response = await client.post(
        f"/api/v1/spools/{spool.id}/adjustments",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "adjustment_type": "relative",
            "measured_weight_g": 800,
            "delta_weight_g": -12.5,
        },
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert event["measured_weight_g"] == 800
    assert event["delta_weight_g"] == -12.5
    for term in ("800", "-12.5"):
        response = await client.get(
            "/api/v1/spools/all-events", params={"search": term}
        )
        assert response.status_code == 200, response.text
        assert [item["id"] for item in response.json()["items"]] == [event["id"]], term
    for operator, value, value_to, count in [
        ("eq", "800", "", 1),
        ("eq", "-12.5", "", 1),
        ("neq", "-12.5", "", 5),
        ("neq", "800", "", 5),
        ("gt", "700", "", 1),
        ("lt", "0", "", 1),
        ("between", "-10", "-20", 1),
        ("isEmpty", "", "", 25),
        ("isNotEmpty", "", "", 6),
    ]:
        response = await client.get(
            "/api/v1/spools/all-events",
            params={
                "filters": json.dumps(
                    {
                        "weight": {
                            "type": "number",
                            "operator": operator,
                            "value": value,
                            "valueTo": value_to,
                        }
                    }
                )
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["total"] == count, (operator, value, response.text)


@pytest.mark.asyncio
async def test_log_defaults_stable_order_and_literal_search(auth_client, log_events):
    client, _ = auth_client
    _, events = log_events
    response = await client.get("/api/v1/spools/all-events", params={"page_size": 2})
    assert [item["id"] for item in response.json()["items"]] == [
        events[-1].id,
        events[-2].id,
    ]
    assert response.json()["total"] == 30
    response = await client.get("/api/v1/spools/all-events", params={"search": "%"})
    assert response.json()["total"] == 5
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "filters": json.dumps(
                {
                    "weight": {
                        "type": "number",
                        "operator": "isEmpty",
                        "value": "",
                        "valueTo": "",
                    }
                }
            )
        },
    )
    assert response.json()["total"] == 25


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"sort_by": "note; DROP TABLE spool_events"},
        {"filters": "{"},
        {
            "filters": json.dumps(
                {"weight": {"type": "number", "operator": "gte", "value": "nan"}}
            )
        },
        {
            "filters": json.dumps(
                {"event_at": {"type": "date", "operator": "on", "value": "bad-date"}}
            )
        },
        {
            "filters": json.dumps(
                {"unknown": {"type": "text", "operator": "equals", "value": "x"}}
            )
        },
    ],
)
async def test_log_rejects_invalid_new_query_controls(auth_client, params):
    client, _ = auth_client
    response = await client.get("/api/v1/spools/all-events", params=params)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_log_date_filter_uses_display_timezone(auth_client, log_events):
    client, _ = auth_client
    # Jan 1 midnight UTC is Dec 31 in the browser's UTC-6 timezone.
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "timezone_name": "America/Chicago",
            "filters": json.dumps(
                {"event_at": {"type": "date", "operator": "on", "value": "2025-12-31"}}
            ),
        },
    )
    assert response.status_code == 200
    assert response.json()["total"] == 1


@pytest.mark.asyncio
async def test_log_date_filter_handles_short_day_at_dst_boundary(
    auth_client, db_session, log_events
):
    client, _ = auth_client
    spool, _ = log_events
    db_session.add_all(
        [
            SpoolEvent(spool_id=spool.id, event_type="measurement", event_at=instant)
            for instant in [
                datetime(2026, 3, 8, 5, 59, tzinfo=UTC),
                datetime(2026, 3, 8, 6, 0, tzinfo=UTC),
                datetime(2026, 3, 9, 4, 59, tzinfo=UTC),
                datetime(2026, 3, 9, 5, 0, tzinfo=UTC),
            ]
        ]
    )
    await db_session.commit()
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "timezone_name": "America/Chicago",
            "filters": json.dumps(
                {"event_at": {"type": "date", "operator": "on", "value": "2026-03-08"}}
            ),
        },
    )
    assert response.status_code == 200
    assert response.json()["total"] == 2


@pytest.mark.asyncio
async def test_log_ranges_and_empty_text_match_shared_column_controls(
    auth_client, db_session, log_events
):
    client, _ = auth_client
    _, events = log_events
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "filters": json.dumps(
                {
                    "weight": {
                        "type": "number",
                        "operator": "between",
                        "value": "63.1",
                        "valueTo": "61.1",
                    },
                    "event_at": {
                        "type": "date",
                        "operator": "between",
                        "value": "2026-01-04",
                        "valueTo": "2026-01-02",
                    },
                }
            )
        },
    )
    assert response.status_code == 200
    assert response.json()["total"] == 3
    events[1].note = None
    await db_session.commit()
    response = await client.get(
        "/api/v1/spools/all-events",
        params={
            "filters": json.dumps(
                {
                    "note": {
                        "type": "text",
                        "operator": "notContains",
                        "value": "Moved",
                    },
                    "weight": {"type": "number", "operator": "gt", "value": "60.1"},
                }
            )
        },
    )
    assert response.status_code == 200
    assert response.json()["total"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params, count",
    [
        ({"search": "MÜNCHEN"}, 30),
        ({"search": "60.1"}, 1),
        (
            {
                "filters": json.dumps(
                    {
                        "manufacturer": {
                            "type": "text",
                            "operator": "equals",
                            "value": "ACME MÜNCHEN",
                        }
                    }
                )
            },
            30,
        ),
        (
            {
                "filters": json.dumps(
                    {
                        "note": {
                            "type": "text",
                            "operator": "contains",
                            "value": "MÜNCHEN",
                        }
                    }
                )
            },
            5,
        ),
        (
            {
                "filters": json.dumps(
                    {
                        "note": {
                            "type": "text",
                            "operator": "notContains",
                            "value": "MÜNCHEN",
                        }
                    }
                )
            },
            25,
        ),
    ],
)
async def test_log_text_controls_use_unicode_case_and_keep_numeric_search(
    auth_client, log_events, params, count
):
    client, _ = auth_client
    response = await client.get("/api/v1/spools/all-events", params=params)
    assert response.status_code == 200
    assert response.json()["total"] == count


@pytest.mark.asyncio
async def test_log_rejects_deeply_nested_filter_json(auth_client):
    client, _ = auth_client
    response = await client.get(
        "/api/v1/spools/all-events", params={"filters": "[" * 1500 + "0" + "]" * 1500}
    )
    assert response.status_code == 422
