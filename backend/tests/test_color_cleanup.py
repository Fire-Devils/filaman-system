import pytest
from app.models import Color, Filament, FilamentColor, Manufacturer
from sqlalchemy import select


async def seed(db):
    colors = [Color(name=name, hex_code=hex_code, custom_fields=fields) for name, hex_code, fields in [
        ('A', '#abc', {'note': 'shared', 'nested': {'x': 1}}),
        ('B', '#AABBCCFF', {'note': 'shared', 'enabled': False}),
        ('C', '#AABBCC', {'nullable': None}),
        ('Transparent', '#AABBCC80', None),
    ]]
    db.add_all(colors)
    await db.commit()
    return colors


async def preview(client):
    response = await client.get('/api/v1/colors/cleanup')
    assert response.status_code == 200, response.text
    return response.json()


def reviewed(snapshot, ids):
    return [{'id': c['id'], 'token': c['token']} for c in snapshot['items'] if c['id'] in ids]


@pytest.mark.asyncio
async def test_groups_include_three_equivalent_opaque_colors_and_leave_alpha_separate(auth_client, db_session):
    client, _ = auth_client
    colors = await seed(db_session)
    data = await preview(client)
    assert data['groups'] == [[c.id for c in colors[:3]]]
    assert data['items'][0]['custom_fields']['nested'] == {'x': 1}
    assert all(item['token'] for item in data['items'])
    # Existing list contract remains unchanged.
    listed = (await client.get('/api/v1/colors')).json()
    assert 'token' not in listed['items'][0]


@pytest.mark.asyncio
async def test_merge_preserves_existing_metadata_and_all_assignment_positions(auth_client, db_session):
    client, csrf = auth_client
    a, b, c, _ = await seed(db_session)
    maker = Manufacturer(name='Maker')
    db_session.add(maker)
    await db_session.flush()
    filament = Filament(manufacturer_id=maker.id, designation='PLA', material_type='PLA', diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    links = [FilamentColor(filament_id=filament.id, color_id=color.id, position=i, display_name_override=f'part {i}') for i, color in enumerate([a, b, c])]
    db_session.add_all(links)
    await db_session.commit()
    original = [(link.id, link.position, link.display_name_override) for link in links]
    data = await preview(client)
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, [a.id, b.id, c.id]), 'survivor_id': b.id, 'name': 'Combined',
    })
    assert response.status_code == 200, response.text
    assert response.json()['changed'] == 2
    survivor_id = b.id
    db_session.expire_all()
    survivor = await db_session.get(Color, survivor_id)
    assert survivor.name == 'Combined'
    assert survivor.custom_fields == {'note': 'shared', 'nested': {'x': 1}, 'enabled': False, 'nullable': None}
    saved = (await db_session.execute(select(FilamentColor).order_by(FilamentColor.position))).scalars().all()
    assert [(x.id, x.position, x.display_name_override) for x in saved] == original
    assert all(x.color_id == survivor_id for x in saved)
    assert len((await preview(client))['items']) == 2
    listed = (await client.get('/api/v1/colors')).json()['items']
    assert next(color['usage_count'] for color in listed if color['id'] == survivor_id) == len(original)


