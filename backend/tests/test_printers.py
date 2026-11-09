import asyncio
import runpy
from pathlib import Path
from socket import socket
from tempfile import TemporaryDirectory

import httpx
from fastapi import FastAPI, HTTPException, Request
import pytest
from sqlalchemy import event
from sqlalchemy.orm.attributes import set_committed_value
from unittest.mock import AsyncMock, patch

from app.api.v1 import printers
from app.core import primary_socket, worker_reload
from app.models import Location, Printer, PrinterSlot


def test_primary_socket_separates_databases_with_the_same_temp_root():
    live = primary_socket._socket_path("sqlite+aiosqlite:////srv/live.db")
    staging = primary_socket._socket_path("sqlite+aiosqlite:////srv/staging.db")

    assert live.parent == staging.parent
    assert live != staging


def test_primary_socket_separates_relative_database_urls_by_working_directory(tmp_path, monkeypatch):
    database_url = "sqlite+aiosqlite:///fila.db"
    first = primary_socket._socket_path(database_url)
    monkeypatch.setattr(primary_socket, "_startup_directory", tmp_path)

    assert first != primary_socket._socket_path(database_url)


def test_primary_socket_survives_working_directory_changes(tmp_path, monkeypatch):
    first = primary_socket._socket_path("sqlite+aiosqlite:///fila.db")
    monkeypatch.chdir(tmp_path)

    assert first == primary_socket._socket_path("sqlite+aiosqlite:///fila.db")


def test_gunicorn_masters_give_reparented_workers_distinct_sockets(monkeypatch):
    database = "sqlite+aiosqlite:////srv/shared.db"
    monkeypatch.setenv("SERVER_SOFTWARE", "gunicorn/25")
    monkeypatch.setenv("FILAMAN_GUNICORN_INSTANCE", "")
    start_master = runpy.run_path(str(Path(__file__).parents[1] / "gunicorn.conf.py"))["on_starting"]
    monkeypatch.setattr(primary_socket.os, "getppid", lambda: 1)

    start_master(None)
    monkeypatch.setattr(primary_socket.os, "getpid", lambda: 502)
    first = primary_socket._socket_path(database)
    monkeypatch.setattr(primary_socket.os, "getpid", lambda: 503)
    assert first == primary_socket._socket_path(database)

    start_master(None)
    monkeypatch.setattr(primary_socket.os, "getpid", lambda: 504)
    assert first != primary_socket._socket_path(database)


def test_gunicorn_workers_without_master_identity_do_not_share_sockets(monkeypatch):
    database = "sqlite+aiosqlite:////srv/shared.db"
    monkeypatch.setenv("SERVER_SOFTWARE", "gunicorn/25")
    monkeypatch.delenv("FILAMAN_GUNICORN_INSTANCE", raising=False)
    monkeypatch.setattr(primary_socket.os, "getpid", lambda: 505)
    first = primary_socket._socket_path(database)
    assert first == primary_socket._socket_path(database)
    monkeypatch.setattr(primary_socket.os, "getpid", lambda: 506)
    assert first != primary_socket._socket_path(database)


@pytest.fixture
def private_socket_path(tmp_path, monkeypatch):
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)
    return primary_socket.primary_socket_path()


async def test_primary_socket_rejects_new_work_while_draining_inflight_requests(monkeypatch):
    app = FastAPI()
    started, release = asyncio.Event(), asyncio.Event()

    @app.post("/driver")
    async def driver():
        if started.is_set():
            return {"admitted_during_drain": True}
        started.set()
        await release.wait()
        return {"completed": True}

    with TemporaryDirectory(dir="/tmp", prefix="filaman-socket-") as directory, socket() as public_listener:
        monkeypatch.setattr(worker_reload, "_worker_listeners", (public_listener,))
        monkeypatch.setattr(primary_socket, "_runtime_dir", Path(directory))
        path = primary_socket.primary_socket_path()
        transport = httpx.AsyncHTTPTransport(uds=str(path))
        async with httpx.AsyncClient(transport=transport, timeout=3) as client:
            async with asyncio.timeout(3):
                async with primary_socket.serve_primary_socket(app) as publish:
                    with pytest.raises(httpx.ConnectError):
                        await client.get("http://localhost/driver")
                    publish()
                    response = asyncio.create_task(client.post("http://localhost/driver"))
                    await started.wait()
                    public_listener.close()
                    rejected = await client.post("http://localhost/driver")
                    asyncio.get_running_loop().call_later(0.2, release.set)
                assert rejected.status_code == 503
                assert rejected.json()["detail"]["code"] == "primary_worker_required"
                assert (await response).json() == {"completed": True}
                assert not path.exists()


