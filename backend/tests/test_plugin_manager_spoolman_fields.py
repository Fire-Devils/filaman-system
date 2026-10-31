import json
import math
from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.api.v1.devices import _build_extended_data
from app.models import (
    FilamentPrinterInitialization,
    FilamentPrinterParam,
    Manufacturer,
    Printer,
    Spool,
    SpoolPrinterParam,
    SpoolStatus,
)
from app.models.filament import Filament
from app.plugins.base import BaseDriver
from app.plugins.manager import PluginManager
from app.services.spoolman_import_service import SpoolmanImportService
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from tests.support.spoolman_fixture_server import SpoolmanFixtureServer


def _bambu_manager(db_session, monkeypatch):
    class _SessionContext:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(
        "app.plugins.manager.async_session_maker", lambda: _SessionContext()
    )
    manager = PluginManager()
    monkeypatch.setattr(
        manager,
        "_load_plugin_json",
        lambda _driver_key: {"printer_params": {"migration": {"legacy_renames": {}}}},
    )
    return manager


async def _run_bambu_migration(db_session, monkeypatch, driver_key="bambulab"):
    await _bambu_manager(db_session, monkeypatch)._migrate_spoolman_bambu_fields(
        driver_key
    )


async def test_non_bambu_driver_does_not_consume_bambu_fields(db_session, monkeypatch):
    printer = Printer(name="Moonraker", driver_key="moonraker")
    manufacturer = Manufacturer(name="Migration Guard Test")
    db_session.add_all([printer, manufacturer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Guard PLA",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={"settings_extruder_temp": 210},
    )
    db_session.add(filament)
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch, "moonraker")

    assert (
        not (
            await db_session.execute(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament.id
                )
            )
        )
        .scalars()
        .all()
    )
    await db_session.refresh(filament)
    assert filament.custom_fields == {"settings_extruder_temp": 210}


def test_extract_bambu_params_reads_promoted_native_nozzle_range():
    params = PluginManager._extract_bambu_params(
        {"nozzle_temperature": {"min": 190, "max": None}},
        set(),
    )

    assert params["bambu_nozzle_temp_min"] == "190"
    assert "bambu_nozzle_temp_max" not in params


def test_clean_bambu_fields_removes_promoted_native_nozzle_range():
    filament = Filament(
        manufacturer_id=1,
        designation="PLA",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={
            "nozzle_temperature": {"min": 190, "max": 230},
            "notes": "keep",
        },
    )

    PluginManager._clean_bambu_keys_from_cf(filament, set())

    assert filament.custom_fields == {"notes": "keep"}


async def test_partial_bambu_migration_fills_missing_params_without_overwriting_spool_override(
    db_session,
    monkeypatch,
):
    printer_a = Printer(name="Bambu A", driver_key="bambulab")
    printer_b = Printer(name="Bambu B", driver_key="bambulab")
    manufacturer = Manufacturer(name="Bambu Migration Test")
    db_session.add_all([printer_a, printer_b, manufacturer])
    await db_session.flush()

    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Partial PLA",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={
            "nozzle_temperature": {"min": 190, "max": 230},
            "notes": "keep filament",
        },
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "active")
    )
    spool = Spool(
        filament_id=filament.id,
        status_id=status_id,
        custom_fields={
            "nozzle_temperature": {"min": 200, "max": 240},
            "notes": "keep spool",
        },
    )
    db_session.add(spool)
    await db_session.flush()
    db_session.add_all(
        [
            FilamentPrinterParam(
                filament_id=filament.id,
                printer_id=printer_a.id,
                param_key="bambu_k_value",
                param_value="0.025",
            ),
            SpoolPrinterParam(
                spool_id=spool.id,
                printer_id=printer_a.id,
                param_key="bambu_nozzle_temp_min",
                param_value="195",
            ),
        ]
    )
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch)

    filament_params = (
        await db_session.execute(
            select(FilamentPrinterParam).where(
                FilamentPrinterParam.filament_id == filament.id
            )
        )
    ).scalars()
    assert {
        (item.printer_id, item.param_key): item.param_value for item in filament_params
    } == {
        (printer_a.id, "bambu_k_value"): "0.025",
        (printer_a.id, "bambu_nozzle_temp_min"): "190",
        (printer_a.id, "bambu_nozzle_temp_max"): "230",
        (printer_b.id, "bambu_nozzle_temp_min"): "190",
        (printer_b.id, "bambu_nozzle_temp_max"): "230",
    }

    spool_params = (
        await db_session.execute(
            select(SpoolPrinterParam).where(SpoolPrinterParam.spool_id == spool.id)
        )
    ).scalars()
    assert {
        (item.printer_id, item.param_key): item.param_value for item in spool_params
    } == {
        (printer_a.id, "bambu_nozzle_temp_min"): "195",
        (printer_a.id, "bambu_nozzle_temp_max"): "240",
        (printer_b.id, "bambu_nozzle_temp_min"): "200",
        (printer_b.id, "bambu_nozzle_temp_max"): "240",
    }

    await db_session.refresh(filament)
    await db_session.refresh(spool)
    assert filament.custom_fields == {"notes": "keep filament"}
    assert spool.custom_fields == {"notes": "keep spool"}


@pytest.mark.parametrize(
    "invalid_range",
    [
        {"min": 190},
        {"min": 190, "max": 230, "unit": "C"},
        {"min": True, "max": 230},
        {"min": math.inf, "max": 230},
    ],
)
async def test_invalid_native_nozzle_object_is_retained(
    db_session,
    monkeypatch,
    invalid_range,
):
    printer = Printer(name="Bambu A", driver_key="bambulab")
    manufacturer = Manufacturer(name="Invalid Range Test")
    db_session.add_all([printer, manufacturer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Malformed PLA",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields={
            "bambu_k_value": "0.031",
            "nozzle_temperature": invalid_range,
            "notes": "keep",
        },
    )
    db_session.add(filament)
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch)

    params = (
        await db_session.execute(
            select(FilamentPrinterParam).where(
                FilamentPrinterParam.filament_id == filament.id
            )
        )
    ).scalars()
    assert {item.param_key: item.param_value for item in params} == {
        "bambu_k_value": "0.031"
    }
    await db_session.refresh(filament)
    assert filament.custom_fields == {
        "nozzle_temperature": invalid_range,
        "notes": "keep",
    }


