from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import AppSettings, Filament, MaterialPreset
from app.services.material_presets import (
    DEFAULT_MATERIAL_PRESETS,
    apply_material_defaults,
    ensure_preset_cache,
    invalidate_preset_cache,
    match_preset,
)
from app.services.spool_moisture import compute_moisture
from tests.test_devices import (
    _create_filament,
    _create_manufacturer,
    _create_spool,
    _get_status,
)
from tests.test_rbac import viewer_auth_client, viewer_user  # noqa: F401

PRESETS = [SimpleNamespace(**row) for row in DEFAULT_MATERIAL_PRESETS]


@pytest.fixture(autouse=True)
def _reset_cache():
    invalidate_preset_cache()
    yield
    invalidate_preset_cache()


def _h(csrf):
    return {"X-CSRF-Token": csrf}


async def _seed_presets(db):
    for row in DEFAULT_MATERIAL_PRESETS:
        db.add(MaterialPreset(**row))
    await db.commit()


class TestMatching:
    @pytest.mark.parametrize(
        "mtype,sub,expected",
        [
            ("PLA", None, "PLA"),
            ("pla", None, "PLA"),
            ("PLA Silk", None, "PLA"),
            ("PLA-CF", None, "PLA-CF"),
            ("PETG-CF", None, "PETG-CF"),
            ("PETG", None, "PETG"),
            ("PCTG", None, "PCTG"),
            ("PPS", None, "PPS"),
            ("PA12", None, "PA"),
            ("Unbekannt", "TPU 95A", "TPU"),
            ("PLA", "PETG", "PLA"),
            ("Unbekannt", None, None),
            (None, None, None),
        ],
    )
    def test_longest_prefix(self, mtype, sub, expected):
        found = match_preset(PRESETS, mtype, sub)
        assert (found.material_type if found else None) == expected

    def test_pctg_does_not_fall_to_pc_when_pctg_exists(self):
        assert match_preset(PRESETS, "PCTG").material_type == "PCTG"


