import asyncio
import io
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image


def write_render_page(root: Path, script: str):
    (root / "label-render").mkdir(parents=True)
    (root / "_astro").mkdir()
    (root / "label-render/index.html").write_text(
        '<!doctype html><script type="module" src="/_astro/render.js"></script>'
    )
    (root / "_astro/render.js").write_text(script)


@pytest.mark.asyncio
async def test_render_uses_local_files_and_owned_assets_without_network(tmp_path, browser_executable):
    from app.services.label_preview_browser import render_preview_png

    requests = []

    async def record_network(reader, writer):
        requests.append(True)
        await reader.read(4096)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nSECRET")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(record_network, "127.0.0.1", 0)
    origin = f"http://LOCALHOST:{server.sockets[0].getsockname()[1]}"
    root = tmp_path / "static"
    write_render_page(root, """
        window.renderApiLabel = async payload => {
          if (await (await fetch('/_astro/allowed.txt')).text() !== 'local') throw Error('local file missing');
          for (const path of payload.blocked) {
            let denied = false;
            try { await fetch(path, {mode: 'no-cors'}); } catch { denied = true; }
            if (!denied) throw Error('Unexpected access to ' + path);
          }
          const link = document.createElement('link');
          link.rel = 'preconnect'; link.href = payload.trap;
          document.head.append(link);
          await new Promise((resolve, reject) => {
            const socket = new WebSocket(payload.trap.replace('http:', 'ws:'));
            socket.onerror = resolve; socket.onopen = () => reject(Error('WebSocket escaped'));
          });
          let workerBlocked = false;
          try { await navigator.serviceWorker.register('/_astro/render.js'); }
          catch { workerBlocked = true; }
          if (!workerBlocked) throw Error('Service worker escaped');
          const image = await createImageBitmap(await (await fetch(payload.asset)).blob());
          const canvas = document.createElement('canvas');
          canvas.width = 3; canvas.height = 2;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          context.fillStyle = payload.color; context.fillRect(2, 1, 1, 1);
          return canvas.toDataURL('image/png');
        };
    """)
    (root / "_astro/allowed.txt").write_text("local")
    (root / "api").mkdir()
    (root / "api/private").write_text("API must remain blocked even if a file exists")
    (root / "uploads").mkdir()
    (root / "uploads/private.png").write_text("unowned upload")
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET")
    (root / "escape.txt").symlink_to(secret)
    asset = io.BytesIO()
    Image.new("RGB", (1, 1), "red").save(asset, format="PNG")
    asset_path = "/api/v1/label-assets/owned/content"
    try:
        result = await render_preview_png(
            {
                "asset": asset_path, "color": "#00ff00", "trap": origin,
                "blocked": [
                    "/api/private", "/uploads/private.png", "/missing.txt", "/escape.txt",
                    "/..%2Fsecret.txt", f"{origin}/outside", "https://example.invalid/private",
                    "file:///etc/passwd",
                ],
            },
            origin, {asset_path: asset.getvalue()}, static_dir=root, executable_path=browser_executable,
        )
        with Image.open(io.BytesIO(result)) as image:
            assert image.size == (3, 2)
            assert image.convert("RGB").getpixel((0, 0)) == (255, 0, 0)
            assert image.convert("RGB").getpixel((2, 1)) == (0, 255, 0)
        assert requests == []
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_render_closes_browser_after_failure_and_does_not_retain_cookies(
    tmp_path, browser_executable, monkeypatch
):
    from app.services.label_preview_browser import render_preview_png

    processes = []
    launch = asyncio.create_subprocess_exec

    async def capture_process(*args, **kwargs):
        process = await launch(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)
    write_render_page(tmp_path, """
        window.renderApiLabel = async payload => {
          if (document.cookie) throw Error('Previous request cookie leaked');
          if (payload.fail) { document.cookie = 'private=1'; throw Error('bad label'); }
          return document.createElement('canvas').toDataURL('image/png');
        };
    """)
    with pytest.raises(HTTPException) as rejected:
        await render_preview_png(
            {"fail": True}, "http://labels.invalid", {},
            static_dir=tmp_path, executable_path=browser_executable,
        )
    assert rejected.value.status_code == 422
    assert processes and all(process.returncode is not None for process in processes)
    png = await render_preview_png(
        {}, "http://labels.invalid", {}, static_dir=tmp_path, executable_path=browser_executable,
    )
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(processes) == 2
    assert all(process.returncode is not None for process in processes)


