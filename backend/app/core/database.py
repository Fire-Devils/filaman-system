from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

# Build engine kwargs based on DB backend
_engine_kwargs: dict = {
    "echo": settings.debug,
}

_is_sqlite = settings.database_url.startswith("sqlite")

if _is_sqlite:
    # SQLite: default QueuePool is fine for aiosqlite.  We only add
    # check_same_thread=False (required by aiosqlite) and a generous
    # busy_timeout so that multiple Gunicorn workers wait for each other
    # instead of failing with "database is locked".
    _engine_kwargs.update(
        connect_args={
            "check_same_thread": False,
            "timeout": 30,  # SQLite busy_timeout in seconds
        },
    )
else:
    # MySQL / PostgreSQL: proper connection pooling
    _engine_kwargs.update(
        pool_size=10,
        max_overflow=20,
        pool_recycle=3600,
        pool_pre_ping=True,
    )

engine = create_async_engine(settings.database_url, **_engine_kwargs)

# Enable WAL mode for SQLite - allows concurrent reads during writes
# This significantly improves performance under load
if _is_sqlite:

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        # Enforce FK constraints/cascades so deleted parent rows cannot leave stale children behind
        cursor.execute("PRAGMA foreign_keys=ON")
        # WAL mode: allows readers and writer to operate concurrently
        cursor.execute("PRAGMA journal_mode=WAL")
        # NORMAL sync: faster than FULL, still safe (WAL protects against corruption)
        cursor.execute("PRAGMA synchronous=NORMAL")
        # Increase cache size to 64MB for better read performance
        cursor.execute("PRAGMA cache_size=-65536")
        # Enable memory-mapped I/O for faster reads (256MB limit)
        cursor.execute("PRAGMA mmap_size=268435456")
        cursor.close()


async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncSession:
    async with async_session_maker() as session:
        yield session
