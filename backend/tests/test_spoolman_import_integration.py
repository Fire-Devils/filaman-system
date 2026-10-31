"""Deterministic integration coverage for rich-field imports and repairs.

Coverage matrix:
- Pure conversion/inference -> test_spoolman_extra_field_mapping.py
- Definition compatibility/planning/query count -> test_spoolman_extra_field_planner.py
- Import entity orchestration/API compatibility -> test_spoolman_import_service.py
- Repair fingerprint/no-overwrite/idempotency -> test_spoolman_import_repair_service.py
- Cross-layer mode and repair workflows -> test_spoolman_import_integration.py
- Real server capability smoke -> test_spoolman_live_smoke.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models.filament import Filament
from app.models.spool import Spool
from app.models.system_extra_field import SystemExtraField
from app.services.spoolman_contracts import (
    ApprovedRepairMapping,
    ImportStorageMode,
    SpoolmanFieldAction,
)
from app.services.spoolman_import_repair_service import SpoolmanImportRepairService
from app.services.spoolman_import_service import (
    SpoolmanImportError,
    SpoolmanImportService,
)
from tests.support.spoolman_fixture_server import SpoolmanFixtureServer

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "spoolman" / "rich_fields.json"


async def _import_fixture(db_session, data, mode="system"):
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman", preview.extra_field_fingerprint, extra_field_mode=mode
    )
    assert result.errors == []
    return await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )


async def test_decoded_temperature_ranges_survive_import_and_native_edit(
    db_session, auth_client,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["filament"][0]["extra"] = {
        "bed": {"min": 55, "max": 65}, "extruder": [200, None],
    }
    filament = await _import_fixture(db_session, data)
    client, csrf = auth_client
    response = await client.get(f"/api/v1/filaments/{filament.id}")
    assert response.status_code == 200
    dto = response.json()
    assert dto["bed_temp_range_c"] == {"min": 55, "max": 65}
    assert dto["extruder_temp_range_c"] == {"min": 200, "max": None}
    assert dto["custom_fields"] == {"spoolman_id": 10}
    aliases = dto["label_field_aliases"]
    assert aliases["bed"]["definition"] == {
        "label": "Bed", "field_type": "range",
        "config": {"decimal_places": 0, "unit": "°C"},
    }
    assert aliases["spoolman_extra.bed"]["wire"]["value"] == {"min": 55, "max": 65}
    response = await client.patch(
        f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf},
        json={"bed_temp_range_c": {"min": 60, "max": 70}},
    )
    assert response.status_code == 200
    reopened = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert reopened["bed_temp_range_c"] == {"min": 60, "max": 70}
    assert reopened["label_field_aliases"] == aliases


@pytest.mark.parametrize("missing", [None, "", '""'])
async def test_empty_temperature_alias_does_not_hide_another_known_range(db_session, missing):
    data = json.loads(FIXTURE_PATH.read_text())
    data["filament"][0]["extra"] = {
        "bed": missing, "bed_temp": {"min": 55, "max": 65},
    }
    filament = await _import_fixture(db_session, data)
    assert filament.bed_temp_range_c == {"min": 55, "max": 65}
    assert filament.custom_fields["spoolman_extra"]["bed"] == missing


async def test_scalar_temperature_label_alias_follows_the_native_range(db_session, auth_client):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"][0]["field_type"] = "integer"
    data["filament"][0]["extra"]["bed"] = "0"
    filament = await _import_fixture(db_session, data)
    client, csrf = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto["bed_temp_range_c"] == {"min": 0, "max": 0}
    alias = dto["label_field_aliases"]["bed"]
    assert alias["target"] == "bed_temp_range_c"
    assert alias["definition"] == {
        "label": "Bed", "field_type": "number", "config": {"decimal_places": 0, "unit": "°C"},
    }
    assert alias["wire"]["value"] == 0
    response = await client.patch(
        f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf},
        json={"bed_temp_range_c": {"min": None, "max": 65}},
    )
    assert response.status_code == 200
    reopened = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert reopened["bed_temp_range_c"] == {"min": None, "max": 65}
    assert reopened["label_field_aliases"]["bed"] == alias


@pytest.mark.parametrize("raw", ['"warm"', "null", '[80,50]', None])
async def test_failed_temperature_promotion_keeps_source_value_and_definition(
    db_session, auth_client, raw,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["filament"][0]["extra"] = {"bed": raw}
    filament = await _import_fixture(db_session, data)
    client, _ = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto["bed_temp_range_c"] is None
    assert dto["custom_fields"] == {"spoolman_id": 10, "spoolman_extra": {"bed": raw}}
    definition = await db_session.scalar(select(SystemExtraField).where(
        SystemExtraField.target_type == "filament", SystemExtraField.key == "bed",
    ))
    assert definition is not None
    assert definition.field_type == "range"
    assert definition.config == {"decimal_places": 0, "unit": "°C"}


@pytest.mark.parametrize("key,name,target", [
    ("plates", "Build Plates", "build_plate_compatibility"),
    ("ams", "AMS Compatibility", "ams_compatibility"),
])
async def test_single_compatibility_choice_keeps_its_comma(
    db_session, auth_client, key, name, target,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"].append({
        "key": key, "name": name, "field_type": "choice", "multi_choice": False,
        "choices": ["Smooth PEI, high-temp", "Textured PEI"],
    })
    data["filament"][0]["extra"][key] = '"Smooth PEI, high-temp"'
    filament = await _import_fixture(db_session, data)
    client, csrf = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto[target] == ["Smooth PEI, high-temp"]
    aliases = dto["label_field_aliases"]
    response = await client.patch(
        f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf},
        json={"designation": "Changed only the name"},
    )
    assert response.status_code == 200
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto[target] == ["Smooth PEI, high-temp"]
    assert dto["label_field_aliases"] == aliases


@pytest.mark.parametrize("key,name,field_type,default,raw,target,expected", [
    ("dry_temp", "Drying Temperature", "integer", "0", "60", "drying_temp_c", 60),
    ("discontinued", "Discontinued", "boolean", "false", "true", "is_discontinued", True),
    ("sku", "SKU", "text", '"default SKU"', '"current SKU"', "manufacturer_sku", "current SKU"),
    ("fan_speed_min", "Fan Speed Min", "integer", "0", "20", "cooling_fan_range_percent", 20),
    ("bed", "Bed", "integer_range", "[0,0]", "[55,65]", "bed_temp_range_c", {"min": 55, "max": 65}),
])
async def test_native_promotion_does_not_discard_configured_defaults(
    db_session, auth_client, key, name, field_type, default, raw, target, expected,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"] = [{
        "key": key, "name": name, "field_type": field_type, "default_value": default,
    }]
    data["filament"][0]["extra"] = {key: raw}
    data["filament"][1]["extra"] = {}
    filament = await _import_fixture(db_session, data)
    client, _ = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto[target] == (False if target == "is_discontinued" else None)
    assert dto["custom_fields"][key] == expected
    definition = await db_session.scalar(select(SystemExtraField).where(
        SystemExtraField.target_type == "filament", SystemExtraField.key == key,
    ))
    assert definition is not None
    if field_type == "text":
        assert definition.default_value == "default SKU"
    elif field_type == "integer_range":
        assert json.loads(definition.default_value) == {"min": 0, "max": 0}
    else:
        assert json.loads(definition.default_value) == json.loads(default)
    missing_value_filament = await db_session.scalar(select(Filament).where(
        Filament.designation == "PETG Clear",
    ))
    assert key not in (missing_value_filament.custom_fields or {})


@pytest.mark.parametrize("mode", ["system", "local"])
async def test_promoted_import_keeps_effective_label_path_and_typed_units(
    db_session, auth_client, mode,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"].append({
        "key": "dry_temp", "name": "Drying Temperature", "field_type": "integer", "unit": "°C",
    })
    data["filament"][0]["extra"]["dry_temp"] = "60"
    filament = await _import_fixture(db_session, data, mode)
    client, csrf = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto["drying_temp_c"] == 60
    assert "dry_temp" not in dto["custom_fields"]
    aliases = dto["label_field_aliases"]
    assert aliases["dry_temp"]["target"] == "drying_temp_c"
    assert aliases["dry_temp"]["definition"] == {
        "label": "Drying Temperature", "field_type": "number",
        "config": {"decimal_places": 0, "unit": "°C"},
    }
    assert aliases["spoolman_extra.dry_temp"]["wire"]["value"] == "60"
    response = await client.patch(
        f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf},
        json={"drying_temp_c": 65},
    )
    assert response.status_code == 200
    reopened = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert reopened["drying_temp_c"] == 65
    assert reopened["label_field_aliases"] == aliases


@pytest.mark.parametrize("filament_tare,vendor_tare,expected", [
    (0, 150, 0), (None, 0, 0), (None, None, 250), (None, 150, 150),
])
async def test_import_preserves_zero_purchase_price_and_default_tare(
    db_session, auth_client, filament_tare, vendor_tare, expected,
):
    data = json.loads(FIXTURE_PATH.read_text())
    data["filament"][0]["spool_weight"] = filament_tare
    data["filament"][0]["vendor"]["empty_spool_weight"] = vendor_tare
    data["spool"][0]["price"] = 0
    filament = await _import_fixture(db_session, data)
    client, _ = auth_client
    dto = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert dto["default_spool_weight_g"] == expected
    spool = await _imported_spool(db_session, 20)
    dto = (await client.get(f"/api/v1/spools/{spool.id}")).json()
    assert dto["purchase_price"] == 0


async def _imported_spool(db_session, spoolman_id: int) -> Spool | None:
    return await db_session.scalar(
        select(Spool).where(Spool.external_id == f"spoolman:{spoolman_id}")
    )


@pytest.mark.parametrize("mode", list(ImportStorageMode))
async def test_fixture_import_supports_every_storage_mode(db_session, mode):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
    )

    assert result.errors == []
    assert result.filaments_created == 2
    assert result.spools_created == 2

    filament = await db_session.scalar(select(Filament).order_by(Filament.id))
    assert filament is not None
    assert filament.extruder_temp_range_c == {"min": 200, "max": 220}
    assert filament.bed_temp_range_c == {"min": 55, "max": 65}
    assert "extruder" not in (filament.custom_fields or {})
    assert "bed" not in (filament.custom_fields or {})

    spool = await _imported_spool(db_session, 20)
    assert spool is not None
    nested = (spool.custom_fields or {}).get("spoolman_extra", {})
    if mode in {ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL}:
        assert spool.custom_fields["tag"] == "rack-a"
        assert spool.custom_fields["dry"] == "2026-07-20T10:30:00Z"
        assert "tag" not in nested
    elif mode is ImportStorageMode.PRESERVE:
        assert nested["tag"] == '"rack-a"'
    else:
        assert nested["tag"] == "rack-a"


async def test_url_only_old_client_keeps_legacy_storage(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    result = await service.execute("http://spoolman")
    spool = await _imported_spool(db_session, 20)

    assert result.errors == []
    assert spool is not None
    assert spool.custom_fields["spoolman_extra"]["tag"] == "rack-a"
    assert spool.custom_field_definitions is None
    assert await db_session.scalar(select(SystemExtraField)) is None


async def test_matching_spoolman_extras_fill_native_filament_fields(db_session):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    data["filament"][0]["extra"].update(
        {
            "dry": "55",
            "fan": "[25,75]",
            "discontinued": "true",
            "ams": '["AMS","AMS Lite"]',
            "datasheet": '"https://example.com/spec.pdf"',
        }
    )
    data["filament"][1]["extra"] = {
        "fan_speed_min": "20",
        "fan_speed_max": "70",
    }
    data["field_definitions"]["filament"].extend(
        [
            {
                "key": "dry",
                "name": "Drying Temperature",
                "field_type": "integer",
                "unit": "°C",
            },
            {
                "key": "fan",
                "name": "Cooling Fan Speed",
                "field_type": "integer_range",
                "unit": "%",
            },
            {"key": "discontinued", "name": "Discontinued", "field_type": "boolean"},
            {
                "key": "ams",
                "name": "AMS Compatibility",
                "field_type": "choice",
                "choices": ["AMS", "AMS Lite"],
                "multi_choice": True,
            },
            {"key": "datasheet", "name": "Datasheet URL", "field_type": "text"},
            {
                "key": "fan_speed_min",
                "name": "Fan Speed Min",
                "field_type": "integer",
                "unit": "%",
            },
            {
                "key": "fan_speed_max",
                "name": "Fan Speed Max",
                "field_type": "integer",
                "unit": "%",
            },
        ]
    )
    server = SpoolmanFixtureServer(data)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    standard_preview_keys = {
        field["key"]
        for field in preview.extra_fields
        if field["target_type"] == "filament" and field["status"] == "standard"
    }
    assert {"dry", "fan", "fan_speed_min", "fan_speed_max"} <= standard_preview_keys
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )

    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament is not None
    assert filament.drying_temp_c == 55
    assert filament.cooling_fan_range_percent == {"min": 25, "max": 75}
    assert filament.is_discontinued is True
    assert filament.ams_compatibility == ["AMS", "AMS Lite"]
    assert filament.datasheet_url == "https://example.com/spec.pdf"
    assert set(filament.custom_fields or {}) == {"spoolman_id"}
    assert await db_session.scalar(
        select(func.count()).select_from(SystemExtraField).where(
            SystemExtraField.target_type == "filament",
            SystemExtraField.key.in_(
                [
                    "dry",
                    "fan",
                    "discontinued",
                    "ams",
                    "datasheet",
                    "fan_speed_min",
                    "fan_speed_max",
                ]
            ),
        )
    ) == 0
    clear_filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PETG Clear")
    )
    assert clear_filament is not None
    assert clear_filament.cooling_fan_range_percent == {"min": 20, "max": 70}
    assert set(clear_filament.custom_fields or {}) == {"spoolman_id"}


@pytest.mark.parametrize(
    ("mode", "actions"),
    [
        (ImportStorageMode.PRESERVE, []),
        (ImportStorageMode.LEGACY, []),
        (
            ImportStorageMode.SYSTEM,
            [SpoolmanFieldAction(target_type="filament", key="dry", action="preserve")],
        ),
    ],
)
async def test_standard_extra_promotion_respects_storage_choice(db_session, mode, actions):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    data["filament"][0]["extra"]["dry"] = "55"
    data["field_definitions"]["filament"].append(
        {"key": "dry", "name": "Drying Temperature", "field_type": "integer", "unit": "°C"}
    )
    server = SpoolmanFixtureServer(data)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    assert any(
        field["key"] == "dry" and field["status"] == "standard"
        for field in preview.extra_fields
    )
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
        field_actions=actions,
    )

    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament is not None
    assert filament.drying_temp_c is None
    assert filament.custom_fields["spoolman_extra"]["dry"] == "55"


@pytest.mark.parametrize("mode", [ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL])
async def test_multichoice_sku_keeps_typed_extra_values_and_options(db_session, mode):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    data["filament"][0]["extra"]["sku"] = '["RED-1","RED-2"]'
    data["field_definitions"]["filament"].append(
        {
            "key": "sku",
            "name": "SKU",
            "field_type": "choice",
            "choices": ["RED-1", "RED-2", "RED-3"],
            "multi_choice": True,
        }
    )
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    sku_preview = next(field for field in preview.extra_fields if field["key"] == "sku")
    assert sku_preview["status"] == "create"
    assert sku_preview["field_type"] == "multiselect"
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
    )

    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament is not None
    assert filament.manufacturer_sku is None
    assert filament.custom_fields["sku"] == ["RED-1", "RED-2"]
    assert "sku" not in filament.custom_fields.get("spoolman_extra", {})
    system_definition = await db_session.scalar(
        select(SystemExtraField).where(
            SystemExtraField.target_type == "filament", SystemExtraField.key == "sku"
        )
    )
    if mode is ImportStorageMode.SYSTEM:
        assert system_definition is not None
        assert system_definition.field_type == "multiselect"
        assert system_definition.options == ["RED-1", "RED-2", "RED-3"]
    else:
        assert system_definition is None
        definition = filament.custom_field_definitions["sku"]
        assert definition["field_type"] == "multiselect"
        assert definition["options"] == ["RED-1", "RED-2", "RED-3"]


@pytest.mark.parametrize("mode", [ImportStorageMode.SYSTEM, ImportStorageMode.LOCAL])
async def test_standard_text_extra_respects_legacy_field_override(db_session, mode):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    data["filament"][0]["extra"]["sku"] = '"SKU-123"'
    data["field_definitions"]["filament"].append(
        {"key": "sku", "name": "SKU", "field_type": "text"}
    )
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
        field_actions=[
            SpoolmanFieldAction(target_type="filament", key="sku", action="legacy")
        ],
    )
    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament.manufacturer_sku is None
    assert filament.custom_fields["spoolman_extra"]["sku"] == "SKU-123"


async def test_incompatible_temperature_and_fan_units_stay_extra_fields(db_session):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    data["filament"][0]["extra"].update(
        {"bed": "[130,150]", "fan_speed_min": "120", "fan_speed_max": "180"}
    )
    definitions = data["field_definitions"]["filament"]
    definitions[0]["unit"] = "°F"
    definitions.extend(
        [
            {"key": "fan_speed_min", "name": "Fan Speed Min", "field_type": "integer", "unit": "rpm"},
            {"key": "fan_speed_max", "name": "Fan Speed Max", "field_type": "integer", "unit": "rpm"},
        ]
    )
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )

    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament is not None
    assert filament.bed_temp_range_c is None
    assert filament.cooling_fan_range_percent is None
    assert filament.custom_fields["bed"] == {"min": 130, "max": 150}
    assert filament.custom_fields["fan_speed_min"] == 120
    assert filament.custom_fields["fan_speed_max"] == 180


@pytest.mark.parametrize(
    ("units", "mode", "overrides", "native", "storage"),
    [
        (("%", "%"), "system", {}, True, (None, None)),
        (("%", "%"), "local", {}, True, (None, None)),
        (("%", "rpm"), "system", {}, False, ("system", "system")),
        (("%", "rpm"), "local", {}, False, ("local", "local")),
        (("rpm", "%"), "system", {}, False, ("system", "system")),
        (("%", "%"), "system", {"fan_speed_min": "preserve"}, False, ("preserve", "system")),
        (("%", "%"), "local", {"fan_speed_max": "preserve"}, False, ("local", "preserve")),
        (("%", "%"), "preserve", {"fan_speed_min": "system"}, False, ("system", "preserve")),
        (("%", "%"), "system", {"fan_speed_min": "legacy"}, False, ("legacy", "system")),
        (("%", "%"), "system", {"fan_speed_min": "local"}, True, (None, None)),
    ],
)
async def test_fan_pair_keeps_typed_metadata_when_not_promoted(
    db_session, units, mode, overrides, native, storage
):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    keys = ("fan_speed_min", "fan_speed_max")
    data["filament"][0]["extra"].update(
        {"fan_speed_min": "20", "fan_speed_max": "70"}
    )
    data["field_definitions"]["filament"].extend(
        {"key": key, "name": key, "field_type": "integer", "unit": unit}
        for key, unit in zip(keys, units, strict=True)
    )
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    fan_preview = {item["key"]: item for item in preview.extra_fields if item["key"] in keys}
    if units == ("%", "%"):
        assert {item["status"] for item in fan_preview.values()} == {"standard"}
    else:
        assert {item["status"] for item in fan_preview.values()} == {"create"}
        assert fan_preview["fan_speed_min"]["config"]["unit"] == units[0]
        assert fan_preview["fan_speed_max"]["config"]["unit"] == units[1]

    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=mode,
        field_actions=[
            SpoolmanFieldAction(target_type="filament", key=key, action=action)
            for key, action in overrides.items()
        ],
    )
    assert result.errors == []
    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert filament is not None
    assert filament.cooling_fan_range_percent == ({"min": 20, "max": 70} if native else None)
    definitions = {
        item.key: item
        for item in (await db_session.scalars(
            select(SystemExtraField).where(SystemExtraField.key.in_(keys))
        )).all()
    }
    local = filament.custom_field_definitions or {}
    remaining = filament.custom_fields.get("spoolman_extra", {})
    for key, unit, action, value in zip(keys, units, storage, (20, 70), strict=True):
        assert (key in definitions) == (action == "system")
        assert (key in local) == (action == "local")
        if action in {"system", "local"}:
            assert filament.custom_fields[key] == value
            definition = definitions[key] if action == "system" else local[key]
            field_type = definition.field_type if action == "system" else definition["field_type"]
            config = definition.config if action == "system" else definition["config"]
            assert field_type == "number"
            assert config == {"decimal_places": 0, "unit": unit}
            assert key not in remaining
        elif action is not None:
            assert remaining[key] == str(value)
        else:
            assert key not in filament.custom_fields
            assert key not in remaining


async def test_invalid_fan_pair_preserves_raw_and_valid_endpoint_metadata(db_session):
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    values = {"fan_speed_min": "20", "fan_speed_max": '"invalid"'}
    data["filament"][0]["extra"].update(values)
    data["field_definitions"]["filament"].extend(
        {"key": key, "name": key, "field_type": "integer", "unit": "%"}
        for key in values
    )
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman", preview.extra_field_fingerprint, extra_field_mode="system"
    )
    filament = await db_session.scalar(
        select(Filament).where(Filament.designation == "PLA Red")
    )
    assert result.errors == []
    assert filament is not None
    assert filament.cooling_fan_range_percent is None
    assert filament.custom_fields["fan_speed_min"] == 20
    assert filament.custom_fields["spoolman_extra"]["fan_speed_max"] == values["fan_speed_max"]
    definitions = (await db_session.scalars(select(SystemExtraField).where(
        SystemExtraField.target_type == "filament", SystemExtraField.key.in_(values),
    ))).all()
    assert {item.key for item in definitions} == set(values)
    assert all(item.field_type == "number" and item.config == {"decimal_places": 0, "unit": "%"} for item in definitions)


async def test_per_field_override_mixes_system_local_and_preserve(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.PRESERVE,
        field_actions=[
            SpoolmanFieldAction(target_type="spool", key="tag", action="local"),
            SpoolmanFieldAction(target_type="spool", key="dry", action="system"),
        ],
    )
    spool = await _imported_spool(db_session, 20)
    definitions = (await db_session.execute(select(SystemExtraField))).scalars().all()

    assert result.errors == []
    assert {(item.target_type, item.key) for item in definitions} == {("spool", "dry")}
    assert spool is not None
    assert spool.custom_field_definitions["tag"]["field_type"] == "text"
    assert spool.custom_fields["tag"] == "rack-a"
    assert spool.custom_fields["dry"] == "2026-07-20T10:30:00Z"


async def test_stale_fingerprint_is_rejected_before_writes(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    with pytest.raises(SpoolmanImportError) as error:
        await service.execute(
            "http://spoolman",
            "0" * 64,
            extra_field_mode=ImportStorageMode.SYSTEM,
        )

    assert error.value.code == "preview_changed"
    assert await db_session.scalar(select(func.count()).select_from(Filament)) == 0


async def test_second_import_is_idempotent_and_reuses_definitions(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    first = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )
    second = await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )

    assert first.extra_fields_created == 2
    assert second.extra_fields_created == 0
    assert second.extra_fields_reused == 2
    assert second.filaments_created == 0
    assert second.spools_created == 0


async def test_invalid_authoritative_value_is_preserved(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    service = SpoolmanImportService(db_session, client_factory=server.client_factory)
    preview = await service.preview("http://spoolman")
    await service.execute(
        "http://spoolman",
        preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.SYSTEM,
    )
    invalid_spool = await _imported_spool(db_session, 21)

    assert invalid_spool is not None
    assert "dry" not in invalid_spool.custom_fields
    assert invalid_spool.custom_fields["spoolman_extra"]["dry"] == '"invalid-date"'


async def test_server_repair_promotes_valid_values_and_keeps_invalid_values(
    db_session,
):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(db_session, client_factory=server.client_factory)
    await importer.execute("http://spoolman")
    repair = SpoolmanImportRepairService(db_session)
    source = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["field_definitions"]
    preview = await repair.preview("server", source)
    tag = next(item for item in preview["mappings"] if item["key"] == "tag")
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    result = await repair.execute(
        "server",
        preview["preview_fingerprint"],
        [
            ApprovedRepairMapping.model_validate({**tag, "action": "system"}),
            ApprovedRepairMapping.model_validate({**dry, "action": "system"}),
        ],
        source,
    )

    assert result["values_promoted"] == 3
    assert result["values_preserved"] >= 1


async def test_offline_repair_supports_system_and_local_actions(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(db_session, client_factory=server.client_factory)
    import_preview = await importer.preview("http://spoolman")
    await importer.execute(
        "http://spoolman",
        import_preview.extra_field_fingerprint,
        extra_field_mode=ImportStorageMode.PRESERVE,
    )
    repair = SpoolmanImportRepairService(db_session)
    preview = await repair.preview("offline")
    tag = next(item for item in preview["mappings"] if item["key"] == "tag")
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    result = await repair.execute(
        "offline",
        preview["preview_fingerprint"],
        [
            ApprovedRepairMapping.model_validate({**tag, "action": "system"}),
            ApprovedRepairMapping.model_validate(
                {
                    **dry,
                    "field_type": "date",
                    "source_field_type": "datetime",
                    "config": None,
                    "default_value": None,
                    "action": "local",
                }
            ),
        ],
    )

    assert result["definitions_created"] == 1
    assert result["local_definitions_created"] == 1
    assert result["values_preserved"] >= 1


async def test_datetime_can_be_repaired_to_date(db_session):
    server = SpoolmanFixtureServer.from_path(FIXTURE_PATH)
    importer = SpoolmanImportService(db_session, client_factory=server.client_factory)
    await importer.execute("http://spoolman")
    source = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["field_definitions"]
    repair = SpoolmanImportRepairService(db_session)
    preview = await repair.preview("server", source)
    dry = next(item for item in preview["mappings"] if item["key"] == "dry")
    mapping = ApprovedRepairMapping.model_validate(
        {
            **dry,
            "field_type": "date",
            "config": None,
            "default_value": None,
        }
    )
    result = await repair.execute(
        "server", preview["preview_fingerprint"], [mapping], source
    )

    assert result["values_promoted"] == 1
    spool = await _imported_spool(db_session, 20)
    assert spool is not None
    assert spool.custom_fields["dry"] == "2026-07-20"


@pytest.mark.parametrize("mode,overrides", [
    ("system", {}), ("local", {}),
    ("system", {"fan_speed_min": "local", "fan_speed_max": "legacy"}),
])
async def test_unused_native_fan_sources_keep_requested_typed_storage(db_session, auth_client, mode, overrides):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"] = [
        {"key": "fan", "name": "Cooling Fan Speed", "field_type": "integer_range", "unit": "%"},
        *({"key": key, "name": key, "field_type": "integer", "unit": "%"} for key in ("fan_speed_min", "fan_speed_max")),
    ]
    data["filament"][0]["extra"] = {"fan": "[25,75]", "fan_speed_min": "20", "fan_speed_max": "70"}
    service = SpoolmanImportService(db_session, client_factory=SpoolmanFixtureServer(data).client_factory)
    preview = await service.preview("http://spoolman")
    result = await service.execute("http://spoolman", preview.extra_field_fingerprint, extra_field_mode=mode, field_actions=[
        SpoolmanFieldAction(target_type="filament", key=key, action=action) for key, action in overrides.items()
    ])
    assert result.errors == []
    filament = await db_session.scalar(select(Filament).where(Filament.designation == "PLA Red"))
    client, csrf = auth_client
    response = await client.get(f"/api/v1/filaments/{filament.id}")
    assert response.status_code == 200
    dto = response.json()
    assert dto["cooling_fan_range_percent"] == {"min": 25, "max": 75}
    for key, value in (("fan_speed_min", 20), ("fan_speed_max", 70)):
        action = overrides.get(key, mode)
        if action == "legacy":
            assert dto["custom_fields"]["spoolman_extra"][key] == str(value)
            continue
        assert dto["custom_fields"][key] == value
        if action == "system":
            definition = await db_session.scalar(select(SystemExtraField).where(SystemExtraField.target_type == "filament", SystemExtraField.key == key))
            assert definition is not None
            assert definition.label == key
            assert definition.field_type == "number"
            assert definition.config == {"decimal_places": 0, "unit": "%"}
        else:
            definition = dto["custom_field_definitions"][key]
            assert definition == {"label": key, "field_type": "number", "config": {"decimal_places": 0, "unit": "%"}}
    assert (await client.patch(f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf}, json={"designation": "Renamed"})).status_code == 200
    reopened = (await client.get(f"/api/v1/filaments/{filament.id}")).json()
    assert reopened["custom_fields"] == dto["custom_fields"]
    assert reopened.get("custom_field_definitions") == dto.get("custom_field_definitions")


@pytest.mark.parametrize("key,name,source_type,raw,extra_definition", [
    ("dry_temp", "Drying Temperature", "integer", '\"warm\"', {}),
    ("fan", "Cooling Fan Speed", "integer_range", "[110,120]", {"unit": "%"}),
    ("sku", "SKU", "text", json.dumps("X" * 256), {}),
    ("datasheet", "Datasheet URL", "text", '\"ftp://example.test/file\"', {}),
    ("currency", "Currency", "text", '\"EURO\"', {}),
    ("discontinued", "Discontinued", "boolean", '\"false\"', {}),
    ("ams", "AMS Compatibility", "choice", '["No match"]', {"choices": ["AMS", "AMS Lite"], "multi_choice": True}),
])
async def test_failed_native_promotions_keep_system_source_metadata(db_session, auth_client, key, name, source_type, raw, extra_definition):
    data = json.loads(FIXTURE_PATH.read_text())
    data["field_definitions"]["filament"] = [{"key": key, "name": name, "field_type": source_type, **extra_definition}]
    data["filament"][0]["extra"] = {key: raw}
    filament = await _import_fixture(db_session, data)
    definition = await db_session.scalar(select(SystemExtraField).where(SystemExtraField.target_type == "filament", SystemExtraField.key == key))
    assert definition is not None
    assert definition.label == name
    expected_type = {"integer": "number", "integer_range": "range", "boolean": "checkbox", "choice": "multiselect"}.get(source_type, "text")
    assert definition.field_type == expected_type
    if extra_definition.get("choices"):
        assert definition.options == extra_definition["choices"]
    client, csrf = auth_client
    dto_response = await client.get(f"/api/v1/filaments/{filament.id}")
    assert dto_response.status_code == 200
    dto = dto_response.json()
    # Failed native validation may still be valid for its less restrictive typed source.
    assert key in dto["custom_fields"] or dto["custom_fields"]["spoolman_extra"][key] == raw
    assert (await client.patch(f"/api/v1/filaments/{filament.id}", headers={"X-CSRF-Token": csrf}, json={"designation": "Renamed"})).status_code == 200
    assert (await client.get(f"/api/v1/filaments/{filament.id}")).json()["custom_fields"] == dto["custom_fields"]
