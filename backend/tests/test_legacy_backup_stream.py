"""Legacy backup compatibility and bounded restoration."""

import io
import json

import pytest
from app.api.v1 import system
from app.models import Manufacturer
from fastapi import UploadFile
from sqlalchemy import select


@pytest.mark.asyncio
@pytest.mark.parametrize("format", ["json", "auto"])
async def test_exported_legacy_backup_restores_above_aggregate_limit(
    auth_client, db_session, tmp_path, monkeypatch, format
):
    from app.services import backup_stream

    # Scale the former aggregate limit and the JSONL record limit, not the data path.
    monkeypatch.setattr(system, "MAX_BACKUP_UPLOAD_BYTES", 1024, raising=False)
    monkeypatch.setattr(backup_stream, "MAX_BACKUP_RECORD_BYTES", 2048)
    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    db_session.add(Manufacturer(name="Large row", custom_fields={"text": "x" * 4096}))
    await db_session.commit()
    client, token = auth_client
    exported = await client.get(
        f"/api/v1/admin/system/backup/export-inventory?format={format}"
    )
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/json"
    response = await client.post(
        "/api/v1/admin/system/backup/import-inventory",
        files={"file": ("backup.json", exported.content, "application/json")},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 200, response.text
    restored = await db_session.scalar(select(Manufacturer))
    assert restored.custom_fields == {"text": "x" * 4096}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "media_type", ["application/json; charset=utf-8", "text/plain; charset=utf-8"]
)
async def test_inventory_restore_accepts_mime_parameters(
    auth_client, tmp_path, monkeypatch, media_type
):
    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    client, token = auth_client
    response = await client.post(
        "/api/v1/admin/system/backup/import-inventory",
        files={"file": ("backup.json", b'{"metadata":{},"data":{}}', media_type)},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["import", "import-inventory"])
async def test_legacy_syntax_errors_keep_invalid_json_code(auth_client, endpoint):
    client, token = auth_client
    response = await client.post(
        f"/api/v1/admin/system/backup/{endpoint}",
        files={"file": ("backup.json", b'{"metadata":{},"data":{', "application/json")},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_json"


@pytest.mark.asyncio
async def test_legacy_preparation_uses_bounded_reads():
    class BoundedStream(io.BytesIO):
        def read(self, size=-1):
            assert 0 <= size <= 65536, f"unbounded backup read: {size}"
            return super().read(size)

    content = json.dumps(
        {"data": {"manufacturers": [{"name": "x" * 1000}] * 100}, "metadata": {}}
    ).encode()
    file = UploadFile(BoundedStream(content), filename="backup.json")
    async with system._prepare_backup_upload(file, "inventory") as (
        _format,
        metadata,
        tables,
    ):
        assert metadata == {}
        assert tables is not None
        assert sum(1 for _line in tables["manufacturers"]) == 100


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "utf-32"])
def test_legacy_stream_preserves_order_independent_values_and_encoding(encoding):
    from app.services.backup_stream import read_legacy_backup

    # Metadata last; duplicate table/key uses the last value like json.loads.
    content = '{"data":{"manufacturers":[{"name":"discard"}],"locations":[],"manufacturers":[{"name":"Ä☃","custom_fields":{"number":-123.45e+6,"value":[true,null,false]}}]},"metadata":{"old":true},"metadata":{"new":true},"ignored":{"nested":[1,{"x":false}]}}'

    class ShortStream(io.BytesIO):
        def read(self, size=-1):
            return super().read(min(size, 7))

    with read_legacy_backup(
        ShortStream(content.encode(encoding)), {"manufacturers", "locations"}
    ) as (metadata, tables):
        assert metadata == {"new": True}
        assert list(tables["locations"]) == []
        assert [json.loads(row) for row in tables["manufacturers"]] == [
            {
                "name": "Ä☃",
                "custom_fields": {"number": -123450000.0, "value": [True, None, False]},
            }
        ]
    assert all(table.closed for table in tables.values())


@pytest.mark.parametrize(
    "content",
    [
        b'{"metadata":{},"data":{"manufacturers":[{"name":"ok"},]}}',
        b'{"metadata":{},"data":{},}',
        b'{"metadata":{},"data":{}} false',
        b'{"metadata":{},"data":{"manufacturers":[{"value":1e}]}}',
        b'{"metadata":{},"data":{"manufacturers":[{"value":01}]}}',
        b'{"metadata":{},"data":{"manufacturers":[{"value":"\\u12zz"}]}}',
        b'{"metadata":{},"data":{"manufacturers":[],"manufacturers":[invalid]}}',
        b'{"metadata":{},"data":{"manufacturers":[]},"data":{"locations":[invalid]}}',
    ],
)
def test_legacy_stream_rejects_invalid_json_and_closes_staged_files(
    content, monkeypatch
):
    from app.services import backup_stream

    original = backup_stream.tempfile.TemporaryFile
    opened = []

    def track_file(*args, **kwargs):
        file = original(*args, **kwargs)
        opened.append(file)
        return file

    monkeypatch.setattr(backup_stream.tempfile, "TemporaryFile", track_file)
    with (
        pytest.raises(backup_stream.LegacyBackupJSONError),
        backup_stream.read_legacy_backup(io.BytesIO(content), {"manufacturers"}),
    ):
        pytest.fail("invalid backup accepted")
    assert all(file.closed for file in opened)


