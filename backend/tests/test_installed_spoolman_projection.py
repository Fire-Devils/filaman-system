"""Promotion -> a separately installed v1 package -> mounted HTTP response."""

import copy
import importlib
import json
import shutil
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.api.deps import get_db
from app.models.filament import Filament, Manufacturer
from app.models.spool import Spool, SpoolStatus
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from tests.test_filament_temperature_migration import (
    legacy_schema,
    load_migration_module,
)

# Independently chosen wire values expose normalization (CSV, casing, numeric text).
FIELDS = [
    (
        "settings_extruder_temp",
        "Extruder temperature",
        "number",
        210,
        "extruder_temp_range_c",
    ),
    ("settings_bed_temp", "Bed temperature", "number", 0, "bed_temp_range_c"),
    ("sku", "Manufacturer SKU", "text", "SKU-123", "manufacturer_sku"),
    (
        "datasheet",
        "Datasheet URL",
        "url",
        "https://example.com/data.pdf",
        "datasheet_url",
    ),
    ("image", "Image URL", "url", "https://example.com/image.png", "image_url"),
    ("discontinued", "Discontinued", "checkbox", False, "is_discontinued"),
    ("dry_temp", "Drying temperature", "number", "0", "drying_temp_c"),
    ("dry_time_hours", "Drying time", "number", 6, "drying_time_hours"),
    ("softening_temp", "Softening temperature", "number", 65, "softening_temp_c"),
    (
        "fan",
        "Cooling fan speed",
        "range",
        {"min": 0, "max": None},
        "cooling_fan_range_percent",
    ),
    ("chamber_temp", "Chamber temperature", "number", 35, "chamber_temp_c"),
    (
        "max_volumetric_speed",
        "Max volumetric speed",
        "number",
        18,
        "max_volumetric_speed_mm3_s",
    ),
    ("flow_ratio", "Flow ratio", "number", 0.97, "flow_ratio"),
    ("k_value", "Pressure advance", "number", 0, "pressure_advance_k"),
    (
        "ams",
        "AMS compatibility",
        "multiselect",
        ["AMS", "AMS Lite"],
        "ams_compatibility",
    ),
    (
        "plates",
        "Build plate compatibility",
        "text",
        "PEI, Textured",
        "build_plate_compatibility",
    ),
    ("currency", "Price currency", "text", "usd", "price_currency"),
]


@pytest.fixture(params=["hot", "startup"])
def installed_app(request, tmp_path, monkeypatch, db_session):
    from app.api.v1 import router as loader
    from app.services import plugin_service

    shutil.copytree(
        Path(__file__).parent / "fixtures/spoolmanapi_v1", tmp_path / "spoolmanapi"
    )
    monkeypatch.setattr(plugin_service, "PLUGINS_DIR", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    saved = {
        key: value
        for key, value in sys.modules.items()
        if key == "spoolmanapi" or key.startswith("spoolmanapi.")
    }
    for key in saved:
        del sys.modules[key]
    monkeypatch.setattr(loader, "_deferred_plugin_routers", [])
    app = FastAPI()
    if request.param == "hot":
        assert loader.mount_plugin_router_on_app(app, "spoolmanapi")
    else:
        loader._mount_plugin_routers()
        loader.mount_deferred_plugin_routers(app)

    async def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    yield app
    for key in list(sys.modules):
        if key == "spoolmanapi" or key.startswith("spoolmanapi."):
            del sys.modules[key]
    sys.modules.update(saved)


def migrated_rows(nested=False, overrides=None):
    metadata, filaments, spools, system_fields = legacy_schema()
    extra = {key: copy.deepcopy(value) for key, _, _, value, _ in FIELDS}
    extra.update(overrides or {})
    definitions = {
        key: {"label": label, "field_type": typ} for key, label, typ, _, _ in FIELDS
    }
    definitions["ams"]["options"] = ["AMS", "AMS Lite"]
    if nested:
        extra = {key: json.dumps(value) for key, value in extra.items()}
        # Nested numeric text is one JSON numeric string, not double encoded.
        extra["dry_temp"] = "0"
        custom = {"spoolman_extra": extra}
    else:
        custom = dict(extra)
    custom.update(
        article_number="ARTICLE",
        comment="note",
        external_id="legacy",
        unrelated={"keep": True},
    )
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            filaments.insert(),
            {"id": 1, "custom_fields": custom, "custom_field_definitions": definitions},
        )
        connection.execute(
            spools.insert(),
            {
                "id": 1,
                "filament_id": 1,
                "custom_fields": {"bed_temp": "0", "rack": "A"},
                "custom_field_definitions": None,
            },
        )
        connection.execute(
            system_fields.insert(),
            [
                {
                    "id": i,
                    "target_type": "filament",
                    "key": key,
                    "label": label,
                    "field_type": typ,
                    "config": None,
                }
                for i, (key, label, typ, _, _) in enumerate(FIELDS, 1)
            ],
        )
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        filament = dict(
            connection.execute(
                sa.select(
                    sa.Table("filaments", sa.MetaData(), autoload_with=connection)
                )
            )
            .mappings()
            .one()
        )
        spool = dict(
            connection.execute(
                sa.select(sa.Table("spools", sa.MetaData(), autoload_with=connection))
            )
            .mappings()
            .one()
        )
    return filament, spool, custom


