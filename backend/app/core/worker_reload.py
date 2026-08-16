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
from pathlib import Path

logger = logging.getLogger(__name__)

_GUNICORN_PID_FILE = Path("/tmp/filaman-gunicorn.pid")


def request_worker_reload() -> None:
    """Send SIGHUP to the Gunicorn master so all workers reload consistently.

    No-op (with a debug log) outside of Gunicorn, e.g. local `uvicorn`
    development, where the pidfile doesn't exist.
    """
    if not _GUNICORN_PID_FILE.exists():
        logger.debug("No Gunicorn pidfile found, skipping worker reload (dev mode?)")
        return

    try:
        master_pid = int(_GUNICORN_PID_FILE.read_text().strip())
        os.kill(master_pid, signal.SIGHUP)
        logger.info(
            "Sent SIGHUP to Gunicorn master (pid=%d) to reload workers "
            "after plugin router change",
            master_pid,
        )
    except (OSError, ValueError) as exc:
        logger.warning("Could not signal Gunicorn master for worker reload: %s", exc)
