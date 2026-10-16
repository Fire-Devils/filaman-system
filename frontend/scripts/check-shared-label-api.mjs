// Browser/WASM versus the real authenticated Python API, using its isolated test evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const evidence = process.env.LABEL_EVIDENCE_DIR;
if (!evidence) throw new Error('Set LABEL_EVIDENCE_DIR to the API fixture evidence');
const fixtures = JSON.parse(await readFile(`${evidence}/api-parity.json`, 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/shared-parity', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local renderer parity</title>' }));
  await page.goto('http://127.0.0.1:4408/shared-parity');
  for (const row of fixtures.cases) {
    const result = await page.evaluate(async ({ payload, origin, assets, threshold }) => {
      const { createSvgRuntime } = await import('/src/lib/label-svg/runtime.mjs');
      const { renderSvgLabel } = await import('/src/lib/label-svg/core.mjs');
      const { prepareSvgApiInput } = await import('/src/lib/label-svg/prepare-api.ts');
      const runtime = await createSvgRuntime(async path => new Uint8Array(await (await fetch('/node_modules/' + path)).arrayBuffer()));
      const logo = new Uint8Array(await (await fetch('/logo-qr.png')).arrayBuffer());
      const encode = bytes => {
        let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(value);
      };
      const dimensions = new DataView(logo.buffer);
      assets.qrLogo = { dataUrl: 'data:image/png;base64,' + encode(logo), width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
      try {
        const output = renderSvgLabel(prepareSvgApiInput(payload, origin, assets), runtime, threshold);
        return { width: output.width, height: output.height, rgba: encode(output.pixels), mono: encode(output.mono) };
      } catch (error) { return { error: error.message }; }
    }, row);
    if (row.status !== 200) {
      assert.equal(result.error, row.error, row.name);
      continue;
    }
    assert.equal(result.error, undefined, row.name);
    const pixels = Buffer.from(result.rgba, 'base64');
    assert.deepEqual(pixels, Buffer.from(row.rgba, 'base64'), `${row.name}: raw RGBA`);
    const width = +row.headers['x-image-width'], height = +row.headers['x-image-height'];
    const contentWidth = +row.headers['x-content-width'], rotated = row.headers['x-rotated'] === '1';
    const offset = row.align === 'right' ? width - contentWidth : 0;
    const wire = Buffer.alloc(row.format === 'png' ? width * height * 4 : Math.ceil(width / 8) * height, row.format === 'png' ? 255 : 0);
    const mono = Buffer.from(result.mono, 'base64');
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const dx = offset + (rotated ? y : x), dy = rotated ? result.width - 1 - x : y;
      if (row.format === 'png') pixels.copy(wire, (dy * width + dx) * 4, (y * result.width + x) * 4, (y * result.width + x + 1) * 4);
      else if (mono[y * Math.ceil(result.width / 8) + (x >> 3)] & (1 << (7 - (x & 7)))) wire[dy * Math.ceil(width / 8) + (dx >> 3)] |= 1 << (7 - (dx & 7));
    }
    assert.deepEqual(wire, Buffer.from(row.format === 'png' ? row.wireRgba : row.wire, 'base64'), `${row.name}: API wire pixels`);
  }
  console.log(`${fixtures.cases.length} real API/browser outcomes match, including final wire padding, rotation and thresholds; ${fixtures.node} ${fixtures.architecture}.`);
} finally { await browser.close(); }