@pytest.mark.asyncio
@pytest.mark.parametrize('endpoint', ['merge', 'combine'])
async def test_merge_rejects_conflicting_metadata_and_stale_data(auth_client, db_session, endpoint):
    client, csrf = auth_client
    colors = await seed(db_session)
    colors[1].custom_fields = {'note': 'different'}
    await db_session.commit()
    data = await preview(client)
    payload = {'records': reviewed(data, [c.id for c in colors[:3]]), 'survivor_id': colors[0].id,
               'hex_code': '#AABBCC', 'name': 'A'}
    response = await client.post(f'/api/v1/colors/{endpoint}', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 422
    colors[1].custom_fields = {'changed': 'since review'}
    await db_session.commit()
    response = await client.post(f'/api/v1/colors/{endpoint}', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 409
    assert len((await preview(client))['items']) == 4


@pytest.mark.asyncio
async def test_bulk_delete_is_atomic_when_one_color_gains_usage(auth_client, db_session):
    client, csrf = auth_client
    a, b, *_ = await seed(db_session)
    data = await preview(client)
    maker = Manufacturer(name='Maker')
    db_session.add(maker)
    await db_session.flush()
    filament = Filament(manufacturer_id=maker.id, designation='PLA', material_type='PLA', diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    db_session.add(FilamentColor(filament_id=filament.id, color_id=b.id, position=1))
    await db_session.commit()
    response = await client.post('/api/v1/colors/bulk-delete', headers={'X-CSRF-Token': csrf}, json={'records': reviewed(data, [a.id, b.id])})
    assert response.status_code == 409
    fresh = await preview(client)
    assert len(fresh['items']) == 4
    response = await client.post('/api/v1/colors/bulk-delete', headers={'X-CSRF-Token': csrf}, json={'records': reviewed(fresh, [a.id, b.id])})
    assert response.status_code == 409
    assert len((await preview(client))['items']) == 4


@pytest.mark.asyncio
async def test_bulk_delete_unused_and_no_duplicates_in_request(auth_client, db_session):
    client, csrf = auth_client
    colors = await seed(db_session)
    data = await preview(client)
    records = reviewed(data, [c.id for c in colors])
    response = await client.post('/api/v1/colors/bulk-delete', headers={'X-CSRF-Token': csrf}, json={'records': [records[0], records[0]]})
    assert response.status_code == 422
    response = await client.post('/api/v1/colors/bulk-delete', headers={'X-CSRF-Token': csrf}, json={'records': records})
    assert response.status_code == 200, response.text
    assert response.json()['changed'] == 4
    assert (await preview(client))['items'] == []


@pytest.mark.asyncio
async def test_cannot_merge_different_opacity_or_choose_unreviewed_survivor(auth_client, db_session):
    client, csrf = auth_client
    a, b, c, alpha = await seed(db_session)
    data = await preview(client)
    survivor_id = a.id
    for ids, survivor_id in [([a.id, alpha.id], a.id), ([a.id, b.id], c.id)]:
        response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json={
            'records': reviewed(data, ids), 'survivor_id': survivor_id, 'name': 'A',
        })
        assert response.status_code == 422, response.text
    assert len((await preview(client))['items']) == 4


@pytest.mark.asyncio
async def test_cleanup_requires_authentication(client):
    assert (await client.get('/api/v1/colors/cleanup')).status_code == 401
    assert (await client.post('/api/v1/colors/bulk-delete', json={'records': []})).status_code in (401, 403)


@pytest.mark.asyncio
@pytest.mark.parametrize('endpoint', ['merge', 'combine'])
async def test_read_only_user_cannot_merge_or_bulk_delete(auth_client, db_session, endpoint):
    from app.core.middleware import invalidate_auth_caches
    from app.core.security import generate_token_secret, hash_token
    from app.models import User, UserSession

    client, csrf = auth_client
    colors = await seed(db_session)
    data = await preview(client)
    user = User(email='color-reader@example.test', display_name='Reader', is_active=True, is_superadmin=False)
    db_session.add(user)
    await db_session.flush()
    secret = generate_token_secret()
    session = UserSession(user_id=user.id, session_token_hash=hash_token(secret))
    db_session.add(session)
    await db_session.commit()
    client.cookies.set('session_id', f'sess.{session.id}.{secret}')
    invalidate_auth_caches()
    assert (await client.get('/api/v1/colors/cleanup')).status_code == 200
    records = reviewed(data, [color.id for color in colors])
    headers = {'X-CSRF-Token': csrf}
    assert (await client.post('/api/v1/colors/bulk-delete', headers=headers, json={'records': records})).status_code == 403
    assert (await client.post(f'/api/v1/colors/{endpoint}', headers=headers, json={
        'records': records[:2], 'survivor_id': records[0]['id'], 'hex_code': '#AABBCC', 'name': 'Reader',
    })).status_code == 403


@pytest.mark.asyncio
async def test_review_rejects_recreated_identical_color_with_reused_id_and_timestamps(auth_client, db_session):
    client, csrf = auth_client
    color = Color(name='Same', hex_code='#ABCDEF', custom_fields={'same': True})
    db_session.add(color)
    await db_session.commit()
    data = await preview(client)
    original = {'id': color.id, 'name': color.name, 'hex_code': color.hex_code, 'custom_fields': color.custom_fields,
                'created_at': color.created_at, 'updated_at': color.updated_at}
    await db_session.delete(color)
    await db_session.commit()
    db_session.add(Color(**original))
    await db_session.commit()
    response = await client.post('/api/v1/colors/bulk-delete', headers={'X-CSRF-Token': csrf}, json={'records': reviewed(data, [original['id']])})
    assert response.status_code == 409, response.text
    assert len((await preview(client))['items']) == 1


def test_all_matching_selection_can_exceed_ten_thousand():
    from app.services.color_cleanup import CleanupRequest

    records = [{'id': i + 1, 'token': 'a' * 64} for i in range(10001)]
    assert len(CleanupRequest.model_validate({'records': records}).records) == 10001


@pytest.mark.asyncio
@pytest.mark.parametrize('endpoint', ['merge', 'combine'])
async def test_revalidation_uses_current_locking_reads_for_records_and_assignments(auth_client, db_session, monkeypatch, endpoint):
    from sqlalchemy.dialects import mysql
    from sqlalchemy.sql import Select

    client, csrf = auth_client
    a, b, *_ = await seed(db_session)
    data = await preview(client)
    statements = []
    execute = db_session.execute

    async def observe(statement, *args, **kwargs):
        if isinstance(statement, Select):
            statements.append(str(statement.compile(dialect=mysql.dialect())))
        return await execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, 'execute', observe)
    response = await client.post(f'/api/v1/colors/{endpoint}', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, [a.id, b.id]), 'survivor_id': b.id, 'hex_code': '#123456', 'name': 'Merged',
    })
    assert response.status_code == 200, response.text
    assert any('FROM colors' in sql and 'FOR UPDATE' in sql for sql in statements)
    assert any('FROM filament_colors' in sql and 'FOR UPDATE' in sql for sql in statements)


