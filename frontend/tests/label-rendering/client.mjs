import { initWasm, loadFonts, renderLabel, rasterize } from './render.mjs';

const el = id => document.getElementById(id);
const from64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const to64 = value => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''));
const model = await fetch('/probe/fixtures').then(r => r.json());
await initWasm(fetch('/probe/wasm'));
const fonts = await loadFonts(async (_file, index) => new Uint8Array(await fetch(`/probe/font/${index}`).then(r => r.arrayBuffer())));
model.fixtures.forEach(fixture => el('fixture').add(new Option(fixture.title, fixture.id)));

function drawMono(canvas, mono, width, height) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(width, height), stride = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const shade = mono[y * stride + (x >> 3)] & (1 << (7 - (x & 7))) ? 0 : 255;
    image.data.set([shade, shade, shade, 255], i);
  }
  ctx.putImageData(image, 0, 0);
}

let running = false;
async function run() {
  if (running) return;
  running = true; window.probeResult = null;
  el('render').disabled = true; el('status').className = ''; el('status').textContent = 'Rendering…';
  try {
    const fixture = model.fixtures.find(f => f.id === el('fixture').value);
    const preset = structuredClone(fixture.preset), values = fixture.data ?? model.data;
    const info = preset.design.elements.find(e => e.id === 'info' || e.legacyTextRole === 'info');
    if (info) {
      info.w = Math.min(Number(el('width').value), preset.design.label.widthMm - info.x);
      info.wrap = el('wrap').checked; info.fitToWidth = el('fit').checked;
      if (el('minimum').value) info.minFontSizeMm = Number(el('minimum').value);
    }
    const dpi = Number(el('dpi').value), threshold = Number(el('threshold').value);
    const thermal = el('output').value === 'thermal', noLogo = el('no-logo').checked, entityPath = fixture.entityPath ?? 'spools';
    const assets = { ...model.assets, ...(noLogo ? { logo: undefined } : {}) };
    el('source').textContent = fixture.provenance ? `${fixture.provenance.note} Source: ${fixture.provenance.file}.` : 'Synthetic coverage fixture.';
    const start = performance.now();
    let local, raster, renderError;
    try { local = renderLabel(preset, values, assets, fonts, dpi, 'https://fila.test', { thermal, entityPath }); raster = rasterize(local.svg, threshold); }
    catch (error) { renderError = error.message; }
    const milliseconds = performance.now() - start;
    const response = await fetch('/probe/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset, data: values, dpi, threshold, thermal, entityPath, noLogo }) });
    const remote = await response.json();
    if (!response.ok && !renderError) throw new Error(remote.error);
    const remoteMono = remote.mono && from64(remote.mono), remotePixels = remote.pixels && from64(remote.pixels);
    const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    const sameSvg = !!local && local.svg === remote.svg, samePixels = !!raster && equal(raster.pixels, remotePixels), sameMono = !!raster && equal(raster.mono, remoteMono);
    for (const [id, mono, pixels] of [['browser', raster?.mono, raster?.pixels], ['server', remoteMono, remotePixels]]) {
      const canvas = el(id);
      canvas.width = local?.width ?? 320; canvas.height = local?.height ?? 240;
      if (local && thermal) drawMono(canvas, mono, local.width, local.height);
      else if (local) canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), local.width, local.height), 0, 0);
    }
    el('browser-info').textContent = renderError ?? `${local.width} × ${local.height} dots\n${milliseconds.toFixed(1)} ms (warm runtime)`;
    el('server-info').textContent = remote.error ?? `${remote.milliseconds.toFixed(1)} ms (warm runtime)\n${raster.mono.length.toLocaleString()} mono1 bytes`;
    el('layout').textContent = local?.text.map(t => `${t.id}: ${t.size.toFixed(3)} mm, ${t.lines.length} lines\n${t.lines.join('\n')}`).join('\n\n') ?? renderError;
    const qrInfo = local?.qrs.map(q => `QR ${q.modules} modules, ${q.dots.toFixed(2)} dots/module, EC ${q.level}`).join('; ') ?? '';
    const match = sameSvg && samePixels && sameMono;
    el('status').textContent = renderError ? `REJECTED — ${renderError}. Browser/server errors ${renderError === remote.error ? 'agree' : 'DIFFER'}.`
      : `${match ? 'MATCH' : 'MISMATCH'} — SVG, RGBA pixels and mono1 bytes ${match ? 'identical' : 'differ'} across browser/server. ${qrInfo}`;
    el('status').className = renderError ? 'error' : '';
    window.probeResult = { preset, data: values, assets, dpi, threshold, thermal, noLogo, provenance: fixture.provenance,
      error: renderError, sameError: renderError && renderError === remote.error,
      sameSvg, samePixels, sameMono, browserMs: milliseconds, serverMs: remote.milliseconds,
      width: local?.width, height: local?.height, text: local?.text, qrs: local?.qrs,
      browserPng: raster && to64(raster.png), serverPng: remote.png, mono: remote.mono,
      svg: local?.svg };
  } catch (error) {
    el('status').className = 'error'; el('status').textContent = error.message;
    window.probeResult = { error: error.message };
  } finally { running = false; el('render').disabled = false; }
}
el('fixture').addEventListener('change', () => {
  const info = model.fixtures.find(f => f.id === el('fixture').value).preset.design.elements.find(e => e.id === 'info' || e.legacyTextRole === 'info');
  el('width').value = info?.w ?? 38; el('wrap').checked = !!info?.wrap; el('fit').checked = !!info?.fitToWidth;
  el('minimum').value = info?.minFontSizeMm ?? '';
  for (const id of ['width', 'wrap', 'fit', 'minimum']) el(id).disabled = !info;
  void run();
});
el('render').addEventListener('click', run);
void run();
