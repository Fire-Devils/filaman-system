import asyncio
import io
import os
import pwd
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException
from PIL import Image

from app.services import label_svg_renderer as renderer


@pytest.fixture
def runtime(monkeypatch):
    node = shutil.which('node')
    assert node
    monkeypatch.setenv('LABEL_RENDER_NODE_EXECUTABLE', node)
    monkeypatch.setenv('LABEL_RENDER_USER', pwd.getpwuid(os.getuid()).pw_name)
    return Path(__file__).resolve().parents[2] / 'frontend/dist/label-svg'


def request():
    return {'spool': {'id': 295, 'filament': {'designation': 'Grüße', 'material_type': 'PLA'}},
            'preset': None, 'fieldDefinitions': {'spool': {}, 'filament': {}},
            'assets': {}, 'pixelWidth': 480, 'pixelHeight': 320, 'thermal': False}


@pytest.mark.asyncio
async def test_real_command_returns_png(runtime):
    png = await renderer.render_svg_png(request(), 'https://fila.test', {}, bundle_dir=runtime)
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (480, 320)


@pytest.mark.asyncio
async def test_clipped_thermal_qr_is_a_validation_error(runtime):
    payload = request()
    payload.update(thermal=True, pixelHeight=360, preset={'version': 2, 'design': {
        'version': 2, 'label': {'widthMm': 40, 'heightMm': 30, 'marginMm': 1},
        'elements': [{'id': 'qr', 'type': 'qr', 'x': 30, 'y': 5, 'w': 18, 'h': 18,
                      'z': 0, 'mode': 'simple', 'linkMode': 'spool'}],
    }})
    with pytest.raises(HTTPException) as error:
        await renderer.render_svg_png(payload, 'https://fila.test', {}, bundle_dir=runtime)
    assert error.value.status_code == 422
    assert 'fit inside the label' in error.value.detail


def test_real_command_under_uvloop(runtime):
    uvloop = pytest.importorskip('uvloop')
    with asyncio.Runner(loop_factory=uvloop.new_event_loop) as runner:
        png = runner.run(renderer.render_svg_png(request(), 'https://fila.test', {}, bundle_dir=runtime))
    assert png.startswith(b'\x89PNG')


@pytest.mark.asyncio
@pytest.mark.parametrize('script,status', [
    ('console.log("not json")', 503),
    ('console.log(JSON.stringify({error:{kind:"layout",message:"Text cannot fit"}}))', 422),
    ('console.log(JSON.stringify({error:{kind:"internal",message:"private"}}))', 503),
    ('process.stdout.write("x".repeat(8192));setInterval(()=>{},100)', 503),
    ('process.stderr.write("x".repeat(8192));setInterval(()=>{},100)', 503),
    ('setInterval(()=>{},100)', 503),
])
async def test_child_failures_are_bounded_and_reaped(runtime, tmp_path, monkeypatch, script, status):
    (tmp_path / 'render.mjs').write_text(script)
    monkeypatch.setattr(renderer, '_TIMEOUT', .3)
    monkeypatch.setattr(renderer, '_MAX_OUTPUT', 4096)
    monkeypatch.setattr(renderer, '_MAX_STDERR', 4096)
    children = []
    popen = subprocess.Popen
    def capture(*args, **kwargs):
        child = popen(*args, **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(renderer.subprocess, 'Popen', capture)
    with pytest.raises(HTTPException) as error:
        await renderer.render_svg_png(request(), 'https://fila.test', {}, bundle_dir=tmp_path)
    assert error.value.status_code == status
    assert children and all(child.poll() is not None for child in children)


@pytest.mark.asyncio
async def test_cancel_kills_and_reaps(runtime, tmp_path, monkeypatch):
    (tmp_path / 'render.mjs').write_text('setInterval(()=>{},100)')
    children = []
    popen = subprocess.Popen
    def capture(*args, **kwargs):
        child = popen(*args, **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(renderer.subprocess, 'Popen', capture)
    task = asyncio.create_task(renderer.render_svg_png(request(), 'https://fila.test', {}, bundle_dir=tmp_path))
    while not children:
        await asyncio.sleep(.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert children[0].poll() is not None


@pytest.mark.asyncio
async def test_missing_runtime_and_large_input(runtime, monkeypatch):
    with pytest.raises(HTTPException) as error:
        await renderer.render_svg_png(request(), 'https://fila.test', {}, executable_path='/missing/node', bundle_dir=runtime)
    assert error.value.status_code == 503
    monkeypatch.setattr(renderer, '_MAX_INPUT', 10)
    with pytest.raises(HTTPException) as error:
        await renderer.render_svg_png(request(), 'https://fila.test', {}, bundle_dir=runtime)
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_render_slot_rejects_concurrent_work_and_releases_after_failure(tmp_path, monkeypatch):
    from app.core.file_lock import exclusive_file_lock
    from app.services import label_svg_renderer

    lock_path = tmp_path / "renderer.lock"
    monkeypatch.setattr(label_svg_renderer, "_LOCK_PATH", lock_path)
    with pytest.raises(ValueError, match="render failed"):
        async with label_svg_renderer.label_render_slot():
            with pytest.raises(HTTPException) as busy:
                async with label_svg_renderer.label_render_slot():
                    pytest.fail("A second renderer entered the slot")
            assert busy.value.status_code == 503
            assert busy.value.headers["Retry-After"] == "1"
            raise ValueError("render failed")
    with exclusive_file_lock(lock_path):
        with pytest.raises(HTTPException) as busy:
            async with label_svg_renderer.label_render_slot():
                pytest.fail("Renderer ignored an existing worker lock")
        assert busy.value.status_code == 503
    async with label_svg_renderer.label_render_slot():
        pass