def test_color_identity_migration_preserves_rows_links_and_can_retry(monkeypatch):
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from alembic.script import ScriptDirectory

    config = Config(str(Path(__file__).parents[1] / 'alembic.ini'))
    migration = ScriptDirectory.from_config(config).get_revision('d9a7c241e6b0').module
    engine = sa.create_engine('sqlite://')
    with engine.begin() as connection:
        connection.exec_driver_sql('CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
        connection.exec_driver_sql("INSERT INTO colors VALUES (1, 'A'), (2, 'B')")
        connection.exec_driver_sql('CREATE TABLE filament_colors (id INTEGER PRIMARY KEY, color_id INTEGER REFERENCES colors(id), position INTEGER)')
        connection.exec_driver_sql('INSERT INTO filament_colors VALUES (1, 2, 3)')

    def fail():
        raise RuntimeError('Interrupted backfill')

    with engine.connect() as connection:
        with monkeypatch.context() as patch:
            patch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
            patch.setattr(migration, 'uuid4', fail)
            with pytest.raises(RuntimeError, match='Interrupted backfill'):
                migration.upgrade()
        connection.rollback()
        assert 'record_token' not in {column['name'] for column in sa.inspect(connection).get_columns('colors')}
    with engine.begin() as connection:
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        rows = connection.exec_driver_sql('SELECT id, name, record_token FROM colors ORDER BY id').all()
        assert [(row.id, row.name) for row in rows] == [(1, 'A'), (2, 'B')]
        assert len({row.record_token for row in rows}) == 2
        assert all(len(row.record_token) == 32 for row in rows)
        assert connection.exec_driver_sql('SELECT color_id, position FROM filament_colors').one() == (2, 3)
        assert not connection.exec_driver_sql('PRAGMA foreign_key_check').all()
    def reject_native_drop(connection, cursor, statement, parameters, context, executemany):
        if 'DROP COLUMN' in statement.upper():
            raise AssertionError('Older SQLite cannot execute native DROP COLUMN')

    sa.event.listen(engine, 'before_cursor_execute', reject_native_drop)
    with engine.begin() as connection:
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.downgrade()
        assert 'record_token' not in {column['name'] for column in sa.inspect(connection).get_columns('colors')}
        assert connection.exec_driver_sql('SELECT id, name FROM colors ORDER BY id').all() == [(1, 'A'), (2, 'B')]
        assert connection.exec_driver_sql('SELECT color_id, position FROM filament_colors').one() == (2, 3)
        assert not connection.exec_driver_sql('PRAGMA foreign_key_check').all()
        migration.upgrade()
        assert len(set(connection.exec_driver_sql('SELECT record_token FROM colors').scalars())) == 2
    engine.dispose()


@pytest.mark.parametrize(('nullable', 'tokens'), [
    (True, [None, None]),
    (True, ['a' * 32, None]),
    (False, ['a' * 32, 'b' * 32]),
])
def test_color_identity_migration_resumes_committed_partial_schema(monkeypatch, nullable, tokens):
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from alembic.script import ScriptDirectory

    migration = ScriptDirectory.from_config(Config(str(Path(__file__).parents[1] / 'alembic.ini'))).get_revision('d9a7c241e6b0').module
    engine = sa.create_engine('sqlite://')
    # Model the durable state left by MySQL's implicit DDL commits.
    with engine.begin() as connection:
        connection.exec_driver_sql('CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, record_token VARCHAR(32)' + ('' if nullable else ' NOT NULL') + ')')
        connection.exec_driver_sql('INSERT INTO colors VALUES (1, ?, ?), (2, ?, ?)', ('A', tokens[0], 'B', tokens[1]))
        connection.exec_driver_sql('CREATE TABLE filament_colors (id INTEGER PRIMARY KEY, color_id INTEGER REFERENCES colors(id), position INTEGER)')
        connection.exec_driver_sql('INSERT INTO filament_colors VALUES (1, 2, 3)')
    for _ in range(2):
        with engine.begin() as connection:
            monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            saved = connection.exec_driver_sql('SELECT record_token FROM colors ORDER BY id').scalars().all()
            assert all(token and len(token) == 32 for token in saved)
            assert len(set(saved)) == 2
            assert all(old is None or old == new for old, new in zip(tokens, saved))
            tokens = saved
            assert not next(column for column in sa.inspect(connection).get_columns('colors') if column['name'] == 'record_token')['nullable']
            assert connection.exec_driver_sql('SELECT color_id, position FROM filament_colors').one() == (2, 3)
            assert not connection.exec_driver_sql('PRAGMA foreign_key_check').all()
    engine.dispose()


def test_internal_identity_stays_out_of_color_backup_and_crud_contracts():
    from app.api.v1.schemas_filament import ColorResponse
    from app.api.v1.system import _serialize_row

    color = Color(id=1, name='A', hex_code='#ABCDEF', record_token='a' * 32)
    assert 'record_token' not in _serialize_row(color)
    assert 'record_token' not in ColorResponse.model_validate(color).model_dump()


@pytest.mark.asyncio
@pytest.mark.parametrize(('first', 'second'), [(False, 0), ({'value': False}, {'value': 0}), (None, '')])
async def test_merge_does_not_silently_replace_different_stored_types(auth_client, db_session, first, second):
    client, csrf = auth_client
    a = Color(name='First', hex_code='#123456', custom_fields={'key': first})
    b = Color(name='Second', hex_code='#123456', custom_fields={'key': second})
    db_session.add_all([a, b])
    await db_session.commit()
    data = await preview(client)
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, [a.id, b.id]), 'survivor_id': a.id, 'name': 'Combined',
    })
    assert response.status_code == 422, response.text
    assert response.json()['detail']['code'] == 'color_metadata_conflict'
    assert len((await preview(client))['items']) == 2


