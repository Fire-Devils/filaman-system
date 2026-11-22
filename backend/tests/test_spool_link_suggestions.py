from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models import Filament, Manufacturer, Spool, SpoolEvent, SpoolLinkSuggestion, SpoolStatus
from app.services import spool_link_service as links
from tests.test_rbac import _create_session, viewer_user  # noqa: F401


async def _filament(db, name="PLA Black"):
    maker = await db.scalar(select(Manufacturer).where(Manufacturer.name == "LinkMaker"))
    if maker is None:
        maker = Manufacturer(name="LinkMaker")
        db.add(maker)
        await db.commit()
    filament = Filament(
        manufacturer_id=maker.id, designation=name, material_type="PLA", diameter_mm=1.75
    )
    db.add(filament)
    await db.commit()
    await db.refresh(filament)
    return filament


async def _spool(db, filament_id, status_key="new", age_min=0, **kwargs):
    status = await db.scalar(select(SpoolStatus).where(SpoolStatus.key == status_key))
    spool = Spool(
        filament_id=filament_id,
        status_id=status.id,
        created_at=datetime.now(timezone.utc) - timedelta(minutes=age_min),
        **kwargs,
    )
    db.add(spool)
    await db.commit()
    await db.refresh(spool)
    return spool


async def _propose(db, filament_id, external_id="TAG1", **kwargs):
    return await links.propose_spool_link(
        db, external_id=external_id, filament_id=filament_id, source="bambulab", **kwargs
    )


@pytest.mark.asyncio
async def test_candidates_rules_and_ordering(db_session):
    f = await _filament(db_session)
    other = await _filament(db_session, "Other")
    newer = await _spool(db_session, f.id, age_min=1)
    oldest = await _spool(db_session, f.id, age_min=10)
    await _spool(db_session, f.id, status_key="opened")
    await _spool(db_session, f.id, external_id="x")
    await _spool(db_session, f.id, rfid_uid="abc")
    await _spool(db_session, other.id)

    ids = [s.id for s in await links.find_link_candidates(db_session, f.id)]
    assert ids == [oldest.id, newer.id]


@pytest.mark.asyncio
async def test_propose_flow(db_session):
    f = await _filament(db_session)
    assert await _propose(db_session, f.id) == links.LINK_NO_CANDIDATES
    assert (await db_session.scalars(select(SpoolLinkSuggestion))).all() == []

    await _spool(db_session, f.id)
    assert await _propose(db_session, f.id, slot_label="AMS A1") == links.LINK_PENDING
    assert await _propose(db_session, f.id, slot_label="AMS B2", remaining_weight_g=900.0) == links.LINK_PENDING
    rows = (await db_session.scalars(select(SpoolLinkSuggestion))).all()
    assert len(rows) == 1
    assert rows[0].slot_label == "AMS B2" and rows[0].remaining_weight_g == 900.0

    await links.dismiss_suggestion(db_session, rows[0])
    assert await _propose(db_session, f.id) == links.LINK_DISMISSED
    # another tag is independent
    assert await _propose(db_session, f.id, external_id="TAG2") == links.LINK_PENDING


@pytest.mark.asyncio
async def test_propose_returns_linked_after_link(db_session):
    f = await _filament(db_session)
    spool = await _spool(db_session, f.id)
    await _propose(db_session, f.id)
    suggestion = await db_session.scalar(select(SpoolLinkSuggestion))
    await links.link_suggestion(db_session, suggestion, spool.id)
    assert await _propose(db_session, f.id) == links.LINK_LINKED


@pytest.mark.asyncio
async def test_link_merges_and_opens(db_session):
    f = await _filament(db_session)
    spool = await _spool(
        db_session, f.id, custom_fields={"keep": "mine", "empty": ""}
    )
    await _propose(
        db_session, f.id, tag_data={"keep": "tag", "empty": "filled", "new": 1}, remaining_weight_g=950.0
    )
    suggestion = await db_session.scalar(select(SpoolLinkSuggestion))
    await links.link_suggestion(db_session, suggestion, spool.id)

    await db_session.refresh(spool)
    status = await db_session.get(SpoolStatus, spool.status_id)
    assert status.key == "opened"
    assert spool.external_id == "TAG1"
    assert spool.custom_fields == {"keep": "mine", "empty": "filled", "new": 1}
    assert spool.remaining_weight_g == 950.0
    assert suggestion.status == "linked" and suggestion.linked_spool_id == spool.id
    events = (await db_session.scalars(select(SpoolEvent).where(SpoolEvent.spool_id == spool.id))).all()
    assert any(e.event_type == "opened" for e in events)


@pytest.mark.asyncio
async def test_link_keeps_existing_weight_and_rejects_non_candidate(db_session):
    f = await _filament(db_session)
    spool = await _spool(db_session, f.id, remaining_weight_g=1000.0)
    opened = await _spool(db_session, f.id, status_key="opened")
    await _propose(db_session, f.id, remaining_weight_g=500.0)
    suggestion = await db_session.scalar(select(SpoolLinkSuggestion))

    with pytest.raises(links.SpoolLinkError):
        await links.link_suggestion(db_session, suggestion, opened.id)
    await links.link_suggestion(db_session, suggestion, spool.id)
    await db_session.refresh(spool)
    assert spool.remaining_weight_g == 1000.0
    with pytest.raises(links.SpoolLinkError):
        await links.link_suggestion(db_session, suggestion, spool.id)


