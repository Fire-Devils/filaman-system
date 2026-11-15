import asyncio
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock

import pytest
import pytest_asyncio
from app.api.v1 import printers
from app.core.event_bus import EventBus
from app.models import Filament, Manufacturer, Printer, Spool, SpoolStatus
from app.models.printer import PrinterSlot, PrinterSlotAssignment
from app.plugins.manager import PluginManager
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker


async def test_cancelled_standalone_provisioning_reaps_installer(monkeypatch):
    from app.plugins import manager as manager_module

    if not hasattr(PluginManager, "_install_pip_packages"):
        pytest.skip("Plugin provisioning runs in the Gunicorn master")

    spawn = asyncio.create_subprocess_exec
    started = asyncio.Event()
    child = None

    async def start_sleeper(*_args, **kwargs):
        nonlocal child
        child = await spawn(sys.executable, "-c", "import time; time.sleep(60)", **kwargs)
        started.set()
        return child

    monkeypatch.setattr(manager_module.asyncio, "create_subprocess_exec", start_sleeper)
    task = asyncio.create_task(PluginManager._install_pip_packages(["fixture"], "fixture"))
    try:
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert child is not None and child.returncode is not None
    finally:
        if child is not None and child.returncode is None:
            child.kill()
            await child.communicate()


@pytest_asyncio.fixture
async def slots_env(db_session, monkeypatch):
    """Point the plugin manager at the test session and seed a printer + two spools."""

    class _SessionContext:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(
        "app.plugins.manager.async_session_maker", lambda: _SessionContext()
    )

    printer = Printer(name="Voron 2T", driver_key="moonraker_filaman")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    manufacturer = Manufacturer(name="Test Manufacturer")
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)

    status = (
        await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == "active"))
    ).scalar_one()

    spools = []
    for designation, material in (("Red PLA", "PLA"), ("Blue PETG", "PETG")):
        filament = Filament(
            manufacturer_id=manufacturer.id,
            designation=designation,
            material_type=material,
            diameter_mm=1.75,
            default_spool_weight_g=250.0,
        )
        db_session.add(filament)
        await db_session.commit()
        await db_session.refresh(filament)

        spool = Spool(
            filament_id=filament.id,
            status_id=status.id,
            initial_total_weight_g=1000.0,
            empty_spool_weight_g=250.0,
            remaining_weight_g=750.0,
        )
        db_session.add(spool)
        await db_session.commit()
        await db_session.refresh(spool)
        spools.append(spool)

    return printer, spools


def _toolhead(slot_index: str, name: str, **extra) -> dict:
    return {
        "slot_index": slot_index,
        "slot_name": name,
        "slot_kind": "toolhead",
        "present": False,
        **extra,
    }


def _tray(slot_index: str, name: str, **extra) -> dict:
    return {
        "slot_index": slot_index,
        "slot_name": name,
        "slot_kind": "tray",
        "present": False,
        **extra,
    }


async def _assignments_by_slot_index(db_session, printer_id: int) -> dict[str, int | None]:
    result = await db_session.execute(
        select(PrinterSlot, PrinterSlotAssignment)
        .join(PrinterSlotAssignment, PrinterSlotAssignment.slot_id == PrinterSlot.id)
        .where(PrinterSlot.printer_id == printer_id)
    )
    return {
        (slot.custom_fields or {}).get("slot_index"): assignment.spool_id
        for slot, assignment in result.all()
    }


