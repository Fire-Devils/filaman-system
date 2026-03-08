import pytest
from sqlalchemy import select

from app.models import Color, Filament, FilamentColor, Manufacturer, Spool, SpoolStatus


async def _create_manufacturer(db_session, name: str = "Test Manufacturer", **kwargs) -> Manufacturer:
    manufacturer = Manufacturer(name=name, **kwargs)
    db_session.add(manufacturer)
    await db_session.commit()
    await db_session.refresh(manufacturer)
    return manufacturer


async def _create_color(
    db_session,
    name: str = "Red",
    hex_code: str = "#FF0000",
    **kwargs,
) -> Color:
    color = Color(name=name, hex_code=hex_code, **kwargs)
    db_session.add(color)
    await db_session.commit()
    await db_session.refresh(color)
    return color


async def _create_filament(
    db_session,
    manufacturer_id: int,
    designation: str = "Test PLA",
    material_type: str = "PLA",
    diameter_mm: float = 1.75,
    **kwargs,
) -> Filament:
    filament = Filament(
        manufacturer_id=manufacturer_id,
        designation=designation,
        material_type=material_type,
        diameter_mm=diameter_mm,
        **kwargs,
    )
    db_session.add(filament)
    await db_session.commit()
    await db_session.refresh(filament)
    return filament


async def _get_status(db_session, key: str) -> SpoolStatus:
    result = await db_session.execute(select(SpoolStatus).where(SpoolStatus.key == key))
    return result.scalar_one()


async def _create_spool(db_session, filament_id, status_id, **kwargs) -> Spool:
    spool = Spool(
        filament_id=filament_id,
        status_id=status_id,
        initial_total_weight_g=kwargs.pop("initial_total_weight_g", 1000.0),
        empty_spool_weight_g=kwargs.pop("empty_spool_weight_g", 250.0),
        remaining_weight_g=kwargs.pop("remaining_weight_g", 750.0),
        **kwargs,
    )
    db_session.add(spool)
    await db_session.commit()
    await db_session.refresh(spool)
    return spool