async def seed(db, row, spool_row=None):
    manufacturer = Manufacturer(name="Boundary vendor")
    db.add(manufacturer)
    await db.flush()
    filament = Filament(
        **row,
        manufacturer=manufacturer,
        designation="Boundary",
        material_type="PLA",
        diameter_mm=1.75,
        density_g_cm3=1.24,
        price=0,
        raw_material_weight_g=1000,
        default_spool_weight_g=250,
    )
    db.add(filament)
    if spool_row:
        spool = Spool(
            **spool_row,
            filament=filament,
            initial_total_weight_g=1250,
            empty_spool_weight_g=250,
            remaining_weight_g=0,
            purchase_price=0,
            status=await db.scalar(
                sa.select(SpoolStatus).where(SpoolStatus.key == "new")
            ),
        )
        db.add(spool)
    await db.commit()
    return filament


async def get(app, path):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/spoolman/api/v1/" + path)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("nested", [False, True])
async def test_migration_preserves_all_17_fields_through_installed_router(
    installed_app, db_session, nested
):
    row, spool, before = migrated_rows(nested)
    assert all(row[target] is not None for *_, target in FIELDS)
    await seed(db_session, row, spool)
    wire = await get(installed_app, "filament/1")
    expected_extra = {
        key: value
        for key, value in before.items()
        if key
        not in {
            "article_number",
            "comment",
            "external_id",
            "settings_extruder_temp",
            "settings_bed_temp",
        }
    }
    assert wire["extra"] == expected_extra
    assert wire["settings_extruder_temp"] == 210
    assert wire["settings_bed_temp"] == 0
    assert type(wire["settings_extruder_temp"]) is int
    assert wire["article_number"] == "ARTICLE"
    assert wire["comment"] == "note"
    assert wire["external_id"] == "legacy"
    assert set(wire) == {
        "id",
        "registered",
        "name",
        "vendor",
        "material",
        "price",
        "density",
        "diameter",
        "weight",
        "spool_weight",
        "article_number",
        "comment",
        "settings_extruder_temp",
        "settings_bed_temp",
        "external_id",
        "extra",
    }
    spool_wire = await get(installed_app, "spool/1")
    assert spool_wire["filament"] == wire
    assert spool_wire["extra"] == {"bed_temp": "0", "rack": "A"}
    assert (
        spool_wire["price"]
        == spool_wire["remaining_weight"]
        == spool_wire["remaining_length"]
        == 0
    )
    assert spool_wire["used_length"] == pytest.approx(335283.6194167644)
    native_spool = await db_session.get(Spool, 1)
    native_spool.remaining_weight_g = None
    await db_session.commit()
    assert "remaining_weight" not in await get(installed_app, "spool/1")


async def test_edits_and_clears_reencode_current_native_without_resurrecting_snapshots(
    installed_app, db_session
):
    row, _, _ = migrated_rows()
    filament = await seed(db_session, row)
    filament.extruder_temp_range_c = {"min": 215.6, "max": 230}
    filament.drying_temp_c = 55.5
    filament.build_plate_compatibility = ["Smooth", "Textured"]
    filament.cooling_fan_range_percent = {"min": None, "max": 80}
    filament.price_currency = "EUR"
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert wire["settings_extruder_temp"] == 216
    assert wire["extra"]["dry_temp"] == "55.5"
    assert wire["extra"]["plates"] == "Smooth,Textured"
    assert wire["extra"]["fan"] == {"min": None, "max": 80}
    assert wire["extra"]["currency"] == "EUR"
    for *_, target in FIELDS:
        if target != "is_discontinued":
            setattr(filament, target, None)
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert "settings_extruder_temp" not in wire
    assert "settings_bed_temp" not in wire
    assert wire["extra"]["dry_temp"] is None
    assert wire["extra"]["plates"] is None
    assert wire["extra"]["discontinued"] is False