@pytest.mark.parametrize("disconnect", [False, True])
async def test_primary_proxy_delivers_once_over_private_socket(monkeypatch, private_socket_path, disconnect):
    received = []

    def handle(request):
        received.append(request)
        if disconnect:
            raise httpx.ReadError("Primary exited after reading the request", request=request)
        return httpx.Response(200, json={"accepted": True})

    transport = httpx.MockTransport(handle)
    real_client = httpx.AsyncClient

    def private_transport(*, uds):
        assert uds == str(private_socket_path)
        return transport

    def client(**kwargs):
        assert kwargs.get("transport") is transport
        return real_client(**kwargs)

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", private_transport)
    monkeypatch.setattr(httpx, "AsyncClient", client)
    request = Request({
        "type": "http",
        "headers": [(b"cookie", b"session_id=test; csrf_token=token"), (b"x-csrf-token", b"token")],
        "query_string": b"refresh=1",
    })
    if disconnect:
        with pytest.raises(HTTPException) as error:
            await printers._proxy_to_primary(request, "POST", "/driver/action", {"spool_id": 67})
        assert error.value.status_code == 503
        assert error.value.detail["code"] == "primary_proxy_failed"
    else:
        assert await printers._proxy_to_primary(
            request, "POST", "/driver/action", {"spool_id": 67}
        ) == {"accepted": True}

    [forwarded] = received
    assert forwarded.url.path == "/driver/action"
    assert forwarded.url.query == b"refresh=1"
    assert forwarded.headers["cookie"] == "session_id=test; csrf_token=token"
    assert forwarded.headers["x-csrf-token"] == "token"
    assert forwarded.content == b'{"spool_id":67}'


async def test_primary_proxy_rejects_untrusted_socket_directory(tmp_path, monkeypatch):
    directory = tmp_path / "public"
    directory.mkdir(mode=0o755)
    monkeypatch.setattr(primary_socket, "_runtime_dir", directory)

    def reject_connection(**kwargs):
        pytest.fail("Forwarding must validate the directory before opening a connection")

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", reject_connection)
    request = Request({"type": "http", "headers": [(b"authorization", b"Device private")]})
    with pytest.raises(HTTPException) as error:
        await printers._proxy_to_primary(request, "POST", "/driver/action")
    assert error.value.status_code == 503


async def test_primary_proxy_preserves_catalog_upload_and_empty_delete(monkeypatch, private_socket_path):
    received = []

    def handle(request):
        received.append(request)
        return httpx.Response(204) if request.method == "DELETE" else httpx.Response(201, json={"installed": True})

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda **kwargs: httpx.MockTransport(handle))
    request = Request({"type": "http", "headers": [], "query_string": b"delete_data=true"})
    assert await printers._proxy_to_primary(
        request, "POST", "/plugins/install", files={"file": ("plugin.zip", b"zip bytes", "application/zip")},
        timeout=120.0,
    ) == {"installed": True}
    assert await printers._proxy_to_primary(request, "DELETE", "/plugins/example", timeout=120.0) is None
    upload, delete = received
    assert upload.headers["content-type"].startswith("multipart/form-data;")
    assert b'filename="plugin.zip"' in upload.content
    assert b"zip bytes" in upload.content
    assert upload.extensions["timeout"]["read"] == 120.0
    assert delete.url.query == b"delete_data=true"


@pytest.fixture(autouse=True)
def mock_plugin_manager():
    with patch("app.api.v1.printers.plugin_manager") as mock_pm:
        mock_pm.start_printer = AsyncMock(return_value=True)
        mock_pm.stop_printer = AsyncMock(return_value=None)
        mock_pm.reconnect_all = AsyncMock(return_value={})
        mock_pm.drivers = {}
        yield mock_pm


@pytest.fixture(autouse=True)
def prevent_assignment_lazy_load(db_session):
    def _set_assignment(session, instance):
        if isinstance(instance, PrinterSlot):
            set_committed_value(instance, "assignment", None)

    event.listen(db_session.sync_session, "loaded_as_persistent", _set_assignment)
    yield
    event.remove(db_session.sync_session, "loaded_as_persistent", _set_assignment)


async def _create_printer(db_session, name: str = "Test Printer", driver_key: str = "bambu_mqtt", **kwargs) -> Printer:
    printer = Printer(name=name, driver_key=driver_key, **kwargs)
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


async def _create_slot(db_session, printer_id: int, slot_no: int = 1, **kwargs) -> PrinterSlot:
    slot = PrinterSlot(printer_id=printer_id, slot_no=slot_no, **kwargs)
    db_session.add(slot)
    await db_session.commit()
    await db_session.refresh(slot)
    set_committed_value(slot, "assignment", None)
    return slot


async def _create_location(db_session, name: str = "Shelf A") -> Location:
    location = Location(name=name)
    db_session.add(location)
    await db_session.commit()
    await db_session.refresh(location)
    return location


