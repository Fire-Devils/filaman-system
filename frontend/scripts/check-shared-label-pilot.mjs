// Local browser fixtures only: never sends writes or print commands to a server.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.argv[2] || 'http://127.0.0.1:4408';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Local test server required');
const directory = process.env.LABEL_EVIDENCE_DIR;
if (!directory) throw new Error('Set LABEL_EVIDENCE_DIR to an ignored evidence directory');
await mkdir(directory, { recursive: true });
const logo = await readFile('public/logo-qr.png');
const design = { version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 1, border: false }, elements: [
  { id: 'text', type: 'text', x: 2, y: 9, w: 33, h: 21, z: 0,
    template: '{filament.name}\n[font=Fraunces]Grüße[/font] [font=Space Mono]Ä Ö Ü ß[/font]\n[font=Roboto Condensed][b]größere Füße[/b][/font]',
    fontFamily: 'Space Grotesk', fontSizeMm: 2.5, fontWeight: 400, wrap: true, fitToWidth: true, minFontSizeMm: 1.5 },
  { id: 'image', type: 'image', assetId: '12345678-1234-1234-1234-123456789abc', x: 2, y: 1, w: 28, h: 7, z: 1, objectFit: 'contain' },
  { id: 'shape', type: 'shape', shape: 'circle', x: 3, y: 32, w: 5, h: 5, z: 2, fill: '#f4a123', stroke: '#000', strokeWidthMm: .3 },
  { id: 'qr', type: 'qr', x: 39, y: 12, w: 18, h: 18, z: 3, mode: 'colorLogo', linkMode: 'spool', urlTemplate: '' },
] };
const filament = { id: 8, designation: 'Matte Charcoal 11101', material_type: 'PLA', diameter_mm: 1.75, manufacturer_id: 1, manufacturer: { id: 1, name: 'Bambu Lab' }, extra: {} };
const spool = { id: 295, filament_id: 8, filament, remaining_weight_g: 432, purchase_date: '2026-10-05', extra: {} };
const migratedFilament = { ...filament, drying_temp_c: 55, bed_temp_range_c: { min: 60, max: 70 },
  label_field_aliases: { my_dryer: 'drying_temp_c' } };