def test_legacy_stream_does_not_retain_previous_rows(tmp_path):
    import tracemalloc

    from app.services.backup_stream import read_legacy_backup

    path = tmp_path / "large.json"
    row = json.dumps({"name": "x" * 65536}).encode()
    with path.open("wb") as output:
        output.write(b'{"metadata":{},"data":{"manufacturers":[')
        for index in range(160):
            output.write((b"," if index else b"") + row)
        output.write(b"]}}")
    tracemalloc.start()
    try:
        with (
            path.open("rb") as stream,
            read_legacy_backup(stream, {"manufacturers"}) as (_metadata, tables),
        ):
            assert sum(1 for _row in tables["manufacturers"]) == 160
            _current, peak = tracemalloc.get_traced_memory()
        assert peak < 2 * 1024 * 1024, f"retained backup rows: {peak} bytes"
    finally:
        tracemalloc.stop()


@pytest.mark.asyncio
async def test_legacy_restore_orders_tables_and_rolls_back_bad_rows(
    auth_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    client, token = auth_client
    # Filaments precede their manufacturer in the file; restore must use FK order.
    payload = {
        "data": {
            "filaments": [
                {
                    "id": 9999,
                    "manufacturer_id": 9998,
                    "designation": "restored",
                    "material_type": "PLA",
                    "diameter_mm": 1.75,
                }
            ],
            "manufacturers": [{"id": 9998, "name": "Restored"}],
        },
        "metadata": {},
    }
    response = await client.post(
        "/api/v1/admin/system/backup/import-inventory",
        files={"file": ("backup.json", json.dumps(payload), "application/json")},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 200, response.text
    assert response.json()["imported"]["filaments"] == 1
    payload["data"]["manufacturers"].append({"id": 10000, "name": None})
    response = await client.post(
        "/api/v1/admin/system/backup/import-inventory",
        files={"file": ("backup.json", json.dumps(payload), "application/json")},
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code == 500
    assert (await db_session.get(Manufacturer, 9998)).name == "Restored"
    assert await db_session.get(Manufacturer, 10000) is None


def test_legacy_stream_rejects_early_syntax_error_without_reading_tail():
    from app.services.backup_stream import LegacyBackupJSONError, read_legacy_backup

    content = b'{"metadata":{},"data":{"manufacturers":[{"name":invalid,' + b" " * (
        1024 * 1024
    )
    stream = io.BytesIO(content)
    with (
        pytest.raises(LegacyBackupJSONError),
        read_legacy_backup(stream, {"manufacturers"}),
    ):
        pytest.fail("invalid backup accepted")
    assert stream.tell() < 100000


def test_legacy_stream_duplicate_data_replaces_previous_tables():
    from app.services.backup_stream import read_legacy_backup

    content = b'{"metadata":{},"data":{"manufacturers":[{"name":"old"}]},"data":{"locations":[]}}'
    with read_legacy_backup(io.BytesIO(content), {"manufacturers", "locations"}) as (
        _metadata,
        tables,
    ):
        assert set(tables) == {"locations"}


@pytest.mark.parametrize("duplicate_key", ["table", "data"])
def test_legacy_duplicate_keys_release_replaced_files(duplicate_key):
    import tracemalloc

    from app.services.backup_stream import read_legacy_backup

    if duplicate_key == "table":
        content = (
            b'{"metadata":{},"data":{'
            + b'"manufacturers":[],' * 10000
            + b'"manufacturers":[{"name":"kept"}]}}'
        )
        expected_table = "manufacturers"
    else:
        content = (
            b'{"metadata":{},'
            + b'"data":{"manufacturers":[]},' * 10000
            + b'"data":{"locations":[{"name":"kept"}]}}'
        )
        expected_table = "locations"
    tracemalloc.start()
    try:
        with read_legacy_backup(
            io.BytesIO(content), {"manufacturers", "locations"}
        ) as (_metadata, tables):
            assert set(tables) == {expected_table}
            assert [json.loads(row) for row in tables[expected_table]] == [{"name": "kept"}]
            _current, peak = tracemalloc.get_traced_memory()
            assert peak < 2 * 1024 * 1024, f"retained replaced files: {peak} bytes"
        assert all(table.closed for table in tables.values())
    finally:
        tracemalloc.stop()


def test_legacy_stream_closes_current_tables_when_import_fails():
    from app.services.backup_stream import read_legacy_backup

    content = b'{"metadata":{},"data":{"manufacturers":[],"locations":[]}}'
    with (
        pytest.raises(RuntimeError, match="import failed"),
        read_legacy_backup(io.BytesIO(content), {"manufacturers", "locations"}) as (
            _metadata,
            tables,
        ),
    ):
        raise RuntimeError("import failed")
    assert all(table.closed for table in tables.values())
