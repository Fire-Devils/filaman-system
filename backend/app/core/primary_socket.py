"""Private HTTP listener owned by the worker that runs printer drivers."""

import os
import socket
import stat
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from functools import lru_cache
from hashlib import blake2s
from multiprocessing import current_process
from pathlib import Path

import uvicorn
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import settings
from app.core.worker_reload import worker_is_draining, worker_is_gunicorn


# Use the same temp-root identity as the election lock, within the short,
# sticky /tmp namespace so a long or shared TMPDIR cannot expose the socket.
_runtime_key = blake2s(os.fsencode(Path(tempfile.gettempdir()).resolve()), digest_size=8).hexdigest()
_runtime_dir = Path("/tmp") / f"filaman-{os.getuid()}-{_runtime_key}"
_startup_directory = Path.cwd()


@lru_cache(maxsize=1)
def _server_identity(worker_pid: int) -> bytes:
    if instance := os.environ.get("FILAMAN_GUNICORN_INSTANCE"):
        return instance.encode()
    if worker_is_gunicorn():
        # A custom Gunicorn config without the startup hook must fail closed.
        return os.urandom(16)
    # Uvicorn's multiprocessing workers inherit their supervisor's random key.
    return current_process().authkey


def _socket_path(database_url: str) -> Path:
    identity = b"\0".join((_server_identity(os.getpid()), os.fsencode(_startup_directory), database_url.encode()))
    return _runtime_dir / f"p-{blake2s(identity, digest_size=8).hexdigest()}.sock"


def primary_socket_path() -> Path:
    directory = _runtime_dir.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or directory.st_mode & 0o077:
        raise PermissionError(f"Primary socket directory must be private: {_runtime_dir}")
    return _socket_path(settings.database_url)


@asynccontextmanager
async def serve_primary_socket(app: ASGIApp) -> AsyncIterator[Callable[[], None]]:
    _runtime_dir.mkdir(mode=0o700, exist_ok=True)
    path = primary_socket_path()
    staged = path.with_suffix(".starting")
    # The primary lock is held, so any existing socket at either path is stale.
    path.unlink(missing_ok=True)
    staged.unlink(missing_ok=True)

    async def dispatch(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and worker_is_draining():
            response = JSONResponse(
                {"detail": {"code": "primary_worker_required", "message": "Primary worker is draining. Please retry."}},
                status_code=503,
            )
            await response(scope, receive, send)
            return
        await app(scope, receive, send)

    config = uvicorn.Config(dispatch, lifespan="off", log_config=None, proxy_headers=False)
    config.load()
    server = uvicorn.Server(config)
    server.lifespan = config.lifespan_class(config)

    def publish() -> None:
        staged.replace(path)

    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(staged))
        try:
            # Gunicorn owns process signals and the application's lifespan.
            await server.startup(sockets=[listener])
            try:
                yield publish
            finally:
                await server.shutdown(sockets=[listener])
        finally:
            staged.unlink(missing_ok=True)
            path.unlink(missing_ok=True)