class TestPrinterCRUD:
    @pytest.mark.asyncio
    async def test_list_printers_paginated(self, auth_client, db_session):
        client, _ = auth_client

        await _create_printer(db_session, name="Printer A")
        await _create_printer(db_session, name="Printer B")

        response = await client.get("/api/v1/printers?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        names = {item["name"] for item in data["items"]}
        assert {"Printer A", "Printer B"}.issubset(names)

    @pytest.mark.asyncio
    async def test_create_printer(self, auth_client, db_session):
        client, csrf_token = auth_client
        location = await _create_location(db_session)

        response = await client.post(
            "/api/v1/printers",
            json={"name": "My Printer", "driver_key": "bambu_mqtt", "location_id": location.id},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "My Printer"
        assert data["driver_key"] == "bambu_mqtt"
        assert data["is_active"] is True
        assert data["location_id"] == location.id

    @pytest.mark.asyncio
    async def test_create_printer_with_invalid_location(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/printers",
            json={"name": "Bad Printer", "driver_key": "bambu_mqtt", "location_id": 999999},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "validation_error"

    @pytest.mark.asyncio
    async def test_get_printer_detail(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session, name="Detail Printer")
        await _create_slot(db_session, printer.id, slot_no=1, name="Slot 1")

        response = await client.get(f"/api/v1/printers/{printer.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == printer.id
        assert data["name"] == "Detail Printer"
        assert len(data["slots"]) == 1
        assert data["slots"][0]["slot_no"] == 1

    @pytest.mark.asyncio
    async def test_get_printer_not_found(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/printers/999999")

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    @pytest.mark.asyncio
    async def test_update_printer(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session, name="Old Name")

        response = await client.patch(
            f"/api/v1/printers/{printer.id}",
            json={"name": "New Name"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New Name"

    @pytest.mark.asyncio
    async def test_delete_printer_soft_delete(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session, name="Delete Printer")

        response = await client.delete(
            f"/api/v1/printers/{printer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        await db_session.refresh(printer)
        assert printer.deleted_at is not None

        list_response = await client.get("/api/v1/printers?page=1&page_size=10")
        assert list_response.status_code == 200
        items = list_response.json()["items"]
        assert printer.id not in {item["id"] for item in items}

    @pytest.mark.asyncio
    async def test_delete_printer_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.delete(
            "/api/v1/printers/999999",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"


class TestPrinterSlots:
    @pytest.mark.asyncio
    async def test_list_slots_empty(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session)

        response = await client.get(f"/api/v1/printers/{printer.id}/slots")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_slots_with_slots(self, auth_client, db_session):
        client, _ = auth_client

        printer = await _create_printer(db_session)
        await _create_slot(db_session, printer.id, slot_no=2, name="Slot 2")
        await _create_slot(db_session, printer.id, slot_no=1, name="Slot 1")

        response = await client.get(f"/api/v1/printers/{printer.id}/slots")

        assert response.status_code == 200
        data = response.json()
        assert [item["slot_no"] for item in data] == [1, 2]

    @pytest.mark.asyncio
    async def test_list_slots_after_soft_delete(self, auth_client, db_session):
        client, csrf_token = auth_client

        printer = await _create_printer(db_session)
        await _create_slot(db_session, printer.id, slot_no=1)

        response = await client.delete(
            f"/api/v1/printers/{printer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204

        list_response = await client.get(f"/api/v1/printers/{printer.id}/slots")
        assert list_response.status_code == 200
        assert [item["slot_no"] for item in list_response.json()] == [1]

    @pytest.mark.asyncio
    async def test_list_slots_printer_not_found_returns_empty(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/printers/999999/slots")

        assert response.status_code == 200
        assert response.json() == []


class _FakeProxyResponse:
    """Mimics an httpx.Response whose body cannot be decoded as JSON."""

    def __init__(self, status_code: int = 200):
        self.status_code = status_code
        self.text = ""

    def json(self):
        raise ValueError("not valid JSON")


class _FakeProxyClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, *args, **kwargs):
        return _FakeProxyResponse()


@pytest.mark.usefixtures("private_socket_path")
class TestDriverActionProxy:
    """Regression coverage for GH issue #133: a non-primary worker proxying a
    driver/action call to the primary must surface a structured error instead
    of crashing with an unhandled pydantic ValidationError when the primary's
    response body can't be decoded as JSON."""

    @pytest.mark.asyncio
    async def test_driver_action_invalid_proxy_response_returns_structured_502(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session)

        with (
            patch("app.api.v1.printers._is_primary_worker", return_value=False),
            patch("app.api.v1.printers.httpx.AsyncClient", _FakeProxyClient),
        ):
            response = await client.post(
                f"/api/v1/printers/{printer.id}/driver/action",
                json={"action": "send_filament_to_tray", "params": {}},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "primary_proxy_invalid_response"

    @pytest.mark.asyncio
    async def test_start_driver_invalid_proxy_response_returns_structured_502(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session)

        with (
            patch("app.api.v1.printers._is_primary_worker", return_value=False),
            patch("app.api.v1.printers.httpx.AsyncClient", _FakeProxyClient),
        ):
            response = await client.post(
                f"/api/v1/printers/{printer.id}/driver/start",
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "primary_proxy_invalid_response"


class TestDriverLifecycleWorkerRouting:
    """Drivers live on the primary worker, so routes touching them must hand over.

    Every test here runs with _is_primary_worker() returning False, which is the
    state of three out of four gunicorn workers and the reason the driver work
    used to be dropped silently.
    """

    @pytest.mark.asyncio
    async def test_driver_config_change_is_handed_to_the_primary_worker(
        self, auth_client, db_session, mock_plugin_manager
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session, name="Bambu")

        forwarded = {
            "id": printer.id,
            "name": "Bambu",
            "location_id": None,
            "is_active": True,
            "driver_key": printer.driver_key,
            "custom_fields": None,
        }

        with patch("app.api.v1.printers._is_primary_worker", return_value=False), patch(
            "app.api.v1.printers._proxy_to_primary",
            new=AsyncMock(return_value=forwarded),
        ) as proxy:
            response = await client.patch(
                f"/api/v1/printers/{printer.id}",
                json={"driver_config": {"host": "192.168.0.9"}},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200
        proxy.assert_awaited_once()
        assert proxy.await_args.kwargs["method"] == "PATCH"
        assert proxy.await_args.kwargs["path"] == f"/api/v1/printers/{printer.id}"

        # The handover happens before the commit, so this worker wrote nothing
        # and never pretended to restart a driver it does not hold.
        await db_session.refresh(printer)
        assert printer.driver_config is None
        mock_plugin_manager.start_printer.assert_not_awaited()
        mock_plugin_manager.stop_printer.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rename_is_handled_locally(self, auth_client, db_session):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session, name="Old Name")

        with patch("app.api.v1.printers._is_primary_worker", return_value=False), patch(
            "app.api.v1.printers._proxy_to_primary", new=AsyncMock()
        ) as proxy:
            response = await client.patch(
                f"/api/v1/printers/{printer.id}",
                json={"name": "New Name"},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200
        assert response.json()["name"] == "New Name"
        # A field that cannot affect the driver must not cost an extra hop.
        proxy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_primary_worker_restarts_the_driver_itself(
        self, auth_client, db_session, mock_plugin_manager
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session, name="Bambu")

        with patch("app.api.v1.printers._is_primary_worker", return_value=True), patch(
            "app.api.v1.printers._proxy_to_primary", new=AsyncMock()
        ) as proxy:
            response = await client.patch(
                f"/api/v1/printers/{printer.id}",
                json={"driver_config": {"host": "192.168.0.9"}},
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 200
        proxy.assert_not_awaited()
        mock_plugin_manager.stop_printer.assert_awaited_once()
        mock_plugin_manager.start_printer.assert_awaited_once()
        await db_session.refresh(printer)
        assert printer.driver_config == {"host": "192.168.0.9"}

    @pytest.mark.asyncio
    async def test_delete_hands_the_stop_over_but_still_soft_deletes(
        self, auth_client, db_session, mock_plugin_manager
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session, name="Delete Me")

        with patch("app.api.v1.printers._is_primary_worker", return_value=False), patch(
            "app.api.v1.printers._proxy_to_primary", new=AsyncMock(return_value=None)
        ) as proxy:
            response = await client.delete(
                f"/api/v1/printers/{printer.id}",
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 204
        proxy.assert_awaited_once()
        assert proxy.await_args.kwargs["path"] == (
            f"/api/v1/printers/{printer.id}/driver/stop"
        )
        # The soft-delete is this worker's own job and stays local.
        await db_session.refresh(printer)
        assert printer.deleted_at is not None

    @pytest.mark.asyncio
    async def test_delete_survives_an_unreachable_primary_worker(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        printer = await _create_printer(db_session, name="Delete Me Too")

        with patch("app.api.v1.printers._is_primary_worker", return_value=False), patch(
            "app.api.v1.printers._proxy_to_primary",
            new=AsyncMock(side_effect=RuntimeError("primary unreachable")),
        ):
            response = await client.delete(
                f"/api/v1/printers/{printer.id}",
                headers={"X-CSRF-Token": csrf_token},
            )

        # Stopping the driver is best effort; losing the primary must not keep
        # the user from deleting a printer.
        assert response.status_code == 204
        await db_session.refresh(printer)
        assert printer.deleted_at is not None
