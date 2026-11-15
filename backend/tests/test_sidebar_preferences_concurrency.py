import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1.me import (
    PreferencesUpdate,
    SidebarPreferencesUpdate,
    update_preferences,
    update_sidebar_preferences,
)
from app.core.security import Principal
from app.models import Base, User


@pytest.mark.asyncio
@pytest.mark.parametrize("second_write", ["dashboard", "conflict", "import"])
async def test_sidebar_writes_read_preferences_after_acquiring_lock(tmp_path, monkeypatch, second_write):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'preferences.db'}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.exec_driver_sql("PRAGMA journal_mode=WAL")
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as seed:
            user = User(email="preferences-race@example.com")
            seed.add(user)
            await seed.commit()
            user_id = user.id

        principal = Principal(auth_type="session", user_id=user_id)
        ready, release = asyncio.Event(), asyncio.Event()
        async with sessions() as first, sessions() as second:
            commit = first.commit

            async def delayed_commit():
                ready.set()
                await release.wait()
                await commit()

            monkeypatch.setattr(first, "commit", delayed_commit)
            first_task = asyncio.create_task(update_sidebar_preferences(
                SidebarPreferencesUpdate(sidebar={"compact": True}, expected_sidebar=None), principal, first,
            ))
            await asyncio.wait_for(ready.wait(), 5)
            if second_write == "dashboard":
                operation = update_preferences(
                    PreferencesUpdate(dashboard_hidden_widgets=["filamentStats"]), principal, second,
                )
            else:
                data = {"sidebar": {"compact": False}}
                data.update({"expected_sidebar": None} if second_write == "conflict" else {"import_legacy": True})
                operation = update_sidebar_preferences(SidebarPreferencesUpdate(**data), principal, second)
            second_task = asyncio.create_task(operation)
            try:
                # The other connection must wait until the first JSON update commits.
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(second_task), 0.1)
            finally:
                release.set()
                results = await asyncio.wait_for(
                    asyncio.gather(first_task, second_task, return_exceptions=True), 5,
                )
            assert not isinstance(results[0], Exception)
            if second_write == "conflict":
                assert isinstance(results[1], HTTPException)
                assert results[1].status_code == 409
            else:
                assert not isinstance(results[1], Exception)

        async with sessions() as check:
            saved = await check.get(User, user_id)
            assert saved.ui_preferences["sidebar_settings"]["sidebar"]["compact"] is True
            if second_write == "dashboard":
                assert saved.ui_preferences["dashboard_hidden_widgets"] == ["filamentStats"]
    finally:
        await engine.dispose()