const migratedSpool = { ...spool, filament: migratedFilament, label_field_aliases: { bed: 'bed_temp_range_c' } };
let migrated = false;
let entityResponseGate = null;
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  async function openDesigner() {
    await page.locator('#label-preview .label-designation, #freeform-canvas-host [data-label-svg-raster]').first().waitFor({ state: 'attached' });
    await page.locator('#tab-btn-designer').click();
  }
  page.setDefaultTimeout(30_000);
  page.on('dialog', async dialog => { console.error(dialog.message()); await dialog.dismiss(); });
  await page.addInitScript(design => {
    for (const entity of ['spool', 'filament']) {
      const key = `filaman-${entity}-label-designer-v1`;
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 2, design }));
    }
    localStorage.setItem('sidebar-collapsed', 'true');
  }, design);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/label-assets/') && path.endsWith('/content') || path.endsWith('/label-logo')) return route.fulfill({ contentType: 'image/png', body: logo });
    let data = [];
    if (path.endsWith('/me')) data = { id: 1, email: 'label@example.test', language: 'en', roles: ['user'], permissions: [] };
    if (/\/filaments\/[89]$/.test(path)) data = { ...(migrated ? migratedFilament : filament), id: Number(path.split('/').at(-1)) };
    if (/\/spools\/29[56]$/.test(path)) data = { ...(migrated ? migratedSpool : spool), id: Number(path.split('/').at(-1)) };
    if (/\/(filaments\/[89]|spools\/29[56])$/.test(path)) {
      await entityResponseGate;
    }
    if (path.endsWith('/label-assets')) data = [{ id: design.elements[1].assetId, display_name: 'Fixture logo', width: 100, height: 50 }];
    if (path.endsWith('/events/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  // A late entity response must not reset a tab the user already selected.
  for (const url of ['/spools/295/print', '/filaments/8/print', '/spools/print?ids=295,296', '/filaments/print?ids=8,9']) {
    console.log(`Checking pending-data Designer selection: ${url}`);
    let release;
    entityResponseGate = new Promise(resolve => { release = resolve; });
    const requested = page.waitForRequest(request => /\/api\/v1\/(spools\/295|filaments\/8)$/.test(new URL(request.url()).pathname));
    await page.goto(`${origin}${url}`, { waitUntil: 'domcontentloaded' });
    await requested;
    assert.equal(new URL(page.url()).pathname, url.split('?')[0]);
    await page.locator('#tab-btn-designer').click();
    assert.equal(await page.locator('#tab-btn-designer').getAttribute('aria-selected'), 'true');
    release();
    entityResponseGate = null;
    await page.locator('#freeform-canvas-host [data-label-svg-raster]').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#freeform-canvas-host [data-label-element-id="text"]')?.textContent.includes('Matte Charcoal 11101'));
    assert.equal(await page.locator('#tab-btn-designer').getAttribute('aria-selected'), 'true');
    await page.evaluate(() => {
      localStorage.removeItem('filaman-label-active-tab');
      localStorage.removeItem('filaman-filament-label-active-tab');
    });
  }
  console.log('Single/batch labels: early Designer selection survives pending entity data');
  // Saved dynamic tokens render after promotion, but never become picker choices.
  migrated = true;
  for (const handoff of [false, true]) for (const entity of ['spools', 'filaments']) {
    const id = entity === 'spools' ? 295 : 8;
    await page.goto(`${origin}/${entity}/${id}/print`);
    await openDesigner();
    await page.evaluate(({ entity, id, handoff, design }) => {
      const kind = entity === 'spools' ? 'spool' : 'filament';
      localStorage.setItem(`filaman-${kind}-label-designer-v1`, JSON.stringify({ version: 2, design: {
        ...design, elements: [{ ...design.elements[0], template: 'Dryer={extra.filament.my_dryer}; Bed={extra.spool.bed}', w: 56, h: 30 }],
      } }));
      if (handoff) sessionStorage.setItem(kind === 'spool' ? 'filaman-label-extra-fields' : 'filaman-filament-label-extra-fields', JSON.stringify({
        entityId: String(id), fields: [{ key: `${kind}.note`, label: 'Note', source: kind, value: 'Keep dry' }],
      }));
    }, { entity, id, handoff, design });
    await page.reload();
    await openDesigner();
    await page.locator('#freeform-canvas-host [data-label-svg-raster]').waitFor();
    await page.waitForFunction(expected => document.querySelector('#freeform-canvas-host [data-label-element-id="text"]')?.textContent === expected,
      entity === 'spools' ? 'Dryer=55; Bed=60–70' : 'Dryer=55; Bed=');
    assert.equal(await page.locator('[data-field-token="{extra.filament.my_dryer}"], [data-field-token="{extra.spool.bed}"]').count(), 0);
    assert.equal(await page.locator('[id="check-ef-filament.my_dryer"], [id="check-ef-spool.bed"]').count(), 0);
  }
  migrated = false;
  await page.evaluate(design => {
    for (const entity of ['spool', 'filament']) localStorage.setItem(`filaman-${entity}-label-designer-v1`, JSON.stringify({ version: 2, design }));
    localStorage.removeItem('filaman-label-active-tab');
    localStorage.removeItem('filaman-filament-label-active-tab');
  }, design);
  console.log('Single labels: migrated aliases render with/without session handoff and stay hidden from pickers');
  for (const entity of ['spools', 'filaments']) {
    await page.goto(`${origin}/${entity}/${entity === 'spools' ? 295 : 8}/print`);
    await openDesigner();
    const surface = page.locator('#freeform-canvas-host .label-preview').first();
    await surface.locator('[data-label-svg-raster]').waitFor();
    assert.equal(await surface.locator('[data-label-output-error]').count(), 0);
    // Editing chrome must not re-center the label-plus-inspector as a group.
    for (const [width, zoom] of [[1600, 100], [1100, 250]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('#preview-zoom-input').fill(String(zoom));
      await page.locator('#preview-zoom-input').press('Tab');
      await page.locator('.freeform-canvas-region').click({ position: { x: 8, y: 8 } });
      const anchor = await surface.boundingBox();
      for (const id of ['text', 'qr']) {
        await surface.locator(`[data-label-element-id="${id}"]`).click();
        const editing = await surface.boundingBox();
        assert.ok(Math.abs(editing.x - anchor.x) < 1 && Math.abs(editing.y - anchor.y) < 1,
          `${entity} ${width}px/${zoom}%: selecting ${id} moved the label`);
        await page.locator('.freeform-canvas-region').click({ position: { x: 8, y: 8 } });
        const cleared = await surface.boundingBox();
        assert.ok(Math.abs(cleared.x - anchor.x) < 1 && Math.abs(cleared.y - anchor.y) < 1);
      }
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('#preview-zoom-input').fill('100');
    await page.locator('#preview-zoom-input').press('Tab');
    const initial = await surface.locator('[data-label-svg-raster]').getAttribute('src');
    await surface.locator('[data-label-element-id="text"]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Ende');
    await page.waitForFunction(previous => document.querySelector('#freeform-canvas-host [data-label-svg-raster]')?.getAttribute('src') !== previous, initial);
    await page.keyboard.press('Escape');
    const saved = await page.evaluate(entity => JSON.parse(localStorage.getItem(`filaman-${entity === 'spools' ? 'spool' : 'filament'}-label-designer-v1`)), entity);
    assert.ok(saved.design.elements.find(e => e.id === 'text').template.includes('Ende'));
    // Exercise undo/redo through the real keyboard controller.
    await page.locator('#freeform-canvas-host').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    const shape = surface.locator('[data-label-element-id="shape"]');
    const before = await shape.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => Number.parseFloat(document.querySelector('#freeform-canvas-host [data-label-element-id="shape"]').style.left) > 3);
    await page.keyboard.press('Escape');
    await surface.screenshot({ path: `${directory}/${entity}-shared-editor.png` });
    const raster = await surface.locator('[data-label-svg-raster]').getAttribute('src');
    await writeFile(`${directory}/${entity}-shared-preview.png`, Buffer.from(raster.split(',')[1], 'base64'));
    const beforeReload = await page.evaluate(entity => localStorage.getItem(`filaman-${entity === 'spools' ? 'spool' : 'filament'}-label-designer-v1`), entity);
    await page.reload();
    await openDesigner();
    await surface.locator('[data-label-svg-raster]').waitFor();
    assert.equal(await page.evaluate(entity => localStorage.getItem(`filaman-${entity === 'spools' ? 'spool' : 'filament'}-label-designer-v1`), entity), beforeReload);
    await page.waitForFunction(async () => {
      try {
        const { renderSvgElementOutput } = await import('/src/lib/label-svg/browser.ts');
        await renderSvgElementOutput(document.querySelector('#freeform-canvas-host .label-preview'), 1417, 945, false);
        return true;
      } catch { return false; }
    });
    const exported = await page.evaluate(async () => {
      const { captureLabelElement, createLabelPagesPdf } = await import('/src/lib/label-export.ts');
      const { renderSvgElementOutput, pngDataUrl } = await import('/src/lib/label-svg/browser.ts');
      const root = document.querySelector('#freeform-canvas-host .label-preview');
      const png = await captureLabelElement(root);
      const expected = pngDataUrl((await renderSvgElementOutput(root, 1417, 945, false)).png);
      if (png !== expected) throw new Error('Export differs from shared pixels');
      const pdf = await createLabelPagesPdf([{ dataUrl: png, widthMm: 60, heightMm: 40 }]);
      const bytes = new Uint8Array(await pdf.output('blob').arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      return { png: png.split(',')[1], pdf: btoa(binary) };
    });
    await writeFile(`${directory}/${entity}-export-600dpi.png`, Buffer.from(exported.png, 'base64'));
    await writeFile(`${directory}/${entity}-export.pdf`, Buffer.from(exported.pdf, 'base64'));
    for (const mode of ['individual', 'sheet']) {
      if (mode === 'sheet') {
        await page.locator('#tab-btn-sheets').click();
        await page.locator('[name="label-sheet-source"][value="designer"]').check();
        for (const [id, value] of [['sheet-columns', '2'], ['sheet-rows', '2'], ['sheet-copies', '5']]) {
          await page.locator('#' + id).fill(value);
          await page.locator('#' + id).press('Tab');
        }
        await page.locator('#sheet-print-grid').check();
        await page.waitForFunction(() => document.querySelectorAll('.label-sheet-page [data-label-svg]').length === 5);
      }
      await page.evaluate(() => {
        window.__previewInvoked = false;
        window.print = () => { window.__previewInvoked = true; }; // No physical printing.
      });
      await page.locator('#check-print-pdf').uncheck();
      await page.locator('#btn-print').click();
      await page.waitForFunction(() => window.__previewInvoked);
      const info = await page.evaluate(() => {
        const host = document.querySelector('#filaman-label-print-host');
        if (host.querySelector('[data-label-editor-chrome], [contenteditable], [data-label-selection-for]')) throw new Error('Editor chrome leaked into print');
        return { invoked: window.__previewInvoked, pages: host.querySelectorAll('.filaman-print-page').length,
          expectedWidths: [...host.querySelectorAll('[data-label-svg]')].map(label => Math.round(parseFloat(label.style.width) * 600 / 25.4)),
          widths: [...host.querySelectorAll('[data-label-svg-raster]')].map(image => image.naturalWidth) };
      });
      assert.ok(info.invoked);
      assert.equal(info.pages, mode === 'individual' ? 1 : 2);
      assert.deepEqual(info.widths, info.expectedWidths);
      await page.pdf({ path: `${directory}/${entity}-${mode}-browser-print.pdf`, preferCSSPageSize: true, printBackground: true });
      await page.evaluate(async () => (await import('/src/lib/label-browser-print.ts')).cleanupLabelBrowserPrint());
    }
    // Switching away must not export the last designer bitmap or leave stale output errors.
    await page.locator('#tab-btn-print').click();
    await page.waitForFunction(() => document.querySelector('#label-preview .label-designation')?.textContent.includes('Matte'));
    assert.equal(await page.locator('#label-preview').getAttribute('data-label-svg'), null);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export-png').click()]);
    const standardPath = `${directory}/${entity}-standard-after-designer.png`;
    await download.saveAs(standardPath);
    assert.notEqual((await readFile(standardPath)).toString('base64'), exported.png);
    await page.evaluate(() => { window.__previewInvoked = false; });
    await page.locator('#btn-print').click();
    await page.waitForFunction(() => window.__previewInvoked);
    await page.evaluate(async () => (await import('/src/lib/label-browser-print.ts')).cleanupLabelBrowserPrint());
    console.log(`${entity}: mixed fonts, image, decorated QR, inline edit, undo/redo, drag, reload passed`);
  }
} finally { await browser.close(); }
