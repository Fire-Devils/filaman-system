// Browser/Node pixel and wire-format parity; Chromium is only the test browser.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const directory = process.env.LABEL_EVIDENCE_DIR;
if (directory) await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
const rows = [];
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4407/tests/label-rendering/');
  await page.waitForFunction(() => window.probeResult);
  for (const id of ['wrapped', 'images', 'thermal', 'fonts', 'mixed']) for (const dpi of [203, 300]) for (const threshold of [150, 200]) {
    await page.selectOption('#fixture', id);
    await page.waitForFunction(() => !document.querySelector('#render').disabled);
    await page.selectOption('#dpi', String(dpi));
    await page.fill('#threshold', String(threshold));
    await page.click('#render');
    await page.waitForFunction(() => window.probeResult && !document.querySelector('#render').disabled);
    const result = await page.evaluate(() => window.probeResult);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.sameSvg && result.samePixels && result.sameMono, `${id}: browser/server differ`);
    assert.equal(result.preset.version, 2);
    assert.equal(result.width, dpi === 203 ? 320 : 472);
    assert.equal(result.height, dpi === 203 ? 240 : 354);
    if (directory) {
      const prefix = `${directory}/${id}-${dpi}-${threshold}`;
      for (const [name, key] of [['browser', 'browserPng'], ['server', 'serverPng']]) {
        await writeFile(`${prefix}-${name}.png`, Buffer.from(result[key], 'base64'));
      }
      await writeFile(`${prefix}.mono1`, Buffer.from(result.mono, 'base64'));
      await writeFile(`${prefix}.svg`, result.svg);
      if (dpi === 203 && threshold === 200) await page.screenshot({ path: `${directory}/${id}-comparison.png`, fullPage: true });
    }
    const summary = { ...result };
    for (const key of ['svg', 'mono', 'assets', 'browserPng', 'serverPng']) delete summary[key];
    rows.push({ id, ...summary });
  }
  // Check actual controls: narrowing a box changes the shared wrap, not just a screenshot.
  await page.selectOption('#fixture', 'wrapped');
  await page.waitForFunction(() => !document.querySelector('#render').disabled);
  await page.fill('#width', '22');
  await page.click('#render');
  await page.waitForFunction(() => window.probeResult && !document.querySelector('#render').disabled);
  const narrow = await page.evaluate(() => window.probeResult);
  assert.equal(narrow.error, undefined);
  assert.ok(narrow.samePixels && narrow.sameMono);
  assert.ok(narrow.text.find(t => t.id === 'info').lines.length > 6);
  await page.uncheck('#wrap'); await page.uncheck('#fit');
  await page.click('#render');
  await page.waitForFunction(() => window.probeResult && !document.querySelector('#render').disabled);
  assert.match((await page.evaluate(() => window.probeResult)).error, /fit/i);
  if (directory) await writeFile(`${directory}/results.json`, JSON.stringify(rows, null, 2));
  console.log(`${rows.length} independent browser/server comparisons: SVG, RGBA and mono1 identical. Wrap and overflow controls passed.`);
} finally { await browser.close(); }