@pytest.mark.asyncio
async def test_api_list_link_dismiss(auth_client, db_session):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    f = await _filament(db_session)
    first = await _spool(db_session, f.id, age_min=10, lot_number="L1")
    second = await _spool(db_session, f.id, age_min=1)
    await _propose(db_session, f.id, slot_label="AMS A1")
    await _propose(db_session, f.id, external_id="TAG2")

    listing = (await client.get("/api/v1/spool-link-suggestions")).json()
    assert len(listing) == 2
    item = listing[0]
    assert item["filament"]["designation"] == "PLA Black"
    assert item["filament"]["manufacturer_name"] == "LinkMaker"
    assert item["slot_label"] == "AMS A1"
    assert [c["id"] for c in item["candidates"]] == [first.id, second.id]
    assert item["candidates"][0]["lot_number"] == "L1"

    assert (await client.post("/api/v1/spool-link-suggestions/999/dismiss", headers=headers)).status_code == 404
    bad = await client.post(
        f"/api/v1/spool-link-suggestions/{item['id']}/link", json={"spool_id": 99999}, headers=headers
    )
    assert bad.status_code == 409
    ok = await client.post(
        f"/api/v1/spool-link-suggestions/{item['id']}/link", json={"spool_id": first.id}, headers=headers
    )
    assert ok.status_code == 200 and ok.json()["linked_spool_id"] == first.id
    again = await client.post(
        f"/api/v1/spool-link-suggestions/{item['id']}/dismiss", headers=headers
    )
    assert again.status_code == 409

    other_id = listing[1]["id"]
    done = await client.post(f"/api/v1/spool-link-suggestions/{other_id}/dismiss", headers=headers)
    assert done.status_code == 200 and done.json()["status"] == "dismissed"
    assert (await client.get("/api/v1/spool-link-suggestions")).json() == []


@pytest.mark.asyncio
async def test_api_requires_auth_and_update_permission(client, viewer_user, db_session):
    f = await _filament(db_session)
    spool = await _spool(db_session, f.id)
    await _propose(db_session, f.id)
    suggestion = await db_session.scalar(select(SpoolLinkSuggestion))

    assert (await client.get("/api/v1/spool-link-suggestions")).status_code == 401

    client, csrf = await _create_session(client, db_session, viewer_user.id)
    headers = {"X-CSRF-Token": csrf}
    assert (await client.get("/api/v1/spool-link-suggestions")).status_code == 200
    base = f"/api/v1/spool-link-suggestions/{suggestion.id}"
    assert (await client.post(f"{base}/link", json={"spool_id": spool.id}, headers=headers)).status_code == 403
    assert (await client.post(f"{base}/dismiss", headers=headers)).status_code == 403
    await db_session.refresh(suggestion)
    assert suggestion.status == "pending"


@pytest.mark.asyncio
async def test_spool_list_status_filter_unaffected(auth_client, db_session):
    client, _ = auth_client
    f = await _filament(db_session)
    sealed = await _spool(db_session, f.id)
    opened = await _spool(db_session, f.id, status_key="opened")
    new_id = sealed.status_id
    everything = (await client.get("/api/v1/spools")).json()
    ids = {s["id"] for s in everything["items"]}
    assert {sealed.id, opened.id} <= ids
    only_new = (await client.get(f"/api/v1/spools?status_id={new_id}")).json()
    assert {s["id"] for s in only_new["items"]} == {sealed.id}


@pytest.mark.asyncio
async def test_stale_pending_without_candidates_no_longer_blocks(db_session):
    f = await _filament(db_session)
    sealed = await _spool(db_session, f.id)
    assert await _propose(db_session, f.id) == links.LINK_PENDING

    # The sealed spool gets opened by hand, so nothing is left to link.
    opened = await db_session.scalar(select(SpoolStatus).where(SpoolStatus.key == "opened"))
    sealed.status_id = opened.id
    await db_session.commit()

    assert await _propose(db_session, f.id) == links.LINK_NO_CANDIDATES
    row = await db_session.scalar(select(SpoolLinkSuggestion))
    assert row.status == links.LINK_DISMISSED


@pytest.mark.asyncio
async def test_linked_tag_removed_again_is_treated_as_unknown(db_session):
    f = await _filament(db_session)
    first = await _spool(db_session, f.id, age_min=5)
    assert await _propose(db_session, f.id) == links.LINK_PENDING
    suggestion = await db_session.scalar(select(SpoolLinkSuggestion))
    await links.link_suggestion(db_session, suggestion, first.id)
    assert await _propose(db_session, f.id) == links.LINK_LINKED

    first.external_id = None
    await db_session.commit()
    assert await _propose(db_session, f.id) == links.LINK_NO_CANDIDATES

    await _spool(db_session, f.id)
    assert await _propose(db_session, f.id) == links.LINK_PENDING
