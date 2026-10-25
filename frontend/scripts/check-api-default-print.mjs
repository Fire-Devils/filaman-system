/** Seeded smoke test against the built Astro app; no real print job is sent. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright-core'

const origin = 'http://127.0.0.1:4397'
const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '4397' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
server.stdout.on('data', data => { output += data })
server.stderr.on('data', data => { output += data })
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break } catch { /* server starting */ }
    if (attempt > 100 || server.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(15000)
  let pending = null
  let presetsOffline = false
  let entityStatus = 200
  const filament = { id: 73, designation: 'Aurora PLA', material_type: 'PLA', diameter_mm: 1.75,
    manufacturer: { id: 2, name: 'FilaWorks' }, manufacturer_color_name: 'Ocean',
    filament_colors: [{ color: { name: 'Ocean', hex_code: '#0088cc' }, position: 1 }] }
  const presets = ['spool', 'filament'].map((kind, i) => ({
    id: 90 + i, preset_type: kind, name: `Requested ${kind}`, selected: false,
    data: { version: 2, design: { version: 2, label: { widthMm: 45, heightMm: 25, marginMm: 0, border: false },
      elements: [{ id: 'text', type: 'text', x: 1, y: 1, w: 43, h: 23, z: 0,
        template: 'Requested {filament.name}', fontFamily: 'Space Grotesk', fontSizeMm: 3, fontWeight: 400, wrap: true }] } },
  }))
  await context.route(`${origin}/api/**`, async route => {
    const path = new URL(route.request().url()).pathname
    if (entityStatus !== 200 && /\/(spools|filaments)\/73$/.test(path)) {
      return route.fulfill({ status: entityStatus, json: { detail: 'Entity unavailable' } })
    }
    let json = []
    if (path.endsWith('/preview')) return route.fulfill({ status: 503, json: { detail: 'Preview unavailable in Edit smoke test' } })
    if (path.endsWith('/pending')) json = pending
    else if (path.endsWith('/claim')) { pending = null; return route.fulfill({ status: 204 }) }
    else if (path.endsWith('/me')) json = { id: 1, username: 'Reviewer', display_name: 'Reviewer', email: 'review@example.test', language: 'en', roles: ['Admin'], is_superuser: true, is_superadmin: true, permissions: ['*'] }
    else if (path.endsWith('/auth/status')) json = { authenticated: true, setup_required: false }
    else if (path.includes('/me/label-presets')) {
      if (presetsOffline) return route.fulfill({ status: 503, json: { detail: 'Presets temporarily unavailable' } })
      json = presets
    }
    else if (path.endsWith('/filaments/73')) json = filament
    else if (path.endsWith('/spools/73')) json = { id: 73, remaining_weight_g: 850, initial_total_weight_g: 1000,
      filament,
      status: { label: 'Active' }, custom_fields: { private: 'do not print' } }
    else if (path.includes('label-logo')) return route.fulfill({ status: 404 })
    return route.fulfill({ json })
  })
  const saved = JSON.stringify({ width: '100', height: '50', fontSize: '100', qrSize: '12', showQR: false,
    showLogo: true, showID: true, showMfr: true, showMat: true, showColor: true,
    showColorSwatch: true, showColorHex: true, extraFields: { private: true } })
  await context.addInitScript(value => {
    for (const prefix of ['filaman-label', 'filaman-filament-label']) {
      const settings = prefix.includes('filament') ? JSON.stringify({ ...JSON.parse(value), _v: 2 }) : value
      if (!localStorage.getItem(`${prefix}-settings`)) localStorage.setItem(`${prefix}-settings`, settings)
      if (!localStorage.getItem(`${prefix}-active-tab`)) localStorage.setItem(`${prefix}-active-tab`, 'designer')
    }
  }, saved)
  for (const kind of ['spool', 'filament']) {
    const prefix = kind === 'spool' ? 'filaman-label' : 'filaman-filament-label'
    const expectedSettings = kind === 'spool' ? saved : JSON.stringify({ ...JSON.parse(saved), _v: 2 })
    const getSettings = page => page.evaluate(key => localStorage.getItem(key), `${prefix}-settings`)
    pending = { id: 18, [`${kind}_id`]: 73, preset_id: null,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() }
    const page = await context.newPage()
    page.on('pageerror', error => console.error(error.message))
    await page.goto(`${origin}/${kind}s`)
    await page.locator('#pc-print-prompt').waitFor({ state: 'visible' })
    const [request] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.pc-print-prompt-edit').click(),
    ])
    await request.waitForURL(`${origin}/${kind}s/73/print?scale_print=1`)
    await request.waitForLoadState()
    assert.equal(new URL(request.url()).pathname, `/${kind}s/73/print`)
    await request.waitForFunction(() => document.querySelector('#label-preview')?.style.width)
    assert.equal(await request.locator('#input-width').inputValue(), '60')
    assert.equal(await request.locator('#input-height').inputValue(), '40')
    assert.equal(await request.locator('#check-qr').isChecked(), true)
    assert.equal(await request.locator('#tab-btn-print').getAttribute('aria-selected'), 'true')
    assert.equal(await request.evaluate(key => localStorage.getItem(key), `${prefix}-active-tab`), 'designer')
    if (kind === 'spool') assert.match(await request.locator('.label-extra-fields').innerText(), /Remaining:\s*850 g/)
    assert.equal(await getSettings(request), expectedSettings)
    await request.locator('#input-width').fill('65')
    await request.locator('#input-width').dispatchEvent('change')
    await request.waitForFunction(() => document.querySelector('#label-preview').style.width === '65mm')
    assert.equal(await getSettings(request), expectedSettings)
    await request.locator('#btn-reset').click()
    await request.waitForFunction(() => document.querySelector('#label-preview').style.width === '60mm')
    assert.equal(await getSettings(request), expectedSettings)
    if (process.env.LABEL_EVIDENCE_DIR) await request.screenshot({ path: `${process.env.LABEL_EVIDENCE_DIR}/${kind}-default-request.png` })
    await request.evaluate(() => { window.print = () => { window.printCalled = true } })
    await request.locator('#check-print-pdf').uncheck()
    await request.locator('#btn-print').click()
    await request.waitForFunction(() => window.printCalled)
    assert.equal(await request.locator('#filaman-label-print-host button, #filaman-label-print-host input, #filaman-label-print-host [data-label-editor-chrome]').count(), 0)
    await request.emulateMedia({ media: 'print' })
    assert.equal(await request.locator('#filaman-label-print-host').isVisible(), true)
    assert.equal(await request.locator('#btn-print').isVisible(), false)
    if (process.env.LABEL_EVIDENCE_DIR) await request.pdf({ path: `${process.env.LABEL_EVIDENCE_DIR}/${kind}-default-print.pdf`, preferCSSPageSize: true })
    await request.emulateMedia({ media: 'screen' })
    await request.goto(`${origin}/${kind}s/73/print`)
    await request.waitForFunction(() => document.querySelector('#input-width')?.value === '100')
    await request.waitForFunction(() => document.querySelector('#tab-btn-designer')?.getAttribute('aria-selected') === 'true')
    assert.equal(await request.locator('#check-qr').isChecked(), false)
    const preset = presets.find(preset => preset.preset_type === kind)
    const workingKey = `filaman-${kind}-label-designer-v1`
    const draft = JSON.stringify({ ...preset.data, design: { ...preset.data.design,
      label: { ...preset.data.design.label, widthMm: 77 },
      elements: [{ ...preset.data.design.elements[0], template: 'Unsaved user draft' }] } })
    await request.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: workingKey, value: draft })
    await request.goto(`${origin}/${kind}s/73/print?scale_print=1&preset_id=${preset.id}`)
    await request.waitForFunction(() => document.querySelector('#label-preview')?.style.width === '45mm')
    assert.equal(await request.locator('#tab-btn-designer').getAttribute('aria-selected'), 'true')
    assert.equal(await getSettings(request), expectedSettings)
    assert.equal(await request.evaluate(key => localStorage.getItem(key), workingKey), draft)
    await request.goto(`${origin}/${kind}s/73/print`)
    await request.waitForFunction(() => document.querySelector('#label-preview')?.style.width === '77mm')
    assert.equal(await request.evaluate(key => JSON.parse(localStorage.getItem(key)).design.elements[0].template, workingKey), 'Unsaved user draft')
    // A previously cached preset must not print when its current definition cannot be fetched.
    presetsOffline = true
    const offlinePresetAlert = request.waitForEvent('dialog')
    await request.goto(`${origin}/${kind}s/73/print?scale_print=1&preset_id=${preset.id}`, { waitUntil: 'domcontentloaded' })
    const offline = await offlinePresetAlert
    assert.match(offline.message(), /unavailable/i)
    await offline.accept()
    assert.equal(await request.locator('#label-preview').innerText(), '')
    for (const id of ['btn-print', 'btn-export-png', 'btn-export-pdf', 'btn-export-aml']) {
      assert.equal(await request.locator(`#${id}`).isDisabled(), true)
    }
    assert.equal(await request.evaluate(key => localStorage.getItem(key), workingKey), draft)
    presetsOffline = false
    for (const status of [404, 503]) for (const explicit of [false, true]) {
      entityStatus = status
      const entityAlert = request.waitForEvent('dialog')
      await request.goto(`${origin}/${kind}s/73/print?scale_print=1${explicit ? `&preset_id=${preset.id}` : ''}`, { waitUntil: 'domcontentloaded' })
      const unavailable = await entityAlert
      assert.match(unavailable.message(), /data.*unavailable/i)
      await unavailable.accept()
      await request.locator('#tab-btn-print').click()
      await request.locator('#input-width').fill('65')
      await request.locator('#input-width').dispatchEvent('change')
      assert.equal(await request.locator('#label-preview').innerText(), '')
      for (const id of ['btn-print', 'btn-export-png', 'btn-export-pdf', 'btn-export-aml']) {
        assert.equal(await request.locator(`#${id}`).isDisabled(), true)
      }
      await request.evaluate(() => { window.printCalled = false; window.print = () => { window.printCalled = true } })
      await request.locator('#check-print-pdf').uncheck()
      const blockedAlert = request.waitForEvent('dialog')
      const click = request.locator('#btn-print').evaluate(button => { button.disabled = false; button.click() })
      const blocked = await blockedAlert
      assert.match(blocked.message(), /printing failed/i)
      await blocked.accept()
      await click
      assert.equal(await request.evaluate(() => window.printCalled), false)
      assert.equal(await request.evaluate(key => localStorage.getItem(key), workingKey), draft)
    }
    // Ordinary navigation still supports caller-supplied data when offline.
    await request.goto(`${origin}/${kind}s/73/print?designation=Offline`)
    await request.waitForFunction(() => document.querySelector('#label-preview')?.style.width)
    assert.equal(await request.locator('#btn-print').isEnabled(), true)
    entityStatus = 200
    const missingPresetAlert = request.waitForEvent('dialog')
    await request.goto(`${origin}/${kind}s/73/print?scale_print=1&preset_id=9999`, { waitUntil: 'domcontentloaded' })
    const alert = await missingPresetAlert
    assert.match(alert.message(), /preset.*unavailable/i)
    await alert.accept()
    // Settings and late extra-field refreshes must not resurrect a Standard label.
    await request.locator('#tab-btn-print').click()
    await request.locator('#input-width').fill('65')
    await request.locator('#input-width').dispatchEvent('change')
    assert.equal(await request.locator('#label-preview').innerText(), '')
    for (const id of ['btn-print', 'btn-export-png', 'btn-export-pdf', 'btn-export-aml']) {
      assert.equal(await request.locator(`#${id}`).isDisabled(), true)
    }
    // The preparation gate must also stop stale/programmatic output actions.
    await request.evaluate(() => { window.printCalled = false; window.print = () => { window.printCalled = true } })
    await request.locator('#check-print-pdf').uncheck()
    const blockedPrintAlert = request.waitForEvent('dialog')
    const printClick = request.locator('#btn-print').evaluate(button => { button.disabled = false; button.click() })
    const blocked = await blockedPrintAlert
    await blocked.accept()
    await printClick
    assert.match(blocked.message(), /printing failed/i)
    assert.equal(await request.evaluate(() => window.printCalled), false)
    await page.close()
    await request.close()
    console.log(`${kind} API request: Default popup, explicit preset, unchanged preferences, and unavailable preset/entity print/export blocking passed`)
  }
} finally {
  await browser.close()
  server.kill('SIGTERM')
  if (server.exitCode === null) await once(server, 'exit')
}
