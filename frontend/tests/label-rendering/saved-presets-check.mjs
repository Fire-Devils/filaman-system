// Original exported layouts stay untouched. Evidence identifies representative data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const directory = process.env.LABEL_EVIDENCE_DIR;
if (!directory) throw new Error('Set LABEL_EVIDENCE_DIR to an ignored artifact directory');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
const rows = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1150 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4407/tests/label-rendering/');
  await page.waitForFunction(() => window.probeResult);
  const ids = await page.locator('#fixture option').evaluateAll(nodes => nodes.map(n => n.value).filter(id => id.startsWith('tester-') || ['styled', 'thermal'].includes(id)));
  assert.ok(ids.includes('tester-4'), 'Start server with LABEL_TESTER_PRESETS_DIR');
  for (const id of ids) for (const dpi of [203, 300]) for (const output of ['thermal', 'normal']) for (const noLogo of [false, true]) {
    await page.selectOption('#fixture', id);
    await page.waitForFunction(() => !document.querySelector('#render').disabled);
    await page.selectOption('#dpi', String(dpi));
    await page.selectOption('#output', output);
    await page.locator('#no-logo').setChecked(noLogo);
    await page.fill('#threshold', '200');
    await page.click('#render');
    await page.waitForFunction(() => window.probeResult && !document.querySelector('#render').disabled);
    const result = await page.evaluate(() => window.probeResult);
    assert.ok(result.error ? result.sameError : result.sameSvg && result.samePixels && result.sameMono, `${id}: runtimes disagree: ${JSON.stringify(result)}`);
    if (id === 'tester-5' && output === 'thermal') assert.match(result.error, /dots per module/);
    if (['styled', 'thermal', 'tester-3'].includes(id)) assert.equal(result.error, undefined, `${id}: ${result.error}`);
    if (!result.error && output === 'thermal') assert.ok(result.qrs.every(q => q.dots >= 3 && Number.isInteger(q.dots) && !q.decorated));
    if (!result.error && id === 'tester-3') assert.ok(result.text.some(t => t.text.includes('Artikel Nr: 11101')), 'Lost last info line');
    const prefix = `${directory}/${id}-${dpi}-${output}${noLogo ? '-no-logo' : ''}`;
    for (const [suffix, key] of [['shared', 'browserPng']]) if (result[key]) await writeFile(`${prefix}-${suffix}.png`, Buffer.from(result[key], 'base64'));
    if (result.svg) await writeFile(`${prefix}.svg`, result.svg);
    if (result.mono) await writeFile(`${prefix}.mono1`, Buffer.from(result.mono, 'base64'));
    if (dpi === 203 && !noLogo) await page.screenshot({ path: `${prefix}-comparison.png`, fullPage: true });
    const { svg, mono, assets, browserPng, serverPng, ...summary } = result;
    rows.push({ id, ...summary });
  }
  // Explicitly separate a proposed setting change from untouched exports above.
  await page.selectOption('#fixture', 'tester-4');
  await page.waitForFunction(() => !document.querySelector('#render').disabled);
  await page.selectOption('#dpi', '203');
  await page.selectOption('#output', 'thermal');
  await page.locator('#no-logo').setChecked(false);
  await page.locator('#fit').setChecked(true);
  await page.fill('#minimum', '1.5');
  await page.click('#render');
  await page.waitForFunction(() => window.probeResult && !document.querySelector('#render').disabled);
  const fitted = await page.evaluate(() => window.probeResult);
  assert.equal(fitted.error, undefined);
  assert.ok(fitted.sameSvg && fitted.samePixels && fitted.sameMono);
  const info = fitted.text.find(t => t.text.includes('Hinzugefügt'));
  assert.ok(info.size < 2 && info.lines.join('').includes('Artikel Nr: 11101'));
  await page.locator('#source').evaluate(node => { node.textContent = 'MODIFIED COMPARISON COPY: tester 4 with Scale font to fit enabled and 1.5 mm minimum, shared across all renderers. Original export unchanged. Representative data and synthetic logo.'; });
  await page.screenshot({ path: `${directory}/tester-4-fit-enabled-comparison.png`, fullPage: true });
  await writeFile(`${directory}/tester-4-fit-enabled.png`, Buffer.from(fitted.browserPng, 'base64'));
  const { svg, mono, assets, browserPng, serverPng, ...fitSummary } = fitted;
  await writeFile(`${directory}/tester-4-fit-enabled.json`, JSON.stringify(fitSummary, null, 2));
  await writeFile(`${directory}/saved-presets-results.json`, JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ comparisons: rows.length, rendered: rows.filter(r => !r.error).length,
    rejected: rows.filter(r => r.error).map(({ id, dpi, thermal, noLogo, error }) => ({ id, dpi, thermal, noLogo, error })) }, null, 2));
} finally { await browser.close(); }
