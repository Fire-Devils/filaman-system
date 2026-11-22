"""Security changes must take effect on a second process with used credentials."""

import asyncio
import multiprocessing

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import hash_token
from app.models import Base, User, UserApiKey, UserSession


def _worker(database, account_id, connection):
    async def run():
        from app.api.deps import get_db
        from app.core import database as db_module
        from app.core import middleware
        from app.main import app

        engine = create_async_engine(database)
        make = async_sessionmaker(engine, expire_on_commit=False)
        db_module.async_session_maker = middleware.async_session_maker = make

        async def session():
            async with make() as db:
                yield db

        app.dependency_overrides[get_db] = session
        transport = httpx.ASGITransport(app=app)
        cookies = {"session_id": f"sess.{account_id}.session-secret", "csrf_token": "csrf-fixture"}
        async with httpx.AsyncClient(transport=transport, base_url="http://test", cookies=cookies) as browser, httpx.AsyncClient(
            transport=transport, base_url="http://test", headers={"Authorization": f"ApiKey uak.{account_id}.key-secret"},
        ) as key:
            async def statuses():
                return [(await client.get("/api/v1/admin/users")).status_code for client in (browser, key)]

            connection.send(await statuses())
            while True:
                command = await asyncio.to_thread(connection.recv)
                if command == "stop":
                    break
                if command == "read":
                    connection.send(await statuses())
                elif command == "disable":
                    response = await browser.patch("/api/v1/admin/users/1", json={"is_active": False}, headers={
                        "X-CSRF-Token": "csrf-fixture", "Cookie": "session_id=sess.2.session-secret; csrf_token=csrf-fixture",
                    })
                    connection.send(response.status_code)
                elif command == "revoke_key":
                    response = await browser.delete("/api/v1/me/api-keys/1", headers={"X-CSRF-Token": "csrf-fixture"})
                    connection.send(response.status_code)
                elif command == "revoke_session":
                    response = await browser.post("/auth/logout", headers={"X-CSRF-Token": "csrf-fixture"})
                    browser.cookies.set("session_id", f"sess.{account_id}.session-secret")
                    connection.send(response.status_code)
                elif command == "demote":
                    response = await browser.patch(f"/api/v1/admin/users/{account_id}", json={"is_superadmin": False}, headers={"X-CSRF-Token": "csrf-fixture"})
                    connection.send(response.status_code)
        await engine.dispose()

    asyncio.run(run())


@pytest.fixture
async def account_database(tmp_path):
    database = f"sqlite+aiosqlite:///{tmp_path}/accounts.db"
    engine = create_async_engine(database)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    make = async_sessionmaker(engine, expire_on_commit=False)
    async with make() as db:
        for number in (1, 2):
            user = User(id=number, email=f"root{number}@example.test", is_active=True, is_superadmin=True)
            db.add(user)
            await db.flush()
            db.add(UserSession(id=number, user_id=number, session_token_hash=hash_token("session-secret")))
            db.add(UserApiKey(id=number, user_id=number, name="fixture", key_hash=hash_token("key-secret")))
        await db.commit()
    yield database, make
    await engine.dispose()


def _start_workers(database, accounts):
    context = multiprocessing.get_context("spawn")
    workers = []
    for account in accounts:
        parent, child = context.Pipe()
        process = context.Process(target=_worker, args=(database, account, child))
        process.start()
        workers.append((process, parent))
    return workers


async def _receive(connection):
    assert await asyncio.to_thread(connection.poll, 10), "Auth worker did not respond"
    return await asyncio.to_thread(connection.recv)


async def _stop(workers):
    for process, connection in workers:
        if process.is_alive():
            connection.send("stop")
    for process, connection in workers:
        await asyncio.to_thread(process.join, 10)
        if process.is_alive():
            process.terminate()
            await asyncio.to_thread(process.join, 3)
        connection.close()
        assert process.exitcode == 0


@pytest.mark.parametrize("change, expected", [("disable", [401, 401]), ("revoke_key", [200, 401]), ("revoke_session", [401, 200])])
async def test_committed_security_change_reaches_already_used_credentials_on_both_workers(account_database, change, expected):
    database, _ = account_database
    workers = _start_workers(database, (1, 1))
    try:
        for _, connection in workers:
            assert await _receive(connection) == [200, 200]
        workers[0][1].send(change)
        assert await _receive(workers[0][1]) == (204 if change == "revoke_key" else 200)
        for _, connection in workers:
            connection.send("read")
        for _, connection in workers:
            assert await _receive(connection) == expected
    finally:
        await _stop(workers)


async def test_two_workers_cannot_demote_all_active_superadmins(account_database):
    database, make = account_database
    workers = _start_workers(database, (1, 2))
    try:
        for _, connection in workers:
            assert await _receive(connection) == [200, 200]
        for _, connection in workers:
            connection.send("demote")
        assert sorted([await _receive(connection) for _, connection in workers]) == [200, 400]
        async with make() as db:
            active = (await db.scalars(select(User.id).where(
                User.is_superadmin.is_(True), User.is_active.is_(True), User.deleted_at.is_(None),
            ))).all()
            assert len(active) == 1
    finally:
        await _stop(workers)