@pytest.mark.asyncio
async def test_name_collision_is_specific_and_including_that_color_resolves_it(auth_client, db_session):
    client, csrf = auth_client
    colors = [Color(name=name, hex_code='#123456') for name in ['First', 'Second', 'Existing']]
    db_session.add_all(colors)
    await db_session.commit()
    ids = [color.id for color in colors]
    data = await preview(client)
    payload = {'records': reviewed(data, ids[:2]), 'survivor_id': ids[1], 'name': ' Existing '}
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 409, response.text
    assert response.json()['detail']['code'] == 'color_name_collision'
    unchanged = await preview(client)
    assert [(color['id'], color['name']) for color in unchanged['items']] == list(zip(ids, ['First', 'Second', 'Existing']))
    payload['records'] = reviewed(unchanged, ids)
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 200, response.text
    assert [(color['id'], color['name']) for color in (await preview(client))['items']] == [(ids[1], 'Existing')]


@pytest.mark.asyncio
async def test_merge_updates_only_affected_filament_timestamps(auth_client, db_session):
    client, csrf = auth_client
    a, b, _, transparent = await seed(db_session)
    maker = Manufacturer(name='Timestamp maker')
    db_session.add(maker)
    await db_session.flush()
    filaments = [Filament(manufacturer_id=maker.id, designation=f'PLA {i}', material_type='PLA', diameter_mm=1.75) for i in range(3)]
    db_session.add_all(filaments)
    await db_session.flush()
    db_session.add_all([FilamentColor(filament_id=filament.id, color_id=color.id, position=1) for filament, color in zip(filaments, [a, b, transparent])])
    await db_session.commit()
    ids = [filament.id for filament in filaments]
    before = [filament.updated_at for filament in filaments]
    data = await preview(client)
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, [a.id, b.id]), 'survivor_id': b.id, 'name': 'Combined',
    })
    assert response.status_code == 200, response.text
    db_session.expire_all()
    saved = [(await db_session.get(Filament, id)).updated_at for id in ids]
    assert saved[0] > before[0] and saved[1] > before[1]
    assert saved[0].microsecond or saved[1].microsecond
    assert saved[2] == before[2]


