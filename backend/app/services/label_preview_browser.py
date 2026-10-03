"""Capture the shared label preview in a fresh, offline Chromium process."""

import asyncio
import base64
import binascii
import json
import mimetypes
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import unquote, urlsplit

from anyio import CancelScope
from fastapi import HTTPException
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from app.core.file_lock import FileLockBusy, exclusive_file_lock

_LOCK_PATH = Path(tempfile.gettempdir()) / "filaman-label-render.lock"
_RENDER_TIMEOUT_SECONDS = 30
_MAX_REQUESTS = 256


@asynccontextmanager
async def label_render_slot() -> AsyncIterator[None]:
    # ponytail: one browser across workers caps RAM; measure before adding slots.
    try:
        with exclusive_file_lock(_LOCK_PATH):
            yield
    except FileLockBusy as exc:
        raise HTTPException(503, "Label renderer is busy", headers={"Retry-After": "1"}) from exc


async def render_preview_png(
    payload: dict,
    origin: str,
    assets: dict[str, bytes],
    *,
    static_dir: str | Path | None = None,
    executable_path: str | None = None,
) -> bytes:
    """Caller holds label_render_slot before loading assets and throughout capture."""
    configured_root = static_dir or os.environ.get("LABEL_RENDER_STATIC_DIR")
    candidates = [Path(configured_root)] if configured_root else [
        Path("/app/static"), Path(__file__).resolve().parents[3] / "frontend/dist",
        Path(__file__).resolve().parents[3] / "frontend/dist/client",
    ]
    root = next((path.resolve() for path in candidates if (path / "label-render/index.html").is_file()), None)
    if root is None:
        raise HTTPException(503, "Label renderer frontend build is missing; build the frontend first")
    executable = executable_path or os.environ.get("LABEL_RENDER_CHROMIUM_EXECUTABLE")
    if not executable:
        executable = next((path for name in ("chromium-headless-shell", "chromium", "chromium-browser", "google-chrome")
                           if (path := shutil.which(name))), None)
    if not executable or not Path(executable).is_file() or not os.access(executable, os.X_OK):
        raise HTTPException(503, "Label renderer Chromium executable is unavailable; use the Chromium-enabled FilaMan image or configure LABEL_RENDER_CHROMIUM_EXECUTABLE")
    render_user = os.environ.get("LABEL_RENDER_CHROMIUM_USER")
    render_account = None
    if render_user:
        if not hasattr(os, "geteuid"):
            raise HTTPException(503, "Label renderer user isolation is unavailable")
        import pwd
        try:
            render_account = pwd.getpwnam(render_user)
        except KeyError as exc:
            raise HTTPException(503, "Label renderer user is unavailable") from exc
    parent_is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if (parent_is_root and render_account is None) or (
        render_account is not None and render_account.pw_uid == 0
    ):
        raise HTTPException(503, "Label renderer requires an unprivileged user")
    try:
        expected = urlsplit(origin)
        def authority(url):
            return url.scheme, url.hostname, url.port or (443 if url.scheme == "https" else 80)
        expected_authority = authority(expected)
    except ValueError as exc:
        raise HTTPException(422, "Invalid label renderer origin") from exc
    if expected.scheme not in {"http", "https"} or not expected.hostname or expected.username is not None:
        raise HTTPException(422, "Invalid label renderer origin")
    base_url = f"{expected.scheme}://{expected.netloc}"

    async def resource(request):
        url = urlsplit(request["url"])
        if request["method"] != "GET" or url.username is not None or authority(url) != expected_authority:
            return None
        path = unquote(url.path)
        if path in assets:
            return assets[path], "image/png"
        if path == "/api" or path.startswith(("/api/", "/uploads/")):
            return None
        try:
            file = (root / path.lstrip("/")).resolve()
            file.relative_to(root)
            if file.is_dir():
                file = (file / "index.html").resolve()
                file.relative_to(root)
            return file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        except (OSError, ValueError):
            return None

    profile = tempfile.mkdtemp(prefix="filaman-label-")
    process = socket = reader = None
    pending, requests = {}, set()
    terminal_error = None
    sequence = 0
    session = None

    def fail(error):
        nonlocal terminal_error
        terminal_error = error
        for future in list(pending.values()):
            if not future.done():
                future.set_exception(error)

    async def command(method, params=None, *, browser=False):
        nonlocal sequence
        if terminal_error:
            raise terminal_error
        sequence += 1
        identifier = sequence
        message = {"id": identifier, "method": method, "params": params or {}}
        if session and not browser:
            message["sessionId"] = session
        future = asyncio.get_running_loop().create_future()
        pending[identifier] = future
        try:
            await socket.send(json.dumps(message))
            return await future
        finally:
            pending.pop(identifier, None)
            if future.done() and not future.cancelled():
                future.exception()  # Observe a simultaneous send/reader failure.

    async def fulfill(params):
        result = await resource(params["request"])
        if result is None:
            await command("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "BlockedByClient"})
        else:
            content, media_type = result
            await command("Fetch.fulfillRequest", {
                "requestId": params["requestId"], "responseCode": 200,
                "responseHeaders": [
                    {"name": "Content-Type", "value": media_type},
                    {"name": "Content-Security-Policy", "value": "worker-src 'none'; connect-src 'self'; frame-src 'none'; object-src 'none'"},
                ],
                "body": base64.b64encode(content).decode(),
            })

    def fulfilled(task):
        requests.discard(task)
        if not task.cancelled() and (error := task.exception()):
            fail(error)

    async def receive():
        try:
            async for raw in socket:
                message = json.loads(raw)
                if "id" in message:
                    future = pending.get(message["id"])
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError(str(message["error"])))
                        else:
                            future.set_result(message.get("result", {}))
                elif message.get("method") == "Fetch.requestPaused":
                    if len(requests) >= _MAX_REQUESTS:
                        raise RuntimeError("Too many label resource requests")
                    task = asyncio.create_task(fulfill(message["params"]))
                    requests.add(task)
                    task.add_done_callback(fulfilled)
        except (WebSocketException, OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            fail(exc)
        finally:
            fail(ConnectionError("Chromium connection closed"))

    def signal_group(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can deny signalling an already-dead, orphaned group.
            # Ignore that only after confirming it has no live members.
            if sys.platform != "darwin":
                raise
            members = subprocess.run(
                ["/bin/ps", "-axo", "pgid=,stat="],
                capture_output=True, text=True, timeout=.2, check=False,
            )
            live = [line.split() for line in members.stdout.splitlines()]
            if members.returncode or any(
                row[0] == str(process.pid) and not any(state in row[1] for state in "EZ")
                for row in live if len(row) >= 2
            ):
                raise

    async def cleanup():
        if socket is not None and terminal_error is None:
            with suppress(Exception):
                await asyncio.wait_for(command("Browser.close", browser=True), 1)
        if process is not None:
            with suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), 1)
            # Kill the owned group even if the browser parent already crashed.
            signal_group(signal.SIGTERM)
            with suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), .5)
            signal_group(signal.SIGKILL)
            await process.wait()
        for task in [reader, *requests]:
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in [reader, *requests] if task is not None), return_exceptions=True)
        if socket is not None:
            with suppress(Exception):
                await asyncio.wait_for(socket.close(), .5)
        # A killed descendant may still be finishing its last filesystem syscall.
        for attempt in range(10):
            try:
                shutil.rmtree(profile)
                break
            except FileNotFoundError:
                break
            except OSError:
                if attempt == 9:
                    raise
                await asyncio.sleep(.05)

    try:
        async with asyncio.timeout(_RENDER_TIMEOUT_SECONDS):
            browser_env = {
                key: os.environ[key]
                for key in ("LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ")
                if key in os.environ
            }
            browser_env.update({
                "LOGNAME": render_user or os.environ.get("LOGNAME", "label-render"),
                "PATH": os.defpath,
                "USER": render_user or os.environ.get("USER", "label-render"),
            })
            if sys.platform == "darwin":
                if home := os.environ.get("HOME"):
                    browser_env["HOME"] = home
            else:
                browser_env.update(
                    HOME=profile, XDG_CACHE_HOME=profile, XDG_CONFIG_HOME=profile,
                )
            launch_options = {
                "env": browser_env,
            }
            if render_account is not None:
                os.chown(profile, render_account.pw_uid, render_account.pw_gid)
                launch_options.update(user=render_account.pw_uid, group=render_account.pw_gid)
                if parent_is_root:
                    launch_options["extra_groups"] = []
            args = [
                executable, "--headless", "--disable-dev-shm-usage",
                "--no-first-run", "--disable-background-networking", "--disable-component-update",
                "--disable-extensions", "--disable-sync", "--disable-default-apps",
                "--hide-scrollbars", "--mute-audio", "--force-color-profile=srgb",
                "--proxy-server=http://label-render.invalid:9", "--proxy-bypass-list=<-loopback>",
                "--host-resolver-rules=MAP * ~NOTFOUND", "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}", "about:blank",
            ]
            if sys.platform == "linux" and platform.machine().startswith("armv7"):
                args.extend(["--disable-gpu", "--in-process-gpu"])
            process = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
                **launch_options,
            )
            portfile = Path(profile) / "DevToolsActivePort"
            while not portfile.exists():
                if process.returncode is not None:
                    raise RuntimeError("Chromium exited during startup")
                await asyncio.sleep(.01)
            port, socket_path = portfile.read_text().splitlines()[:2]
            socket = await connect(f"ws://127.0.0.1:{int(port)}{socket_path}", max_size=16 * 1024 * 1024, max_queue=16)
            reader = asyncio.create_task(receive())
            target = await command("Target.createTarget", {"url": "about:blank"}, browser=True)
            attached = await command("Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}, browser=True)
            session = attached["sessionId"]
            await command("Browser.setDownloadBehavior", {"behavior": "deny"}, browser=True)
            await command("Page.enable")
            if sys.platform == "linux":
                await command("Page.setFontFamilies", {"fontFamilies": {
                    "standard": "Times New Roman", "fixed": "Monospace", "serif": "Times New Roman",
                    "sansSerif": "Arial", "cursive": "Comic Sans MS", "fantasy": "Impact",
                }})
            await command("Network.enable")
            await command("Network.setBypassServiceWorker", {"bypass": True})
            await command("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": 0, "uploadThroughput": 0})
            await command("Fetch.enable", {"patterns": [{"urlPattern": "*"}]})
            await command("Page.navigate", {"url": f"{base_url}/label-render/"})
            while True:
                ready = await command("Runtime.evaluate", {"expression": "typeof window.renderApiLabel === 'function'", "returnByValue": True})
                if ready["result"].get("value"):
                    break
                await asyncio.sleep(.01)
            result = await command("Runtime.evaluate", {
                "expression": "window.renderApiLabel(" + json.dumps(payload) + ")",
                "awaitPromise": True, "returnByValue": True,
            })
            if "exceptionDetails" in result:
                raise HTTPException(422, "Label could not be rendered by the browser preview")
            data_url = result["result"].get("value")
    except TimeoutError as exc:
        raise HTTPException(503, "Label renderer timed out", headers={"Retry-After": "1"}) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Label renderer Chromium failed") from exc
    finally:
        with CancelScope(shield=True):
            cleanup_task = asyncio.create_task(cleanup())
            cancelled = False
            while not cleanup_task.done():
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    cancelled = True
            cleanup_task.result()
            if cancelled:
                raise asyncio.CancelledError

    prefix = "data:image/png;base64,"
    try:
        if not isinstance(data_url, str) or not data_url.startswith(prefix):
            raise ValueError("Expected PNG data URL")
        png = base64.b64decode(data_url[len(prefix):], validate=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Expected PNG bytes")
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "Browser preview did not return a PNG image") from exc
    return png