class TestPerSlotSpoolAssignment:
    @pytest.mark.asyncio
    async def test_emitter_copies_slot_records_before_the_driver_can_reuse_them(self, monkeypatch):
        manager = PluginManager()
        received = []

        async def capture(_printer_id, report):
            received.append(report["slots"][0]["present"])

        monkeypatch.setattr(manager, "_handle_event", capture)
        emit = manager._create_event_handler(1)
        slot = _tray("0-0", "AMS 1", present=True)
        emit({"event_type": "slots_update", "slots": [slot]})
        slot["present"] = False
        emit({"event_type": "slots_update", "slots": [slot]})
        await asyncio.sleep(0)

        assert received == [True, False]

    @pytest.mark.asyncio
    async def test_rapid_slot_events_are_persisted_in_report_order(self, db_session, slots_env, monkeypatch):
        printer, _ = slots_env
        manager = PluginManager()
        first_started = asyncio.Event()
        finish_first = asyncio.Event()
        opened_sessions = []

        @asynccontextmanager
        async def delayed_session():
            opened_sessions.append(None)
            if len(opened_sessions) == 1:
                first_started.set()
                await finish_first.wait()
            yield db_session

        monkeypatch.setattr("app.plugins.manager.async_session_maker", delayed_session)
        inserted = asyncio.create_task(manager._handle_event(printer.id, {
            "event_type": "slots_update", "slots": [_tray("0-0", "AMS 1", present=True)],
        }))
        await asyncio.wait_for(first_started.wait(), 1)
        removed = asyncio.create_task(manager._handle_event(printer.id, {
            "event_type": "slots_update", "slots": [_tray("0-0", "AMS 1", spool_id=None)],
        }))
        await asyncio.sleep(0)
        if len(opened_sessions) > 1:
            await removed
        finish_first.set()
        await asyncio.gather(inserted, removed)

        assignment = (await db_session.scalars(select(PrinterSlotAssignment))).one()
        assert assignment.present is False

    @pytest.mark.asyncio
    async def test_spool_lands_on_reporting_toolhead(self, db_session, slots_env):
        """A spool reported for toolhead 2 must not be recorded on toolhead 1."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[1].id, present=True),
            ],
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_clearing_a_spool_link_keeps_the_reported_occupancy(self, db_session, slots_env):
        printer, spools = slots_env
        manager = PluginManager()
        tray = _tray("0-0", "AMS 1", present=True, tray_type="PETG", tray_color="123456")
        await manager._handle_slots_update(printer.id, [{**tray, "spool_id": spools[0].id}])
        await manager._handle_slots_update(printer.id, [{**tray, "spool_id": None}])

        assignment = (await db_session.scalars(select(PrinterSlotAssignment))).one()
        assert assignment.spool_id is None
        assert assignment.present is True
        assert assignment.meta["tray_type"] == "PETG"
        assert assignment.meta["tray_color"] == "123456"

        await manager._handle_slots_update(printer.id, [{**tray, "present": False, "spool_id": None}])
        await db_session.refresh(assignment)
        assert assignment.present is False
        assert "tray_type" not in assignment.meta

    @pytest.mark.asyncio
    async def test_removed_tray_is_inactive_and_reappears_in_same_slot(self, db_session, slots_env):
        printer, spools = slots_env
        manager = PluginManager()
        tray = _tray("1-0", "AMS 2", present=True, spool_id=spools[0].id)
        await manager._handle_slots_update(printer.id, [tray])
        slot = (await db_session.scalars(select(PrinterSlot))).one()
        original_id = slot.id
        await manager._handle_slots_update(printer.id, [
            {"slot_index": "1-0", "slot_name": "AMS 2", "is_active": False},
        ])

        assignment = (await db_session.scalars(select(PrinterSlotAssignment))).one()
        assert not slot.is_active
        assert not assignment.present
        assert assignment.spool_id is None

        await manager._handle_slots_update(printer.id, [_tray("1-0", "AMS 2")])
        assert (await db_session.scalars(select(PrinterSlot))).one().id == original_id
        assert slot.is_active

    @pytest.mark.asyncio
    async def test_retiring_a_slot_does_not_mask_the_remaining_legacy_link(self, db_session, slots_env):
        printer, spools = slots_env
        manager = PluginManager()
        active = _tray("0-0", "Toolhead")
        await manager._handle_slots_update(printer.id, [active, _tray("1-0", "Removed tray")])
        await manager._handle_slots_update(
            printer.id,
            [active, {"slot_index": "1-0", "is_active": False}],
            active_spool_id_raw=spools[0].id,
        )

        assert await _assignments_by_slot_index(db_session, printer.id) == {
            "0-0": spools[0].id, "1-0": None,
        }

    @pytest.mark.asyncio
    async def test_per_slot_report_overrides_printer_wide_active_spool(
        self, db_session, slots_env
    ):
        """The printer-wide active spool must not pull the assignment onto slot 0-0."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[1].id, present=True),
            ],
            active_spool_id_raw=spools[1].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_moving_spool_between_toolheads_clears_the_old_one(
        self, db_session, slots_env
    ):
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=spools[0].id, present=True),
                _toolhead("0-1", "Toolhead 2", spool_id=None),
            ],
        )
        await manager._handle_slots_update(
            printer.id,
            [
                _toolhead("0-0", "Toolhead 1", spool_id=None),
                _toolhead("0-1", "Toolhead 2", spool_id=spools[0].id, present=True),
            ],
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-1"] == spools[0].id
        assert assignments["0-0"] is None

    @pytest.mark.asyncio
    async def test_single_toolhead_driver_still_uses_active_spool_fallback(
        self, db_session, slots_env
    ):
        """Drivers that report no per-slot spool keep the previous behaviour."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [_toolhead("0-0", "Toolhead 1")],
            active_spool_id_raw=spools[0].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id

    @pytest.mark.asyncio
    async def test_single_slot_fallback_also_works_without_slot_data(
        self, db_session, slots_env
    ):
        """The refresh path passes no slots; on a single-slot printer it still syncs."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(printer.id, [_toolhead("0-0", "Toolhead 1")])
        await manager._handle_slots_update(
            printer.id, [], None, spools[0].id
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id


class TestActiveSpoolFallbackOnMultiSlotPrinters:
    """Regression cover for #127.

    driver_health(?refresh=1) and driver startup call _handle_slots_update with an
    empty slot list, so per_slot_spools stays False there no matter what the driver
    reports. On a tray printer the fallback then stamped the active spool into 0-0
    on every poll, overwriting the real map.
    """

    async def _seed_tray_map(self, manager, printer, spools):
        await manager._handle_slots_update(
            printer.id,
            [
                _tray("0-0", "Tray 1", spool_id=spools[0].id, present=True),
                _tray("0-1", "Tray 2", spool_id=spools[1].id, present=True),
                _tray("0-2", "Tray 3", spool_id=None),
                _tray("0-3", "Tray 4", spool_id=None),
            ],
        )

    @pytest.mark.asyncio
    async def test_refresh_path_leaves_the_tray_map_alone(self, db_session, slots_env):
        printer, spools = slots_env
        manager = PluginManager()
        await self._seed_tray_map(manager, printer, spools)

        # Exactly what api/v1/printers.py::driver_health does on ?refresh=1:
        # the spool loaded in the toolhead sits in tray 1, not tray 0.
        await manager._handle_slots_update(printer.id, [], None, spools[1].id)

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id
        assert assignments["0-1"] == spools[1].id
        assert assignments["0-2"] is None
        assert assignments["0-3"] is None

    @pytest.mark.asyncio
    async def test_repeated_polls_do_not_drift(self, db_session, slots_env):
        """The UI polls every few seconds, so the skip has to hold indefinitely."""
        printer, spools = slots_env
        manager = PluginManager()
        await self._seed_tray_map(manager, printer, spools)

        for _ in range(5):
            await manager._handle_slots_update(printer.id, [], None, spools[1].id)

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] == spools[0].id
        assert assignments["0-1"] == spools[1].id

    @pytest.mark.asyncio
    async def test_unassigned_multi_slot_printer_is_not_stamped_either(
        self, db_session, slots_env
    ):
        """Drivers that report no spool_id at all must not get slot 0-0 filled in."""
        printer, spools = slots_env
        manager = PluginManager()

        await manager._handle_slots_update(
            printer.id,
            [_tray("0-0", "Tray 1"), _tray("0-1", "Tray 2")],
            None,
            spools[0].id,
        )

        assignments = await _assignments_by_slot_index(db_session, printer.id)
        assert assignments["0-0"] is None
        assert assignments["0-1"] is None


@pytest_asyncio.fixture
async def health_env(db_session, db_engine, slots_env, monkeypatch):
    printer, spools = slots_env
    manager = PluginManager()
    await manager._handle_slots_update(printer.id, [_toolhead("0-0", "Toolhead")])

    class Driver:
        def __init__(self):
            self.payload = {"active_spool_id": 0}

        async def refresh_status(self):
            if isinstance(self.payload, Exception):
                raise self.payload
            return self.payload

        def health(self):
            return {"running": True, "connected": True}

    driver = Driver()
    manager.drivers[printer.id] = driver
    monkeypatch.setattr(printers, "plugin_manager", manager)
    monkeypatch.setattr(printers, "_is_primary_worker", lambda: True)
    monkeypatch.setattr(printers.shared_health_store, "publish", lambda payload: None)

    bus = EventBus()
    published = []

    async def publish(payload):
        published.append(payload)
        await bus.publish(payload)

    monkeypatch.setattr("app.plugins.manager.event_bus.publish", publish)
    commits = Mock()
    sessions = async_sessionmaker(db_engine, expire_on_commit=False)

    @asynccontextmanager
    async def manager_session():
        async with sessions() as session:
            event.listen(session.sync_session, "after_commit", commits)
            yield session

    monkeypatch.setattr("app.plugins.manager.async_session_maker", manager_session)
    return printer, spools, manager, driver, published, commits


class TestSingleSlotHealthReconciliation:
    async def test_stop_waits_for_manual_refresh_to_publish_before_clearing(self, monkeypatch, tmp_path):
        from app.core.shared_health import SharedStateStore
        from app.plugins import manager as manager_module

        manager = PluginManager()
        refreshing, release = asyncio.Event(), asyncio.Event()
        calls = []

        class Driver:
            def health(self):
                return {"running": True}

            async def refresh_status(self):
                refreshing.set()
                await release.wait()
                return {"active_spool_id": 17}

            async def stop(self):
                calls.append("stop")

        async def update_slots(*args):
            calls.append(args[-1])

        manager.drivers[1] = Driver()
        health = SharedStateStore(lambda: tmp_path / "health.json")
        display = SharedStateStore(lambda: tmp_path / "display.json")
        monkeypatch.setattr(manager_module, "shared_health_store", health)
        monkeypatch.setattr(manager_module, "shared_display_store", display)
        monkeypatch.setattr(printers, "shared_health_store", health)
        monkeypatch.setattr(printers, "plugin_manager", manager)
        monkeypatch.setattr(printers, "_is_primary_worker", lambda: True)
        monkeypatch.setattr(manager, "_handle_slots_update", update_slots)
        refreshing_request = asyncio.create_task(printers.driver_health(1, None, None, None, refresh=1))
        stopping = None
        try:
            await asyncio.wait_for(refreshing.wait(), 1)
            stopping = asyncio.create_task(manager.stop_printer(1))
            await asyncio.sleep(0)
        finally:
            release.set()
            await refreshing_request
            if stopping is not None:
                await stopping

        assert calls == [17, "stop"]
        assert health.read(1) is None

    @pytest.mark.parametrize("loaded", [False, True])
    async def test_repeated_health_refresh_does_not_republish_or_commit(
        self, auth_client, db_session, health_env, loaded
    ):
        printer, spools, _, driver, published, commits = health_env
        client, _ = auth_client
        driver.payload = {"active_spool_id": spools[0].id if loaded else 0}
        url = f"/api/v1/printers/{printer.id}/driver/health?refresh=1"
        response = await client.get(url)
        assert response.status_code == 200
        assert [item["event"] for item in published] == ["slots_update", "printer_update"]
        assignment = (
            await db_session.execute(select(PrinterSlotAssignment))
        ).scalar_one()
        await db_session.refresh(assignment)
        updated_at = assignment.updated_at
        published.clear()
        commits.reset_mock()

        for _ in range(3):
            response = await client.get(url)
            assert response.status_code == 200
            assert response.json() == {"running": True, "connected": True}

        await db_session.refresh(assignment)
        assert assignment.spool_id == (spools[0].id if loaded else None)
        assert assignment.present is loaded
        assert assignment.updated_at == updated_at
        assert published == []
        commits.assert_not_called()

    async def test_external_load_switch_and_unload_are_persisted_and_published(
        self, auth_client, db_session, health_env
    ):
        printer, spools, _, driver, published, commits = health_env
        client, _ = auth_client
        for raw_id, spool_id, present, material in (
            (str(spools[0].id), spools[0].id, True, "PLA"),
            (spools[1].id, spools[1].id, True, "PETG"),
            (0, None, False, None),
        ):
            published.clear()
            commits.reset_mock()
            driver.payload = {"active_spool_id": raw_id}
            response = await client.get(
                f"/api/v1/printers/{printer.id}/driver/health?refresh=1"
            )
            assert response.status_code == 200
            assignment = (
                await db_session.execute(select(PrinterSlotAssignment))
            ).scalar_one()
            await db_session.refresh(assignment)
            assert assignment.spool_id == spool_id
            assert assignment.present is present
            assert assignment.meta.get("tray_type") == material
            assert assignment.meta["active_spool_id"] == spool_id
            assert published == [
                {"event": "slots_update", "printer_id": printer.id},
                {"event": "printer_update", "printer_id": printer.id},
            ]
            assert commits.call_count == 1

    @pytest.mark.parametrize(
        "payload", [None, {}, {"active_spool_id": None}, RuntimeError("offline")]
    )
    async def test_unavailable_active_spool_does_not_clear_assignment(
        self, auth_client, db_session, health_env, payload
    ):
        printer, spools, manager, driver, published, commits = health_env
        client, _ = auth_client
        await manager._handle_slots_update(printer.id, [], None, spools[0].id)
        published.clear()
        commits.reset_mock()
        driver.payload = payload

        response = await client.get(
            f"/api/v1/printers/{printer.id}/driver/health?refresh=1"
        )

        assert response.status_code == 200
        assert response.json() == {"running": True, "connected": True}
        assert await _assignments_by_slot_index(db_session, printer.id) == {
            "0-0": spools[0].id
        }
        assert published == []
        commits.assert_not_called()

    async def test_unchanged_spool_still_reconciles_metadata(
        self, auth_client, db_session, health_env
    ):
        printer, spools, manager, driver, published, commits = health_env
        client, _ = auth_client
        await manager._handle_slots_update(printer.id, [], None, spools[0].id)
        assignment = (
            await db_session.execute(select(PrinterSlotAssignment))
        ).scalar_one()
        await db_session.refresh(assignment)
        assignment.meta = {**assignment.meta, "tray_type": "outdated", "cali_idx": 7}
        await db_session.commit()
        published.clear()
        commits.reset_mock()
        driver.payload = {"active_spool_id": spools[0].id}

        response = await client.get(
            f"/api/v1/printers/{printer.id}/driver/health?refresh=1"
        )

        assert response.status_code == 200
        await db_session.refresh(assignment)
        assert assignment.meta == {
            "active_spool_id": spools[0].id, "tray_type": "PLA", "cali_idx": 7
        }
        assert [item["event"] for item in published] == ["slots_update", "printer_update"]
        assert commits.call_count == 1


async def test_cancelled_initial_refresh_stops_the_driver(monkeypatch):
    manager = PluginManager()
    refreshing = asyncio.Event()
    driver = Mock()
    driver.start = AsyncMock()
    driver.stop = AsyncMock()

    async def refresh():
        refreshing.set()
        await asyncio.Future()

    driver.refresh_status = refresh
    monkeypatch.setattr(manager, "load_driver", lambda _key: Mock(return_value=driver))
    monkeypatch.setattr(manager, "_ensure_plugin_extra_fields", AsyncMock())
    monkeypatch.setattr(manager, "_migrate_spoolman_bambu_fields", AsyncMock())
    monkeypatch.setattr(manager, "_copy_params_to_new_printer", AsyncMock())

    start = asyncio.create_task(manager.start_printer(Printer(id=1, driver_key="fixture")))
    await asyncio.wait_for(refreshing.wait(), 1)
    start.cancel()
    with pytest.raises(asyncio.CancelledError):
        await start

    driver.stop.assert_awaited_once()
    assert not manager.drivers


async def test_cancelled_driver_stop_finishes_stopping_the_driver():
    manager = PluginManager()
    stopping, release, stopped = (asyncio.Event() for _ in range(3))

    async def stop():
        stopping.set()
        await release.wait()
        stopped.set()

    manager.drivers[1] = Mock(stop=stop)
    task = asyncio.create_task(manager.stop_printer(1))
    try:
        await asyncio.wait_for(stopping.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert stopped.is_set()
    assert not manager.drivers


@pytest.mark.parametrize("phase", ["start", "refresh_status"])
@pytest.mark.parametrize("failure", ["timeout", "cancelled"])
async def test_driver_startup_isolates_unresponsive_plugins(monkeypatch, phase, failure):
    from app.plugins import manager as plugin_manager_module

    manager = PluginManager()
    driver = Mock(start=AsyncMock(), stop=AsyncMock())
    driver.health.return_value = {"running": True}
    driver.refresh_status = AsyncMock()

    async def fail():
        if failure == "cancelled":
            raise asyncio.CancelledError
        await asyncio.Future()

    setattr(driver, phase, fail)
    monkeypatch.setattr(plugin_manager_module, "_DRIVER_START_TIMEOUT", 0.01, raising=False)
    monkeypatch.setattr(plugin_manager_module, "_DRIVER_REFRESH_TIMEOUT", 0.01, raising=False)
    monkeypatch.setattr(manager, "load_driver", lambda _key: Mock(return_value=driver))
    for method in ("_ensure_plugin_extra_fields", "_migrate_spoolman_bambu_fields", "_copy_params_to_new_printer"):
        monkeypatch.setattr(manager, method, AsyncMock())

    started = await asyncio.wait_for(manager.start_printer(Printer(id=1, driver_key="fixture")), 0.2)

    if phase == "start":
        assert not started and not manager.drivers
        driver.stop.assert_awaited_once()
    else:
        assert started and manager.drivers[1] is driver
        driver.stop.assert_not_awaited()


async def test_self_cancelled_driver_does_not_abort_other_driver_stops():
    async def stop():
        raise asyncio.CancelledError

    manager = PluginManager()
    healthy = Mock(stop=AsyncMock())
    manager.drivers.update({1: Mock(stop=stop), 2: healthy})

    await manager.stop_all()

    healthy.stop.assert_awaited_once()
    assert not manager.drivers


async def test_driver_stop_failure_does_not_replace_caller_cancellation():
    manager = PluginManager()
    stopping, release = asyncio.Event(), asyncio.Event()

    async def stop():
        stopping.set()
        await release.wait()
        raise ValueError("fixture stop failed")

    manager.drivers[1] = Mock(stop=stop)
    task = asyncio.create_task(manager.stop_printer(1))
    await asyncio.wait_for(stopping.wait(), 1)
    task.cancel()
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_start_waits_for_previous_driver_to_stop(monkeypatch):
    manager = PluginManager()
    stopping, release = asyncio.Event(), asyncio.Event()

    async def stop():
        stopping.set()
        await release.wait()

    manager.drivers[1] = Mock(stop=stop)
    replacement = AsyncMock(return_value=True)
    monkeypatch.setattr(manager, "_start_printer", replacement)
    printer = Printer(id=1, driver_key="new_driver")
    stop_task = asyncio.create_task(manager.stop_printer(1))
    await asyncio.wait_for(stopping.wait(), 1)
    start_task = asyncio.create_task(manager.start_printer(printer))
    try:
        await asyncio.sleep(0)
        replacement.assert_not_awaited()
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(stop_task, start_task), 1)

    replacement.assert_awaited_once_with(printer)


@pytest.mark.parametrize("operation", ["startup", "stop"])
async def test_stalled_driver_is_fatal_before_election_can_be_released(monkeypatch, operation):
    from app.core import async_tasks


    class WorkerExit(BaseException):
        pass

    fatal = Mock(side_effect=WorkerExit)
    monkeypatch.setattr(async_tasks, "os", Mock(_exit=fatal), raising=False)
    release = asyncio.Event()

    async def unresponsive():
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            await release.wait()

    try:
        with pytest.raises(WorkerExit):
            async with asyncio.timeout(0.2):
                if operation == "startup":
                    monkeypatch.setattr(async_tasks, "_DRIVER_CANCEL_GRACE", 0.01, raising=False)
                    await async_tasks.await_driver_startup(unresponsive(), 0.01)
                else:
                    await async_tasks.finish_on_cancel(unresponsive(), timeout=0.01)
        fatal.assert_called_once_with(1)
    finally:
        release.set()


async def test_stop_removes_shared_state_and_rejects_late_events(monkeypatch):
    from app.plugins import manager as plugin_manager_module

    manager = PluginManager()
    driver = Mock(start=AsyncMock(), stop=AsyncMock(), refresh_status=None)
    factory = Mock(return_value=driver)
    monkeypatch.setattr(manager, "load_driver", lambda _key: factory)
    monkeypatch.setattr(manager, "_handle_event", event := AsyncMock())
    for method in ("_ensure_plugin_extra_fields", "_migrate_spoolman_bambu_fields", "_copy_params_to_new_printer"):
        monkeypatch.setattr(manager, method, AsyncMock())
    health, display = Mock(), Mock()
    monkeypatch.setattr(plugin_manager_module, "shared_health_store", health, raising=False)
    monkeypatch.setattr(plugin_manager_module, "shared_display_store", display, raising=False)

    assert await manager.start_printer(Printer(id=1, driver_key="fixture"))
    emit = factory.call_args.kwargs["emitter"]
    await manager.stop_printer(1)
    emit({"event_type": "slots_update"})
    await asyncio.sleep(0)

    health.clear.assert_called_once_with(1)
    display.clear.assert_called_once_with(1)
    event.assert_not_awaited()


async def test_failed_health_read_does_not_stop_a_started_driver(monkeypatch):
    manager = PluginManager()
    driver = Mock(
        driver_key="fixture", start=AsyncMock(), stop=AsyncMock(),
        refresh_status=None, health=Mock(side_effect=OSError("health unavailable")),
    )
    monkeypatch.setattr(manager, "load_driver", lambda _key: Mock(return_value=driver))
    for method in ("_ensure_plugin_extra_fields", "_migrate_spoolman_bambu_fields", "_copy_params_to_new_printer"):
        monkeypatch.setattr(manager, method, AsyncMock())

    assert await manager.start_printer(Printer(id=1, driver_key="fixture"))
    assert manager.drivers[1] is driver
    assert manager.get_health()[1] == {"driver_key": "fixture", "status": "error"}
    driver.stop.assert_not_awaited()