@pytest.mark.parametrize(
    ("mode", "temperature", "param_value", "tag_value"),
    [
        ("system", 215, "215", "215"),
        ("preserve", 215.0, "215", "215"),
        ("system", 215.25, "215.25", "215"),
        ("preserve", 215.75, "215.75", "216"),
    ],
)
async def test_imported_settings_temperatures_reach_bambu_rfid_tag(
    db_session, monkeypatch, mode, temperature, param_value, tag_value
):
    data = json.loads(
        (Path(__file__).parent / "fixtures/spoolman/rich_fields.json").read_text()
    )
    data["filament"][0].update(
        settings_extruder_temp=temperature, settings_bed_temp=60.0
    )
    db_session.add(Printer(name="Bambu", driver_key="bambulab"))
    await db_session.commit()
    server = SpoolmanFixtureServer(data)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman", preview.extra_field_fingerprint, extra_field_mode=mode
    )
    assert result.errors == []
    spool = await db_session.scalar(
        select(Spool).where(Spool.external_id == "spoolman:20")
    )
    filament = await db_session.get(Filament, spool.filament_id)
    spool.filament = filament
    assert filament.extruder_temp_range_c == {"min": temperature, "max": temperature}
    assert filament.bed_temp_range_c == {"min": 60.0, "max": 60.0}
    assert "settings_extruder_temp" not in (filament.custom_fields or {})
    assert "settings_bed_temp" not in (filament.custom_fields or {})

    await _run_bambu_migration(db_session, monkeypatch)

    params = await db_session.scalars(
        select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament.id
        )
    )
    temperatures = {
        item.param_key: item.param_value for item in params if "temp" in item.param_key
    }
    assert temperatures == {
        "bambu_nozzle_temp_min": param_value,
        "bambu_nozzle_temp_max": param_value,
        "bambu_bed_temp": "60",
    }
    tag = await _build_extended_data(db_session, spool, "bambu")
    assert (tag["min_temp"], tag["max_temp"]) == (tag_value, tag_value)
    await db_session.refresh(filament)
    assert filament.extruder_temp_range_c == {"min": temperature, "max": temperature}


@pytest.mark.parametrize(
    ("nozzle", "bed", "expected"),
    [
        (
            {"min": 190, "max": 230},
            {"min": 55, "max": 65},
            {
                "bambu_nozzle_temp_min": "190",
                "bambu_nozzle_temp_max": "230",
                "bambu_bed_temp": "55",
            },
        ),
        (
            {"min": 0, "max": None},
            {"min": 0, "max": 60},
            {"bambu_nozzle_temp_min": "0", "bambu_bed_temp": "0"},
        ),
        (
            {"min": None, "max": 230},
            {"min": None, "max": 60},
            {"bambu_nozzle_temp_max": "230", "bambu_bed_temp": "60"},
        ),
        ({"min": True, "max": 230}, {"min": 80, "max": 60}, {}),
        ({"min": 190, "max": math.inf}, {"min": 50}, {}),
        ({"min": None, "max": None}, None, {}),
    ],
)
async def test_native_temperature_fallback_preserves_printer_overrides_and_profiles(
    db_session, monkeypatch, nozzle, bed, expected
):
    manufacturer = Manufacturer(name="Native Range Test")
    printers = [Printer(name=name, driver_key="bambulab") for name in ("A", "B")]
    db_session.add_all([manufacturer, *printers])
    await db_session.flush()
    profile_metadata = {
        "spoolman_extra": {
            "bambu_profile_base_name": "Generic PLA",
            "bambu_profiles_by_model": {"X1": "PLA profile"},
        },
        "notes": "keep",
    }
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Native PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c=nozzle,
        bed_temp_range_c=bed,
        custom_fields=profile_metadata,
    )
    db_session.add(filament)
    await db_session.flush()
    overrides = {
        "bambu_nozzle_temp_min": "205",
        "bambu_nozzle_temp_max": "250",
        "bambu_bed_temp": "77",
    }
    db_session.add_all(
        [
            FilamentPrinterParam(
                filament_id=filament.id,
                printer_id=printers[0].id,
                param_key=key,
                param_value=value,
            )
            for key, value in overrides.items()
        ]
    )
    db_session.add(
        FilamentPrinterParam(
            filament_id=filament.id,
            printer_id=printers[1].id,
            param_key="bambu_k_value",
            param_value="0.031",
        )
    )
    await db_session.commit()

    for _ in range(2):
        await _run_bambu_migration(db_session, monkeypatch)
        params = (
            await db_session.scalars(
                select(FilamentPrinterParam).where(
                    FilamentPrinterParam.filament_id == filament.id
                )
            )
        ).all()
        for printer, values in zip(
            printers,
            [{**expected, **overrides}, {**expected, "bambu_k_value": "0.031"}],
        ):
            assert {
                p.param_key: p.param_value for p in params if p.printer_id == printer.id
            } == values
        await db_session.refresh(filament)
        assert filament.extruder_temp_range_c == nozzle
        assert filament.bed_temp_range_c == bed
        assert filament.custom_fields == profile_metadata


