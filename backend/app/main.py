from contextlib import asynccontextmanager
import os  # Added import

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
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
    logger.info(f"Using database URL: {settings.database_url}")

    # Skip migrations in app context if configured (e.g. in Docker where entrypoint handles it)
    if os.getenv("RUN_MIGRATIONS_IN_APP", "true").lower() == "true":
        try:
            run_migrations()
            logger.info("Database migrations checked/applied")
        except Exception as e:
            logger.error(f"Error running migrations in app startup: {e}")
            # We don't raise here to allow app to try starting, or we could raise to fail hard.
            # Given entrypoint handles it in prod, this is mostly for dev safety.
            raise e
    else:
        logger.info("Skipping in-app migrations (RUN_MIGRATIONS_IN_APP is false)")

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
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Cache-Control Middleware for static files
@app.middleware("http")
async def add_cache_control_header(request, call_next):
    response = await call_next(request)
    path = request.url.path
    is_api = path.startswith("/api/") or path.startswith("/auth/")
    if not is_api and (
        path.startswith("/_astro/") or
        path.startswith("/img/") or
        path.endswith((".js", ".css", ".png", ".jpg", ".svg", ".woff2", ".ico"))
    ):
        # Cache static assets for 1 year
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


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

    static_files_path = "/app/static"
    if not os.path.exists(static_files_path) or not os.path.isdir(static_files_path):
        logger.warning(
            f"Static files directory '{static_files_path}' not found. "
            "Frontend will not be served."
        )
    else:
        logger.info(f"Serving static files from '{static_files_path}'")

        # Serve detail pages for dynamic routes
        # IMPORTANT: These must come BEFORE the /{id} routes to avoid "new" being parsed as int
        @app.get("/filaments/new")
        async def serve_filament_new():
            return FileResponse(os.path.join(static_files_path, "filaments/new/index.html"))

        @app.get("/spools/new")
        async def serve_spool_new():
            return FileResponse(os.path.join(static_files_path, "spools/new/index.html"))

        @app.get("/spools/{id}")
        async def serve_spool_detail(id: int):
            return FileResponse(os.path.join(static_files_path, "spools/detail/index.html"))

        @app.get("/spools/{id}/edit")
        async def serve_spool_edit(id: int):
            return FileResponse(os.path.join(static_files_path, "spools/detail/edit/index.html"))

        @app.get("/printers/{id}")
        async def serve_printer_detail(id: int):
            return FileResponse(os.path.join(static_files_path, "printers/detail/index.html"))

        @app.get("/filaments/colors")
        async def serve_filament_colors():
            return FileResponse(os.path.join(static_files_path, "filaments/colors/index.html"))

        @app.get("/filaments/{id}")
        async def serve_filament_detail(id: int):
            return FileResponse(os.path.join(static_files_path, "filaments/detail/index.html"))

        @app.get("/filaments/{id}/edit")
        async def serve_filament_edit(id: int):
            return FileResponse(os.path.join(static_files_path, "filaments/detail/edit/index.html"))

        app.mount("/", StaticFiles(directory=static_files_path, html=True), name="static")
