"""Backups must include committed WAL pages while other connections stay open."""

import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine

from app.api.v1 import system
from app.core.config import PROJECT_ROOT
from app.models import Base


def create_filaman_schema(path):
    engine = create_engine(f'sqlite:///{path}')
    try:
        Base.metadata.create_all(engine)
    finally:
        engine.dispose()


def run_backup(url, backup_dir, *, cwd=None, **options):
    return subprocess.run(
        ['bash', str(Path(__file__).parents[1] / 'backup_db.sh')],
        check=False, cwd=cwd,
        env={
            **os.environ, 'DATABASE_URL': url, 'BACKUP_DIR': str(backup_dir),
            'PATH': str(Path(sys.executable).parent) + os.pathsep + os.environ['PATH'],
            **options,
        },
        capture_output=True, text=True,
    )


def wal_database(path):
    create_filaman_schema(path)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA wal_autocheckpoint=0')
    db.execute('CREATE TABLE audit_rows (id INTEGER PRIMARY KEY)')
    db.execute('INSERT INTO audit_rows VALUES(1)')
    db.commit()
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.execute('INSERT INTO audit_rows VALUES(2)')
    db.commit()
    return db


def count_rows(path):
    with sqlite3.connect(path) as db:
        return db.execute('SELECT count(*) FROM audit_rows').fetchone()[0]


def test_scheduled_backup_includes_committed_wal(tmp_path):
    live = tmp_path / 'live.db'
    backup_dir = tmp_path / 'backups'
    db = wal_database(live)
    try:
        completed = run_backup(f'sqlite+aiosqlite:///{live}', backup_dir)
        completed.check_returncode()
        assert 'Backup created:' in completed.stdout
        assert count_rows(live) == count_rows(next(backup_dir.glob('*.db'))) == 2
    finally:
        db.close()


def test_scheduled_backup_rejects_invalid_sqlite(tmp_path):
    source = tmp_path / 'invalid.db'
    source.write_bytes(b'not a SQLite database')
    backup_dir = tmp_path / 'backups'
    result = run_backup(f'sqlite+aiosqlite:///{source}', backup_dir)
    assert result.returncode != 0
    assert not list(backup_dir.glob('*.db'))


async def test_online_restore_snapshots_wal_and_preserves_other_connections(auth_client, tmp_path, monkeypatch):
    from app.core import database

    live = tmp_path / 'live.db'
    backups = tmp_path / 'backups'
    backups.mkdir()
    backup = backups / 'selected.db'
    active = wal_database(live)
    create_filaman_schema(backup)
    with sqlite3.connect(backup) as original:
        original.execute('CREATE TABLE audit_rows (id INTEGER PRIMARY KEY)')
        original.executemany('INSERT INTO audit_rows VALUES(?)', [(i,) for i in range(10)])
    monkeypatch.setattr(system, '_get_db_path', lambda: live)
    monkeypatch.setattr(system, '_get_backup_dir', lambda: backups)
    monkeypatch.setattr(database, 'engine', SimpleNamespace(dispose=AsyncMock()))
    client, csrf = auth_client
    try:
        response = await client.post(
            '/api/v1/admin/system/backup/sqlite-restore', json={'filename': 'selected.db'},
            headers={'X-CSRF-Token': csrf},
        )
        assert response.status_code == 200, response.text
        assert count_rows(backups / response.json()['auto_backup']) == 2
        assert count_rows(live) == 10
        assert active.execute('SELECT count(*) FROM audit_rows').fetchone()[0] == 10
    finally:
        active.close()


def test_failed_snapshot_keeps_previous_backup(tmp_path, monkeypatch):
    from app.services import sqlite_backup

    source = tmp_path / 'large.db'
    destination = tmp_path / 'previous.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE payload (value BLOB)')
        db.execute('INSERT INTO payload VALUES(zeroblob(2097152))')
    with sqlite3.connect(destination) as db:
        db.execute('CREATE TABLE retained (id INTEGER)')
        db.execute('INSERT INTO retained VALUES(7)')
    ticks = iter([0, 121])
    monkeypatch.setattr(sqlite_backup.time, 'monotonic', lambda: next(ticks))
    with pytest.raises(TimeoutError):
        sqlite_backup.write_sqlite_snapshot(source, destination)
    with sqlite3.connect(destination) as db:
        assert db.execute('SELECT id FROM retained').fetchall() == [(7,)]
    assert sorted(path.name for path in tmp_path.iterdir()) == ['large.db', 'previous.db']