@pytest.mark.parametrize(
    ("cleared_keys", "remaining"),
    [
        (
            ["bambu_nozzle_temp_min"],
            {"bambu_nozzle_temp_max": "230", "bambu_bed_temp": "60"},
        ),
        (["bambu_nozzle_temp_min", "bambu_nozzle_temp_max"], {"bambu_bed_temp": "60"}),
        (
            ["bambu_bed_temp"],
            {"bambu_nozzle_temp_min": "190", "bambu_nozzle_temp_max": "230"},
        ),
        (["bambu_nozzle_temp_min", "bambu_nozzle_temp_max", "bambu_bed_temp"], {}),
    ],
)
async def test_native_temperature_clear_survives_printer_restart(
    db_session, db_engine, monkeypatch, auth_client, cleared_keys, remaining
):
    class OfflineDriver(BaseDriver):
        async def start(self):
            pass

        async def stop(self):
            pass

    manufacturer = Manufacturer(name="Clear Native Temperatures")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 190, "max": 230},
        bed_temp_range_c={"min": 60, "max": 60},
    )
    db_session.add(filament)
    await db_session.flush()
    db_session.add(
        FilamentPrinterParam(
            filament_id=filament.id,
            printer_id=printer.id,
            param_key="bambu_k_value",
            param_value="0.031",
        )
    )
    await db_session.commit()

    manager = _bambu_manager(db_session, monkeypatch)
    monkeypatch.setattr(manager, "load_driver", lambda _key: OfflineDriver)
    assert await manager.start_printer(printer)
    client, csrf_token = auth_client
    for key in cleared_keys:
        response = await client.delete(
            f"/api/v1/filaments/{filament.id}/printer-params/{printer.id}",
            params={"param_key": key},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204

    # Reload persisted state and recreate the manager, as on a service restart.
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as reopened:
        restarted_printer = await reopened.get(Printer, printer.id)
        manager = _bambu_manager(reopened, monkeypatch)
        monkeypatch.setattr(manager, "load_driver", lambda _key: OfflineDriver)
        assert await manager.start_printer(restarted_printer)
        params = await reopened.scalars(select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament.id,
            FilamentPrinterParam.printer_id == printer.id,
        ))
        assert {p.param_key: p.param_value for p in params} == {
            **remaining, "bambu_k_value": "0.031"
        }


async def test_cleared_native_temperatures_are_not_copied_back_from_another_printer(
    db_session, monkeypatch, auth_client
):
    class OfflineDriver(BaseDriver):
        async def start(self):
            pass

        async def stop(self):
            pass

    manufacturer = Manufacturer(name="Clear All Native Temperatures")
    printers = [Printer(name=name, driver_key="bambulab") for name in ("A", "B")]
    db_session.add_all([manufacturer, *printers])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 190, "max": 230},
        bed_temp_range_c={"min": 60, "max": 60},
    )
    other = Filament(
        manufacturer_id=manufacturer.id,
        designation="Non-native PLA",
        material_type="PLA",
        diameter_mm=1.75,
    )
    db_session.add_all([filament, other])
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "active")
    )
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.flush()
    db_session.add(
        SpoolPrinterParam(
            spool_id=spool.id,
            printer_id=printers[1].id,
            param_key="bambu_k_value",
            param_value="0.035",
        )
    )
    db_session.add(FilamentPrinterParam(
        filament_id=other.id,
        printer_id=printers[1].id,
        param_key="bambu_k_value",
        param_value="0.04",
    ))
    await db_session.commit()

    client, csrf_token = auth_client
    response = await client.delete(
        f"/api/v1/filaments/{filament.id}/printer-params/{printers[0].id}",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 204
    manager = _bambu_manager(db_session, monkeypatch)
    monkeypatch.setattr(manager, "load_driver", lambda _key: OfflineDriver)
    assert await manager.start_printer(printers[0])
    params = (await db_session.scalars(select(FilamentPrinterParam))).all()
    assert {(p.filament_id, p.printer_id, p.param_key): p.param_value for p in params} == {
        (filament.id, printers[1].id, "bambu_nozzle_temp_min"): "190",
        (filament.id, printers[1].id, "bambu_nozzle_temp_max"): "230",
        (filament.id, printers[1].id, "bambu_bed_temp"): "60",
        (other.id, printers[0].id, "bambu_k_value"): "0.04",
        (other.id, printers[1].id, "bambu_k_value"): "0.04",
    }
    spool_params = await db_session.scalars(select(SpoolPrinterParam).where(
        SpoolPrinterParam.printer_id == printers[0].id,
    ))
    assert {p.param_key: p.param_value for p in spool_params} == {"bambu_k_value": "0.035"}


async def test_native_initialization_seeds_later_filaments_and_new_printers(
    db_session, monkeypatch
):
    manufacturer = Manufacturer(name="Later Native Initialization")
    printer = Printer(name="A", driver_key="bambulab", custom_fields={"notes": "keep"})
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Initial PLA",
        material_type="PLA",
        diameter_mm=1.75,
    )
    db_session.add(filament)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)

    # A filament with no native temperatures must remain eligible for initialization.
    filament.extruder_temp_range_c = {"min": 190, "max": 230}
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    minimum = await db_session.scalar(select(FilamentPrinterParam).where(
        FilamentPrinterParam.param_key == "bambu_nozzle_temp_min",
    ))
    assert minimum is not None
    await db_session.delete(minimum)
    # Legacy imports must still migrate after the native defaults were initialized.
    filament.custom_fields = {"bambu_k_value": "0.04"}
    later = Filament(
        manufacturer_id=manufacturer.id,
        designation="Later PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 205, "max": 225},
    )
    db_session.add(later)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)

    params = await db_session.scalars(select(FilamentPrinterParam))
    assert {(p.filament_id, p.param_key): p.param_value for p in params} == {
        (filament.id, "bambu_nozzle_temp_max"): "230",
        (filament.id, "bambu_k_value"): "0.04",
        (later.id, "bambu_nozzle_temp_min"): "205",
        (later.id, "bambu_nozzle_temp_max"): "225",
    }
    assert printer.custom_fields["notes"] == "keep"
    assert filament.custom_fields is None

    new_printer = Printer(name="B", driver_key="bambulab")
    db_session.add(new_printer)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    params = await db_session.scalars(select(FilamentPrinterParam).where(
        FilamentPrinterParam.printer_id == new_printer.id,
    ))
    assert {(p.filament_id, p.param_key): p.param_value for p in params} == {
        (filament.id, "bambu_nozzle_temp_min"): "190",
        (filament.id, "bambu_nozzle_temp_max"): "230",
        (filament.id, "bambu_k_value"): "0.04",
        (later.id, "bambu_nozzle_temp_min"): "205",
        (later.id, "bambu_nozzle_temp_max"): "225",
    }


