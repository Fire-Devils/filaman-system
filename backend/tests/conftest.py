import asyncio

import pytest
import pytest_asyncio
from app.core.security import generate_token_secret, hash_password, hash_token
from app.core.seeds import run_all_seeds
from app.main import app
from app.models import Base
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="function")
async def db_engine():
    engine = create_async_engine(
        TEST_DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def db_session(db_engine):
    async_session = async_sessionmaker(db_engine, expire_on_commit=False)

    async with async_session() as session:
        await run_all_seeds(session)
        yield session


@pytest_asyncio.fixture(scope="function")
async def client(db_session, db_engine):
    from httpx import ASGITransport

    async def override_db():
        yield db_session

    from app.api.deps import get_db

    app.dependency_overrides[get_db] = override_db

    # Patch the global async_session_maker so the AuthMiddleware
    # (which creates its own DB sessions) uses the same test session.
    # SQLite in-memory + StaticPool shares one connection, but concurrent
    # sessions on that connection can deadlock or miss uncommitted data.
    # By returning the same session, the middleware sees test fixture data.
    import app.core.database as db_module
    import app.core.middleware as mw_module

    original_db_session_maker = db_module.async_session_maker
    original_mw_session_maker = mw_module.async_session_maker

    class _FakeSessionContext:
        """Context manager that returns the existing test session without closing it."""

        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *args):
            pass  # Don't close the shared test session

    def _fake_session_maker():
        return _FakeSessionContext()

    db_module.async_session_maker = _fake_session_maker
    mw_module.async_session_maker = _fake_session_maker

    # Clear auth caches so stale entries from prior tests don't interfere
    from app.core.middleware import invalidate_auth_caches

    invalidate_auth_caches()
    # Clear API response caches as well
    from app.core.cache import response_cache

    response_cache.clear()

    # Note: Rate limiting is now handled by nginx, not slowapi

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    db_module.async_session_maker = original_db_session_maker
    mw_module.async_session_maker = original_mw_session_maker
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def admin_user(db_session):
    from app.models import User

    result = await db_session.execute(
        select(User).where(User.email == "test-admin@example.com")
    )
    user = result.scalar_one_or_none()

    if not user:
        user = User(
            email="test-admin@example.com",
            password_hash=hash_password("testpassword"),
            display_name="Test Admin",
            is_superadmin=True,
            is_active=True,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)

    return user


@pytest_asyncio.fixture
async def normal_user(db_session):
    from app.models import Role, User, UserRole

    user = User(
        email="test-user@example.com",
        password_hash=hash_password("testpassword"),
        display_name="Test User",
        is_superadmin=False,
        is_active=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    result = await db_session.execute(select(Role).where(Role.key == "user"))
    user_role = result.scalar_one_or_none()

    if user_role:
        user_role_assoc = UserRole(user_id=user.id, role_id=user_role.id)
        db_session.add(user_role_assoc)
        await db_session.commit()

    return user


@pytest_asyncio.fixture
async def auth_client(client, admin_user, db_session):
    from app.models import UserSession

    secret = generate_token_secret()
    session = UserSession(
        user_id=admin_user.id,
        session_token_hash=hash_token(secret),
    )
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)

    session_token = f"sess.{session.id}.{secret}"
    csrf_token = generate_token_secret()

    client.cookies.set("session_id", session_token)
    client.cookies.set("csrf_token", csrf_token)

    return client, csrf_token


@pytest.fixture
def browser_executable():
    import os
    import shutil
    from pathlib import Path

    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

    executable = os.environ.get("LABEL_RENDER_CHROMIUM_EXECUTABLE") or shutil.which("chromium-headless-shell") or shutil.which("chromium")
    if not executable and chrome.is_file():
        executable = str(chrome)
    if not executable:
        pytest.skip("Chromium is required for the browser renderer integration test")
    return executable


@pytest.fixture
def label_render_runtime(browser_executable, monkeypatch):
    from pathlib import Path

    from app.core.config import settings as app_settings

    frontend = Path(__file__).resolve().parents[2] / "frontend/dist"
    if not (frontend / "label-render/index.html").is_file():
        frontend /= "client"
    if not (frontend / "label-render/index.html").is_file():
        pytest.skip("Build the frontend for label rendering integration tests")
    monkeypatch.setenv("LABEL_RENDER_STATIC_DIR", str(frontend))
    if browser_executable:
        monkeypatch.setenv("LABEL_RENDER_CHROMIUM_EXECUTABLE", browser_executable)
    monkeypatch.setattr(app_settings, "label_renderer", "chromium")
