from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from app.api.v1.system import _export_inventory_data, _import_inventory_data
from app.models import Filament, Manufacturer, Spool, SpoolStatus, SystemExtraField
from app.services.spoolman_import_service import ImportResult, SpoolmanImportService


class _SchemaRecord:
    """Small schema stand-in for the separately installed compatibility plugin."""

    def __init__(self, **values: Any):
        for key, value in values.items():
            setattr(self, key, value)

    def model_dump(self, *, exclude_none: bool = False) -> dict[str, Any]:
        def dump(value: Any) -> Any:
            if isinstance(value, _SchemaRecord):
                return value.model_dump(exclude_none=exclude_none)
            if isinstance(value, datetime):
                return value.isoformat()
            if isinstance(value, list):
                return [dump(item) for item in value]
            if isinstance(value, dict):
                return {key: dump(item) for key, item in value.items()}
            return value

        return {
            key: dump(value)
            for key, value in vars(self).items()
            if not exclude_none or value is not None
        }


def _load_spoolman_service(monkeypatch):
    """Load the tracked adapter without requiring the runtime plugin package."""
    package_name = "app.plugins.spoolmanapi"
    schemas_name = f"{package_name}.schemas"
    service_name = f"{package_name}.contract_test_service"

    package = ModuleType(package_name)
    package.__path__ = []
    schemas = ModuleType(schemas_name)
    schemas.Vendor = _SchemaRecord
    schemas.Filament = _SchemaRecord
    schemas.Spool = _SchemaRecord
    monkeypatch.setitem(sys.modules, package_name, package)
    monkeypatch.setitem(sys.modules, schemas_name, schemas)

    service_path = (
        Path(__file__).parents[1] / "app/plugins/spoolmanapi/service.py"
    )
    spec = importlib.util.spec_from_file_location(service_name, service_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, service_name, module)
    spec.loader.exec_module(module)
    return module.SpoolmanService


def test_spoolman_adapter_golden_payload_ignores_native_derived(monkeypatch):
    service_class = _load_spoolman_service(monkeypatch)
    registered = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    filament = SimpleNamespace(
        id=11,
        created_at=registered,
        designation="Contract PLA",
        manufacturer=None,
        material_type="PLA",
        price=None,
        density_g_cm3=None,
        diameter_mm=1.75,
        raw_material_weight_g=None,
        default_spool_weight_g=None,
        color_mode="single",
        multi_color_style=None,
        filament_colors=[],
        custom_fields={"structured": {"min": 190, "max": 220}},
        derived={"native_only": "must not leak"},
    )
    spool = SimpleNamespace(
        id=22,
        created_at=registered,
        stocked_in_at=None,
        last_used_at=None,
        filament=filament,
        purchase_price=None,
        initial_total_weight_g=1000.0,
        empty_spool_weight_g=250.0,
        remaining_weight_g=500.0,
        location=None,
        lot_number="LOT-22",
        status=SimpleNamespace(key="active"),
        custom_fields={"comment": "Stored note", "tags": ["A", "B"]},
        derived={"native_only": 500},
    )

    payload = service_class(None)._spool_to_schema(spool).model_dump(
        exclude_none=True
    )

    assert payload == {
        "id": 22,
        "registered": "2026-01-02T03:04:05+00:00",
        "filament": {
            "id": 11,
            "registered": "2026-01-02T03:04:05+00:00",
            "name": "Contract PLA",
            "material": "PLA",
            "diameter": 1.75,
            "extra": {"structured": {"min": 190, "max": 220}},
        },
        "initial_weight": 750.0,
        "spool_weight": 250.0,
        "remaining_weight": 500.0,
        "used_weight": 250.0,
        "lot_nr": "LOT-22",
        "comment": "Stored note",
        "archived": False,
        "extra": {"tags": ["A", "B"]},
    }


@pytest.mark.asyncio
async def test_spoolman_import_preserves_structured_extra_without_formula_definitions(
    db_session,
):
    manufacturer = Manufacturer(name="Importer manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Importer filament",
        material_type="PLA",
        diameter_mm=1.75,
    )
    formula = SystemExtraField(
        target_type="spool",
        key="existing_formula",
        label="Existing formula",
        field_type="formula",
        formula={"var": "remaining_weight_g"},
    )
    db_session.add_all([filament, formula])
    await db_session.flush()
    status_result = await db_session.execute(
        select(SpoolStatus).where(SpoolStatus.key == "new")
    )
    status = status_result.scalar_one()

    result = ImportResult()
    await SpoolmanImportService(db_session)._import_spools(
        [
            {
                "id": 77,
                "filament": {"id": 42},
                "initial_weight": 750.0,
                "spool_weight": 250.0,
                "remaining_weight": 500.0,
                "comment": "Imported note",
                "extra": {
                    "temperature_band": {"min": 190, "max": 220},
                    "tags": ["A", "B"],
                },
            }
        ],
        filament_map={42: filament.id},
        location_map={},
        location_name_map={},
        status_map={"new": status.id, "active": status.id},
        result=result,
    )
    await db_session.commit()

    spool_result = await db_session.execute(
        select(Spool).where(Spool.external_id == "spoolman:77")
    )
    imported = spool_result.scalar_one()
    assert result.spools_created == 1
    assert imported.custom_fields == {
        "spoolman_id": 77,
        "comment": "Imported note",
        "spoolman_extra": {
            "temperature_band": {"min": 190, "max": 220},
            "tags": ["A", "B"],
        },
    }
    formulas = await db_session.execute(
        select(SystemExtraField).where(SystemExtraField.formula.is_not(None))
    )
    assert [field.key for field in formulas.scalars().all()] == ["existing_formula"]


@pytest.mark.asyncio
async def test_inventory_backup_round_trips_formula_definition(db_session):
    field = SystemExtraField(
        target_type="filament",
        key="backup_formula",
        label="Backup formula",
        field_type="formula",
        formula={"var": "custom_fields.temperature"},
        show_in_detail=False,
        show_in_template=True,
        include_in_api=True,
    )
    db_session.add(field)
    await db_session.commit()

    exported = await _export_inventory_data(db_session)
    row = next(
        item
        for item in exported["system_extra_fields"]
        if item["key"] == "backup_formula"
    )
    assert row["formula"] == {"var": "custom_fields.temperature"}
    assert row["show_in_detail"] is False
    assert row["show_in_template"] is True
    assert row["include_in_api"] is True
    assert "show_in_list" not in row

    restored_row = {
        **row,
        "key": "restored_formula",
        "label": "Restored formula",
    }
    restored_row.pop("id")
    imported = await _import_inventory_data(
        db_session,
        {"system_extra_fields": [restored_row]},
    )
    await db_session.commit()

    restored_result = await db_session.execute(
        select(SystemExtraField).where(SystemExtraField.key == "restored_formula")
    )
    restored = restored_result.scalar_one()
    assert imported["system_extra_fields"] == 1
    assert restored.formula == {"var": "custom_fields.temperature"}
    assert restored.show_in_detail is False
    assert restored.show_in_template is True
    assert restored.include_in_api is True