async def test_native_initialization_allows_a_recreated_filament_with_reused_id(
    db_session, db_engine, monkeypatch
):
    manufacturer = Manufacturer(name="Recreated Native Initialization")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Old PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 190, "max": 230},
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    db_session.add(filament)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    filament_id, printer_id = filament.id, printer.id
    await db_session.delete(filament)
    await db_session.flush()
    recreated = Filament(
        manufacturer_id=manufacturer.id,
        designation="Replacement PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 205, "max": 225},
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    db_session.add(recreated)
    await db_session.commit()
    assert recreated.id == filament_id  # SQLite reuses a deleted maximum row ID.

    # Use a fresh session so initialization state is reloaded from the database.
    async with async_sessionmaker(db_engine, expire_on_commit=False)() as reopened:
        for _ in range(2):
            await _run_bambu_migration(reopened, monkeypatch)
            params = await reopened.scalars(select(FilamentPrinterParam).where(
                FilamentPrinterParam.printer_id == printer_id,
                FilamentPrinterParam.filament_id == filament_id,
            ))
            assert {p.param_key: p.param_value for p in params} == {
                "bambu_nozzle_temp_min": "205",
                "bambu_nozzle_temp_max": "225",
            }


@pytest.mark.parametrize(
    ("custom_fields", "expected", "remaining"),
    [
        (
            {"settings_extruder_temp": 210, "settings_bed_temp": 50},
            {
                "bambu_nozzle_temp_min": "210",
                "bambu_nozzle_temp_max": "210",
                "bambu_bed_temp": "50",
            },
            None,
        ),
        (
            {"nozzle_temperature": [195, 225], "settings_extruder_temp": 210},
            {
                "bambu_nozzle_temp_min": "195",
                "bambu_nozzle_temp_max": "225",
                "bambu_bed_temp": "60",
            },
            None,
        ),
        (
            {
                "bambu_nozzle_temp_min": 205,
                "bambu_bed_temp": 70,
                "settings_extruder_temp": 210,
                "spoolman_extra": {
                    "bambu_nozzle_temp_min": 200,
                    "bambu_nozzle_temp_max": 240,
                },
            },
            {
                "bambu_nozzle_temp_min": "205",
                "bambu_nozzle_temp_max": "240",
                "bambu_bed_temp": "70",
            },
            None,
        ),
        (
            {"bambu_nozzle_temp": 205},
            {
                "bambu_nozzle_temp_min": "205",
                "bambu_nozzle_temp_max": "230",
                "bambu_bed_temp": "60",
            },
            None,
        ),
        (
            {"nozzle_temperature": {"min": True, "max": 240}},
            {
                "bambu_nozzle_temp_min": "190",
                "bambu_nozzle_temp_max": "230",
                "bambu_bed_temp": "60",
            },
            {"nozzle_temperature": {"min": True, "max": 240}},
        ),
    ],
)
async def test_legacy_temperature_precedence_above_native_fallback(
    db_session, monkeypatch, custom_fields, expected, remaining
):
    manufacturer = Manufacturer(name="Legacy Precedence Test")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Legacy PLA",
        material_type="PLA",
        diameter_mm=1.75,
        custom_fields=custom_fields,
        extruder_temp_range_c={"min": 190, "max": 230},
        bed_temp_range_c={"min": 60, "max": 60},
    )
    db_session.add(filament)
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch)

    params = await db_session.scalars(
        select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament.id
        )
    )
    assert {p.param_key: p.param_value for p in params} == expected
    await db_session.refresh(filament)
    assert filament.custom_fields == remaining


@pytest.mark.parametrize("legacy_temperature", [None, 210])
async def test_existing_printer_start_copies_calibration_before_native_defaults(
    db_session, monkeypatch, legacy_temperature
):
    class OfflineDriver(BaseDriver):
        async def start(self):
            pass

        async def stop(self):
            pass

    manufacturer = Manufacturer(name="Startup Migration Test")
    source = Printer(name="Existing Bambu", driver_key="bambulab")
    target = Printer(name="New Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, source, target])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Startup PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 215, "max": 215},
        custom_fields={"settings_extruder_temp": legacy_temperature}
        if legacy_temperature is not None
        else None,
    )
    db_session.add(filament)
    await db_session.flush()
    db_session.add_all(
        [
            FilamentPrinterParam(
                filament_id=filament.id,
                printer_id=source.id,
                param_key=key,
                param_value=value,
            )
            for key, value in {
                "bambu_setting_id": "saved-profile",
                "bambu_k_value": "0.035",
                "bambu_nozzle_temp_min": "225",
            }.items()
        ]
    )
    await db_session.commit()
    manager = _bambu_manager(db_session, monkeypatch)
    monkeypatch.setattr(manager, "load_driver", lambda _key: OfflineDriver)

    assert await manager.start_printer(source)
    expected = {
        "bambu_setting_id": "saved-profile",
        "bambu_k_value": "0.035",
        "bambu_nozzle_temp_min": "225",
    }
    if legacy_temperature is not None:
        expected["bambu_nozzle_temp_max"] = "210"
    for printer in (target, source):
        params = await db_session.scalars(
            select(FilamentPrinterParam).where(
                FilamentPrinterParam.filament_id == filament.id,
                FilamentPrinterParam.printer_id == printer.id,
            )
        )
        assert {p.param_key: p.param_value for p in params} == expected
    assert await manager.start_printer(target)
    params = await db_session.scalars(
        select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament.id,
            FilamentPrinterParam.printer_id == target.id,
        )
    )
    assert {p.param_key: p.param_value for p in params} == expected


@pytest.mark.parametrize(
    ("native", "override_key", "override_value", "expected"),
    [
        (
            {"min": 215, "max": 215},
            "bambu_nozzle_temp_min",
            "225",
            {"bambu_nozzle_temp_min": "225"},
        ),
        (
            {"min": 215, "max": 215},
            "bambu_nozzle_temp_max",
            "200",
            {"bambu_nozzle_temp_max": "200"},
        ),
        (
            {"min": 215, "max": 230},
            "bambu_nozzle_temp_min",
            "225",
            {"bambu_nozzle_temp_min": "225", "bambu_nozzle_temp_max": "230"},
        ),
        (
            {"min": 215, "max": None},
            "bambu_nozzle_temp_max",
            "200",
            {"bambu_nozzle_temp_max": "200"},
        ),
        (
            {"min": 215, "max": 230},
            "bambu_nozzle_temp_min",
            "invalid",
            {"bambu_nozzle_temp_min": "invalid", "bambu_nozzle_temp_max": "230"},
        ),
    ],
)
async def test_native_fallback_does_not_invert_explicit_printer_range(
    db_session, monkeypatch, native, override_key, override_value, expected
):
    manufacturer = Manufacturer(name="Native Conflict Test")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Conflict PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c=native,
    )
    db_session.add(filament)
    await db_session.flush()
    db_session.add(
        FilamentPrinterParam(
            filament_id=filament.id,
            printer_id=printer.id,
            param_key=override_key,
            param_value=override_value,
        )
    )
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch)

    params = await db_session.scalars(
        select(FilamentPrinterParam).where(
            FilamentPrinterParam.filament_id == filament.id
        )
    )
    assert {p.param_key: p.param_value for p in params} == expected