async def test_native_only_projection_preserves_conflicting_extras_and_default_false_shape(
    installed_app, db_session
):
    filament = await seed(db_session, {"id": 1})
    assert (await get(installed_app, "filament/1"))["extra"] == {}
    filament.manufacturer_sku = "SKU"
    filament.drying_temp_c = 0
    filament.pressure_advance_k = 0
    filament.extruder_temp_range_c = {"min": 210, "max": 230}
    filament.custom_fields = {
        "article_number": "ARTICLE",
        "sku": {"unrelated": True},
        "dry_temp": "old user text",
    }
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert wire["settings_extruder_temp"] == 210
    assert wire["article_number"] == "ARTICLE"
    assert wire["extra"] == {
        "sku": {"unrelated": True},
        "dry_temp": "old user text",
        "k_value": 0,
    }


@pytest.mark.parametrize(
    "native, expected",
    [
        ({"min": 210.6, "max": 230}, 211),
        (None, None),
        ({"min": None, "max": None}, None),
    ],
)
async def test_retained_range_temperature_cannot_fail_legacy_schema_before_projection(
    installed_app, db_session, native, expected
):
    await seed(
        db_session,
        {
            "id": 1,
            "extruder_temp_range_c": native,
            "custom_fields": {"settings_extruder_temp": {"min": 190, "max": 200}},
            "label_field_aliases": {"settings_extruder_temp": "extruder_temp_range_c"},
        },
    )
    wire = await get(installed_app, "filament/1")
    assert wire.get("settings_extruder_temp") == expected
    assert wire["extra"] == {}


async def test_preprovenance_aliases_use_native_and_unmigrated_temperatures_fall_back(
    installed_app, db_session
):
    await seed(
        db_session,
        {
            "id": 1,
            "drying_temp_c": 0,
            "cooling_fan_range_percent": {"min": 0, "max": None},
            "custom_fields": {
                "settings_extruder_temp": 190,
                "spoolman_extra": {"keep": "yes"},
            },
            "label_field_aliases": {
                "spoolman_extra.dry": "drying_temp_c",
                "fan": "cooling_fan_range_percent",
                "fan.min": "cooling_fan_range_percent.min",
                "fan.max": "cooling_fan_range_percent.max",
            },
        },
    )
    wire = await get(installed_app, "filament/1")
    assert wire["settings_extruder_temp"] == 190
    assert wire["extra"] == {
        "spoolman_extra": {"keep": "yes", "dry": "0.0"},
        "fan": {"min": 0, "max": None},
    }


def test_loader_adapter_is_idempotent_and_rejects_unknown_versions(installed_app):
    from app.services.spoolman_projection import adapt_installed_spoolman

    module = importlib.import_module("spoolmanapi.router")
    method = module.SpoolmanService._filament_to_schema
    assert adapt_installed_spoolman(module, "spoolmanapi", {"version": "1.0.0"})
    assert module.SpoolmanService._filament_to_schema is method
    assert not adapt_installed_spoolman(module, "spoolmanapi", {"version": "2.0.0"})
    assert not adapt_installed_spoolman(module, "unrelated", {"version": "1.0.0"})
    assert not adapt_installed_spoolman(object(), "spoolmanapi", {"version": "1.0.0"})