@pytest.mark.asyncio
async def test_render_keeps_chromium_sandboxed_under_the_configured_user(
    tmp_path, browser_executable, monkeypatch
):
    import os
    import pwd

    from app.services.label_preview_browser import render_preview_png

    account = pwd.getpwuid(os.getuid())
    monkeypatch.setenv("LABEL_RENDER_CHROMIUM_USER", account.pw_name)
    monkeypatch.setenv("SECRET_KEY", "must-not-reach-chromium")
    monkeypatch.setenv("SMTP_DSN", "must-not-reach-chromium-either")
    launches = []

    async def capture_process(*args, **kwargs):
        launches.append((args, kwargs))
        raise OSError("stop after launch options are captured")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)
    write_render_page(
        tmp_path,
        "window.renderApiLabel = () => document.createElement('canvas').toDataURL('image/png')",
    )

    with pytest.raises(HTTPException):
        await render_preview_png(
            {},
            "http://labels.invalid",
            {},
            static_dir=tmp_path,
            executable_path=browser_executable,
        )

    args, options = launches[0]
    assert "--no-sandbox" not in args
    assert options["user"] == account.pw_uid
    assert options["group"] == account.pw_gid
    assert "SECRET_KEY" not in options["env"]
    assert "SMTP_DSN" not in options["env"]


@pytest.mark.asyncio
async def test_armv7_keeps_the_zygote_required_by_the_sandbox(
    tmp_path, browser_executable, monkeypatch
):
    from app.services import label_preview_browser

    launches = []

    async def capture_process(*args, **kwargs):
        launches.append(args)
        raise OSError("stop after argv is captured")

    monkeypatch.setattr(label_preview_browser.sys, "platform", "linux")
    monkeypatch.setattr(label_preview_browser.platform, "machine", lambda: "armv7l")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)
    write_render_page(tmp_path, "window.renderApiLabel = () => ''")

    with pytest.raises(HTTPException):
        await label_preview_browser.render_preview_png(
            {}, "http://labels.invalid", {},
            static_dir=tmp_path, executable_path=browser_executable,
        )

    assert "--disable-gpu" in launches[0]
    assert "--in-process-gpu" in launches[0]
    assert "--no-zygote" not in launches[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("render_user", [None, "root"])
async def test_root_renderer_requires_a_non_root_browser_user(
    tmp_path, browser_executable, monkeypatch, render_user
):
    from app.services.label_preview_browser import render_preview_png

    write_render_page(
        tmp_path,
        "window.renderApiLabel = () => document.createElement('canvas').toDataURL('image/png')",
    )
    monkeypatch.setattr("os.geteuid", lambda: 0)
    if render_user is None:
        monkeypatch.delenv("LABEL_RENDER_CHROMIUM_USER", raising=False)
    else:
        monkeypatch.setenv("LABEL_RENDER_CHROMIUM_USER", render_user)

    with pytest.raises(HTTPException) as rejected:
        await render_preview_png(
            {},
            "http://labels.invalid",
            {},
            static_dir=tmp_path,
            executable_path=browser_executable,
        )

    assert rejected.value.status_code == 503
    assert rejected.value.detail == "Label renderer requires an unprivileged user"


@pytest.mark.asyncio
async def test_root_renderer_drops_supplementary_groups(
    tmp_path, browser_executable, monkeypatch
):
    import os
    import pwd

    from app.services.label_preview_browser import render_preview_png

    account = pwd.getpwuid(os.getuid())
    monkeypatch.setenv("LABEL_RENDER_CHROMIUM_USER", account.pw_name)
    monkeypatch.setattr("os.geteuid", lambda: 0)
    launches = []

    async def capture_process(*args, **kwargs):
        launches.append((args, kwargs))
        raise OSError("stop after launch options are captured")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_process)
    write_render_page(tmp_path, "window.renderApiLabel = () => ''")

    with pytest.raises(HTTPException):
        await render_preview_png(
            {},
            "http://labels.invalid",
            {},
            static_dir=tmp_path,
            executable_path=browser_executable,
        )

    assert launches[0][1]["extra_groups"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["build", "binary"])
async def test_missing_browser_runtime_returns_clear_503(tmp_path, missing):
    from app.services.label_preview_browser import render_preview_png

    if missing == "binary":
        write_render_page(tmp_path, "window.renderApiLabel = () => ''")
    with pytest.raises(HTTPException) as rejected:
        await render_preview_png(
            {}, "http://labels.invalid", {}, static_dir=tmp_path,
            executable_path=str(tmp_path / "missing-chromium"),
        )
    assert rejected.value.status_code == 503
    assert ("build" if missing == "build" else "Chromium") in rejected.value.detail