@pytest.mark.parametrize("entity_count", [1, 25])
async def test_bambu_migration_parameter_reads_do_not_scale_with_entities(
    db_session, db_engine, monkeypatch, entity_count
):
    manufacturer = Manufacturer(name="Migration query count")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filaments = [
        Filament(
            manufacturer_id=manufacturer.id,
            designation=f"PLA {index}",
            material_type="PLA",
            diameter_mm=1.75,
            extruder_temp_range_c={"min": 190, "max": 230},
        )
        for index in range(entity_count)
    ]
    db_session.add_all(filaments)
    await db_session.flush()
    status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "active")
    )
    spools = [
        Spool(
            filament_id=filament.id,
            status_id=status_id,
            custom_fields={"bambu_k_value": "0.025"},
        )
        for filament in filaments
    ]
    db_session.add_all(spools)
    await db_session.flush()
    db_session.add_all(
        [
            FilamentPrinterParam(
                filament_id=filaments[0].id,
                printer_id=printer.id,
                param_key="bambu_nozzle_temp_min",
                param_value="205",
            ),
            SpoolPrinterParam(
                spool_id=spools[0].id,
                printer_id=printer.id,
                param_key="bambu_k_value",
                param_value="0.031",
            ),
        ]
    )
    for model, entity_field, entity_id in (
        (FilamentPrinterParam, "filament_id", filaments[0].id),
        (SpoolPrinterParam, "spool_id", spools[0].id),
    ):
        db_session.add(
            model(
                **{
                    entity_field: entity_id,
                    "printer_id": printer.id,
                    "param_key": "unrelated_payload",
                    "param_value": "x" * 100_000,
                }
            )
        )
    await db_session.commit()

    reads = []
    loaded_keys = []

    def capture_loaded(_session, row):
        if isinstance(row, (FilamentPrinterParam, SpoolPrinterParam)):
            loaded_keys.append(row.param_key)

    def capture_reads(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            reads.append(statement)

    event.listen(db_session.sync_session, "loaded_as_persistent", capture_loaded)
    event.listen(db_engine.sync_engine, "before_cursor_execute", capture_reads)
    try:
        for _ in range(2):
            reads.clear()
            await _run_bambu_migration(db_session, monkeypatch)
            # Upstream adds two bounded scans to restore misplaced RFID identity fields.
            assert len(reads) <= 10, f"{len(reads)} SELECTs for {entity_count} entities"
            assert "unrelated_payload" not in loaded_keys
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture_reads)
        event.remove(db_session.sync_session, "loaded_as_persistent", capture_loaded)

    params = (
        await db_session.scalars(
            select(FilamentPrinterParam).where(
                FilamentPrinterParam.param_key != "unrelated_payload"
            )
        )
    ).all()
    assert len(params) == entity_count * 2
    assert {(p.filament_id, p.param_key): p.param_value for p in params} == {
        (filament.id, key): value
        for index, filament in enumerate(filaments)
        for key, value in {
            "bambu_nozzle_temp_min": "205" if index == 0 else "190",
            "bambu_nozzle_temp_max": "230",
        }.items()
    }
    spool_params = (
        await db_session.scalars(
            select(SpoolPrinterParam).where(
                SpoolPrinterParam.param_key != "unrelated_payload"
            )
        )
    ).all()
    assert len(spool_params) == entity_count
    assert {p.spool_id: p.param_value for p in spool_params} == {
        spool.id: "0.031" if index == 0 else "0.025"
        for index, spool in enumerate(spools)
    }


@pytest.mark.parametrize("kind", ["", "-inventory"])
@pytest.mark.parametrize("format", ["json", "jsonl"])
async def test_native_temperature_clear_survives_backup_restore(
    db_session, monkeypatch, auth_client, tmp_path, kind, format
):
    from app.api.v1 import system

    monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
    manufacturer = Manufacturer(name="Native Backup Test")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 190, "max": 230},
    )
    db_session.add(filament)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    client, csrf_token = auth_client
    cleared = await client.delete(
        f"/api/v1/filaments/{filament.id}/printer-params/{printer.id}",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert cleared.status_code == 204
    exported = await client.get(
        f"/api/v1/admin/system/backup/export{kind}?format={format}"
    )
    assert exported.status_code == 200
    # Restore into storage without the initialization row, as on a fresh installation.
    await db_session.execute(delete(FilamentPrinterInitialization))
    await db_session.commit()
    restored = await client.post(
        f"/api/v1/admin/system/backup/import{kind}",
        files={"file": (f"backup.{format}", exported.content, exported.headers["content-type"])},
        headers={"X-CSRF-Token": csrf_token},
    )
    assert restored.status_code == 200, restored.text
    await _run_bambu_migration(db_session, monkeypatch)
    assert (await db_session.scalars(select(FilamentPrinterParam))).all() == []


@pytest.mark.parametrize("cleanup", ["killswitch", "uninstall"])
async def test_native_initialization_is_removed_with_inventory_or_plugin_data(
    db_session, monkeypatch, cleanup
):
    from app.api.v1 import system
    from app.core.security import Principal

    manufacturer = Manufacturer(name="Native Cleanup Test")
    printer = Printer(name="Bambu", driver_key="bambulab")
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="PLA",
        material_type="PLA",
        diameter_mm=1.75,
        extruder_temp_range_c={"min": 190, "max": 230},
    )
    db_session.add(filament)
    await db_session.commit()
    await _run_bambu_migration(db_session, monkeypatch)
    assert await db_session.scalar(select(FilamentPrinterInitialization)) is not None
    principal = Principal(auth_type="session", user_id=1, is_superadmin=True)
    if cleanup == "killswitch":
        await system.killswitch(db_session, principal)
    else:
        async def keep_plugin_files(_service, _plugin_key):
            pass

        monkeypatch.setattr(system.PluginInstallService, "uninstall", keep_plugin_files)
        await system.uninstall_plugin("bambulab", db_session, principal, delete_data=True)
    assert await db_session.scalar(select(FilamentPrinterInitialization)) is None


