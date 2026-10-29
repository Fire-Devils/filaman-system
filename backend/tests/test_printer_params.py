"""Contracts used by the shared printer setup UI; reset is a per-key DELETE."""
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.models import Filament, Manufacturer, Printer, Spool, SpoolStatus


@pytest_asyncio.fixture
async def parameter_entities(db_session):
    manufacturer = Manufacturer(name="Parameter contract manufacturer")
    db_session.add(manufacturer)
    await db_session.flush()
    filament = Filament(
        manufacturer_id=manufacturer.id,
        designation="Parameter contract filament",
        material_type="PLA",
        diameter_mm=1.75,
    )
    printer = Printer(name="Parameter contract printer", driver_key="contract-driver")
    db_session.add_all([filament, printer])
    await db_session.flush()
    status_id = await db_session.scalar(select(SpoolStatus.id).limit(1))
    spool = Spool(filament_id=filament.id, status_id=status_id)
    db_session.add(spool)
    await db_session.commit()
    return filament, spool, printer


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["filaments", "spools"])
async def test_parameter_upsert_and_single_key_reset_preserve_legacy_values(
    auth_client, parameter_entities, entity_type
):
    client, csrf_token = auth_client
    filament, spool, printer = parameter_entities
    entity_id = filament.id if entity_type == "filaments" else spool.id
    path = f"/api/v1/{entity_type}/{entity_id}/printer-params"
    headers = {"X-CSRF-Token": csrf_token}
    values = {"temperature": "205", "zero": "0", "false": "false", "empty": "", "null": None, "profile": "PFUS-kept"}
    response = await client.put(
        f"{path}/{printer.id}",
        json={"params": [{"param_key": key, "param_value": value} for key, value in values.items()]},
        headers=headers,
    )
    assert response.status_code == 200
    owner_key = "filament_id" if entity_type == "filaments" else "spool_id"
    assert set(response.json()[0]) == {"id", owner_key, "printer_id", "param_key", "param_value"}
    updated = await client.put(
        f"{path}/{printer.id}",
        json={"params": [{"param_key": "temperature", "param_value": "210"}]},
        headers=headers,
    )
    assert updated.status_code == 200
    assert [row["param_key"] for row in updated.json()] == ["temperature"]
    removed = await client.delete(
        f"{path}/{printer.id}?param_key=temperature", headers=headers
    )
    assert removed.status_code == 204
    assert removed.content == b""
    remaining = await client.get(f"{path}?printer_id={printer.id}")
    assert remaining.status_code == 200
    assert {row["param_key"]: row["param_value"] for row in remaining.json()} == {
        key: value for key, value in values.items() if key != "temperature"
    }
    repeat = await client.delete(
        f"{path}/{printer.id}?param_key=temperature", headers=headers
    )
    assert repeat.status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["filaments", "spools"])
@pytest.mark.parametrize("can_edit", [True, False], ids=["editor", "viewer"])
async def test_parameter_writes_use_seeded_update_permissions(
    client, normal_user, db_session, parameter_entities, entity_type, can_edit
):
    from app.models import Permission, Role, RolePermission, UserRole
    from tests.test_rbac import _create_session

    if can_edit:
        permission = await db_session.scalar(select(Permission).where(Permission.key == f"{entity_type}:update"))
        role = Role(key="parameter-editor", name="Parameter editor")
        db_session.add(role)
        await db_session.flush()
        db_session.add_all([
            RolePermission(role_id=role.id, permission_id=permission.id),
            UserRole(user_id=normal_user.id, role_id=role.id),
        ])
    else:
        await db_session.execute(delete(UserRole).where(UserRole.user_id == normal_user.id))
        role = await db_session.scalar(select(Role).where(Role.key == "viewer"))
        db_session.add(UserRole(user_id=normal_user.id, role_id=role.id))
    await db_session.commit()
    client, csrf_token = await _create_session(client, db_session, normal_user.id)
    filament, spool, printer = parameter_entities
    entity_id = filament.id if entity_type == "filaments" else spool.id
    path = f"/api/v1/{entity_type}/{entity_id}/printer-params/{printer.id}"
    headers = {"X-CSRF-Token": csrf_token}
    response = await client.put(path, json={"params": [{"param_key": "temperature", "param_value": "210"}]}, headers=headers)
    assert response.status_code == (200 if can_edit else 403)
    removed = await client.delete(f"{path}?param_key=temperature", headers=headers)
    assert removed.status_code == (204 if can_edit else 403)


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["filaments", "spools"])
async def test_parameter_writes_accept_driver_fields_owned_by_another_plugin(
    auth_client, db_session, parameter_entities, monkeypatch, tmp_path, entity_type
):
    import json

    from app.models.system_extra_field import SystemExtraField
    from app.plugins.manager import plugin_manager

    client, csrf_token = auth_client
    filament, spool, printer = parameter_entities
    folder = tmp_path / printer.driver_key
    folder.mkdir()
    target_type = "filament_printer_param" if entity_type == "filaments" else "spool_printer_param"
    (folder / "plugin.json").write_text(json.dumps({"printer_params": {
        "target_types": [target_type], "fields": [{"key": "shared_temperature", "label": "Temperature"}],
    }}))
    monkeypatch.setattr(plugin_manager, "_plugin_search_dirs", lambda: [tmp_path])
    db_session.add_all([
        SystemExtraField(target_type=target_type, key="shared_temperature", label="Temperature", field_type="number", source="other-driver"),
        SystemExtraField(target_type=target_type, key="legacy", label="Legacy", field_type="text", source=printer.driver_key),
    ])
    await db_session.commit()
    entity_id = filament.id if entity_type == "filaments" else spool.id
    path = f"/api/v1/{entity_type}/{entity_id}/printer-params/{printer.id}"
    headers = {"X-CSRF-Token": csrf_token}
    response = await client.put(path, json={"params": [
        {"param_key": "shared_temperature", "param_value": "210"},
        {"param_key": "legacy", "param_value": "kept"},
    ]}, headers=headers)
    assert response.status_code == 200
    assert {row["param_key"]: row["param_value"] for row in response.json()} == {"shared_temperature": "210", "legacy": "kept"}
    invalid = await client.put(path, json={"params": [{"param_key": "unknown", "param_value": "1"}]}, headers=headers)
    assert invalid.status_code == 400


