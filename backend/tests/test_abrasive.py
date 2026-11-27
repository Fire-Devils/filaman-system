import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models import (
    Filament,
    Manufacturer,
    Printer,
    PrinterSlot,
    PrinterSlotAssignment,
    Spool,
    SpoolStatus,
)
from app.services.abrasive import effective_abrasive, min_nozzle_mm, slot_warnings
from sqlalchemy import select


def fil(designation="X", material_type="PLA", subgroup=None, is_abrasive=None):
    return SimpleNamespace(
        designation=designation,
        material_type=material_type,
        material_subgroup=subgroup,
        is_abrasive=is_abrasive,
    )


@pytest.mark.parametrize(
    "kwargs,expected",
    [
        ({"material_type": "PLA"}, False),
        ({"material_type": "PLA-CF"}, True),
        ({"material_type": "PETG", "designation": "PETG+GF"}, True),
        ({"designation": "Silk Glow in the dark"}, True),
        ({"subgroup": "Carbon"}, True),
        ({"designation": "Holz Optik"}, True),
        ({"designation": "Marmor Weiss"}, True),
        ({"designation": "Cfoo Basic"}, False),
        ({"designation": "Glassy Silk"}, False),
        ({"designation": "Steelblue PLA"}, False),
        ({"material_type": "PLA", "is_abrasive": False, "designation": "PLA-CF"}, False),
        ({"material_type": "PLA", "is_abrasive": True}, True),
    ],
)
def test_effective_abrasive(kwargs, expected):
    assert effective_abrasive(fil(**kwargs)) is expected


@pytest.mark.parametrize(
    "kwargs,expected",
    [
        ({"material_type": "PLA-CF"}, 0.4),
        ({"designation": "Wood Fill"}, 0.4),
        ({"designation": "Bronze Fill"}, 0.6),
        ({"designation": "Metal Silk"}, 0.6),
        ({"designation": "Marble"}, None),
        ({"material_type": "PLA"}, None),
    ],
)
def test_min_nozzle(kwargs, expected):
    assert min_nozzle_mm(fil(**kwargs)) == expected


def test_warnings_levels():
    cf = fil(material_type="PLA-CF")
    unknown = SimpleNamespace(nozzle_hardened=None, nozzle_diameter_mm=None)
    soft = SimpleNamespace(nozzle_hardened=False, nozzle_diameter_mm=0.4)
    hard = SimpleNamespace(nozzle_hardened=True, nozzle_diameter_mm=0.2)
    assert slot_warnings(cf, unknown) == [
        {"code": "abrasive_soft_nozzle", "level": "unknown"}
    ]
    assert [w["level"] for w in slot_warnings(cf, soft)] == ["warning"]
    codes = [w["code"] for w in slot_warnings(cf, hard)]
    assert codes == ["nozzle_too_small"]
    assert slot_warnings(fil(), soft) == []
    assert slot_warnings(None, soft) == []


@pytest.mark.asyncio
async def test_slot_warnings_in_printer_detail_and_slots(auth_client, db_session):
    client, _ = auth_client
    maker = Manufacturer(name="M")
    db_session.add(maker)
    await db_session.commit()
    filament = Filament(
        manufacturer_id=maker.id,
        designation="Carbon PLA-CF",
        material_type="PLA",
        diameter_mm=1.75,
    )
    printer = Printer(
        name="P", driver_key="bambu_mqtt", nozzle_diameter_mm=0.2, nozzle_hardened=False
    )
    db_session.add_all([filament, printer])
    await db_session.commit()
    status = (await db_session.execute(select(SpoolStatus))).scalars().first()
    spool = Spool(
        filament_id=filament.id,
        status_id=status.id,
        initial_total_weight_g=1000.0,
        empty_spool_weight_g=250.0,
        remaining_weight_g=750.0,
    )
    slot = PrinterSlot(printer_id=printer.id, slot_no=1)
    db_session.add_all([spool, slot])
    await db_session.commit()
    db_session.add(
        PrinterSlotAssignment(slot_id=slot.id, spool_id=spool.id, present=True)
    )
    await db_session.commit()
    printer_id, filament_id = printer.id, filament.id
    db_session.expire_all()

    detail = (await client.get(f"/api/v1/printers/{printer_id}")).json()
    assert detail["nozzle_diameter_mm"] == 0.2
    assert detail["nozzle_hardened"] is False
    codes = {w["code"] for w in detail["slots"][0]["warnings"]}
    assert codes == {"abrasive_soft_nozzle", "nozzle_too_small"}

    slots = (await client.get(f"/api/v1/printers/{printer_id}/slots")).json()
    assert {w["code"] for w in slots[0]["warnings"]} == codes

    fil_json = (await client.get(f"/api/v1/filaments/{filament_id}")).json()
    assert fil_json["abrasive"] is True
    assert fil_json["is_abrasive"] is None
    assert fil_json["min_nozzle_mm"] == 0.4


