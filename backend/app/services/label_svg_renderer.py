"""Bounded, offline Node command for the shared label renderer."""

import asyncio
import base64
import io
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from anyio import CancelScope
from fastapi import HTTPException
from PIL import Image

from app.core.file_lock import FileLockBusy, exclusive_file_lock

_LOCK_PATH = Path(tempfile.gettempdir()) / "filaman-label-render.lock"
_TIMEOUT = 30
_MAX_INPUT = 96 * 1024 * 1024
_MAX_OUTPUT = 24 * 1024 * 1024
_MAX_STDERR = 64 * 1024


@asynccontextmanager
async def label_render_slot() -> AsyncIterator[None]:
    # One render across workers bounds peak memory.
    try:
        with exclusive_file_lock(_LOCK_PATH):
            yield
    except FileLockBusy as exc:
        raise HTTPException(503, "Label renderer is busy", headers={"Retry-After": "1"}) from exc


async def render_svg_png(payload: dict, origin: str, assets: dict[str, bytes], *,
                         executable_path: str | None = None, bundle_dir: str | Path | None = None) -> bytes:
    """Caller holds label_render_slot and has authorized/validated canonical assets."""
    root = Path(bundle_dir or os.environ.get('LABEL_RENDER_SVG_DIR', '/app/static/label-svg'))
    if bundle_dir is None and 'LABEL_RENDER_SVG_DIR' not in os.environ and not root.is_dir():
        root = Path(__file__).resolve().parents[3] / 'frontend/dist/label-svg'
    executable = executable_path or os.environ.get('LABEL_RENDER_NODE_EXECUTABLE') or shutil.which('node')
    if not executable or not os.access(executable, os.X_OK) or not (root / 'render.mjs').is_file():
        raise HTTPException(503, 'Shared label renderer runtime is unavailable')
    embedded = {}
    for key, content in assets.items():
        with Image.open(io.BytesIO(content)) as image:
            embedded[key] = {'dataUrl': 'data:image/png;base64,' + base64.b64encode(content).decode(),
                             'width': image.width, 'height': image.height}
    encoded = json.dumps({'payload': payload, 'origin': origin, 'assets': embedded}).encode()
    if len(encoded) > _MAX_INPUT:
        raise HTTPException(422, 'Label input exceeds renderer budget')
    launch = {}
    user = os.environ.get('LABEL_RENDER_USER')
    is_root = hasattr(os, 'geteuid') and os.geteuid() == 0
    if user:
        import pwd
        try:
            account = pwd.getpwnam(user)
        except KeyError as exc:
            raise HTTPException(503, 'Label renderer user is unavailable') from exc
        if account.pw_uid == 0:
            raise HTTPException(503, 'Label renderer requires an unprivileged user')
        launch.update(user=account.pw_uid, group=account.pw_gid)
        if is_root:
            launch['extra_groups'] = []
    elif is_root:
        raise HTTPException(503, 'Label renderer requires an unprivileged user')
    process = None
    tasks = []

    def write_input():
        try:
            process.stdin.write(encoded)
        except BrokenPipeError:
            pass
        finally:
            process.stdin.close()

    async def read_output(pipe, limit):
        value = await asyncio.to_thread(pipe.read, limit + 1)
        if len(value) > limit:
            raise ValueError('Renderer output budget exceeded')
        return value

    async def cleanup():
        if process is not None:
            if process.poll() is None:
                process.kill()
            await asyncio.to_thread(process.wait)
        await asyncio.gather(*tasks, return_exceptions=True)
        if process is not None:
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()

    try:
        async with asyncio.timeout(_TIMEOUT):
            # Popen retains ownership synchronously and supports privilege dropping under uvloop.
            process = subprocess.Popen(  # noqa: ASYNC220
                [executable, str((root / 'render.mjs').resolve())],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={key: os.environ[key] for key in ('LANG', 'LC_ALL', 'TZ') if key in os.environ},
                **launch,
            )
            tasks = [asyncio.create_task(asyncio.to_thread(write_input)),
                     asyncio.create_task(read_output(process.stdout, _MAX_OUTPUT)),
                     asyncio.create_task(read_output(process.stderr, _MAX_STDERR))]
            # Shield pipe tasks so cancellation cannot orphan a thread using a live child.
            _, stdout, _ = await asyncio.shield(asyncio.gather(*tasks))
            code = await asyncio.to_thread(process.wait)
            if code:
                raise ValueError('Renderer exited unsuccessfully')
            response = json.loads(stdout)
            if isinstance(response, dict) and isinstance(response.get('error'), dict):
                error = response['error']
                if error.get('kind') == 'layout' and isinstance(error.get('message'), str):
                    raise HTTPException(422, error['message'][:300])
                raise TypeError('Invalid renderer response')
            png = base64.b64decode(response['png'], validate=True)
            if not png.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Invalid renderer PNG')
            return png
    except HTTPException:
        raise
    except TimeoutError as exc:
        raise HTTPException(503, 'Shared label renderer timed out', headers={'Retry-After': '1'}) from exc
    except Exception as exc:
        raise HTTPException(503, 'Shared label renderer failed') from exc
    finally:
        with CancelScope(shield=True):
            task = asyncio.create_task(cleanup())
            cancelled = False
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    cancelled = True
            task.result()
            if cancelled:
                raise asyncio.CancelledError
