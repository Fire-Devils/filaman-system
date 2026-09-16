"""Tag scans: any reader reports, any browser can follow."""

import pytest
from sqlalchemy import select

from app.models import TagReader
from tests.test_devices import (
    _create_device,
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _device_headers,
    _get_status,
    _register_device,
)


async def _scale(client, db_session, csrf_token, code="SCAN01", name="Waage"):
    await _create_device(db_session, device_code=code, name=name)
    token, device_id = await _register_device(client, code, csrf_token)
    return token, device_id


async def _spool_with_tag(db_session, uid, designation=None):
    manufacturer = await _create_manufacturer(db_session, name=f"Mfr {uid}")
    filament = await _create_filament(db_session, manufacturer.id)
    if designation:
        filament.designation = designation
        await db_session.commit()
    status = await _get_status(db_session, "new")
    return await _create_spool(db_session, filament.id, status.id, rfid_uid=uid)


class TestReportingAScan:
    @pytest.mark.asyncio
    async def test_a_device_reports_and_gets_the_match_back(self, auth_client, db_session):
        client, csrf = auth_client
        token, _ = await _scale(client, db_session, csrf)
        spool = await _spool_with_tag(db_session, "04:EF:14:10:C8:2A:81", "PLA Basic Black")

        response = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "04ef1410c82a81", "format": "ntag"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )

        assert response.status_code == 200, response.text
        data = response.json()
        # Spelling is normalised, so one tag reads the same however it arrives.
        assert data["uid"] == "04EF1410C82A81"
        assert data["matched_spool_id"] == spool.id
        assert data["filament_name"] == "PLA Basic Black"

    @pytest.mark.asyncio
    async def test_an_api_key_may_report_too(self, auth_client, db_session):
        """A phone app signs in with an API key and is a reader like any other."""
        client, csrf = auth_client
        spool = await _spool_with_tag(db_session, "AABBCCDD")

        response = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "AABBCCDD", "reader_id": "iphone-nikolai", "name": "iPhone"},
            headers={"X-CSRF-Token": csrf},
        )

        assert response.status_code == 200, response.text
        data = response.json()
        assert data["matched_spool_id"] == spool.id
        assert data["reader_id"] == "iphone-nikolai"

        newest = (await client.get("/api/v1/tag/last-scan")).json()
        assert newest["reader_id"] == "iphone-nikolai"
        assert newest["reader_name"] == "iPhone"

    @pytest.mark.asyncio
    async def test_a_reader_without_an_id_gets_one_from_its_credential(
        self, auth_client, db_session
    ):
        """Stable for as long as the credential is, so a binding survives a reboot."""
        client, csrf = auth_client
        token, device_id = await _scale(client, db_session, csrf)

        first = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "1111"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )
        second = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "2222"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )

        assert first.json()["reader_id"] == f"device-{device_id}"
        assert second.json()["reader_id"] == f"device-{device_id}"
        readers = (await client.get("/api/v1/tag/readers")).json()
        assert [r["reader_id"] for r in readers] == [f"device-{device_id}"]
        assert readers[0]["name"] == "Waage"

    @pytest.mark.asyncio
    async def test_the_second_spelling_of_a_tag_also_resolves(self, auth_client, db_session):
        """A Bambu chip carries a hardware uid and a tray uuid; either may be on file."""
        client, csrf = auth_client
        token, _ = await _scale(client, db_session, csrf)
        # On file under the tray uuid, as the Bambu driver writes it.
        spool = await _spool_with_tag(db_session, "D12461A84CE0476286B4E47FD62390C3")

        response = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "15B4B7A4", "alt_uid": "D12461A84CE0476286B4E47FD62390C3"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )

        assert response.status_code == 200, response.text
        assert response.json()["matched_spool_id"] == spool.id
        # Still reported under what was physically read.
        assert response.json()["uid"] == "15B4B7A4"

    @pytest.mark.asyncio
    async def test_an_unknown_tag_is_a_scan_without_a_match(self, auth_client, db_session):
        """Not an error: the browser says so rather than jumping somewhere."""
        client, csrf = auth_client
        token, _ = await _scale(client, db_session, csrf)

        response = await client.post(
            "/api/v1/tag/scan",
            json={"uid": "DEADBEEF"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )

        assert response.status_code == 200, response.text
        assert response.json()["matched_spool_id"] is None
        assert (await client.get("/api/v1/tag/last-scan")).json()["spool_id"] is None

    @pytest.mark.asyncio
    async def test_a_reader_keeps_one_row_however_often_it_scans(self, auth_client, db_session):
        """A scan is a moment, not history."""
        client, csrf = auth_client
        token, _ = await _scale(client, db_session, csrf)

        for uid in ("1111", "2222", "3333"):
            await client.post(
                "/api/v1/tag/scan",
                json={"uid": uid},
                headers={**_device_headers(token), "X-CSRF-Token": csrf},
            )

        rows = (await db_session.execute(select(TagReader))).scalars().all()
        assert len(rows) == 1
        assert rows[0].last_uid == "3333"


class TestFollowingAReader:
    @pytest.mark.asyncio
    async def test_nothing_scanned_yet_is_a_normal_answer(self, auth_client):
        client, _ = auth_client
        response = await client.get("/api/v1/tag/last-scan")
        assert response.status_code == 200, response.text
        assert response.json()["seq"] == 0

    @pytest.mark.asyncio
    async def test_the_newest_wins_and_one_reader_can_be_singled_out(
        self, auth_client, db_session
    ):
        client, csrf = auth_client
        bench, _ = await _scale(client, db_session, csrf, "SCAN01", "Werkstatt")
        shelf, _ = await _scale(client, db_session, csrf, "SCAN02", "Regal")

        for token, uid, reader in (
            (bench, "AA11", "bench"),
            (shelf, "BB22", "shelf"),
        ):
            assert (
                await client.post(
                    "/api/v1/tag/scan",
                    json={"uid": uid, "reader_id": reader},
                    headers={**_device_headers(token), "X-CSRF-Token": csrf},
                )
            ).status_code == 200

        newest = (await client.get("/api/v1/tag/last-scan")).json()
        assert newest["reader_id"] == "shelf"

        bound = (await client.get("/api/v1/tag/last-scan?reader_id=bench")).json()
        assert bound["reader_id"] == "bench"
        assert bound["uid"] == "AA11"

    @pytest.mark.asyncio
    async def test_the_label_travels_with_the_scan(self, auth_client, db_session):
        """So an offer can name the spool without a second request."""
        client, csrf = auth_client
        token, _ = await _scale(client, db_session, csrf)
        await _spool_with_tag(db_session, "CAFE1234", "PETG HF White")

        await client.post(
            "/api/v1/tag/scan",
            json={"uid": "CAFE1234"},
            headers={**_device_headers(token), "X-CSRF-Token": csrf},
        )

        assert (await client.get("/api/v1/tag/last-scan")).json()["spool_label"] == "PETG HF White"

    @pytest.mark.asyncio
    async def test_reporting_needs_a_principal(self, client):
        response = await client.post("/api/v1/tag/scan", json={"uid": "AA11"})
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_following_needs_a_principal(self, client):
        assert (await client.get("/api/v1/tag/last-scan")).status_code == 401
