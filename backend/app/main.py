from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.auth import router as auth_router
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import async_session_maker
from app.core.logging_config import setup_logging
from app.core.middleware import AuthMiddleware, CsrfMiddleware, RequestIdMiddleware
from app.core.seeds import run_all_seeds
from app.plugins.manager import plugin_manager

setup_logging()
logger = __import__('logging').getLogger(__name__)


def run_migrations() -> None:
    """Alembic-Migrationen programmatisch ausfuehren (upgrade head).

    Wird synchron ausgefuehrt. Dank der Anpassung in env.py wird dabei
    automatisch ein synchroner DB-Treiber verwendet, auch wenn die App
    asynchron konfiguriert ist.
    """
    from alembic import command
    from alembic.config import Config

    alembic_cfg = Config("alembic.ini")
    alembic_cfg.set_main_option("script_location", str(
        __import__("pathlib").Path(__file__).resolve().parent.parent / "alembic"
    ))
    # Wir muessen hier nichts mehr an der URL drehen, das macht env.py jetzt selbst.

    command.upgrade(alembic_cfg, "head")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting FilaMan backend...")
    run_migrations()
    logger.info("Database migrations checked/applied")
    async with async_session_maker() as db:
        await run_all_seeds(db)
    await plugin_manager.start_all()
    logger.info("FilaMan backend started")
    yield
    logger.info("Shutting down FilaMan backend...")
    await plugin_manager.stop_all()
    logger.info("FilaMan backend stopped")


app = FastAPI(
    title=settings.app_name,
    debug=settings.debug,
    lifespan=lifespan,
)

cors_origins: list[str] = []
if settings.cors_origins == "*":
    cors_origins = ["*"]
elif settings.cors_origins:
    cors_origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]

if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.add_middleware(RequestIdMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(CsrfMiddleware)

app.include_router(auth_router)
app.include_router(api_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready():
    db_ok = False
    try:
        async with async_session_maker() as db:
            await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:
        logger.error(f"DB health check failed: {e}")

    plugins_ok = True
    plugin_health = plugin_manager.get_health()
    for printer_id, health in plugin_health.items():
        if health.get("status") == "error":
            plugins_ok = False
            break

    if db_ok and plugins_ok:
        return {"status": "ok", "db": "ok", "plugins": "ok"}

    return {
        "status": "not_ready",
        "db": "ok" if db_ok else "fail",
        "plugins": "ok" if plugins_ok else "fail",
    }


if not settings.debug:
    from fastapi.staticfiles import StaticFiles
    import os

    static_files_path = "/app/static"
    if not os.path.exists(static_files_path) or not os.path.isdir(static_files_path):
        logger.warning(
            f"Static files directory '{static_files_path}' not found. "
            "Frontend will not be served."
        )
    else:
        logger.info(f"Serving static files from '{static_files_path}'")
        app.mount("/", StaticFiles(directory=static_files_path, html=True), name="static")