@pytest.mark.asyncio
@pytest.mark.parametrize('error_type', ['operational', 'integrity'])
async def test_database_errors_roll_back_without_becoming_stale_review_conflicts(db_session, monkeypatch, error_type):
    from unittest.mock import AsyncMock

    from app.services.color_cleanup import ReviewedColor, reviewed_transaction, snapshot
    from sqlalchemy.exc import IntegrityError, OperationalError

    colors = await seed(db_session)
    data = await snapshot(db_session, [colors[0].id])
    error = (OperationalError if error_type == 'operational' else IntegrityError)('statement', {}, RuntimeError('Database failure'))
    monkeypatch.setattr(db_session, 'commit', AsyncMock(side_effect=error))
    rollback = AsyncMock(wraps=db_session.rollback)
    monkeypatch.setattr(db_session, 'rollback', rollback)
    with pytest.raises(type(error)) as caught:
        async with reviewed_transaction(db_session, [ReviewedColor(id=data.items[0].id, token=data.items[0].token)]):
            pass
    assert caught.value is error
    rollback.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('endpoint', ['merge', 'combine'])
async def test_late_name_collision_reports_specific_error_and_rolls_back_assignments(auth_client, db_session, monkeypatch, endpoint):
    from sqlalchemy import insert
    from sqlalchemy.sql.dml import Update

    client, csrf = auth_client
    a, b = [Color(name=name, hex_code='#123456') for name in ['First', 'Second']]
    maker = Manufacturer(name='Late collision maker')
    db_session.add_all([a, b, maker])
    await db_session.flush()
    filament = Filament(manufacturer_id=maker.id, designation='PLA', material_type='PLA', diameter_mm=1.75)
    db_session.add(filament)
    await db_session.flush()
    link = FilamentColor(filament_id=filament.id, color_id=a.id, position=3, display_name_override='Keep this stop')
    db_session.add(link)
    await db_session.commit()
    a_id, b_id, link_id, filament_id, before = a.id, b.id, link.id, filament.id, filament.updated_at
    data = await preview(client)
    execute = db_session.execute

    async def insert_after_preflight(statement, *args, **kwargs):
        if isinstance(statement, Update) and statement.table.name == 'colors' and statement.compile().params.get('name') == 'Late collision':
            await execute(insert(Color).values(name='Late collision', hex_code='#123456'))
        return await execute(statement, *args, **kwargs)

    monkeypatch.setattr(db_session, 'execute', insert_after_preflight)
    response = await client.post(f'/api/v1/colors/{endpoint}', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, [a_id, b_id]), 'survivor_id': b_id, 'hex_code': '#123456', 'name': 'Late collision',
    })
    assert response.status_code == 409, response.text
    assert response.json()['detail']['code'] == 'color_name_collision'
    assert len((await preview(client))['items']) == 2
    db_session.expire_all()
    saved = await db_session.get(FilamentColor, link_id)
    assert (saved.color_id, saved.position, saved.display_name_override) == (a_id, 3, 'Keep this stop')
    assert (await db_session.get(Filament, filament_id)).updated_at == before


