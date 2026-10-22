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
  await page.route(/\/(?:api\/|auth\/me$)/, async route => {
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
    else if (path.endsWith('/public-info')) json = { currency: 'USD', filament_lookup_source: 'disabled' }
    else if (path.endsWith('/system-extra-fields') && new URL(request.url()).searchParams.get('target_type') === 'spool') json = [{ id: 1, key: 'storage_note', label: 'Storage note', field_type: 'text' }]
    else if (path.endsWith('/spool-profiles')) json = { items: [{ name: 'Fixture spool profile', empty_weight_g: 333, spool_material: 'Plastic', outer_diameter_mm: 205, width_mm: 70 }], total: 1 }
    else if (path.endsWith('/devices/active')) json = [{ id: 1, name: 'Fixture RFID device' }]
    else if (path.endsWith('/status')) json = { active: true }
    await route.fulfill({ json })
  })
  const goto = async suffix => {
    await page.goto(new URL(`/spools/16${suffix}`, baseUrl).href, { waitUntil: 'domcontentloaded' })
    await page.locator('#spool-inline-form').waitFor()
  }
  const replacingActions = ['btn-measurement', 'btn-adjustment', 'btn-status', 'btn-move', 'btn-print-label', 'btn-rfid', 'btn-duplicate-spool', 'btn-delete']
  const expectViewActions = async () => {
    for (const id of replacingActions) {
      assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} restored in view mode`)
      assert.equal(await page.locator(`#${id}`).isEnabled(), true, `${id} enabled in view mode`)
    }
    assert.equal(await page.locator('.remove-rfid-tag').count(), 2)
  }
  // Both entry paths must protect unsaved fields from action reloads and duplicate/print navigation.
  for (const directEdit of [false, true]) {
    await goto(directEdit ? '?edit=1' : '')
    if (!directEdit) {
      await expectViewActions()
      await page.locator('#btn-edit-spool').click()
    }
    await page.locator('[name="lot_number"]').fill('UNSAVED DRAFT')
    const writesBefore = writes.length
    for (const id of replacingActions) {
      const action = page.locator(`#${id}`)
      assert.ok(!await action.isVisible() || await action.isDisabled(), `${id} cannot replace an unsaved draft`)
    }
    assert.equal(await page.locator('.remove-rfid-tag').count(), 0, 'RFID removal cannot reload an unsaved draft')
    assert.equal(await page.locator('[name="lot_number"]').inputValue(), 'UNSAVED DRAFT')
    assert.equal(writes.length, writesBefore, 'Checking draft action reachability writes nothing')
    await page.locator(directEdit ? '#btn-edit-spool' : '#btn-cancel-edit').click()
    await expectViewActions()
  }
  // All reload-producing quick actions still complete after cancel, through real UI and intercepted APIs.
  for (const [action, path, field, value] of [
    ['measurement', '/measurements', '#field-weight', '1100'],
    ['adjustment', '/adjustments', '#field-delta', '-10'],
    ['status', '/status', null, null],
    ['move', '/move', null, null],
  ]) {
    await page.locator(`#btn-${action}`).click()
    await page.locator('#modal-container').waitFor({ state: 'visible' })
    if (field) await page.locator(field).fill(value)
    const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/spools/16')
    await page.locator('#modal-submit').click()
    await refreshed
    await page.locator('#modal-container').waitFor({ state: 'hidden' })
    await expectViewActions()
    assert.equal(writes.at(-1).path, `/api/v1/spools/16${path}`)
  }
  await page.locator('#btn-rfid').click()
  assert.equal(await page.locator('#rfid-modal').evaluate(el => el.classList.contains('open')), true)
  await page.locator('#rfid-cancel').click()
  await page.locator('#btn-duplicate-spool').click()
  await page.waitForURL(/\/spools\/new\/?$/)
  await page.waitForFunction(() => document.querySelector('#lot_number')?.value === 'LOT-1')
  assert.equal(await page.locator('#lot_number').inputValue(), 'LOT-1', 'Duplicate uses saved data after leaving edit mode')
  await goto('')
  await page.locator('#btn-edit-extra-fields').click()
  const parent = page.locator('.entity-extra-fields-overlay')
  const child = page.locator('dialog').filter({ has: page.locator('.extra-field-dialog-form') })
  const expectChildClosed = async () => {
    try {
      await child.waitFor({ state: 'hidden' })
    } catch (error) {
      console.error('Extra-field dialog remained open:', await child.evaluate(dialog => ({
        text: dialog.textContent,
        controls: [...dialog.querySelectorAll('input, select')].map(input => ({ name: input.className, value: input.value, disabled: input.disabled, validation: input.validationMessage })),
      })))
      throw error
    }
  }
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
  await expectChildClosed()
  assert.match(await parent.textContent(), /new_field/)
  await parent.locator('.entity-extra-edit').first().click()
  await page.locator('.extra-field-dialog-label').fill('Changed inspection')
  await page.locator('.extra-field-dialog-cancel').click()
  assert.doesNotMatch(await parent.textContent(), /Changed inspection/)
  await parent.locator('.entity-extra-edit').first().click()
  await page.locator('.extra-field-dialog-label').fill('Updated inspection')
  await page.locator('.extra-field-dialog-submit').click()
  await expectChildClosed()
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

  for (const [width, collapsed] of [[390, true], [1024, true], [1440, false]]) {
    await page.setViewportSize({ width, height: 1100 })
    await goto('?edit=1&keep=yes')
    await page.locator('[name="filament_id"] option[value="11"]').waitFor({ state: 'attached' })
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), collapsed, `${width}: editing preserves responsive navigation`)
    assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', 'Editing preserves the saved sidebar preference')
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
  const save = page.locator('[form="spool-inline-form"][type="submit"]')
  assert.equal(await save.isDisabled(), true, 'Clean spool Save is disabled')
  await page.locator('#spool-inline-form').evaluate(form => form.requestSubmit())
  assert.equal(writes.filter(write => write.path === '/api/v1/spools/16').length, 0, 'Clean programmatic submit cannot write')
  await page.locator('#uses_spool_core').uncheck()
  assert.equal(await save.isEnabled(), true, 'Core checkbox change enables Save')
  await page.locator('#uses_spool_core').check()
  assert.equal(await save.isDisabled(), true, 'Undoing core checkbox restores clean state')
  const systemNote = page.locator('#spool-system-fields-editor .system-field-input[data-key="storage_note"]')
  await systemNote.fill('Keep dry')
  assert.equal(await save.isEnabled(), true, 'System extra-field input enables Save')
  await systemNote.fill('')
  assert.equal(await save.isDisabled(), true, 'Undoing system extra-field input restores clean state')
  for (const [label, disabled] of [['Updated inspection', false], ['Inspection', true]]) {
    await page.locator('#spool-custom-fields-editor .entity-extra-edit').first().click()
    await page.locator('.extra-field-dialog-label').fill(label)
    await page.locator('.extra-field-dialog-submit').click()
    await child.waitFor({ state: 'hidden' })
    await page.waitForFunction(expected => document.querySelector('[form="spool-inline-form"][type="submit"]').disabled === expected, disabled)
  }
  await page.locator('#btn-spool-profile-lookup').click()
  await page.locator('#spool-profile-lookup-container input').focus()
  assert.equal(await save.isDisabled(), true, 'Opening catalog search does not dirty the spool')
  await page.getByText('Fixture spool profile', { exact: true }).click()
  assert.equal(await save.isEnabled(), true, 'Catalog-applied spool fields enable Save')
  assert.equal(await page.locator('[name="empty_spool_weight_g"]').inputValue(), '333')
  await page.locator('#btn-cancel-edit').click()
  await goto('?edit=1')
  await page.locator('[name="filament_id"]').selectOption('11')
  await page.locator('[name="rfid_uid"]').fill(' aa:bb:cc:dd ')
  await page.locator('[name="rfid_uid_2"]').fill('')
  await page.locator('[form="spool-inline-form"][type="submit"]').click()
  await page.locator('#btn-edit-spool[aria-pressed="false"]').waitFor()
  assert.equal(new URL(page.url()).searchParams.has('edit'), false)
  const payload = writes.filter(write => write.path === '/api/v1/spools/16').at(-1).body
  assert.deepEqual(payload, {
    filament_id: 11, rfid_uid: 'aa:bb:cc:dd', rfid_uid_2: null,
  })
  await page.reload()
  await page.locator('#btn-edit-spool').waitFor()
  await page.locator('#btn-edit-spool').click()
  assert.equal(await page.locator('[name="filament_id"]').inputValue(), '10', 'Reopened edit retains the saved filament')
  await page.locator('[name="rfid_uid_2"]').fill(' 55:66:77:88 ')
  await page.locator('[form="spool-inline-form"][type="submit"]').click()
  await page.locator('#btn-edit-spool[aria-pressed="false"]').waitFor()
  const secondPayload = writes.filter(write => write.path === '/api/v1/spools/16').at(-1).body
  assert.equal(Object.hasOwn(secondPayload, 'filament_id'), false, 'An untouched filament stays out of the sparse PATCH')
  assert.equal(Object.hasOwn(secondPayload, 'rfid_uid'), false, 'An untouched primary tag must not overwrite a concurrent device write')
  assert.equal(secondPayload.rfid_uid_2, '55:66:77:88')
  assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), false)
  await page.locator('#btn-print-label[href*="designation="]').waitFor()
  await page.goto(new URL(await page.locator('#btn-print-label').getAttribute('href'), page.url()).href)
  await page.locator('[id="check-ef-purchase_currency"]').check()
  await page.waitForFunction(() => document.querySelector('#label-preview')?.textContent.includes('USD'))
  assert.match(await page.locator('#label-preview').textContent(), /USD/, 'Standard labels initialize purchase currency from app settings')
  console.log('PASS draft-safe quick actions/RFID/duplicate and view restoration; extra-field Add/Edit/Delete/cancel/focus, global confirmation, spool reassignment/RFID, legacy edit exit, responsive controls and purchase currency on Standard labels')
} finally {
  await browser.close()
}