async def test_rfid_tags_stay_in_custom_fields_and_misfiled_params_are_restored(
    db_session,
    monkeypatch,
):
    printer_a = Printer(name="Bambu RFID A", driver_key="bambulab")
    printer_b = Printer(name="Bambu RFID B", driver_key="bambulab")
    manufacturer = Manufacturer(name="Bambu RFID Test")
    db_session.add_all([printer_a, printer_b, manufacturer])
    await db_session.flush()

    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="RFID PLA",
        material_type="PLA",
        diameter_mm=1.75,
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(
        select(SpoolStatus.id).where(SpoolStatus.key == "active")
    )
    kept_spool = Spool(
        filament_id=filament.id,
        status_id=status_id,
        custom_fields={
            "bambu_rfid_tag_1": "0B:11:57:FF",
            "spoolman_extra": {"bambu_rfid_tag_2": "4B:5B:51:FF"},
        },
    )
    misfiled_spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add_all([kept_spool, misfiled_spool])
    await db_session.flush()
    db_session.add_all(
        [
            SpoolPrinterParam(
                spool_id=misfiled_spool.id,
                printer_id=printer_id,
                param_key=key,
                param_value=value,
            )
            for printer_id in (printer_a.id, printer_b.id)
            for key, value in (
                ("bambu_rfid_tag_1", "AA:BB:CC:DD"),
                ("bambu_rfid_tag_2", "EE:FF:00:11"),
            )
        ]
    )
    await db_session.commit()

    await _run_bambu_migration(db_session, monkeypatch)

    await db_session.refresh(kept_spool)
    await db_session.refresh(misfiled_spool)
    assert kept_spool.custom_fields == {
        "bambu_rfid_tag_1": "0B:11:57:FF",
        "spoolman_extra": {"bambu_rfid_tag_2": "4B:5B:51:FF"},
    }
    assert misfiled_spool.custom_fields == {
        "bambu_rfid_tag_1": "AA:BB:CC:DD",
        "bambu_rfid_tag_2": "EE:FF:00:11",
    }
    remaining = (
        await db_session.execute(
            select(SpoolPrinterParam).where(
                SpoolPrinterParam.param_key.like("bambu_rfid_tag_%")
            )
        )
    ).scalars().all()
    assert remaining == []


def _declared_bambu_manager(db_session, monkeypatch, keys=None):
    manager = _bambu_manager(db_session, monkeypatch)
    keys = keys if keys is not None else [
        'bambu_idx', 'bambu_tray_idx', 'bambu_cali_idx', 'bambu_setting_id',
        'bambu_k_value', 'bambu_flow_ratio', 'bambu_max_volumetric_speed',
        'bambu_default_nozzle_mm', 'bambu_nozzle_temp_min',
        'bambu_nozzle_temp_max', 'bambu_bed_temp',
    ]
    monkeypatch.setattr(manager, '_load_plugin_json', lambda _key: {
        'printer_params': {
            'target_types': ['filament_printer_param', 'spool_printer_param'],
            'fields': [{'key': key, 'label': key} for key in keys],
            'migration': {'legacy_renames': {
                'bambu_k': 'bambu_k_value', 'bambu_cali_id': 'bambu_cali_idx',
                'bambu_max_volspeed': 'bambu_max_volumetric_speed',
            }},
        },
    })
    return manager


@pytest.mark.parametrize('driver_key', ['bambuddy', 'bambulab', 'unrelated'])
async def test_declared_driver_migration_preserves_indices_zeros_and_unrelated_data(
    db_session, monkeypatch, driver_key
):
    manufacturer = Manufacturer(name='Declared migration')
    printer = Printer(name='Current driver', driver_key=driver_key)
    unrelated = Printer(name='Other driver', driver_key='other')
    db_session.add_all([manufacturer, printer, unrelated])
    await db_session.flush()
    retained = {'bambu_profiles_by_model': {'X1': 'profile'}, 'bambu_unknown': 17}
    filament = Filament(
        manufacturer_id=manufacturer.id, designation='PLA', material_type='PLA',
        diameter_mm=1.75, pressure_advance_k=0.09,
        extruder_temp_range_c={'min': 215.75, 'max': 235},
        custom_fields={**retained, 'bambu_k': 0, 'bambu_flow_ratio': 0,
                       'bambu_max_volspeed': 18, 'bambu_default_nozzle_mm': 0.4,
                       'bambu_idx': 'GFL01', 'bambu_cali_id': '7'},
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).where(SpoolStatus.key == 'active'))
    spool = Spool(filament_id=filament.id, status_id=status_id,
                  custom_fields={'bambu_k': 0, 'bambu_rfid_tag_1': 'UID'})
    db_session.add(spool)
    await db_session.flush()
    db_session.add_all([
        FilamentPrinterParam(filament_id=filament.id, printer_id=unrelated.id,
                             param_key='bambu_k', param_value='0.05'),
        SpoolPrinterParam(spool_id=spool.id, printer_id=unrelated.id,
                          param_key='bambu_k', param_value='0.06'),
    ])
    await db_session.commit()
    original = dict(filament.custom_fields)
    manager = _declared_bambu_manager(db_session, monkeypatch,
                                    ['temperature'] if driver_key == 'unrelated' else None)
    await manager._migrate_spoolman_bambu_fields(driver_key)
    params = await db_session.scalars(select(FilamentPrinterParam))
    by_printer = {(p.printer_id, p.param_key): p.param_value for p in params}
    assert by_printer.pop((unrelated.id, 'bambu_k')) == '0.05'
    if driver_key == 'unrelated':
        assert by_printer == {}
        assert filament.custom_fields == original
    else:
        index_key = 'bambu_tray_idx' if driver_key == 'bambulab' else 'bambu_idx'
        assert by_printer == {
            (printer.id, 'bambu_k_value'): '0', (printer.id, 'bambu_flow_ratio'): '0',
            (printer.id, 'bambu_max_volumetric_speed'): '18',
            (printer.id, 'bambu_default_nozzle_mm'): '0.4',
            (printer.id, 'bambu_cali_idx'): '7', (printer.id, index_key): 'GFL01',
            (printer.id, 'bambu_nozzle_temp_min'): '215.75',
            (printer.id, 'bambu_nozzle_temp_max'): '235',
        }
        assert filament.custom_fields == retained
        assert spool.custom_fields == {'bambu_rfid_tag_1': 'UID'}
    spool_params = await db_session.scalars(select(SpoolPrinterParam))
    assert {(p.printer_id, p.param_key): p.param_value for p in spool_params} == {
        (unrelated.id, 'bambu_k'): '0.06',
        **({} if driver_key == 'unrelated' else {(printer.id, 'bambu_k_value'): '0'}),
    }