async def test_spoolman_import_preserves_source_shapes_through_installed_loader(
    installed_app, db_session
):
    from app.services.spoolman_import_service import SpoolmanImportService

    from tests.support.spoolman_fixture_server import SpoolmanFixtureServer

    data = json.loads(
        (Path(__file__).parent / "fixtures/spoolman/rich_fields.json").read_text()
    )
    extra = {
        "sku": '"12345"',
        "dry": "0",
        "fan": "[0,null]",
        "plates": '"PEI, Textured"',
        "discontinued": "false",
        "extruder": "[210,230]",
    }
    data["filament"][0]["extra"] = extra
    data["field_definitions"]["filament"] = [
        {"key": key, "name": label, "field_type": typ}
        for key, label, typ in [
            ("sku", "SKU", "text"),
            ("dry", "Drying temperature", "float"),
            ("fan", "Cooling fan speed", "float_range"),
            ("plates", "Build plates", "text"),
            ("discontinued", "Discontinued", "boolean"),
            ("extruder", "Extruder temperature", "float_range"),
        ]
    ]
    service = SpoolmanImportService(
        db_session, client_factory=SpoolmanFixtureServer(data).client_factory
    )
    preview = await service.preview("http://spoolman")
    result = await service.execute(
        "http://spoolman", preview.extra_field_fingerprint, extra_field_mode="system"
    )
    assert result.errors == []
    filament = await db_session.scalar(sa.select(Filament).order_by(Filament.id))
    wire = await get(installed_app, f"filament/{filament.id}")
    assert wire["extra"]["spoolman_extra"] == extra
    filament.drying_temp_c = 55
    filament.cooling_fan_range_percent = {"min": 5, "max": 80}
    filament.build_plate_compatibility = ["Smooth, PEI", "Textured"]
    await db_session.commit()
    wire = await get(installed_app, f"filament/{filament.id}")
    assert wire["extra"]["spoolman_extra"]["dry"] == "55"
    assert json.loads(wire["extra"]["spoolman_extra"]["fan"]) == [5, 80]
    # CSV has no escaping contract: use a JSON array instead of losing commas.
    assert json.loads(wire["extra"]["spoolman_extra"]["plates"]) == [
        "Smooth, PEI",
        "Textured",
    ]


async def test_catalog_import_and_update_capture_csv_and_false_provenance(
    installed_app, db_session
):
    from app.services.filamentdb_import_service import (
        FilamentDBImportService,
        ImportResult,
    )

    manufacturer = Manufacturer(name="Catalog")
    db_session.add(manufacturer)
    await db_session.flush()
    service = FilamentDBImportService(db_session)
    source = {
        "id": 71,
        "manufacturer_id": 5,
        "material_id": 6,
        "designation": "Catalog PLA",
        "temp_nozzle_min": 0,
        "temp_nozzle_max": 230,
        "dry_temp": 0,
        "discontinued": False,
        "ams_compatible": "ams, ams-lite",
        "currency": "usd",
    }
    await service._import_filaments(
        [source], {6: "PLA"}, {5: manufacturer.id}, {}, {}, "filament", ImportResult()
    )
    await db_session.commit()
    filament = await db_session.scalar(sa.select(Filament))
    wire = await get(installed_app, f"filament/{filament.id}")
    assert wire["extra"]["ams_compatible"] == "ams, ams-lite"
    assert wire["extra"]["currency"] == "usd"
    assert wire["extra"]["discontinued"] is False
    assert wire["extra"]["temp_nozzle_min"] == 0
    await service._update_existing_filament(
        filament,
        {**source, "ams_compatible": ["ams"], "currency": "eur"},
        "PLA",
        {},
        "filament",
        {},
    )
    await db_session.commit()
    wire = await get(installed_app, f"filament/{filament.id}")
    assert wire["extra"]["ams_compatible"] == ["ams"]
    assert wire["extra"]["currency"] == "eur"


@pytest.mark.parametrize(
    "original,native,edited,expected",
    [
        (
            "210",
            {"min": 210, "max": 210},
            {"min": 200, "max": 230},
            "200",
        ),
        ({"min": 0}, {"min": 0, "max": None}, {"min": 20, "max": None}, {"min": 20}),
        (0, 0, 0.0234, 0.0234),
        ("0", 0, 0.0234, "0.0234"),
        ("[0,null]", {"min": 0, "max": None}, {"min": None, "max": 80}, "[null, 80]"),
        ('"AMS, Lite"', ["AMS", "Lite"], ["AMS"], '"AMS"'),
    ],
)
def test_projection_preserves_numeric_precision_and_legacy_scalar_or_range_shape(
    original, native, edited, expected
):
    from types import SimpleNamespace

    from app.services.spoolman_projection import project_extra, promotion_alias

    target = (
        "cooling_fan_range_percent"
        if isinstance(native, dict)
        else "ams_compatibility"
        if isinstance(native, list)
        else "pressure_advance_k"
    )
    entity = SimpleNamespace(
        **{
            target: edited,
            "label_field_aliases": {
                "original": promotion_alias(target, original, native)
            },
        }
    )
    assert project_extra(entity, {}) == {"original": expected}


