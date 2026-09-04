"""Two RFID chips per spool: normalisation, slot service, API, write-tag, migration."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

from app.core.rfid import normalize_rfid_uid, rfid_uids_equal
from app.models import Location, Spool
from app.services.spool_service import RfidSlotsFullError, SpoolService
from tests.test_devices import (
    _create_device,
    _create_filament,
    _create_location,
    _create_manufacturer,
    _create_spool,
    _device_headers,
    _get_status,
    _register_device,
)

CHIP_A = "04:EF:14:10:C8:2A:81"
CHIP_A_COMPACT = "04ef1410c82a81"
CHIP_B = "04:98:51:11:C8:2A:81"
CHIP_C = "04:11:22:33:44:55:66"


async def _spool_fixture(db_session, **kwargs) -> Spool:
    manufacturer = await _create_manufacturer(db_session)
    filament = await _create_filament(db_session, manufacturer.id)
    status = await _get_status(db_session, "new")
    return await _create_spool(db_session, filament.id, status.id, **kwargs)


async def _second_spool(db_session, first: Spool, **kwargs) -> Spool:
    status = await _get_status(db_session, "new")
    return await _create_spool(db_session, first.filament_id, status.id, **kwargs)


# ---------------------------------------------------------------------------
# normalisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("04:ef:14:10:c8:2a:81", "04:EF:14:10:C8:2A:81"),
        ("04EF1410C82A81", "04:EF:14:10:C8:2A:81"),
        ("04-ef-14-10-c8-2a-81", "04:EF:14:10:C8:2A:81"),
        ("  04 ef 14 10 c8 2a 81 ", "04:EF:14:10:C8:2A:81"),
        ("rfid-123", "RFID-123"),  # non-hex legacy/test data: only upper-cased
        ("ABC", "ABC"),  # odd length is not a byte string: left alone
        ("", None),
        ("   ", None),
        (None, None),
    ],
)
def test_normalize_rfid_uid(raw, expected):
    assert normalize_rfid_uid(raw) == expected


def test_rfid_uids_equal_across_spellings():
    assert rfid_uids_equal(CHIP_A, CHIP_A_COMPACT)
    assert rfid_uids_equal("rfid-1", "RFID-1")
    assert not rfid_uids_equal(CHIP_A, CHIP_B)
    assert not rfid_uids_equal(None, CHIP_A)
    assert not rfid_uids_equal("", "")


# ---------------------------------------------------------------------------
# service
# ---------------------------------------------------------------------------


class TestRfidSlotService:
    async def test_add_fills_first_then_second_slot(self, db_session):
        spool = await _spool_fixture(db_session)
        service = SpoolService(db_session)

        change = await service.add_rfid_uid(spool, CHIP_A_COMPACT)
        assert change.removed_from == [] and not change.already_assigned
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, None)

        await service.add_rfid_uid(spool, CHIP_B)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_B)

    async def test_add_same_chip_in_other_spelling_is_noop(self, db_session):
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A)
        change = await SpoolService(db_session).add_rfid_uid(spool, CHIP_A_COMPACT)
        assert change.already_assigned
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, None)

    async def test_full_slots_reject_unless_replace(self, db_session):
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        service = SpoolService(db_session)

        with pytest.raises(RfidSlotsFullError):
            await service.add_rfid_uid(spool, CHIP_C)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_B)

        change = await service.add_rfid_uid(spool, CHIP_C, replace_secondary=True)
        assert change.replaced_uid == CHIP_B
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_C)

    async def test_add_steals_from_other_spool_secondary_slot(self, db_session):
        victim = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        winner = await _second_spool(db_session, victim)

        change = await SpoolService(db_session).add_rfid_uid(winner, CHIP_B)
        await db_session.commit()

        assert change.removed_from == [f"Spule #{victim.id}"]
        await db_session.refresh(victim)
        assert (victim.rfid_uid, victim.rfid_uid_2) == (CHIP_A, None)
        assert (winner.rfid_uid, winner.rfid_uid_2) == (CHIP_B, None)

    async def test_add_steals_primary_and_victim_shifts_secondary_down(self, db_session):
        victim = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        winner = await _second_spool(db_session, victim)

        await SpoolService(db_session).add_rfid_uid(winner, CHIP_A_COMPACT)
        await db_session.commit()

        await db_session.refresh(victim)
        assert (victim.rfid_uid, victim.rfid_uid_2) == (CHIP_B, None)
        assert winner.rfid_uid == CHIP_A

    async def test_add_steals_from_location(self, db_session):
        location = await _create_location(db_session, name="Shelf", identifier=CHIP_A)
        spool = await _spool_fixture(db_session)

        change = await SpoolService(db_session).add_rfid_uid(spool, CHIP_A)
        await db_session.commit()

        assert change.removed_from == ["Standort 'Shelf'"]
        await db_session.refresh(location)
        assert location.identifier is None

    async def test_remove_primary_shifts_secondary_down(self, db_session):
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        service = SpoolService(db_session)

        assert await service.remove_rfid_uid(spool, CHIP_A_COMPACT)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_B, None)

        assert await service.remove_rfid_uid(spool, CHIP_B)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (None, None)

        assert not await service.remove_rfid_uid(spool, CHIP_C)

    async def test_set_collapses_duplicate_slots(self, db_session):
        spool = await _spool_fixture(db_session)
        await SpoolService(db_session).set_rfid_uids(
            spool, rfid_uid=CHIP_A, rfid_uid_2=CHIP_A_COMPACT
        )
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, None)

    async def test_identify_by_either_slot_any_spelling(self, db_session):
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        service = SpoolService(db_session)

        for probe in (CHIP_A, CHIP_A_COMPACT, CHIP_B, CHIP_B.lower().replace(":", "")):
            found = await service.get_spool_by_identifier(probe, None)
            assert found is not None and found.id == spool.id, probe

        assert await service.get_spool_by_identifier(CHIP_C, None) is None
        assert await service.get_spool_by_identifier("", None) is None

    async def test_identify_legacy_raw_value_written_directly(self, db_session):
        # Rows written without the service (legacy data the migration could not
        # rewrite) still resolve via the raw-spelling fallback.
        spool = await _spool_fixture(db_session, rfid_uid="abc123")
        found = await SpoolService(db_session).get_spool_by_identifier("ABC123", None)
        assert found is not None and found.id == spool.id


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


class TestRfidSlotApi:
    async def _base(self, db_session) -> tuple[int, int]:
        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        return filament.id, status.id

    async def test_create_with_both_slots_normalises(self, auth_client, db_session):
        client, csrf = auth_client
        filament_id, _ = await self._base(db_session)

        response = await client.post(
            "/api/v1/spools",
            json={
                "filament_id": filament_id,
                "rfid_uid": CHIP_A_COMPACT,
                "rfid_uid_2": CHIP_B.lower(),
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert (body["rfid_uid"], body["rfid_uid_2"]) == (CHIP_A, CHIP_B)

    async def test_create_only_secondary_backfills_primary(self, auth_client, db_session):
        client, csrf = auth_client
        filament_id, _ = await self._base(db_session)

        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": filament_id, "rfid_uid_2": CHIP_A},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 201, response.text
        assert (response.json()["rfid_uid"], response.json()["rfid_uid_2"]) == (CHIP_A, None)

    async def test_create_steals_from_existing_spool(self, auth_client, db_session):
        client, csrf = auth_client
        victim = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)

        response = await client.post(
            "/api/v1/spools",
            json={"filament_id": victim.filament_id, "rfid_uid": CHIP_B},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 201, response.text

        await db_session.refresh(victim)
        assert (victim.rfid_uid, victim.rfid_uid_2) == (CHIP_A, None)

    async def test_patch_second_slot_and_clear_primary(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A)

        response = await client.patch(
            f"/api/v1/spools/{spool.id}",
            json={"rfid_uid_2": CHIP_B},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 200, response.text
        assert (response.json()["rfid_uid"], response.json()["rfid_uid_2"]) == (CHIP_A, CHIP_B)

        response = await client.patch(
            f"/api/v1/spools/{spool.id}",
            json={"rfid_uid": None},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 200, response.text
        assert (response.json()["rfid_uid"], response.json()["rfid_uid_2"]) == (CHIP_B, None)

    async def test_patch_unrelated_field_keeps_both_slots(self, auth_client, db_session):
        client, csrf = auth_client
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)

        response = await client.patch(
            f"/api/v1/spools/{spool.id}",
            json={"lot_number": "LOT-1"},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 200, response.text
        assert (response.json()["rfid_uid"], response.json()["rfid_uid_2"]) == (CHIP_A, CHIP_B)

    async def test_bulk_create_drops_both_slots_for_quantity_gt_1(self, auth_client, db_session):
        client, csrf = auth_client
        filament_id, _ = await self._base(db_session)

        response = await client.post(
            "/api/v1/spools/bulk",
            json={
                "filament_id": filament_id,
                "quantity": 2,
                "rfid_uid": CHIP_A,
                "rfid_uid_2": CHIP_B,
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 201, response.text
        assert all(
            item["rfid_uid"] is None and item["rfid_uid_2"] is None
            for item in response.json()
        )

    async def test_list_search_matches_second_slot_and_compact_spelling(
        self, auth_client, db_session
    ):
        client, _ = auth_client
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        await _second_spool(db_session, spool, rfid_uid=CHIP_C)

        for term in (CHIP_B, "04985111C82A81", "985111c8"):
            response = await client.get("/api/v1/spools", params={"search": term})
            assert response.status_code == 200, response.text
            ids = [item["id"] for item in response.json()["items"]]
            assert ids == [spool.id], term


# ---------------------------------------------------------------------------
# write-tag result from the ESP32
# ---------------------------------------------------------------------------


class TestRfidResultAddsSecondChip:
    async def _device(self, auth_client, db_session):
        client, csrf = auth_client
        await _create_device(db_session, device_code="ABC123")
        token, device_id = await _register_device(client, "ABC123", csrf)
        return client, {**_device_headers(token), "X-CSRF-Token": csrf}, device_id

    async def _write(self, client, headers, spool_id: int, uid: str):
        response = await client.post(
            "/api/v1/devices/rfid-result",
            json={"success": True, "tag_uuid": uid, "spool_id": spool_id},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        return response

    async def test_successive_writes_fill_then_replace_secondary(
        self, auth_client, db_session
    ):
        client, headers, device_id = await self._device(auth_client, db_session)
        spool = await _spool_fixture(db_session)

        await self._write(client, headers, spool.id, CHIP_A_COMPACT)
        await db_session.refresh(spool)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, None)

        await self._write(client, headers, spool.id, CHIP_B)
        await db_session.refresh(spool)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_B)

        # Re-writing an existing chip changes nothing.
        await self._write(client, headers, spool.id, CHIP_A)
        await db_session.refresh(spool)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_B)

        # Both slots full: the chip is already written, so the secondary is replaced.
        await self._write(client, headers, spool.id, CHIP_C)
        await db_session.refresh(spool)
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, CHIP_C)

        status = (await client.get(f"/api/v1/devices/{device_id}/write-status")).json()
        assert "ersetzt" in (status.get("removed_from") or "")

    async def test_write_steals_chip_from_other_spool(self, auth_client, db_session):
        client, headers, device_id = await self._device(auth_client, db_session)
        victim = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        winner = await _second_spool(db_session, victim)

        await self._write(client, headers, winner.id, CHIP_B)

        await db_session.refresh(victim)
        await db_session.refresh(winner)
        assert (victim.rfid_uid, victim.rfid_uid_2) == (CHIP_A, None)
        assert (winner.rfid_uid, winner.rfid_uid_2) == (CHIP_B, None)

        status = (await client.get(f"/api/v1/devices/{device_id}/write-status")).json()
        assert status["removed_from"] == f"Spule #{victim.id}"

    async def test_location_write_takes_chip_from_spool(self, auth_client, db_session):
        client, headers, _ = await self._device(auth_client, db_session)
        spool = await _spool_fixture(db_session, rfid_uid=CHIP_A, rfid_uid_2=CHIP_B)
        location = await _create_location(db_session, name="Bin 1")

        response = await client.post(
            "/api/v1/devices/rfid-result",
            json={"success": True, "tag_uuid": CHIP_B, "location_id": location.id},
            headers=headers,
        )
        assert response.status_code == 200, response.text

        await db_session.refresh(spool)
        await db_session.refresh(location)
        assert location.identifier == CHIP_B
        assert (spool.rfid_uid, spool.rfid_uid_2) == (CHIP_A, None)


# ---------------------------------------------------------------------------
# migration
# ---------------------------------------------------------------------------

MIGRATION_PATH = (
    Path(__file__).parents[1] / "alembic" / "versions" / "b3c7d1e9f402_add_spool_rfid_uid_2.py"
)


def _load_migration_module():
    spec = importlib.util.spec_from_file_location("rfid_uid_2_migration", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_adds_slot_and_canonicalises_existing_uids(tmp_path):
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    metadata = sa.MetaData()
    spools = sa.Table(
        "spools",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("rfid_uid", sa.String(100), nullable=True, unique=True),
    )
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            spools.insert(),
            [
                {"id": 1, "rfid_uid": "04:ef:14:10:c8:2a:81"},  # lower-case colon form
                {"id": 2, "rfid_uid": "04985111C82A81"},  # compact form
                {"id": 3, "rfid_uid": "rfid-legacy"},  # non-hex
                {"id": 4, "rfid_uid": None},
                {"id": 5, "rfid_uid": "AB:CD:EF:01"},  # canonical already
                {"id": 6, "rfid_uid": "abcdef01"},  # collides with 5 -> left alone
                {"id": 7, "rfid_uid": "   "},  # blank -> cleared
            ],
        )

    module = _load_migration_module()
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            module.upgrade()

    with engine.connect() as connection:
        rows = dict(
            connection.execute(sa.text("SELECT id, rfid_uid FROM spools ORDER BY id")).fetchall()
        )
        assert rows == {
            1: "04:EF:14:10:C8:2A:81",
            2: "04:98:51:11:C8:2A:81",
            3: "RFID-LEGACY",
            4: None,
            5: "AB:CD:EF:01",
            6: "abcdef01",
            7: None,
        }
        columns = {c["name"] for c in sa.inspect(connection).get_columns("spools")}
        assert "rfid_uid_2" in columns
        indexes = {i["name"]: i for i in sa.inspect(connection).get_indexes("spools")}
        assert indexes["ix_spools_rfid_uid_2"]["unique"]

    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            module.downgrade()

    with engine.connect() as connection:
        columns = {c["name"] for c in sa.inspect(connection).get_columns("spools")}
        assert "rfid_uid_2" not in columns