@pytest.mark.asyncio
async def test_render_slot_rejects_concurrent_work_and_releases_after_failure(tmp_path, monkeypatch):
    from app.core.file_lock import exclusive_file_lock
    from app.services import label_preview_browser

    lock_path = tmp_path / "renderer.lock"
    monkeypatch.setattr(label_preview_browser, "_LOCK_PATH", lock_path)
    with pytest.raises(ValueError, match="render failed"):
        async with label_preview_browser.label_render_slot():
            with pytest.raises(HTTPException) as busy:
                async with label_preview_browser.label_render_slot():
                    pytest.fail("A second renderer entered the slot")
            assert busy.value.status_code == 503
            assert busy.value.headers["Retry-After"] == "1"
            raise ValueError("render failed")
    with exclusive_file_lock(lock_path):
        with pytest.raises(HTTPException) as busy:
            async with label_preview_browser.label_render_slot():
                pytest.fail("Renderer ignored an existing worker lock")
        assert busy.value.status_code == 503
    async with label_preview_browser.label_render_slot():
        pass


@pytest.mark.asyncio
async def test_origin_credentials_are_rejected_before_loading_page(tmp_path, browser_executable):
    from app.services.label_preview_browser import render_preview_png

    write_render_page(tmp_path, "window.renderApiLabel = () => ''")
    with pytest.raises(HTTPException) as rejected:
        await render_preview_png(
            {}, "http://:secret@labels.invalid", {}, static_dir=tmp_path,
            executable_path=browser_executable,
        )
    assert rejected.value.status_code == 422
    assert rejected.value.detail == "Invalid label renderer origin"


def test_service_imports_without_playwright():
    import subprocess
    import sys
    result = subprocess.run([sys.executable, "-c", "import sys; sys.modules['playwright'] = None; from app.services.label_preview_browser import render_preview_png"], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["crash", "timeout", "cancel", "resource"])
async def test_browser_failure_reaps_process_and_profile(tmp_path, browser_executable, monkeypatch, failure):
    import os
    import signal

    from app.services import label_preview_browser as service

    launched = asyncio.Event()
    processes, profiles = [], []
    original = asyncio.create_subprocess_exec

    async def capture(*args, **kwargs):
        process = await original(*args, **kwargs)
        processes.append(process)
        profiles.extend(Path(arg.split("=", 1)[1]) for arg in args if arg.startswith("--user-data-dir="))
        launched.set()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)
    write_render_page(tmp_path, "window.renderApiLabel = async () => new Promise(() => {})")
    if failure == "timeout":
        monkeypatch.setattr(service, "_RENDER_TIMEOUT_SECONDS", 0.5)
    if failure == "resource":
        read = Path.read_bytes
        def broken_read(path):
            if path.name == "render.js":
                raise RuntimeError("resource failed")
            return read(path)
        monkeypatch.setattr(Path, "read_bytes", broken_read)
    async def run():
        async with service.label_render_slot():
            return await service.render_preview_png({}, "http://labels.invalid", {}, static_dir=tmp_path, executable_path=browser_executable)
    task = asyncio.create_task(run())
    await asyncio.wait_for(launched.wait(), 5)
    if not profiles:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        pytest.fail("Chromium must be launched directly")
    if failure in ("crash", "cancel"):
        await asyncio.sleep(0.5)
        if failure == "crash":
            os.kill(processes[0].pid, signal.SIGKILL)
        else:
            task.cancel()
    with pytest.raises(asyncio.CancelledError if failure == "cancel" else HTTPException) as caught:
        await asyncio.wait_for(task, 6)
    if failure != "cancel":
        assert caught.value.status_code == 503
        assert bool(caught.value.headers and "Retry-After" in caught.value.headers) == (failure == "timeout")
    assert all(process.returncode is not None for process in processes)
    assert all(not profile.exists() for profile in profiles)
    member_process = await original(
        "ps", "-axo", "pgid=,stat=", stdout=asyncio.subprocess.PIPE,
    )
    members, _ = await member_process.communicate()
    groups = {process.pid for process in processes}
    assert not [line for line in members.decode().splitlines()
                if int(line.split()[0]) in groups and not line.split()[1].startswith("Z")]
    async with service.label_render_slot():
        pass
