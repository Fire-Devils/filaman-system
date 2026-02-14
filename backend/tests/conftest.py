import asyncio
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base
from app.core.seeds import run_all_seeds
from app.main import app
from app.core.security import hash_password, generate_token_secret


TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="function")
async def db_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    
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
    
    from app.api.deps import DBSession
    app.dependency_overrides[DBSession] = override_db
    
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def admin_user(db_session):
    from app.models import User
    from sqlalchemy import select
    
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
    from app.models import User, UserRole, Role
    from sqlalchemy import select
    
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
        session_token_hash=hash_password(secret),
    )
    db_session.add(session)
    await db_session.commit()
    await db_session.refresh(session)
    
    session_token = f"sess.{session.id}.{secret}"
    csrf_token = generate_token_secret()
    
    client.cookies.set("session_id", session_token)
    client.cookies.set("csrf_token", csrf_token)
    
    return client, csrf_token


from sqlalchemy import select