@pytest.mark.parametrize(('message', 'attributes', 'collision'), [
    ('duplicate key value violates unique constraint "uq_colors_name_hex"', {'sqlstate': '23505'}, True),
    ('duplicate key value violates unique constraint "another_key"', {'sqlstate': '23505'}, False),
    ('foreign key violation: uq_colors_name_hex', {'sqlstate': '23503'}, False),
    ((1062, "Duplicate entry 'name-hex' for key 'colors.uq_colors_name_hex'"), {}, True),
    ((1062, "Duplicate entry 'uq_colors_name_hex' for key 'another_key'"), {}, False),
    ((1213, 'Deadlock'), {}, False),
    ('UNIQUE constraint failed: colors.id', {}, False),
])
def test_name_collision_classification_does_not_mask_other_database_errors(message, attributes, collision):
    from app.services.color_cleanup import _is_name_collision
    from sqlalchemy.exc import IntegrityError

    error = Exception(*(message if isinstance(message, tuple) else (message,)))
    for key, value in attributes.items():
        setattr(error, key, value)
    assert _is_name_collision(IntegrityError('statement', {}, error)) is collision


@pytest.mark.asyncio
@pytest.mark.parametrize('combine', [False, True])
async def test_cancelled_merge_publishes_all_committed_changes(db_session, tmp_path, monkeypatch, combine):
    import asyncio
    import json

    from app.core import primary_socket
    from app.core.event_bus import event_bus
    from app.services.color_cleanup import (
        CombineRequest,
        MergeRequest,
        combine_colors,
        merge_colors,
        snapshot,
    )

    a, b, *_ = await seed(db_session)
    data = (await snapshot(db_session)).model_dump()
    monkeypatch.setattr(primary_socket, '_runtime_dir', tmp_path / 'private')
    async with event_bus.run(), event_bus.subscribe() as notices:
        request_model, operation = (CombineRequest, combine_colors) if combine else (MergeRequest, merge_colors)
        request = asyncio.create_task(operation(request_model(
            hex_code='#ABCDEF80', records=reviewed(data, [a.id, b.id]), survivor_id=b.id, name='Committed merge',
        ), db_session))
        try:
            assert json.loads(await asyncio.wait_for(anext(notices), 5))['event'] == 'colors_changed'
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert json.loads(await asyncio.wait_for(anext(notices), 1))['event'] == 'filaments_changed'
            assert await db_session.scalar(select(Color.name).where(Color.id == b.id)) == 'Committed merge'
        finally:
            if not request.done():
                request.cancel()
            await asyncio.gather(request, return_exceptions=True)


@pytest.mark.asyncio
async def test_combine_different_hex_preserves_stops_and_survivor_references(auth_client, db_session):
    client, csrf = auth_client
    colors = [Color(name=name, hex_code=value) for name, value in [
        ('Red', '#FF0000'), ('Blue', '#0000FF'), ('Alpha', '#11223380'), ('Unrelated', '#FFFFFF'),
    ]]
    maker = Manufacturer(name='Combine maker')
    db_session.add_all([*colors, maker])
    await db_session.flush()
    filaments = [Filament(manufacturer_id=maker.id, designation=f'Combine {i}', material_type='PLA', diameter_mm=1.75) for i in range(3)]
    db_session.add_all(filaments)
    await db_session.flush()
    links = [FilamentColor(filament_id=filaments[0].id, color_id=color.id, position=i, display_name_override=f'stop {i}') for i, color in enumerate([colors[0], colors[1], colors[0], colors[2]])]
    links += [FilamentColor(filament_id=filaments[i].id, color_id=colors[j].id, position=0) for i, j in [(1, 1), (2, 3)]]
    db_session.add_all(links)
    await db_session.commit()
    ids, filament_ids = [c.id for c in colors], [f.id for f in filaments]
    original = [(x.id, x.filament_id, x.position, x.display_name_override) for x in links]
    before = [f.updated_at for f in filaments]
    response = await client.post('/api/v1/colors/combine', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(await preview(client), ids[:3]), 'survivor_id': ids[1], 'name': ' Combined ', 'hex_code': ' abcdef80 ',
    })
    assert response.status_code == 200, response.text
    assert response.json() == {'changed': 2}
    db_session.expire_all()
    result = await db_session.get(Color, ids[1])
    assert (result.name, result.hex_code) == ('Combined', '#ABCDEF80')
    saved = (await db_session.scalars(select(FilamentColor).order_by(FilamentColor.id))).all()
    assert [(x.id, x.filament_id, x.position, x.display_name_override) for x in saved] == original
    assert [x.color_id for x in saved] == [ids[1]] * 5 + [ids[3]]
    timestamps = [(await db_session.get(Filament, fid)).updated_at for fid in filament_ids]
    assert timestamps[0] > before[0] and timestamps[1] > before[1] and timestamps[2] == before[2]
    assert [c['id'] for c in (await preview(client))['items']] == [ids[1], ids[3]]


