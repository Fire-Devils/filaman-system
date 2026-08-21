import math

import pytest
from sqlalchemy import select

from app.models import (
    FilamentPrinterParam,
    Manufacturer,
    Printer,
    Spool,
    SpoolPrinterParam,
    SpoolStatus,
)
from app.models.filament import Filament
from app.plugins.manager import PluginManager


async def _run_bambu_migration(db_session, monkeypatch):
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
    await manager._migrate_spoolman_bambu_fields("bambulab")


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


async def test_partial_bambu_migration_upserts_every_entity_printer_parameter(
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
        (printer_a.id, "bambu_nozzle_temp_min"): "200",
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