def _filament(**kw):
    base = dict(
        extruder_temp_range_c=None, bed_temp_range_c=None, flow_ratio=None,
        drying_temp_c=None, drying_time_hours=None, drying_interval_days=None,
        density_g_cm3=None, default_spool_weight_g=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


class TestApply:
    def test_fills_only_none(self):
        preset = match_preset(PRESETS, "PETG")
        fil = _filament(flow_ratio=0.9, extruder_temp_range_c={"min": 200, "max": None})
        changed = apply_material_defaults(
            fil, preset, SimpleNamespace(default_empty_spool_weight_g=250)
        )
        assert fil.flow_ratio == 0.9
        assert fil.extruder_temp_range_c == {"min": 200, "max": None}
        assert fil.bed_temp_range_c == {"min": 70, "max": 85}
        assert fil.drying_temp_c == 65
        assert fil.drying_interval_days == 30
        assert fil.density_g_cm3 == 1.27
        assert fil.default_spool_weight_g == 250
        assert changed == 6

    def test_empty_range_dict_is_filled(self):
        fil = _filament(bed_temp_range_c={"min": None, "max": None})
        apply_material_defaults(fil, match_preset(PRESETS, "PLA"), None)
        assert fil.bed_temp_range_c == {"min": 50, "max": 65}

    def test_spool_weight_prefers_manufacturer(self):
        fil = _filament()
        apply_material_defaults(
            fil, None, SimpleNamespace(default_empty_spool_weight_g=250),
            SimpleNamespace(empty_spool_weight_g=180),
        )
        assert fil.default_spool_weight_g == 180

    def test_existing_spool_weight_wins(self):
        fil = _filament(default_spool_weight_g=300)
        apply_material_defaults(
            fil, None, SimpleNamespace(default_empty_spool_weight_g=250)
        )
        assert fil.default_spool_weight_g == 300

    def test_no_settings_row_uses_shipped_default(self):
        fil = _filament()
        apply_material_defaults(fil, None, None)
        assert fil.default_spool_weight_g == 250


class TestMoistureInterval:
    def _days(self, days, interval):
        now = datetime.now(timezone.utc)
        return compute_moisture(
            "opened", "PLA", None, now - timedelta(days=days), None, now,
            interval_days=interval,
        )["level"]

    @pytest.mark.parametrize(
        "days,level",
        [(6, "dry"), (7, "fair"), (15, "fair"), (16, "damp"), (30, "damp"), (31, "wet")],
    )
    def test_interval_30(self, days, level):
        # interval 30: dry <= 6, fair <= 15, damp <= 30
        assert self._days(days, 30) == level

    def test_small_interval_keeps_ordering(self):
        assert self._days(1, 3) == "dry"
        assert self._days(2, 3) == "fair"
        assert self._days(3, 3) == "damp"
        assert self._days(4, 3) == "wet"

    def test_without_interval_unchanged(self):
        assert self._days(40, None) == "fair"  # PLA sensitivity: dry 30 / fair 90


class TestAdminApi:
    @pytest.mark.asyncio
    async def test_crud_and_validation(self, auth_client):
        client, csrf = auth_client
        created = await client.post(
            "/api/v1/admin/material-presets",
            json={"material_type": "XYZ", "extruder_temp_min_c": 200, "extruder_temp_max_c": 220},
            headers=_h(csrf),
        )
        assert created.status_code == 201, created.text
        pid = created.json()["id"]
        dup = await client.post(
            "/api/v1/admin/material-presets", json={"material_type": "XYZ"}, headers=_h(csrf)
        )
        assert dup.status_code == 409
        bad = await client.post(
            "/api/v1/admin/material-presets",
            json={"material_type": "BAD", "bed_temp_min_c": 90, "bed_temp_max_c": 60},
            headers=_h(csrf),
        )
        assert bad.status_code == 422
        bad_flow = await client.patch(
            f"/api/v1/admin/material-presets/{pid}", json={"flow_ratio": 2}, headers=_h(csrf)
        )
        assert bad_flow.status_code == 422
        crossing = await client.patch(
            f"/api/v1/admin/material-presets/{pid}",
            json={"extruder_temp_max_c": 150},
            headers=_h(csrf),
        )
        assert crossing.status_code == 422
        ok = await client.patch(
            f"/api/v1/admin/material-presets/{pid}", json={"flow_ratio": 0.97}, headers=_h(csrf)
        )
        assert ok.status_code == 200 and ok.json()["flow_ratio"] == 0.97
        assert len((await client.get("/api/v1/admin/material-presets")).json()) == 1
        assert (
            await client.delete(f"/api/v1/admin/material-presets/{pid}", headers=_h(csrf))
        ).status_code == 204

    @pytest.mark.asyncio
    async def test_reset_restores_defaults(self, auth_client, db_session):
        client, csrf = auth_client
        await _seed_presets(db_session)
        first = (await client.get("/api/v1/admin/material-presets")).json()
        await client.delete(f"/api/v1/admin/material-presets/{first[0]['id']}", headers=_h(csrf))
        reset = await client.post("/api/v1/admin/material-presets/reset", headers=_h(csrf))
        assert reset.status_code == 200
        assert len(reset.json()) == len(DEFAULT_MATERIAL_PRESETS)

    @pytest.mark.asyncio
    async def test_non_admin_forbidden(self, viewer_auth_client):  # noqa: F811
        client, csrf = viewer_auth_client
        assert (await client.get("/api/v1/admin/material-presets")).status_code == 403
        for path in ("reset", "apply-to-filaments"):
            response = await client.post(f"/api/v1/admin/material-presets/{path}", headers=_h(csrf))
            assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_app_settings_empty_spool_weight(self, auth_client):
        client, csrf = auth_client
        response = await client.put(
            "/api/v1/admin/app-settings/",
            json={"default_empty_spool_weight_g": 220},
            headers=_h(csrf),
        )
        assert response.status_code == 200
        assert response.json()["default_empty_spool_weight_g"] == 220


class TestCreateAndBulk:
    @pytest.mark.asyncio
    async def test_create_fills_defaults_user_values_win(self, auth_client, db_session):
        client, csrf = auth_client
        await _seed_presets(db_session)
        db_session.add(AppSettings(id=1, default_empty_spool_weight_g=240))
        await db_session.commit()
        manufacturer = await _create_manufacturer(db_session, name="PresetMfr")
        response = await client.post(
            "/api/v1/filaments",
            json={
                "manufacturer_id": manufacturer.id,
                "designation": "Test",
                "material_type": "PETG-CF",
                "diameter_mm": 1.75,
                "flow_ratio": 0.9,
            },
            headers=_h(csrf),
        )
        assert response.status_code in (200, 201), response.text
        body = response.json()
        assert body["flow_ratio"] == 0.9
        assert body["extruder_temp_range_c"] == {"min": 240, "max": 270}
        assert body["drying_interval_days"] == 30
        assert body["density_g_cm3"] == 1.29
        assert body["default_spool_weight_g"] == 240

    @pytest.mark.asyncio
    async def test_patch_does_not_apply_defaults(self, auth_client, db_session):
        client, csrf = auth_client
        await _seed_presets(db_session)
        manufacturer = await _create_manufacturer(db_session, name="PatchMfr")
        filament = await _create_filament(db_session, manufacturer.id, material_type="PLA")
        response = await client.patch(
            f"/api/v1/filaments/{filament.id}", json={"designation": "Renamed"}, headers=_h(csrf)
        )
        assert response.status_code == 200
        assert response.json()["drying_interval_days"] is None

    @pytest.mark.asyncio
    async def test_bulk_apply(self, auth_client, db_session):
        client, csrf = auth_client
        await _seed_presets(db_session)
        manufacturer = await _create_manufacturer(db_session, name="BulkMfr")
        plain = await _create_filament(db_session, manufacturer.id, material_type="ABS")
        custom = await _create_filament(db_session, manufacturer.id, material_type="PLA")
        custom.density_g_cm3 = 1.5
        await db_session.commit()
        response = await client.post(
            "/api/v1/admin/material-presets/apply-to-filaments", headers=_h(csrf)
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["updated_filaments"] == 2
        assert data["updated_fields"] > 0
        await db_session.refresh(plain)
        await db_session.refresh(custom)
        assert plain.density_g_cm3 == 1.04
        assert custom.density_g_cm3 == 1.5
        assert custom.drying_interval_days == 90
        again = await client.post(
            "/api/v1/admin/material-presets/apply-to-filaments", headers=_h(csrf)
        )
        assert again.json() == {"updated_filaments": 0, "updated_fields": 0}


class TestSpoolMoistureUsesPresets:
    @pytest.mark.asyncio
    async def test_filament_interval_beats_preset_beats_sensitivity(self, auth_client, db_session):
        client, _ = auth_client
        await _seed_presets(db_session)
        await ensure_preset_cache(db_session)
        manufacturer = await _create_manufacturer(db_session, name="MoistMfr")
        status_obj = await _get_status(db_session, "opened")
        opened = datetime.now(timezone.utc) - timedelta(days=20)

        # PLA preset interval 90 -> day 20 is still dry (<=18)? 90*0.2=18 -> fair
        pla = await _create_filament(db_session, manufacturer.id, material_type="PLA")
        s1 = await _create_spool(db_session, pla.id, status_obj.id, opened_at=opened)
        assert (await client.get(f"/api/v1/spools/{s1.id}")).json()["moisture"]["level"] == "fair"

        # filament override 10 days -> wet at day 20
        pla2 = await _create_filament(db_session, manufacturer.id, material_type="PLA")
        pla2.drying_interval_days = 10
        await db_session.commit()
        s2 = await _create_spool(db_session, pla2.id, status_obj.id, opened_at=opened)
        assert (await client.get(f"/api/v1/spools/{s2.id}")).json()["moisture"]["level"] == "wet"