@pytest.mark.asyncio
async def test_parameter_reads_and_writes_require_authentication(client):
    for method, path, body in [
        ("GET", "/api/v1/filaments/1/printer-params", None),
        ("GET", "/api/v1/spools/1/printer-params", None),
        ("PUT", "/api/v1/spools/1/printer-params/1", {"params": []}),
        ("DELETE", "/api/v1/filaments/1/printer-params/1?param_key=temperature", None),
    ]:
        response = await client.request(method, path, **({"json": body} if body is not None else {}))
        assert response.status_code == 401

@pytest.mark.asyncio
async def test_driver_parameter_metadata_ignores_shared_registry_ownership(
    auth_client, db_session, monkeypatch, tmp_path
):
    import json

    from app.models.system_extra_field import SystemExtraField
    from app.plugins.manager import plugin_manager

    client, _ = auth_client
    folder = tmp_path / 'bambulab'
    folder.mkdir()
    (folder / 'plugin.json').write_text(json.dumps({
        'driver_config_schema': {'properties': {'secret': {'default': 'MUST-NOT-LEAK'}}},
        'printer_params': {
            'target_types': ['filament_printer_param', 'spool_printer_param'],
            'fields': [
                {'key': 'shared_temperature', 'label': 'Direct temperature', 'field_type': 'number', 'config': {'unit': '°C'}},
                {'key': 'spool_only', 'label': 'Spool link', 'target_type': 'spool_printer_param'},
            ],
        },
    }))
    monkeypatch.setattr(plugin_manager, '_plugin_search_dirs', lambda: [tmp_path])
    stored = SystemExtraField(target_type='filament_printer_param', key='shared_temperature', label='Registry owner label', field_type='number', source='bambuddy')
    direct = Printer(name='Disabled direct printer', driver_key='bambulab', is_active=False)
    db_session.add_all([stored, direct])
    await db_session.commit()
    response = await client.get(f'/api/v1/printers/{direct.id}/parameter-fields?target_type=filament_printer_param')
    assert response.status_code == 200
    assert response.json() == [{'key': 'shared_temperature', 'label': 'Direct temperature', 'field_type': 'number', 'options': None, 'config': {'unit': '°C'}}]
    assert 'MUST-NOT-LEAK' not in response.text
    spool = await client.get(f'/api/v1/printers/{direct.id}/parameter-fields?target_type=spool_printer_param')
    assert [field['key'] for field in spool.json()] == ['shared_temperature', 'spool_only']
    legacy = await client.get('/api/v1/system-extra-fields?target_type=filament_printer_param&source=bambuddy')
    assert [(field['key'], field['source']) for field in legacy.json()] == [('shared_temperature', 'bambuddy')]
    await db_session.refresh(stored)
    assert (stored.label, stored.source) == ('Registry owner label', 'bambuddy')


@pytest.mark.asyncio
async def test_parameter_metadata_missing_plugin_and_printer(auth_client, db_session):
    client, _ = auth_client
    printer = Printer(name='Missing plugin', driver_key='not-installed', is_active=False)
    db_session.add(printer)
    await db_session.commit()
    response = await client.get(f'/api/v1/printers/{printer.id}/parameter-fields?target_type=spool_printer_param')
    assert response.status_code == 200
    assert response.json() == []
    assert (await client.get('/api/v1/printers/999999/parameter-fields?target_type=spool_printer_param')).status_code == 404
    assert (await client.get(f'/api/v1/printers/{printer.id}/parameter-fields?target_type=filament')).status_code == 422


@pytest.mark.asyncio
async def test_parameter_metadata_requires_authentication(client):
    assert (await client.get('/api/v1/printers/1/parameter-fields?target_type=spool_printer_param')).status_code == 401