@pytest.mark.asyncio
async def test_printer_and_filament_fields_writable(auth_client, db_session):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    created = await client.post(
        "/api/v1/printers",
        json={
            "name": "N",
            "driver_key": "bambu_mqtt",
            "nozzle_diameter_mm": 0.6,
            "nozzle_hardened": True,
        },
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["nozzle_hardened"] is True
    patched = await client.patch(
        f"/api/v1/printers/{created.json()['id']}",
        json={"nozzle_diameter_mm": 0.4, "nozzle_hardened": False},
        headers=headers,
    )
    assert patched.status_code == 200
    assert patched.json()["nozzle_diameter_mm"] == 0.4
    assert patched.json()["nozzle_hardened"] is False

    maker = Manufacturer(name="M2")
    db_session.add(maker)
    await db_session.commit()
    resp = await client.post(
        "/api/v1/filaments",
        json={
            "manufacturer_id": maker.id,
            "designation": "PLA-CF",
            "material_type": "PLA",
            "diameter_mm": 1.75,
            "is_abrasive": False,
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["is_abrasive"] is False
    assert body["abrasive"] is False


@pytest.mark.asyncio
async def test_printer_detail_returns_model_fields(auth_client):
    client, csrf = auth_client
    headers = {"X-CSRF-Token": csrf}
    created = await client.post(
        "/api/v1/printers",
        json={
            "name": "Modelled",
            "driver_key": "bambu_mqtt",
            "printer_manufacturer": "Bambu Lab",
            "printer_model": "X1C",
            "filamentdb_printer_model_id": 42,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    detail = await client.get(f"/api/v1/printers/{created.json()['id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["printer_manufacturer"] == "Bambu Lab"
    assert body["printer_model"] == "X1C"
    assert body["filamentdb_printer_model_id"] == 42


MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "alembic"
    / "versions"
    / "c3e9a5f7d120_add_abrasive_and_nozzle_fields.py"
)


def test_migration_adds_and_drops_columns():
    spec = importlib.util.spec_from_file_location("abrasive_migration", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "c3e9a71f2d85"

    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    for name in ("filaments", "printers"):
        sa.Table(
            name,
            metadata,
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("created_at", sa.DateTime, nullable=False),
            sa.Column("updated_at", sa.DateTime, nullable=False),
        )
    metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO printers (id, created_at, updated_at) "
                "VALUES (1, '2026-01-01', '2026-01-01')"
            )
        )
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
        cols = {c["name"] for c in sa.inspect(conn).get_columns("printers")}
        assert {"nozzle_diameter_mm", "nozzle_hardened"} <= cols
        assert "is_abrasive" in {c["name"] for c in sa.inspect(conn).get_columns("filaments")}
        row = conn.execute(sa.text("SELECT nozzle_hardened FROM printers")).one()
        assert row[0] is None
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
        assert "nozzle_hardened" not in {
            c["name"] for c in sa.inspect(conn).get_columns("printers")
        }
