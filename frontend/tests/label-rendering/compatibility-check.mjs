// Expanded font/shape compatibility matrix for the shared renderer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const directory = process.env.LABEL_EVIDENCE_DIR;
if (directory) await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.goto('http://127.0.0.1:4407/tests/label-rendering/');
  await page.waitForFunction(() => window.probeResult);
  const results = await page.evaluate(async () => {
    const { renderLabel, rasterize, loadFonts } = await import('/tests/label-rendering/render.mjs');
    const { LABEL_FONT_FAMILIES, LABEL_FONT_WEIGHTS, LABEL_SHAPES } = await import('/src/lib/freeform-label/types.ts');
    const model = await fetch('/probe/fixtures').then(r => r.json());
    const fonts = await loadFonts(async (_file, index) => new Uint8Array(await fetch(`/probe/font/${index}`).then(r => r.arrayBuffer())));
    const phrase = 'Ä Ö Ü ä ö ü ß — Grüße, größere Füße, süß';
    const text = (extra = {}) => ({ id: 'text', type: 'text', x: 1, y: 1, w: 38, h: 28,
      template: phrase, fontFamily: 'Space Grotesk', fontWeight: 400, fontSizeMm: 3,
      wrap: true, fitToWidth: true, minFontSizeMm: 1, color: '#000000', ...extra });
    const preset = elements => ({ version: 2, design: { version: 2,
      label: { widthMm: 40, heightMm: 30, marginMm: 1, border: false }, elements } });
    const cases = [];
    for (const fontFamily of LABEL_FONT_FAMILIES) for (const fontWeight of LABEL_FONT_WEIGHTS)
      for (const options of [
        { name: 'wrap', w: 18, h: 28, wrap: true, fitToWidth: false },
        { name: 'wrap + fit', w: 18, h: 9, wrap: true, fitToWidth: true },
        { name: 'no-wrap + fit', w: 38, h: 28, wrap: false, fitToWidth: true },
      ]) cases.push({ name: `${fontFamily} ${fontWeight} ${options.name}`, fontCase: options.name,
        elements: [text({ fontFamily, fontWeight, ...options })] });
    for (const shape of LABEL_SHAPES) cases.push({ name: shape, elements: [{ id: shape,
      type: 'shape', shape, x: 3, y: 3, w: 12, h: shape === 'line' ? 1 : shape === 'rectangle' ? 8 : 12,
      fill: '#eeeeee', stroke: '#000000', strokeWidthMm: 0.5, radiusMm: 0 }] });
    cases.push(
      { name: 'Mixed font families in separate boxes', elements: LABEL_FONT_FAMILIES.map((fontFamily, i) => text({ id: `font-${i}`, fontFamily, y: 1 + i * 7, h: 6, fontSizeMm: 2 })) },
      { name: 'Mixed regular/bold in separate boxes', elements: [text({ y: 1, h: 13 }), text({ id: 'bold', y: 16, h: 13, fontWeight: 700 })] },
      { name: 'Mixed inline fonts', elements: [text({ template: 'Grüße [font=Fraunces]größere Füße[/font]' })] },
      { name: 'Mixed inline bold', elements: [text({ template: 'Grüße **größere Füße**' })] },
      { name: 'Font-tag separator wrap boundary', elements: [text({ w: 5, h: 20, fitToWidth: false, template: 'A[font=Space Mono] B[/font]' })] },
      { name: 'Empty conditional', elements: [text({ w: 5, h: 0.5, fitToWidth: false, template: '[if={missing}]ÄÖÜ[/if]' })] },
      { name: 'Umlauts, wrapped', elements: [text({ w: 18 })] },
      { name: 'Umlauts, shrink to fit', elements: [text({ w: 18, h: 9 })] },
      { name: 'Umlauts, no-wrap shrink to fit', elements: [text({ wrap: false })] },
      { name: 'Explicit blank lines', elements: [text({ template: 'ÄÖÜ\n\näöü ß', wrap: false })] },
      { name: 'Too small at minimum font', elements: [text({ w: 5, h: 1 })] },
      { name: 'All drawing elements together', elements: LABEL_SHAPES.map((shape, i) => ({ id: shape, type: 'shape', shape, x: 1 + i * 9, y: 3, w: 8, h: shape === 'rectangle' ? 5 : 8, fill: '#eeeeee', stroke: '#000000', strokeWidthMm: 0.4, radiusMm: 0 })) },
    );
    const rows = [];
    for (const item of cases) for (const dpi of [203, 300]) for (const threshold of [150, 200]) {
      const input = preset(item.elements);
      let local, raster, error;
      try { local = renderLabel(input, model.data, model.assets, fonts, dpi); raster = rasterize(local.svg, threshold); }
      catch (caught) { error = caught.message; }
      const response = await fetch('/probe/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: input, data: model.data, dpi, threshold }) });
      const remote = await response.json();
      const mono = remote.mono && Uint8Array.from(atob(remote.mono), c => c.charCodeAt(0));
      const pixels = remote.pixels && Uint8Array.from(atob(remote.pixels), c => c.charCodeAt(0));
      rows.push({ name: item.name, fontCase: item.fontCase, dpi, threshold, status: error ? 'unsupported/error' : 'rendered', error,
        same: error ? error === remote.error : response.ok && local.svg === remote.svg && raster.mono.length === mono.length && raster.mono.every((v, i) => v === mono[i]) && raster.pixels.length === pixels.length && raster.pixels.every((v, i) => v === pixels[i]),
        text: local?.text, ink: raster?.mono.some(v => v !== 0) });
    }
    return { rows };
  });
  assert.ok(results.rows.every(row => row.same), 'Browser/server outcomes differ');
  for (const row of results.rows) assert.equal(row.status === 'rendered', row.name !== 'Too small at minimum font', row.name);
  assert.ok(results.rows.filter(row => row.status === 'rendered' && row.name !== 'Empty conditional').every(row => row.ink), 'Blank raster');
  for (const row of results.rows.filter(row => row.name === 'Empty conditional')) assert.equal(row.ink, false);
  for (const row of results.rows.filter(row => row.name === 'Font-tag separator wrap boundary')) assert.deepEqual(row.text[0].lines, ['A', 'B']);
  for (const row of results.rows.filter(row => row.text && (row.fontCase || row.name.startsWith('Umlauts')))) {
    assert.equal(row.text[0].lines.join('').replace(/\s/g, ''), 'Ä Ö Ü ä ö ü ß — Grüße, größere Füße, süß'.replace(/\s/g, ''));
    if (row.name === 'Umlauts, shrink to fit' || row.fontCase?.includes('fit')) assert.ok(row.text[0].size < 3 && row.text[0].size >= 1, row.name);
    if (row.name === 'Umlauts, wrapped' || row.fontCase === 'wrap') assert.ok(row.text[0].lines.length > 1, row.name);
  }
  if (directory) await writeFile(`${directory}/compatibility-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ cases: results.rows.length, rendered: results.rows.filter(r => r.status === 'rendered').length,
    rows: results.rows.filter(r => r.dpi === 203 && r.threshold === 200).map(({ name, status, error }) => ({ name, status, error })) }, null, 2));
} finally { await browser.close(); }
