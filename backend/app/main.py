import asyncio
from contextlib import asynccontextmanager
import fcntl
import json as _json
import os
from pathlib import Path
import tempfile
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import text

from app.api.auth import router as auth_router
from app.api.auth_oidc import router as auth_oidc_router
from app.api.v1.router import api_router, mount_deferred_plugin_routers
from app.core.config import settings, MANUFACTURER_LOGO_DIR
from app.core.database import async_session_maker
from app.core.logging_config import setup_logging
from app.core.middleware import AuthMiddleware, CsrfMiddleware, RequestIdMiddleware
from app.core.seeds import run_all_seeds
from app.core.shared_health import shared_health_store
from app.plugins.manager import plugin_manager
from app.services.plugin_service import PLUGINS_DIR

setup_logging()
logger = __import__("logging").getLogger(__name__)

# ---------------------------------------------------------------------------
# Startup guard – ensures seeds and plugin-start run only once across all
# Gunicorn workers.  Uses an exclusive file lock so only the first worker
# executes these tasks; the others skip them.
# ---------------------------------------------------------------------------
_STARTUP_LOCK_PATH = Path(tempfile.gettempdir()) / "filaman-startup.lock"
_is_primary = False
_lock_fd = None
_WATCHDOG_INTERVAL = 60  # seconds


def run_migrations() -> None:
    """Alembic-Migrationen programmatisch ausfuehren (upgrade head).

    Wird synchron ausgefuehrt. Dank der Anpassung in env.py wird dabei
    automatisch ein synchroner DB-Treiber verwendet, auch wenn die App
    asynchron konfiguriert ist.
    """
    from alembic import command
    from alembic.config import Config

    alembic_cfg = Config("alembic.ini")
    alembic_cfg.set_main_option(
        "script_location",
        str(__import__("pathlib").Path(__file__).resolve().parent.parent / "alembic"),
    )
    # Wir muessen hier nichts mehr an der URL drehen, das macht env.py jetzt selbst.

    command.upgrade(alembic_cfg, "head")


# ---------------------------------------------------------------------------
# Driver watchdog – runs in every Gunicorn worker as a background task.
#
# Primary worker:  periodically checks driver health and restarts dead
#                  drivers or starts missing ones.
# Secondary workers: periodically try to acquire the startup lock.  If they
#                    succeed the previous primary is gone and they take over
#                    driver management.
# ---------------------------------------------------------------------------
async def _driver_watchdog() -> None:
    """Background task: monitors driver health and handles primary failover."""
    global _is_primary, _lock_fd

    # Give the primary worker time to finish initial startup.
    await asyncio.sleep(30)

    while True:
        try:
            if _is_primary:
                await _watchdog_health_check()
            else:
                await _watchdog_try_takeover()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Driver watchdog error (will retry next cycle)")

        await asyncio.sleep(_WATCHDOG_INTERVAL)


async def _watchdog_health_check() -> None:
    """Primary worker: restart dead drivers and start missing ones."""
    from app.models.printer import Printer
    from app.models.plugin import InstalledPlugin
    from sqlalchemy import select

    health = plugin_manager.get_health()

    # Publish current health to shared memory so secondary workers
    # can return accurate status to the frontend.
    if health:
        shared_health_store.publish(health)

    # Deaktivierte Plugins ermitteln
    async with async_session_maker() as db:
        disabled_result = await db.execute(
            select(InstalledPlugin.driver_key).where(
                InstalledPlugin.is_active.is_(False),
                InstalledPlugin.driver_key.isnot(None),
            )
        )
        disabled_drivers = {r for r in disabled_result.scalars().all()}

    # 1. Restart drivers that report running=False
    for printer_id, status in list(health.items()):
        if not status.get("running", True):
            logger.warning(
                f"Watchdog: driver for printer {printer_id} not running, restarting"
            )
            await plugin_manager.stop_printer(printer_id)
            # Reload printer from DB to get current config
            async with async_session_maker() as db:
                result = await db.execute(
                    select(Printer).where(
                        Printer.id == printer_id,
                        Printer.is_active == True,
                        Printer.deleted_at.is_(None),
                    )
                )
                printer = result.scalar_one_or_none()
            if printer:
                if printer.driver_key in disabled_drivers:
                    logger.info(
                        f"Watchdog: skipping printer {printer_id}: plugin '{printer.driver_key}' is deactivated"
                    )
                    continue
                started = await plugin_manager.start_printer(printer)
                if started:
                    logger.info(f"Watchdog: restarted driver for printer {printer_id}")
                else:
                    logger.error(
                        f"Watchdog: failed to restart driver for printer {printer_id}"
                    )

    # 2. Start drivers for active printers that have no driver in memory
    async with async_session_maker() as db:
        result = await db.execute(
            select(Printer).where(
                Printer.is_active == True,
                Printer.deleted_at.is_(None),
            )
        )
        active_printers = result.scalars().all()

    for printer in active_printers:
        if printer.id not in plugin_manager.drivers:
            if printer.driver_key in disabled_drivers:
                continue
            logger.info(
                f"Watchdog: no driver for active printer {printer.id}, starting"
            )
            started = await plugin_manager.start_printer(printer)
            if started:
                logger.info(f"Watchdog: started driver for printer {printer.id}")
            else:
                logger.error(
                    f"Watchdog: failed to start driver for printer {printer.id}"
                )