def test_restore_timeout_keeps_live_database(tmp_path, monkeypatch):
    from app.services import sqlite_backup

    source = tmp_path / 'large.db'
    live = tmp_path / 'live.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE payload (value BLOB)')
        db.execute('INSERT INTO payload VALUES(zeroblob(2097152))')
    with sqlite3.connect(live) as db:
        db.execute('CREATE TABLE retained (id INTEGER)')
        db.execute('INSERT INTO retained VALUES(7)')
    ticks = iter([0, 121])
    monkeypatch.setattr(sqlite_backup.time, 'monotonic', lambda: next(ticks))
    with pytest.raises(TimeoutError):
        sqlite_backup.copy_sqlite_database(source, live)
    with sqlite3.connect(live) as db:
        assert db.execute('SELECT id FROM retained').fetchall() == [(7,)]


def test_snapshot_rejects_same_source_and_destination(tmp_path):
    from app.services.sqlite_backup import copy_sqlite_database

    path = tmp_path / 'live.db'
    with pytest.raises(ValueError, match='must differ'):
        copy_sqlite_database(path, path)


async def test_cancelled_restore_finishes_cache_cleanup(db_session, tmp_path, monkeypatch):
    import asyncio
    import threading

    from app.core import database
    from app.core.cache import response_cache

    live = tmp_path / 'live.db'
    backups = tmp_path / 'backups'
    backups.mkdir()
    selected = backups / 'selected.db'
    create_filaman_schema(live)
    create_filaman_schema(selected)
    with sqlite3.connect(live) as db:
        db.execute('CREATE TABLE retained (id INTEGER)')
    with sqlite3.connect(selected) as db:
        db.execute('CREATE TABLE restored (id INTEGER)')
    copied, release = threading.Event(), threading.Event()
    original = system.copy_sqlite_database

    def delayed_copy(source, destination):
        original(source, destination)
        copied.set()
        assert release.wait(5)

    monkeypatch.setattr(system, 'copy_sqlite_database', delayed_copy)
    monkeypatch.setattr(system, '_get_db_path', lambda: live)
    monkeypatch.setattr(system, '_get_backup_dir', lambda: backups)
    monkeypatch.setattr(database, 'engine', SimpleNamespace(dispose=AsyncMock()))
    response_cache.set('restore-cleanup-fixture', 'stale')
    request = asyncio.create_task(system.restore_sqlite_backup(
        system.SqliteRestoreRequest(filename='selected.db'), db_session,
        SimpleNamespace(is_superadmin=True, user_id=1),
    ))
    try:
        assert await asyncio.to_thread(copied.wait, 3)
        request.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert response_cache.get('restore-cleanup-fixture') is None
        with sqlite3.connect(live) as db:
            assert db.execute("SELECT name FROM sqlite_master WHERE name='restored'").fetchone()
    finally:
        release.set()
        await asyncio.gather(request, return_exceptions=True)
        response_cache.clear()


@pytest.mark.parametrize('explicit_dot', [False, True])
def test_scheduled_backup_uses_configured_relative_path_from_cron_home(tmp_path, explicit_dot):
    live = tmp_path / 'stock.db'
    backup_dir = tmp_path / 'backups'
    cron_home = tmp_path / 'home'
    cron_home.mkdir()
    backend = Path(__file__).parents[1]
    with closing(wal_database(live)):
        relative = './' + os.path.relpath(live, PROJECT_ROOT) if explicit_dot else os.path.relpath(live, backend)
        url = f'sqlite+aiosqlite:///{relative}?timeout=15'
        result = run_backup(url, os.path.relpath(backup_dir, backend), cwd=cron_home)
        result.check_returncode()
        assert [count_rows(path) for path in backup_dir.glob('*.db')] == [2]