async def test_spool_source_aliases_follow_shared_filament_edits_and_clears(
    installed_app, db_session
):
    metadata, filaments, spools, _ = legacy_schema()
    original = {
        "rack": "A",
        "spoolman_extra": {"extruder_temp": "[200,230]", "bed_temp": "0"},
    }
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        connection.execute(filaments.insert(), {"id": 1})
        connection.execute(
            spools.insert(), {"id": 1, "filament_id": 1, "custom_fields": original}
        )
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        row = dict(
            connection.execute(
                sa.select(
                    sa.Table("filaments", sa.MetaData(), autoload_with=connection)
                )
            )
            .mappings()
            .one()
        )
        spool = dict(
            connection.execute(
                sa.select(sa.Table("spools", sa.MetaData(), autoload_with=connection))
            )
            .mappings()
            .one()
        )
    filament = await seed(db_session, row, spool)
    assert (await get(installed_app, "spool/1"))["extra"] == original
    filament.extruder_temp_range_c = {"min": 0, "max": None}
    filament.bed_temp_range_c = None
    await db_session.commit()
    wire = await get(installed_app, "spool/1")
    assert wire["extra"] == {
        "rack": "A",
        "spoolman_extra": {"extruder_temp": "[0, null]", "bed_temp": None},
    }
    assert wire["filament"]["settings_extruder_temp"] == 0
    assert "settings_bed_temp" not in wire["filament"]


async def test_projection_never_mutates_persisted_fields_or_metadata(
    installed_app, db_session
):
    row, _, _ = migrated_rows(True)
    filament = await seed(db_session, row)
    snapshot = (
        copy.deepcopy(filament.custom_fields),
        copy.deepcopy(filament.label_field_aliases),
    )
    wire = await get(installed_app, "filament/1")
    wire["extra"]["spoolman_extra"]["sku"] = "client change"
    assert (filament.custom_fields, filament.label_field_aliases) == snapshot
    from app.api.v1.system import _deserialize_row, _serialize_row

    restored = _deserialize_row(Filament, "filaments", _serialize_row(filament))
    assert restored["label_field_aliases"] == snapshot[1]


async def test_catalog_update_preserves_unowned_same_name_user_extras(
    installed_app, db_session
):
    from app.services.filamentdb_import_service import FilamentDBImportService

    custom = {
        "sku": {"owner": "user"},
        "dry_temp": "cabinet temperature",
        "discontinued": "user status",
        "currency": {"notes": "retain"},
    }
    filament = await seed(db_session, {"id": 1, "custom_fields": custom})
    await FilamentDBImportService(db_session)._update_existing_filament(
        filament,
        {
            "sku": "CATALOG-SKU",
            "dry_temp": 55,
            "discontinued": False,
            "currency": "usd",
        },
        "PLA",
        {},
        "filament",
        {},
    )
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert wire["extra"] == custom
    assert filament.custom_fields == custom
    assert filament.manufacturer_sku == "CATALOG-SKU"
    assert filament.drying_temp_c == 55


async def test_malformed_old_alias_metadata_does_not_break_installed_reads(
    installed_app, db_session
):
    await seed(
        db_session,
        {
            "id": 1,
            "drying_temp_c": 55,
            "label_field_aliases": {
                "bad": {"target": None},
                "old": {"target": "drying_temp_c", "wire": None},
            },
        },
    )
    assert (await get(installed_app, "filament/1"))["extra"] == {"old": 55}


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("edited", ["67890", "NEW-SKU"])
@pytest.mark.parametrize("original", ["12345", '"12345"', '  "12345"  '])
async def test_edited_numeric_text_sku_keeps_plain_or_json_quoted_encoding(
    installed_app, db_session, nested, edited, original
):
    row, _, _ = migrated_rows(nested, {"sku": original})
    filament = await seed(db_session, row)
    filament.manufacturer_sku = edited
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert (
        wire["extra"]["spoolman_extra"]["sku"] if nested else wire["extra"]["sku"]
    ) == (json.dumps(edited) if nested else edited)


@pytest.mark.parametrize(
    "nested,original,edited,expected",
    [
        (
            False,
            {"min": "0", "max": "100"},
            {"min": 20, "max": 90},
            {"min": "20", "max": "90"},
        ),
        (True, ["0", None], {"min": 20, "max": None}, '["20", null]'),
        (True, ["0", None], {"min": 0, "max": 90}, '["0", 90]'),
    ],
)
async def test_edited_ranges_keep_each_endpoint_representation(
    installed_app, db_session, nested, original, edited, expected
):
    row, _, before = migrated_rows(nested, {"fan": original})
    filament = await seed(db_session, row)
    wire = await get(installed_app, "filament/1")
    assert (
        wire["extra"]["spoolman_extra"]["fan"] if nested else wire["extra"]["fan"]
    ) == (before["spoolman_extra"]["fan"] if nested else original)
    filament.cooling_fan_range_percent = edited
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert (
        wire["extra"]["spoolman_extra"]["fan"] if nested else wire["extra"]["fan"]
    ) == expected