class TestManufacturerCRUD:
    @pytest.mark.asyncio
    async def test_list_manufacturers_paginated(self, auth_client, db_session, client):
        client, _ = auth_client

        await _create_manufacturer(db_session, name="Maker A")
        await _create_manufacturer(db_session, name="Maker B")

        response = await client.get("/api/v1/manufacturers?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        names = {item["name"] for item in data["items"]}
        assert {"Maker A", "Maker B"}.issubset(names)

    @pytest.mark.asyncio
    async def test_create_manufacturer(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/manufacturers",
            json={
                "name": "Acme",
                "url": "https://acme.example",
                "empty_spool_weight_g": 280.0,
                "spool_outer_diameter_mm": 200.0,
                "spool_width_mm": 65.0,
                "spool_material": "Cardboard",
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Acme"
        assert data["url"] == "https://acme.example"
        assert data["empty_spool_weight_g"] == 280.0
        assert data["spool_outer_diameter_mm"] == 200.0
        assert data["spool_width_mm"] == 65.0
        assert data["spool_material"] == "Cardboard"

    @pytest.mark.asyncio
    async def test_create_manufacturer_duplicate_name(self, auth_client, db_session):
        client, csrf_token = auth_client

        await _create_manufacturer(db_session, name="DupMaker")

        response = await client.post(
            "/api/v1/manufacturers",
            json={"name": "DupMaker"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"

    @pytest.mark.asyncio
    async def test_get_manufacturer(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session, name="GetMaker")

        response = await client.get(f"/api/v1/manufacturers/{manufacturer.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == manufacturer.id
        assert data["name"] == "GetMaker"

    @pytest.mark.asyncio
    async def test_update_manufacturer(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session, name="OldMaker")

        response = await client.patch(
            f"/api/v1/manufacturers/{manufacturer.id}",
            json={"name": "NewMaker", "url": "https://new.example"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "NewMaker"
        assert data["url"] == "https://new.example"

    @pytest.mark.asyncio
    async def test_update_manufacturer_duplicate_name(self, auth_client, db_session):
        client, csrf_token = auth_client

        first = await _create_manufacturer(db_session, name="Maker One")
        second = await _create_manufacturer(db_session, name="Maker Two")

        response = await client.patch(
            f"/api/v1/manufacturers/{second.id}",
            json={"name": first.name},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"

    @pytest.mark.asyncio
    async def test_delete_manufacturer_no_filaments(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session, name="DeleteMaker")

        response = await client.delete(
            f"/api/v1/manufacturers/{manufacturer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Manufacturer).where(Manufacturer.id == manufacturer.id))
        assert result.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_delete_manufacturer_with_filaments_conflict(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session, name="ConflictMaker")
        await _create_filament(db_session, manufacturer.id)

        response = await client.delete(
            f"/api/v1/manufacturers/{manufacturer.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"

    @pytest.mark.asyncio
    async def test_delete_manufacturer_with_filaments_force(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session, name="ForceMaker")
        filament = await _create_filament(db_session, manufacturer.id)
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.delete(
            f"/api/v1/manufacturers/{manufacturer.id}?force=true",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Manufacturer).where(Manufacturer.id == manufacturer.id))
        assert result.scalar_one_or_none() is None
        fil_result = await db_session.execute(select(Filament).where(Filament.id == filament.id))
        assert fil_result.scalar_one_or_none() is None
        spool_result = await db_session.execute(select(Spool).where(Spool.id == spool.id))
        assert spool_result.scalar_one_or_none() is None


class TestColorCRUD:
    @pytest.mark.asyncio
    async def test_list_colors_paginated(self, auth_client, db_session):
        client, _ = auth_client

        color_used = await _create_color(db_session, name="Crimson", hex_code="#AA0000")
        await _create_color(db_session, name="Azure", hex_code="#0000FF")
        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        db_session.add(FilamentColor(filament_id=filament.id, color_id=color_used.id, position=1))
        await db_session.commit()

        response = await client.get("/api/v1/colors?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        usage_map = {item["name"]: item["usage_count"] for item in data["items"]}
        assert usage_map["Crimson"] >= 1
        assert usage_map["Azure"] == 0

    @pytest.mark.asyncio
    async def test_create_color(self, auth_client):
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/colors",
            json={"name": "Green", "hex_code": "#00FF00"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Green"
        assert data["hex_code"] == "#00FF00"

    @pytest.mark.asyncio
    async def test_get_color(self, auth_client, db_session):
        client, _ = auth_client

        color = await _create_color(db_session, name="Get Blue", hex_code="#1122FF")

        response = await client.get(f"/api/v1/colors/{color.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == color.id
        assert data["name"] == "Get Blue"

    @pytest.mark.asyncio
    async def test_update_color(self, auth_client, db_session):
        client, csrf_token = auth_client

        color = await _create_color(db_session, name="Old", hex_code="#010101")

        response = await client.patch(
            f"/api/v1/colors/{color.id}",
            json={"name": "New", "hex_code": "#020202"},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "New"
        assert data["hex_code"] == "#020202"

    @pytest.mark.asyncio
    async def test_delete_color_unused(self, auth_client, db_session):
        client, csrf_token = auth_client

        color = await _create_color(db_session, name="Unused", hex_code="#123456")

        response = await client.delete(
            f"/api/v1/colors/{color.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Color).where(Color.id == color.id))
        assert result.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_delete_color_in_use(self, auth_client, db_session):
        client, csrf_token = auth_client

        color = await _create_color(db_session, name="Used", hex_code="#654321")
        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id)
        db_session.add(FilamentColor(filament_id=filament.id, color_id=color.id, position=1))
        await db_session.commit()

        response = await client.delete(
            f"/api/v1/colors/{color.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"


class TestFilamentCRUD:
    @pytest.mark.asyncio
    async def test_list_filament_types(self, auth_client):
        client, _ = auth_client

        response = await client.get("/api/v1/filaments/types")

        assert response.status_code == 200
        types = response.json()
        assert {"PLA", "PETG", "ABS"}.issubset(set(types))

    @pytest.mark.asyncio
    async def test_list_filaments_paginated(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session, name="Maker F")
        color = await _create_color(db_session, name="White", hex_code="#FFFFFF")
        filament = await _create_filament(db_session, manufacturer.id, designation="PLA White")
        db_session.add(FilamentColor(filament_id=filament.id, color_id=color.id, position=1))
        await db_session.commit()

        response = await client.get("/api/v1/filaments?page=1&page_size=10")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "page" in data
        assert "total" in data
        item = next(item for item in data["items"] if item["id"] == filament.id)
        assert item["manufacturer"]["id"] == manufacturer.id
        assert item["colors"][0]["color_id"] == color.id

    @pytest.mark.asyncio
    async def test_create_filament_basic(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)

        response = await client.post(
            "/api/v1/filaments",
            json={
                "manufacturer_id": manufacturer.id,
                "designation": "PLA Basic",
                "material_type": "PLA",
                "diameter_mm": 1.75,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["designation"] == "PLA Basic"
        assert data["material_type"] == "PLA"
        assert data["diameter_mm"] == 1.75

    @pytest.mark.asyncio
    async def test_create_filament_cascades_from_manufacturer(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(
            db_session,
            name="CascadeMaker",
            empty_spool_weight_g=300.0,
            spool_outer_diameter_mm=210.0,
            spool_width_mm=70.0,
            spool_material="Plastic",
        )

        response = await client.post(
            "/api/v1/filaments",
            json={
                "manufacturer_id": manufacturer.id,
                "designation": "PLA Cascade",
                "material_type": "PLA",
                "diameter_mm": 1.75,
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["default_spool_weight_g"] == 300.0
        assert data["spool_outer_diameter_mm"] == 210.0
        assert data["spool_width_mm"] == 70.0
        assert data["spool_material"] == "Plastic"

    @pytest.mark.asyncio
    async def test_get_filament_detail(self, auth_client, db_session):
        client, _ = auth_client

        manufacturer = await _create_manufacturer(db_session, name="DetailMaker")
        color = await _create_color(db_session, name="Detail Red", hex_code="#FF1100")
        filament = await _create_filament(db_session, manufacturer.id, designation="Detail PLA")
        db_session.add(FilamentColor(filament_id=filament.id, color_id=color.id, position=1))
        await db_session.commit()
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament.id, status.id)

        response = await client.get(f"/api/v1/filaments/{filament.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == filament.id
        assert data["manufacturer"]["id"] == manufacturer.id
        assert data["spool_count"] == 1
        assert data["colors"][0]["color_id"] == color.id

    @pytest.mark.asyncio
    async def test_update_filament(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, designation="Old Filament")

        response = await client.patch(
            f"/api/v1/filaments/{filament.id}",
            json={"designation": "New Filament", "price": 22.5},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["designation"] == "New Filament"
        assert data["price"] == 22.5

    @pytest.mark.asyncio
    async def test_delete_filament_no_spools(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, designation="Delete Filament")

        response = await client.delete(
            f"/api/v1/filaments/{filament.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        result = await db_session.execute(select(Filament).where(Filament.id == filament.id))
        assert result.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_delete_filament_with_spools_conflict(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, designation="Conflict Filament")
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament.id, status.id)

        response = await client.delete(
            f"/api/v1/filaments/{filament.id}",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "conflict"

    @pytest.mark.asyncio
    async def test_delete_filament_with_spools_force(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament = await _create_filament(db_session, manufacturer.id, designation="Force Filament")
        status = await _get_status(db_session, "new")
        spool = await _create_spool(db_session, filament.id, status.id)

        response = await client.delete(
            f"/api/v1/filaments/{filament.id}?force=true",
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 204
        fil_result = await db_session.execute(select(Filament).where(Filament.id == filament.id))
        assert fil_result.scalar_one_or_none() is None
        spool_result = await db_session.execute(select(Spool).where(Spool.id == spool.id))
        assert spool_result.scalar_one_or_none() is None


class TestFilamentBulkOperations:
    @pytest.mark.asyncio
    async def test_bulk_update_filaments(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament_one = await _create_filament(db_session, manufacturer.id, designation="Bulk A")
        filament_two = await _create_filament(db_session, manufacturer.id, designation="Bulk B")

        response = await client.patch(
            "/api/v1/filaments/bulk",
            json={"filament_ids": [filament_one.id, filament_two.id], "price": 29.99},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["count"] == 2
        await db_session.refresh(filament_one)
        await db_session.refresh(filament_two)
        assert filament_one.price == 29.99
        assert filament_two.price == 29.99

    @pytest.mark.asyncio
    async def test_bulk_delete_filaments(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament_one = await _create_filament(db_session, manufacturer.id, designation="Delete A")
        filament_two = await _create_filament(db_session, manufacturer.id, designation="Delete B")

        response = await client.request(
            "DELETE",
            "/api/v1/filaments/bulk",
            json={"filament_ids": [filament_one.id, filament_two.id], "force": False},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["count"] == 2
        result = await db_session.execute(select(Filament).where(Filament.id.in_([filament_one.id, filament_two.id])))
        assert result.scalars().all() == []

    @pytest.mark.asyncio
    async def test_bulk_delete_filaments_with_spools_skips(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        filament_keep = await _create_filament(db_session, manufacturer.id, designation="Keep")
        filament_delete = await _create_filament(db_session, manufacturer.id, designation="Remove")
        status = await _get_status(db_session, "new")
        await _create_spool(db_session, filament_keep.id, status.id)

        response = await client.request(
            "DELETE",
            "/api/v1/filaments/bulk",
            json={"filament_ids": [filament_keep.id, filament_delete.id], "force": False},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["success"] is True
        assert payload["count"] == 1
        remaining = await db_session.execute(select(Filament).where(Filament.id == filament_keep.id))
        deleted = await db_session.execute(select(Filament).where(Filament.id == filament_delete.id))
        assert remaining.scalar_one_or_none() is not None
        assert deleted.scalar_one_or_none() is None


class TestFilamentColors:
    @pytest.mark.asyncio
    async def test_create_filament_with_inline_colors(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        color_one = await _create_color(db_session, name="Inline Red", hex_code="#FF0000")
        color_two = await _create_color(db_session, name="Inline Blue", hex_code="#0000FF")

        response = await client.post(
            "/api/v1/filaments",
            json={
                "manufacturer_id": manufacturer.id,
                "designation": "Inline Multi",
                "material_type": "PLA",
                "diameter_mm": 1.75,
                "color_mode": "multi",
                "multi_color_style": "striped",
                "colors": [
                    {"color_id": color_one.id, "position": 1},
                    {"color_id": color_two.id, "position": 2},
                ],
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["color_mode"] == "multi"
        assert data["multi_color_style"] == "striped"
        assert len(data["colors"]) == 2
        assert data["colors"][0]["color_id"] == color_one.id
        assert data["colors"][1]["color_id"] == color_two.id

    @pytest.mark.asyncio
    async def test_replace_filament_colors(self, auth_client, db_session):
        client, csrf_token = auth_client

        manufacturer = await _create_manufacturer(db_session)
        color_one = await _create_color(db_session, name="Replace Red", hex_code="#FF1100")
        color_two = await _create_color(db_session, name="Replace Green", hex_code="#00FF11")
        filament = await _create_filament(db_session, manufacturer.id, designation="Replace Filament")
        db_session.add(FilamentColor(filament_id=filament.id, color_id=color_one.id, position=1))
        await db_session.commit()

        response = await client.put(
            f"/api/v1/filaments/{filament.id}/colors",
            json={
                "color_mode": "multi",
                "multi_color_style": "gradient",
                "colors": [
                    {"color_id": color_one.id, "position": 1},
                    {"color_id": color_two.id, "position": 2},
                ],
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["color_id"] == color_one.id
        assert data[1]["color_id"] == color_two.id
        await db_session.refresh(filament)
        assert filament.color_mode == "multi"
        assert filament.multi_color_style == "gradient"

    @pytest.mark.asyncio
    async def test_replace_filament_colors_not_found(self, auth_client):
        client, csrf_token = auth_client

        response = await client.put(
            "/api/v1/filaments/999999/colors",
            json={
                "color_mode": "single",
                "multi_color_style": None,
                "colors": [],
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"
