/** Run against Astro dev. All API writes are intercepted; no inventory is changed. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const filament = { id: 10, designation: 'Fixture PLA', material_type: 'PLA', diameter_mm: 1.75, manufacturer: { name: 'Fixture Brand' }, colors: [] }
const spool = { id: 16, filament_id: 10, filament, status_id: 1, initial_total_weight_g: 1200, empty_spool_weight_g: 200, spool_core_weight_g: null, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 65, low_weight_threshold_g: 100, purchase_price: 24.95, purchase_date: '2026-10-01', lot_number: 'LOT-1', external_id: 'EX-1', rfid_uid: 'AABBCCDD', rfid_uid_2: '11223344', custom_fields: { inspection: 'Passed' }, custom_field_definitions: { inspection: { label: 'Inspection', field_type: 'text' } } }
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(15000)
  const writes = []
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    localStorage.setItem('sidebar-collapsed', 'false')
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/me/label-presets/migrate')) return route.fulfill({ json: [] })
    if (request.method() !== 'GET') {
      writes.push({ path, body: request.postDataJSON() })
      return route.fulfill({ json: spool })
    }
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/spools/16')) json = spool
    else if (path.endsWith('/spools/16/events')) json = { items: [], total: 0, page: 1, page_size: 50 }
    else if (path.endsWith('/spools/statuses')) json = [{ id: 1, key: 'opened', label: 'Opened' }]
    else if (path.endsWith('/filaments')) json = { items: [filament, { ...filament, id: 11, designation: 'Other PLA' }], total: 2 }
    else if (path.endsWith('/locations')) json = { items: [], total: 0 }
    else if (path.endsWith('/public-info')) json = { filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    await route.fulfill({ json })
  })
  const goto = async suffix => {
    await page.goto(new URL(`/spools/16${suffix}`, baseUrl).href, { waitUntil: 'domcontentloaded' })
    await page.locator('#spool-inline-form').waitFor()
  }
  await goto('')
  await page.locator('#btn-edit-extra-fields').click()
  const parent = page.locator('.entity-extra-fields-overlay')
  const child = page.locator('dialog').filter({ has: page.locator('.extra-field-dialog-form') })
  await parent.locator('[data-extra-fields-add]').click()
  await page.locator('.extra-field-dialog-key').fill('new_field')
  assert.equal(await page.locator('.extra-field-dialog-key').evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Escape')
  assert.equal(await parent.evaluate(el => el.open), true)
  assert.equal(await parent.locator('[data-extra-fields-add]').evaluate(el => el === document.activeElement), true)
  await parent.locator('[data-extra-fields-add]').click()
  await page.locator('.extra-field-dialog-key').fill('new_field')
  await page.locator('.extra-field-dialog-label').fill('New Field')
  await page.locator('.extra-field-dialog-submit').click()
  await child.waitFor({ state: 'hidden' })
  assert.match(await parent.textContent(), /new_field/)
  await parent.locator('.entity-extra-edit').first().click()
  await page.locator('.extra-field-dialog-label').fill('Changed inspection')
  await page.locator('.extra-field-dialog-cancel').click()
  assert.doesNotMatch(await parent.textContent(), /Changed inspection/)
  await parent.locator('.entity-extra-edit').first().click()
  await page.locator('.extra-field-dialog-label').fill('Updated inspection')
  await page.locator('.extra-field-dialog-submit').click()
  await child.waitFor({ state: 'hidden' })
  assert.match(await parent.textContent(), /Updated inspection/)
  assert.equal(await parent.evaluate(el => el.contains(document.activeElement)), true)
  await parent.locator('.entity-extra-remove').first().click()
  await page.keyboard.press('Escape')
  assert.equal(await parent.evaluate(el => el.open), true)
  assert.equal(await parent.locator('.entity-extra-remove').first().evaluate(el => el === document.activeElement), true)
  await parent.locator('.entity-extra-remove').first().click()
  await page.locator('#fm-confirm-cancel').click()
  assert.equal(await parent.locator('.entity-extra-remove').count(), 2)
  await parent.locator('.entity-extra-remove').first().click()
  await page.locator('#fm-confirm-ok').click()
  assert.equal(await parent.locator('.entity-extra-remove').count(), 1)
  assert.equal(await parent.locator('[data-extra-fields-add]').evaluate(el => el === document.activeElement), true)
  // Existing global callers retain custom labels, result promises, backdrop cancel, and repeat opening.
  await page.evaluate(() => { window.fixtureResult = null; window.__fmConfirm('Fixture', { title: 'Custom title', okLabel: 'Proceed' }).then(result => { window.fixtureResult = result }) })
  assert.equal(await page.locator('#fm-confirm-ok').textContent(), 'Proceed')
  await page.locator('#fm-confirm-overlay').click({ position: { x: 2, y: 2 } })
  await page.waitForFunction(() => window.fixtureResult === false)
  assert.equal(await parent.evaluate(el => el.open), true)
  await parent.locator('[data-extra-fields-cancel]').last().click()
  assert.equal(writes.filter(write => write.path === '/api/v1/spools/16').length, 0)

  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1100 })
    await goto('?edit=1&keep=yes')
    await page.locator('[name="filament_id"] option[value="11"]').waitFor({ state: 'attached' })
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), true)
    const bounds = await page.locator('[name="filament_id"], [name="rfid_uid"], [name="rfid_uid_2"]').evaluateAll(controls => controls.map(control => {
      const rect = control.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    }))
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= width && rect.width > 0), `${width}: restored controls fit viewport`)
    await page.locator('#btn-cancel-edit').click()
    assert.equal(new URL(page.url()).searchParams.has('edit'), false)
    assert.equal(new URL(page.url()).searchParams.get('keep'), 'yes')
    await page.reload()
    await page.locator('#btn-edit-spool').waitFor()
  }
  await goto('?edit=1')
  await page.locator('[name="filament_id"]').selectOption('11')
  await page.locator('[name="rfid_uid"]').fill(' aa:bb:cc:dd ')
  await page.locator('[name="rfid_uid_2"]').fill('')
  await page.locator('[form="spool-inline-form"][type="submit"]').click()
  await page.locator('#btn-edit-spool').waitFor()
  assert.equal(new URL(page.url()).searchParams.has('edit'), false)
  const payload = writes.filter(write => write.path === '/api/v1/spools/16').at(-1).body
  assert.deepEqual(payload, {
    initial_total_weight_g: 1200, empty_spool_weight_g: 200, spool_core_weight_g: null, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 65, low_weight_threshold_g: 100, purchase_price: 24.95, purchase_date: '2026-10-01', lot_number: 'LOT-1', external_id: 'EX-1', filament_id: 11, rfid_uid: 'aa:bb:cc:dd', rfid_uid_2: null, custom_fields: { inspection: 'Passed' }, custom_field_definitions: { inspection: { label: 'Inspection', field_type: 'text', options: null, config: null } },
  })
  await page.reload()
  await page.locator('#btn-edit-spool').waitFor()
  await page.locator('#btn-edit-spool').click()
  await page.locator('[name="rfid_uid_2"]').fill(' 55:66:77:88 ')
  await page.locator('[form="spool-inline-form"][type="submit"]').click()
  await page.locator('#btn-edit-spool').waitFor()
  const secondPayload = writes.filter(write => write.path === '/api/v1/spools/16').at(-1).body
  assert.equal(secondPayload.filament_id, 10)
  assert.equal(secondPayload.rfid_uid, 'AABBCCDD')
  assert.equal(secondPayload.rfid_uid_2, '55:66:77:88')
  assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), false)
  console.log('PASS extra-field Add/Edit/Delete/cancel/focus, global confirmation, spool reassignment/RFID, legacy edit exit, responsive controls')
} finally {
  await browser.close()
}