@pytest.mark.asyncio
async def test_duplicate_merge_ignores_extra_hex_and_keeps_legacy_contract(auth_client, db_session):
    client, csrf = auth_client
    a, b, *_ = await seed(db_session)
    response = await client.post('/api/v1/colors/merge', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(await preview(client), [a.id, b.id]), 'survivor_id': b.id, 'name': 'Legacy', 'hex_code': 'invalid',
    })
    assert response.status_code == 200, response.text
    assert next(c for c in (await preview(client))['items'] if c['id'] == b.id)['hex_code'] == '#AABBCCFF'


@pytest.mark.asyncio
@pytest.mark.parametrize('change', [
    {'hex_code': None}, {'hex_code': 'bad hex'}, {'hex_code': ''}, {'name': ' '}, {'name': 'x' * 101},
    {'survivor_id': 999999}, {'records': []}, {'omit_hex': True}, {'one': True}, {'duplicate': True},
])
async def test_combine_validates_result_without_changes(auth_client, db_session, change):
    client, csrf = auth_client
    colors = await seed(db_session)
    before = await preview(client)
    records = reviewed(before, [colors[0].id, colors[3].id])
    payload = {'records': records, 'survivor_id': colors[0].id, 'name': 'Result', 'hex_code': '#abc8', **change}
    if change.get('omit_hex'):
        del payload['hex_code']
    if change.get('one'):
        payload['records'] = records[:1]
    if change.get('duplicate'):
        payload['records'] = [records[0], records[0]]
    response = await client.post('/api/v1/colors/combine', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 422, response.text
    assert await preview(client) == before


@pytest.mark.asyncio
async def test_combine_checks_final_hex_collision_and_normalizes_shorthand(auth_client, db_session):
    client, csrf = auth_client
    a, b, c, _ = await seed(db_session)
    c.name, c.hex_code = 'Result', '#AABBCC88'
    await db_session.commit()
    before = await preview(client)
    payload = {'records': reviewed(before, [a.id, b.id]), 'survivor_id': b.id, 'name': 'Result', 'hex_code': '#abc8'}
    response = await client.post('/api/v1/colors/combine', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 409, response.text
    assert response.json()['detail']['code'] == 'color_name_collision'
    assert await preview(client) == before
    payload['name'] = 'New result'
    response = await client.post('/api/v1/colors/combine', headers={'X-CSRF-Token': csrf}, json=payload)
    assert response.status_code == 200, response.text
    assert next(c for c in (await preview(client))['items'] if c['id'] == b.id)['hex_code'] == '#AABBCC88'


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['delete', 'edit', 'assignment'])
async def test_combine_rejects_changed_sources_atomically(auth_client, db_session, change):
    client, csrf = auth_client
    a, _, _, b = await seed(db_session)
    data = await preview(client)
    ids = [a.id, b.id]
    if change == 'delete':
        await db_session.delete(b)
    elif change == 'edit':
        b.hex_code = '#123456'
    else:
        maker = Manufacturer(name='Changed assignment maker')
        db_session.add(maker)
        await db_session.flush()
        filament = Filament(manufacturer_id=maker.id, designation='Changed', material_type='PLA', diameter_mm=1.75)
        db_session.add(filament)
        await db_session.flush()
        db_session.add(FilamentColor(filament_id=filament.id, color_id=b.id, position=1))
    await db_session.commit()
    changed = await preview(client)
    response = await client.post('/api/v1/colors/combine', headers={'X-CSRF-Token': csrf}, json={
        'records': reviewed(data, ids), 'survivor_id': ids[0], 'name': 'Combined', 'hex_code': '#ABCDEF',
    })
    assert response.status_code == 409, response.text
    assert await preview(client) == changed