@pytest.mark.parametrize("nested", [False, True])
async def test_reintroduced_native_custom_values_win_over_historical_aliases(
    installed_app, db_session, auth_client, nested
):
    row, _, _ = migrated_rows(nested)
    filament = await seed(db_session, row)
    custom = copy.deepcopy(filament.custom_fields)
    container = custom.setdefault("spoolman_extra", {}) if nested else custom
    container.update(sku={"owner": "user"}, dry_temp="cabinet Fahrenheit")
    client, csrf_token = auth_client
    response = await client.patch(
        "/api/v1/filaments/1",
        json={
            "custom_fields": custom,
            "extruder_temp_range_c": {"min": 225, "max": 230},
        },
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 200, response.text
    wire = await get(installed_app, "filament/1")
    extras = wire["extra"]["spoolman_extra"] if nested else wire["extra"]
    assert extras["sku"] == {"owner": "user"}
    assert extras["dry_temp"] == "cabinet Fahrenheit"
    assert wire["settings_extruder_temp"] == 225
    if nested:
        assert extras["settings_extruder_temp"] == "225"


async def test_reintroduced_definition_releases_retained_temperature_source(
    installed_app, db_session
):
    row, _, _ = migrated_rows(True)
    filament = await seed(db_session, row)
    filament.extruder_temp_range_c = {"min": 225, "max": 230}
    filament.custom_field_definitions = {
        "spoolman_extra.settings_extruder_temp": {
            "label": "Fahrenheit cabinet",
            "field_type": "number",
            "config": {"unit": "°F"},
        }
    }
    await db_session.commit()
    wire = await get(installed_app, "filament/1")
    assert wire["settings_extruder_temp"] == 225
    assert wire["extra"]["spoolman_extra"]["settings_extruder_temp"] == "210"


@pytest.mark.parametrize(
    "custom,key,label,field_type,native,edited,expected",
    [
        pytest.param(
            {"sku": "SKU-42", "sku.datasheet": "https://example.com/spec"},
            "sku.datasheet", "Datasheet URL", "url",
            {"manufacturer_sku": "SKU-42", "datasheet_url": "https://example.com/spec"},
            {"manufacturer_sku": "SKU-43", "datasheet_url": "https://example.com/new"},
            {"sku": "SKU-43", "sku.datasheet": "https://example.com/new"},
            id="accepted-single-system-definition",
        ),
        pytest.param(
            {"spoolman_extra.sku": "SKU-42", "spoolman_extra": {"keep": "nested"}},
            "spoolman_extra.sku", "Manufacturer SKU", "text",
            {"manufacturer_sku": "SKU-42"}, {"manufacturer_sku": "SKU-43"},
            {"spoolman_extra.sku": "SKU-43", "spoolman_extra": {"keep": "nested"}},
            id="legacy-stored-reserved-prefix",
        ),
    ],
)
async def test_migration_literal_sources_survive_installed_projection_and_explicit_ownership(
    installed_app, db_session, custom, key, label, field_type, native, edited, expected
):
    metadata, filaments, _, system_fields = legacy_schema()
    with sa.create_engine("sqlite://").begin() as connection:
        metadata.create_all(connection)
        # Define first: the accepted case has no overlapping parent System definition.
        # The reserved-prefix case covers legacy stored data; its System key is API-rejected.
        connection.execute(system_fields.insert(), {
            "id": 1, "target_type": "filament", "key": key,
            "label": label, "field_type": field_type,
        })
        connection.execute(filaments.insert(), {"id": 1, "custom_fields": custom})
        migration = load_migration_module()
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        upgraded = sa.Table("filaments", sa.MetaData(), autoload_with=connection)
        row = dict(connection.execute(sa.select(upgraded)).mappings().one())
    assert {column: row[column] for column in native} == native
    filament = await seed(db_session, row)
    assert (await get(installed_app, "filament/1"))["extra"] == custom
    for column, value in edited.items():
        setattr(filament, column, value)
    await db_session.commit()
    assert (await get(installed_app, "filament/1"))["extra"] == expected
    filament.custom_fields = copy.deepcopy(custom)
    await db_session.commit()
    assert (await get(installed_app, "filament/1"))["extra"] == custom