@pytest.mark.parametrize('selected_kind', ['zero-bytes', 'unrelated', 'damaged'])
async def test_invalid_restore_keeps_database_and_creates_no_recovery(
    auth_client, tmp_path, monkeypatch, selected_kind
):
    live = tmp_path / 'live.db'
    backups = tmp_path / 'backups'
    backups.mkdir()
    selected = backups / 'selected.db'
    selected.touch()
    if selected_kind == 'damaged':
        selected.write_bytes(b'not a SQLite database')
    elif selected_kind == 'unrelated':
        with sqlite3.connect(selected) as db:
            db.execute('CREATE TABLE customers (id INTEGER)')
    active = wal_database(live)
    monkeypatch.setattr(system, '_get_db_path', lambda: live)
    monkeypatch.setattr(system, '_get_backup_dir', lambda: backups)
    client, csrf = auth_client
    try:
        response = await client.post(
            '/api/v1/admin/system/backup/sqlite-restore', json={'filename': selected.name},
            headers={'X-CSRF-Token': csrf},
        )
        assert response.status_code == 422, response.text
        assert count_rows(live) == 2
        assert list(backups.iterdir()) == [selected]
    finally:
        active.close()


async def test_repeated_restore_preserves_selected_recovery_file(db_session, tmp_path, monkeypatch):
    from app.core import database

    class FrozenTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2025, 1, 1, tzinfo=tz)

    live = tmp_path / 'live.db'
    backups = tmp_path / 'backups'
    backups.mkdir()
    selected = backups / 'original.db'
    for path in (live, selected):
        wal_database(path).close()
    with sqlite3.connect(selected) as db:
        db.execute('INSERT INTO audit_rows VALUES(3)')

    from app.services import sqlite_backup

    monkeypatch.setattr(sqlite_backup, 'datetime', FrozenTime)
    monkeypatch.setattr(system, '_get_db_path', lambda: live)
    monkeypatch.setattr(system, '_get_backup_dir', lambda: backups)
    monkeypatch.setattr(database, 'engine', SimpleNamespace(dispose=AsyncMock()))
    principal = SimpleNamespace(is_superadmin=True, user_id=1)
    result = await system.restore_sqlite_backup(
        system.SqliteRestoreRequest(filename=selected.name), db_session, principal,
    )
    previous = backups / result.auto_backup
    assert count_rows(previous) == 2
    assert count_rows(live) == 3
    again = await system.restore_sqlite_backup(
        system.SqliteRestoreRequest(filename=previous.name), db_session, principal,
    )
    assert again.auto_backup != previous.name
    assert count_rows(previous) == count_rows(live) == 2
    assert count_rows(backups / again.auto_backup) == 3


@pytest.mark.parametrize('url', [
    'sqlite+aiosqlite://', 'sqlite:///:memory:', 'sqlite:///file::memory:?uri=true',
    'sqlite:///file:in-memory?mode=memory&cache=shared&uri=true', 'postgresql://db/stock',
])
def test_native_paths_skip_non_file_databases(url):
    from app.services.sqlite_backup import sqlite_database_path

    assert sqlite_database_path(url) is None


def test_scheduled_retention_preserves_live_database_and_recovery_files(tmp_path):
    live = tmp_path / 'filaman_live.db'
    recovery = tmp_path / 'auto_before_restore_old.db'
    recovery.touch()
    with closing(wal_database(live)):
        for _ in range(2):
            result = run_backup(f'sqlite+aiosqlite:///{live}', tmp_path, MAX_BACKUPS='1')
            result.check_returncode()
        snapshots = set(tmp_path.glob('filaman_*.db')) - {live}
        assert len(snapshots) == 1
        assert count_rows(snapshots.pop()) == count_rows(live) == 2
        assert recovery.exists()


def test_scheduled_backup_skips_empty_database(tmp_path):
    live = tmp_path / 'new.db'
    live.touch()
    backups = tmp_path / 'backups'
    result = run_backup(f'sqlite+aiosqlite:///{live}', backups)
    result.check_returncode()
    assert not backups.exists()
    assert not live.read_bytes()


def test_sqlite_file_uri_uses_same_path_as_the_application(tmp_path):
    from app.services.sqlite_backup import sqlite_database_path

    live = tmp_path / 'stock #1.db'
    url = f'sqlite:///{live.as_uri()}?uri=true&mode=rwc&timeout=5'
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql('CREATE TABLE marker (id INTEGER)')
        assert sqlite_database_path(url) == live
        assert live.is_file()
    finally:
        engine.dispose()


def test_copy_from_zero_bytes_preserves_existing_database(tmp_path):
    from app.services.sqlite_backup import copy_sqlite_database

    source = tmp_path / 'empty.db'
    source.touch()
    live = tmp_path / 'stock.db'
    with closing(wal_database(live)):
        with pytest.raises(ValueError, match='empty'):
            copy_sqlite_database(source, live)
        assert count_rows(live) == 2