async def test_declared_driver_preserves_overrides_and_cleared_temperature_pairs(
    db_session, monkeypatch
):
    manufacturer = Manufacturer(name='Override migration')
    printers = [Printer(name=name, driver_key='bambuddy') for name in ('Override', 'Cleared')]
    db_session.add_all([manufacturer, *printers])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation='PLA', material_type='PLA',
        diameter_mm=1.75, extruder_temp_range_c={'min': 215, 'max': 235},
        bed_temp_range_c={'min': 60, 'max': 70},
        custom_fields={'bambu_k': 0.03, 'bambu_nozzle_temp_min': 205},
    )
    db_session.add(filament)
    await db_session.flush()
    db_session.add_all([
        FilamentPrinterInitialization(filament_id=filament.id, printer_id=printers[1].id),
        FilamentPrinterParam(filament_id=filament.id, printer_id=printers[0].id,
                             param_key='bambu_k_value', param_value='0.04'),
        FilamentPrinterParam(filament_id=filament.id, printer_id=printers[0].id,
                             param_key='bambu_nozzle_temp_min', param_value='220'),
        FilamentPrinterParam(filament_id=filament.id, printer_id=printers[1].id,
                             param_key='bambu_k_value', param_value=None),
    ])
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch)
    await manager._migrate_spoolman_bambu_fields('bambuddy')
    params = await db_session.scalars(select(FilamentPrinterParam))
    assert {(p.printer_id, p.param_key): p.param_value for p in params} == {
        (printers[0].id, 'bambu_k_value'): '0.04',
        (printers[0].id, 'bambu_nozzle_temp_min'): '220',
        (printers[0].id, 'bambu_nozzle_temp_max'): '235',
        (printers[0].id, 'bambu_bed_temp'): '60',
        (printers[1].id, 'bambu_k_value'): None,
        (printers[1].id, 'bambu_nozzle_temp_min'): '205',
    }


@pytest.mark.parametrize('edited', [{'min': 216.75, 'max': 236.25}, None])
@pytest.mark.parametrize('source_changed', [False, True])
async def test_promoted_temperature_snapshot_cannot_win_after_native_edit_on_start(
    db_session, monkeypatch, edited, source_changed
):
    class OfflineDriver(BaseDriver):
        async def start(self):
            pass

        async def stop(self):
            pass

    manufacturer = Manufacturer(name='Promoted temperature')
    printer = Printer(name='Bambuddy', driver_key='bambuddy')
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    # Use the real upgrade output so retained-source provenance cannot drift.
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    from tests.test_filament_temperature_migration import (
        legacy_schema,
        load_migration_module,
    )

    metadata, legacy_filaments, _, _ = legacy_schema()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(legacy_filaments.insert(), {
            "id": 1, "custom_fields": {"spoolman_extra": {"nozzle_temperature": [190, 230]}},
        })
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        promoted = dict(connection.execute(sa.select(upgraded)).mappings().one())
    engine.dispose()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation="PLA", material_type="PLA",
        diameter_mm=1.75, extruder_temp_range_c=promoted["extruder_temp_range_c"],
        custom_fields=promoted["custom_fields"], label_field_aliases=promoted["label_field_aliases"],
    )
    db_session.add(filament)
    await db_session.commit()
    filament.extruder_temp_range_c = edited
    if source_changed:
        filament.custom_fields = {'spoolman_extra': {'nozzle_temperature': [210, 250]}}
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch)
    monkeypatch.setattr(manager, 'load_driver', lambda _key: OfflineDriver)
    assert await manager.start_printer(printer)
    params = await db_session.scalars(select(FilamentPrinterParam))
    assert {p.param_key: p.param_value for p in params} == (
        {'bambu_nozzle_temp_min': '210', 'bambu_nozzle_temp_max': '250'} if source_changed else
        {'bambu_nozzle_temp_min': '216.75', 'bambu_nozzle_temp_max': '236.25'} if edited else {}
    )
    assert filament.custom_fields == (
        None if source_changed else {'spoolman_extra': {'nozzle_temperature': [190, 230]}}
    )


async def test_driver_native_temperature_enrichment_respects_declarations_and_clear(
    db_session, monkeypatch
):
    manufacturer = Manufacturer(name='Enriched native temperature')
    printer = Printer(name='Bambuddy', driver_key='bambuddy')
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation='PLA', material_type='PLA', diameter_mm=1.75,
        extruder_temp_range_c={'min': 216.75, 'max': 236.25},
        bed_temp_range_c={'min': 65, 'max': 75}, pressure_advance_k=0.07,
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).where(SpoolStatus.key == 'active'))
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch,
                                    ['bambu_nozzle_temp_min', 'bambu_nozzle_temp_max'])
    base = {'nozzle_temp_min': 190, 'nozzle_temp_max': 230}
    native = await manager.enrich_filament_data(spool.id, printer.id, base)
    assert native == {**base, 'bambu_nozzle_temp_min': '216.75',
                      'bambu_nozzle_temp_max': '236.25', 'id': spool.id, 'filament_id': filament.id}
    db_session.add_all([
        FilamentPrinterParam(filament_id=filament.id, printer_id=printer.id,
                             param_key='bambu_nozzle_temp_min', param_value=None),
        SpoolPrinterParam(spool_id=spool.id, printer_id=printer.id,
                          param_key='bambu_nozzle_temp_max', param_value=''),
    ])
    await db_session.commit()
    empty = await manager.enrich_filament_data(spool.id, printer.id, base)
    assert empty == {**base, 'id': spool.id, 'filament_id': filament.id}
    db_session.add_all([
        FilamentPrinterInitialization(filament_id=filament.id, printer_id=printer.id),
        SpoolPrinterParam(spool_id=spool.id, printer_id=printer.id,
                          param_key='bambu_nozzle_temp_min', param_value='225'),
    ])
    await db_session.commit()
    cleared = await manager.enrich_filament_data(spool.id, printer.id, base)
    assert cleared == {**base, 'bambu_nozzle_temp_min': '225',
                       'id': spool.id, 'filament_id': filament.id}