async def _watchdog_try_takeover() -> None:
    """Secondary worker: try to become primary if the lock is available."""
    global _is_primary, _lock_fd

    try:
        fd = open(_STARTUP_LOCK_PATH, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Lock acquired – previous primary is gone.
        _lock_fd = fd
        _is_primary = True
        logger.info("Watchdog: acquired lock – promoted to primary worker")
        await plugin_manager.start_all()
        logger.info("Watchdog: drivers started after takeover")
    except OSError:
        # Primary still holds the lock – nothing to do.
        pass
    except Exception:
        logger.exception("Watchdog: takeover attempt failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _is_primary, _lock_fd

    logger.info("Starting FilaMan backend...")
    logger.info(f"Using database URL: {settings.database_url}")

    # Ensure persistent directories exist
    MANUFACTURER_LOGO_DIR.mkdir(parents=True, exist_ok=True)

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

    # --- Startup guard: run seeds & plugin start only in ONE worker ----------
    # With Gunicorn prefork (multiple workers) every worker executes this
    # lifespan independently.  Seeds and plugin drivers must only run once.
    # We use an exclusive file-lock: the first worker wins and runs the
    # one-time tasks; the others skip them.
    try:
        _lock_fd = open(_STARTUP_LOCK_PATH, "w")
        fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _is_primary = True
        logger.info("Primary worker – running seeds and starting plugins")
    except OSError:
        # Another worker already holds the lock
        logger.info("Secondary worker – skipping seeds and plugin start")
    except Exception as exc:
        logger.warning(f"Startup lock failed ({exc}), running seeds as fallback")
        _is_primary = True

    if _is_primary:
        async with async_session_maker() as db:
            await run_all_seeds(db)
        await plugin_manager.start_all()
        # Publish initial health so secondary workers have data immediately
        initial_health = plugin_manager.get_health()
        if initial_health:
            shared_health_store.publish(initial_health)

    # Start the driver watchdog in every worker (handles health checks
    # for the primary and automatic takeover for secondary workers).
    watchdog_task = asyncio.create_task(_driver_watchdog())

    logger.info("FilaMan backend started")
    yield
    logger.info("Shutting down FilaMan backend...")

    # Cancel the watchdog first
    watchdog_task.cancel()
    try:
        await watchdog_task
    except asyncio.CancelledError:
        pass

    if _is_primary:
        await plugin_manager.stop_all()
        # Clean up shared health memory (primary is the owner)
        shared_health_store.cleanup()
        # Release the file lock (OS also releases automatically on exit).
        # We intentionally do NOT delete the lock file so that secondary
        # workers can still attempt flock() on it during takeover.
        if _lock_fd:
            try:
                fcntl.flock(_lock_fd, fcntl.LOCK_UN)
                _lock_fd.close()
            except OSError:
                pass
            _lock_fd = None
        _is_primary = False
    else:
        # Secondary workers just close their handle (don't unlink)
        shared_health_store.close()
    logger.info("FilaMan backend stopped")


def _read_version() -> str:
    """Installierte Version aus version.txt lesen."""
    candidates = [
        Path("/app/version.txt"),
        Path(__file__).resolve().parents[2] / "version.txt",
    ]
    for p in candidates:
        if p.is_file():
            return p.read_text().strip()
    return "0.0.0"


app = FastAPI(
    title=settings.app_name,
    version=_read_version(),
    debug=settings.debug,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

cors_origins: list[str] = []
if settings.cors_origins == "*":
    cors_origins = ["*"]
elif settings.cors_origins:
    cors_origins = [
        origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()
    ]

if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.add_middleware(RequestIdMiddleware)
app.add_middleware(CsrfMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Note: Rate limiting for /auth/login is handled by nginx (see nginx.conf)
# This ensures consistent limits across all Gunicorn workers


# Redirect /spool → /spools (singular → plural alias)
# Covers both API paths (/api/v1/spool/...) and frontend paths (/spool/...)
# Uses 307 to preserve the HTTP method (POST stays POST)
_SPOOL_SINGULAR_PREFIXES = ("/spool/", "/api/v1/spool/")
_SPOOL_SINGULAR_EXACT = ("/spool", "/api/v1/spool")


@app.middleware("http")
async def redirect_singular_spool(request, call_next):
    path = request.url.path
    for prefix in _SPOOL_SINGULAR_PREFIXES:
        plural = prefix[:-1] + "s/"  # e.g. "/spools/", "/api/v1/spools/"
        if path.startswith(prefix) and not path.startswith(plural):
            new_path = plural + path[len(prefix) :]
            return RedirectResponse(
                url=str(request.url.replace(path=new_path)), status_code=307
            )
    for exact in _SPOOL_SINGULAR_EXACT:
        if path == exact:
            return RedirectResponse(
                url=str(request.url.replace(path=exact + "s")), status_code=307
            )
    return await call_next(request)


# Slow-Request Logging Middleware - helps diagnose performance issues
_SLOW_REQUEST_THRESHOLD = 5.0  # Log requests taking longer than 5 seconds


@app.middleware("http")
async def log_slow_requests(request, call_next):
    start = time.monotonic()
    response = await call_next(request)
    duration = time.monotonic() - start

    if duration > _SLOW_REQUEST_THRESHOLD:
        path = request.url.path
        query = str(request.url.query) if request.url.query else ""
        logger.warning(
            f"SLOW REQUEST: {request.method} {path}"
            + (f"?{query}" if query else "")
            + f" took {duration:.2f}s (status: {response.status_code})"
        )
    return response


# Allow iframe embedding from any origin for Bambuddy and self-hosted integrations
@app.middleware("http")
async def allow_iframe_embedding(request, call_next):
    response = await call_next(request)
    
    # Remove restrictive X-Frame-Options header (if set by upstream proxy)
    if "x-frame-options" in response.headers:
        del response.headers["x-frame-options"]
    
    # Allow embedding from any origin
    # This enables Bambuddy and other self-hosted integrations to display
    # FilaMan pages in iframes
    response.headers["content-security-policy"] = "frame-ancestors *"
    
    return response


# Cache-Control Middleware for static files
@app.middleware("http")
async def add_cache_control_header(request, call_next):
    response = await call_next(request)
    path = request.url.path
    is_api = path.startswith("/api/") or path.startswith("/auth/")
    if not is_api and (
        path.startswith("/_astro/")
        or path.startswith("/img/")
        or path.endswith((".js", ".css", ".png", ".jpg", ".svg", ".woff2", ".ico"))
    ):
        # Cache hashed static assets for 1 year
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif not is_api and response.headers.get("content-type", "").startswith(
        "text/html"
    ):
        # HTML pages: always revalidate so new deployments are picked up immediately
        response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(auth_router)
app.include_router(auth_oidc_router)
app.include_router(api_router)
mount_deferred_plugin_routers(app)


# --- Plugin Page Serving (works in both debug and production) ---
# Dynamic catch-all: resolves plugin pages at request time so that
# plugins installed after server start are served without restart.


@app.get("/plugin-page/{plugin_slug:path}")
async def serve_plugin_page(plugin_slug: str):
    from fastapi import HTTPException
    from app.models.plugin import InstalledPlugin
    from sqlalchemy import select

    if not PLUGINS_DIR.is_dir():
        raise HTTPException(status_code=404, detail="Plugin page not found")

    for entry in PLUGINS_DIR.iterdir():
        if not entry.is_dir():
            continue
        manifest = entry / "plugin.json"
        page_file = entry / "page.html"
        if not manifest.is_file() or not page_file.is_file():
            continue
        try:
            meta = _json.loads(manifest.read_text(encoding="utf-8"))
            if meta.get("page_url", "").strip() == f"/plugin-page/{plugin_slug}":
                # Pruefen ob das Plugin aktiviert ist
                plugin_key = meta.get("plugin_key", entry.name)
                async with async_session_maker() as db:
                    result = await db.execute(
                        select(InstalledPlugin.is_active).where(
                            InstalledPlugin.plugin_key == plugin_key
                        )
                    )
                    is_active = result.scalar_one_or_none()
                if is_active is False:
                    raise HTTPException(status_code=404, detail="Plugin is deactivated")
                return FileResponse(str(page_file))
        except HTTPException:
            raise
        except Exception:
            continue

    raise HTTPException(status_code=404, detail="Plugin page not found")


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


# ---------------------------------------------------------------------------
# Uploads directory – serves manufacturer logos and other user-uploaded assets.
# In Docker the canonical location is /app/data/uploads; during local
# development we fall back to <PROJECT_ROOT>/data/uploads.
# ---------------------------------------------------------------------------
from fastapi.staticfiles import StaticFiles as _StaticFiles  # noqa: E402

_uploads_dir = Path("/app/data/uploads")
if not _uploads_dir.is_dir():
    from app.core.config import PROJECT_ROOT

    _uploads_dir = PROJECT_ROOT / "data" / "uploads"
_uploads_dir.mkdir(parents=True, exist_ok=True)
(_uploads_dir / "manufacturer-logos").mkdir(exist_ok=True)

app.mount("/uploads", _StaticFiles(directory=str(_uploads_dir)), name="uploads")
logger.info("Serving uploads from '%s'", _uploads_dir)

if not settings.debug:
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
            return FileResponse(
                os.path.join(static_files_path, "filaments/new/index.html")
            )

        @app.get("/spools/new")
        async def serve_spool_new():
            return FileResponse(
                os.path.join(static_files_path, "spools/new/index.html")
            )

        @app.get("/spools/detail")
        async def serve_spool_detail_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/index.html")
            )

        @app.get("/spools/detail/edit")
        async def serve_spool_edit_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/edit/index.html")
            )

        @app.get("/spools/{id}")
        async def serve_spool_detail(id: int):
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/index.html")
            )

        @app.get("/spools/{id}/edit")
        async def serve_spool_edit(id: int):
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/edit/index.html")
            )

        @app.get("/spools/detail/print")
        async def serve_spool_print_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/print/index.html")
            )

        @app.get("/spools/{id}/print")
        async def serve_spool_print(id: int):
            return FileResponse(
                os.path.join(static_files_path, "spools/detail/print/index.html")
            )

        @app.get("/printers/detail")
        async def serve_printer_detail_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "printers/detail/index.html")
            )

        @app.get("/printers/{id}")
        async def serve_printer_detail(id: int):
            return FileResponse(
                os.path.join(static_files_path, "printers/detail/index.html")
            )

        @app.get("/filaments/colors")
        async def serve_filament_colors():
            return FileResponse(
                os.path.join(static_files_path, "filaments/colors/index.html")
            )

        @app.get("/filaments/detail")
        async def serve_filament_detail_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "filaments/detail/index.html")
            )

        @app.get("/filaments/detail/edit")
        async def serve_filament_edit_placeholder():
            return FileResponse(
                os.path.join(static_files_path, "filaments/detail/edit/index.html")
            )

        @app.get("/filaments/{id}")
        async def serve_filament_detail(id: int):
            return FileResponse(
                os.path.join(static_files_path, "filaments/detail/index.html")
            )

        @app.get("/filaments/{id}/edit")
        async def serve_filament_edit(id: int):
            return FileResponse(
                os.path.join(static_files_path, "filaments/detail/edit/index.html")
            )

        @app.get("/admin/oidc")
        async def serve_admin_oidc():
            return FileResponse(
                os.path.join(static_files_path, "admin/oidc/index.html")
            )

        app.mount(
            "/", _StaticFiles(directory=static_files_path, html=True), name="static"
        )
