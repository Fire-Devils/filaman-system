"""Trigger a graceful reload of all Gunicorn workers.

Needed after dynamically mounting/unmounting a plugin router, because
mount_plugin_router_on_app() only patches app.router.routes in the single
worker process handling the request — the other Gunicorn workers keep
serving stale routes until they are restarted. Gunicorn's SIGHUP handling
(without --preload) re-imports the app from disk in every worker, which
re-runs the already-consistent cold-start plugin discovery in
_mount_plugin_routers().
"""

import logging
import os
import signal
from collections.abc import Iterable
from pathlib import Path
from socket import socket

logger = logging.getLogger(__name__)

_GUNICORN_PID_FILE = Path("/tmp/filaman-gunicorn.pid")
_worker_listeners: tuple[socket, ...] = ()


def worker_is_gunicorn() -> bool:
    return os.environ.get("SERVER_SOFTWARE", "").startswith("gunicorn/")


def track_worker_listeners(listeners: Iterable[socket]) -> None:
    global _worker_listeners
    _worker_listeners = tuple(listeners)


def worker_is_draining() -> bool:
    # Uvicorn closes public listeners before draining requests and ending the lifespan.
    return bool(_worker_listeners) and all(listener.fileno() < 0 for listener in _worker_listeners)


def _gunicorn_master_pid() -> int | None:
    try:
        master_pid = int(_GUNICORN_PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    # A stale pidfile must not signal an unrelated process.
    return master_pid if master_pid > 0 and master_pid == os.getppid() else None


def worker_reload_available() -> bool:
    return _gunicorn_master_pid() is not None


def request_worker_reload() -> bool:
    """Send SIGHUP to the Gunicorn master so all workers reload consistently."""
    master_pid = _gunicorn_master_pid()
    if master_pid is None:
        return False
    try:
        os.kill(master_pid, signal.SIGHUP)
        logger.info(
            "Sent SIGHUP to Gunicorn master (pid=%d) to reload workers "
            "after plugin change",
            master_pid,
        )
        return True
    except OSError as exc:
        logger.warning("Could not signal Gunicorn master for worker reload: %s", exc)
        return False