async def test_partial_temperature_declaration_does_not_discard_unhandled_legacy_endpoint(
    db_session, monkeypatch
):
    manufacturer = Manufacturer(name='Partial declaration')
    printer = Printer(name='Limited driver', driver_key='compatible')
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation='PLA', material_type='PLA', diameter_mm=1.75,
        custom_fields={'nozzle_temperature': [205, 245], 'bambu_k': 0.03},
    )
    db_session.add(filament)
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch, ['bambu_nozzle_temp_min'])
    await manager._migrate_spoolman_bambu_fields('compatible')
    params = await db_session.scalars(select(FilamentPrinterParam))
    assert {p.param_key: p.param_value for p in params} == {'bambu_nozzle_temp_min': '205'}
    assert filament.custom_fields == {'nozzle_temperature': [205, 245], 'bambu_k': 0.03}


@pytest.mark.parametrize('param_model,entity_key', [
    (FilamentPrinterParam, 'filament_id'), (SpoolPrinterParam, 'spool_id'),
])
async def test_declared_legacy_row_rename_preserves_existing_destination_and_row_identity(
    db_session, monkeypatch, param_model, entity_key
):
    manufacturer = Manufacturer(name='Rename collision')
    printer = Printer(name='Bambuddy', driver_key='bambuddy')
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(manufacturer_id=manufacturer.id, designation='PLA',
                        material_type='PLA', diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).where(SpoolStatus.key == 'active'))
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.flush()
    entity_id = filament.id if entity_key == 'filament_id' else spool.id
    rows = [param_model(**{entity_key: entity_id, 'printer_id': printer.id,
                           'param_key': key, 'param_value': value})
            for key, value in [('bambu_k', '0.03'), ('bambu_k_value', None), ('bambu_cali_id', '4')]]
    db_session.add_all(rows)
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch)
    await manager._migrate_spoolman_bambu_fields('bambuddy')
    saved = await db_session.scalars(select(param_model))
    assert {p.param_key: (p.id, p.param_value) for p in saved} == {
        'bambu_k_value': (rows[1].id, None), 'bambu_cali_idx': (rows[2].id, '4'),
    }


@pytest.mark.parametrize('native,declared_keys,filament_values,spool_values,expected', [
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_min': '225'}, {}, {'bambu_nozzle_temp_min': '225'}),
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_max': '200'}, {}, {'bambu_nozzle_temp_max': '200'}),
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_min': '205'}, {'bambu_nozzle_temp_min': '225.75'},
     {'bambu_nozzle_temp_min': '225.75'}),
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_max': '225'}, {'bambu_nozzle_temp_max': '200.25'},
     {'bambu_nozzle_temp_max': '200.25'}),
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_min': '225'}, {'bambu_nozzle_temp_min': '0'},
     {'bambu_nozzle_temp_min': '0', 'bambu_nozzle_temp_max': '215'}),
    ({'min': 215, 'max': 215}, None,
     {'bambu_nozzle_temp_max': '200'}, {'bambu_nozzle_temp_max': '225'},
     {'bambu_nozzle_temp_min': '215', 'bambu_nozzle_temp_max': '225'}),
    ({'min': 240, 'max': None}, None, {}, {}, {}),
    ({'min': None, 'max': 170}, None, {}, {}, {}),
    ({'min': 240.25, 'max': 260.75}, None, {}, {},
     {'bambu_nozzle_temp_min': '240.25', 'bambu_nozzle_temp_max': '260.75'}),
    ({'min': 150.25, 'max': 170.75}, None, {}, {},
     {'bambu_nozzle_temp_min': '150.25', 'bambu_nozzle_temp_max': '170.75'}),
    ({'min': 240, 'max': 260}, None, {'bambu_nozzle_temp_max': None}, {}, {}),
    ({'min': 150, 'max': 170}, None, {}, {'bambu_nozzle_temp_min': ''}, {}),
    ({'min': 240, 'max': 260}, ['bambu_nozzle_temp_min'], {}, {}, {}),
    ({'min': 150, 'max': 170}, ['bambu_nozzle_temp_max'], {}, {}, {}),
])
async def test_assignment_native_fallback_does_not_invert_effective_bounds(
    db_session, monkeypatch, native, declared_keys, filament_values, spool_values, expected
):
    manufacturer = Manufacturer(name='Assignment range conflict')
    printer = Printer(name='Bambuddy', driver_key='bambuddy')
    db_session.add_all([manufacturer, printer])
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id, designation='PLA', material_type='PLA', diameter_mm=1.75,
        extruder_temp_range_c=native,
    )
    db_session.add(filament)
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).where(SpoolStatus.key == 'active'))
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.flush()
    db_session.add_all([
        FilamentPrinterParam(filament_id=filament.id, printer_id=printer.id,
                             param_key=key, param_value=value)
        for key, value in filament_values.items()
    ] + [
        SpoolPrinterParam(spool_id=spool.id, printer_id=printer.id,
                          param_key=key, param_value=value)
        for key, value in spool_values.items()
    ])
    await db_session.commit()
    manager = _declared_bambu_manager(db_session, monkeypatch, declared_keys)
    base = {'nozzle_temp_min': 190, 'nozzle_temp_max': 230}
    enriched = await manager.enrich_filament_data(spool.id, printer.id, base)
    assert enriched == {**base, **expected, 'id': spool.id, 'filament_id': filament.id}


@pytest.mark.parametrize('opposite', ['invalid', 'nan', 'inf', '-inf', 10 ** 400])
def test_native_fallback_preserves_uncomparable_caller_bounds(opposite):
    assert PluginManager._bambu_temperature_fallbacks(
        {'bambu_nozzle_temp_min': '240'}, {}, {'bambu_nozzle_temp_max': opposite},
    ) == {'bambu_nozzle_temp_min': '240'}
