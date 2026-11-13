/** Run against Astro dev. The API and installed plugin page use local fixtures. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const manufacturer = { id: 7, name: 'Fixture Brand', empty_spool_weight_g: 201 }
const color = { id: 11, name: 'Fixture Red', hex_code: '#FF0000' }
const reel = { id: 4, name: 'Fixture reel', empty_weight_g: 177, spool_material: 'Plastic', outer_diameter_mm: 200, width_mm: 66 }
const filament = (id, designation) => ({
  id, designation, manufacturer_id: 7, manufacturer,
  record_token: String(id).padStart(32, '0'),
  material_type: 'PLA', diameter_mm: 1.75, color_mode: 'single',
  colors: [{ color_id: 11, position: 1, color }],
})
const plugin = { plugin_key: 'fixture', name: 'Fixture Plugin', page_url: '/plugin-page/fixture' }
const first = { ...filament(10, 'Existing PLA'), manufacturer_color_name: ' Fixture Red ' }
const inventory = [first, ...Array.from({ length: 49 }, (_, index) => filament(100 + index, 'Batch one PLA')), filament(12, 'Second batch PLA')]
const pickerFilaments = [filament(20, 'Black PLA'), {
  ...filament(21, 'Black PLA'), manufacturer_id: 8, manufacturer: { id: 8, name: 'Other Manufacturer' },
}, ...Array.from({ length: 49 }, (_, index) => filament(22 + index, `Picker PLA ${index + 1}`))]
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(6000)
  const writes = []
  let failFilamentLoad = false
  await page.addInitScript(() => { localStorage.setItem('lang', 'en') })
  await page.route('**/plugin-page/fixture?*', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Plugin fixture</title><p>Plugin fixture</p>',
  }))
  await page.route(/\/(?:api\/|auth\/me$)/, async route => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (req.method() !== 'GET') {
      if (path.endsWith('/filaments') || path.endsWith('/filaments/10')) writes.push(req.postDataJSON())
      return route.fulfill({ status: 422, json: { detail: { message: 'Fixture intercepted Save' } } })
    }
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/filament-plugin-hooks')) json = [plugin, { ...plugin, name: 'External plugin', page_url: 'https://example.invalid/fixture' }]
    else if (path.endsWith('/manufacturers')) json = { items: [manufacturer], total: 1 }
    else if (path.endsWith('/types')) json = ['PLA', 'PETG']
    else if (path.endsWith('/colors')) json = { items: [color], total: 1 }
    else if (path.endsWith('/filaments/10')) {
      assert.equal(url.searchParams.get('include_record_token'), 'true')
      json = first
    }
    else if (path.endsWith('/public-info')) json = { filament_lookup_source: 'disabled' }
    else if (path.endsWith('/filamentdb/status')) json = { active: true }
    else if (path.endsWith('/filamentdb/spool-profiles')) json = { items: [reel], total: 1 }
    else if (path.endsWith('/status')) json = { active: false }
    else if (path.endsWith('/filaments/filter-options')) json = { manufacturers: [], types: [], designations: [], diameters: [], finishes: [], subgroups: [], spool_counts: [], colors: [] }
    else if (path.endsWith('/filaments')) {
      if (failFilamentLoad) return route.fulfill({ status: 500, json: {} })
      if (req.frame().url().includes('/filament-picker')) {
        const ids = url.searchParams.getAll('filament_id')
        const items = pickerFilaments.filter(item => !ids.length || ids.includes(String(item.id)))
        const size = Number(url.searchParams.get('page_size'))
        const offset = (Number(url.searchParams.get('page') || 1) - 1) * size
        json = { items: items.slice(offset, offset + size).map(item => url.searchParams.get('include_record_token') === 'true'
          ? { ...item, record_token: item.record_token || `record-${item.id}` } : item), total: items.length }
      } else {
        const size = Number(url.searchParams.get('page_size'))
        const offset = (Number(url.searchParams.get('page') || 1) - 1) * size
        json = { items: inventory.slice(offset, offset + size).map(({ record_token, ...item }) =>
          url.searchParams.get('include_record_token') === 'true' ? { ...item, record_token } : item), total: inventory.length }
      }
    }
    else if (path.endsWith('/spools') || path.endsWith('/locations') || path.endsWith('/printers')) json = { items: [], total: 0 }
    return route.fulfill({ json })
  })

  const launch = page.getByRole('button', { name: 'Fixture Plugin', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Fixture Plugin' })
  const field = id => page.locator('#' + id)
  async function openPlugin(mode) {
    await launch.click()
    await dialog.frameLocator('iframe').getByText('Plugin fixture').waitFor()
    const frame = page.frames().find(frame => new URL(frame.url()).searchParams.get('filament_host') === mode)
    assert.ok(frame, 'the plugin iframe receives the host surface')
    return frame
  }
  function message(frame, type, payload = {}) {
    return frame.evaluate(({ type, payload }) => new Promise((resolve, reject) => {
      const request_id = crypto.randomUUID()
      const timer = setTimeout(() => reject(new Error('No plugin hook response for ' + type)), 1500)
      window.addEventListener('message', function respond(event) {
        if (event.origin !== location.origin || event.source !== parent || event.data?.request_id !== request_id) return
        window.removeEventListener('message', respond)
        clearTimeout(timer)
        resolve(event.data)
      })
      parent.postMessage({ type, request_id, ...payload }, location.origin)
    }), { type, payload })
  }

  await page.goto(new URL('/filaments/new', base).href)
  await field('designation').fill('Unsaved draft')
  await field('default_spool_weight_g').fill('177')
  await field('spool_material').selectOption('Plastic')
  await field('spool_outer_diameter_mm').fill('200')
  await field('spool_width_mm').fill('66')
  const spoolProfile = field('filament-spool-profile').getByRole('status')
  await spoolProfile.filter({ hasText: reel.name }).waitFor()
  const create = await openPlugin('editor')
  const context = await message(create, 'filaman:filament-context')
  assert.equal(context.mode, 'create')
  assert.equal(context.filament_id, null)
  assert.equal(context.fields.designation, 'Unsaved draft')
  assert.equal(context.fields.material_type, null)
  assert.equal(context.fields.diameter_mm, null)
  assert.equal(await field('type').inputValue(), 'PLA')
  assert.equal(await field('diameter_mm').inputValue(), '1.75')
  assert.equal('custom_fields' in context.fields, false)
  assert.equal(await page.getByRole('button', { name: 'External plugin' }).count(), 0)
  const fake = { type: 'filaman:filament-stage', request_id: 'forged', units: [{ designation: { old: 'Unsaved draft', value: 'Wrong document' } }] }
  await page.evaluate(data => {
    const frame = document.querySelector('dialog[open] iframe')
    window.dispatchEvent(new MessageEvent('message', { data, origin: location.origin, source: window }))
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://example.invalid', source: frame.contentWindow }))
  }, fake)
  assert.equal(await field('designation').inputValue(), 'Unsaved draft')

  const staged = await message(create, 'filaman:filament-stage', { units: [
    { designation: { old: 'Unsaved draft', value: 'Proposed PLA' } },
    { material_type: { old: context.fields.material_type, value: 'PETG' } },
    { diameter_mm: { old: context.fields.diameter_mm, value: 2.85 } },
    { manufacturer_id: { old: context.fields.manufacturer_id, value: 7 } },
    { color_id: { old: context.fields.color_id, value: 11 } },
    { spool_width_mm: { old: context.fields.spool_width_mm, value: 67 } },
    { custom_fields: { old: null, value: { injected: true } } },
  ] })
  assert.deepEqual(staged.staged, ['designation', 'material_type', 'diameter_mm', 'manufacturer_id', 'color_id', 'spool_width_mm'])
  assert.deepEqual(staged.skipped, ['custom_fields'])
  assert.equal(await field('designation').inputValue(), 'Proposed PLA')
  assert.equal(await field('default_spool_weight_g').inputValue(), '177')
  assert.ok(!(await spoolProfile.textContent()).includes(reel.name), 'staging a new reel width clears the old automatic match')
  const filled = await message(create, 'filaman:filament-context')
  assert.equal(filled.fields.material_type, 'PETG')
  assert.equal(filled.fields.diameter_mm, 2.85)
  assert.equal(writes.length, 0)
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close' }).click()
  await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/filaments')), field('submit-btn').click()])
  assert.equal(writes[0].designation, 'Proposed PLA')
  assert.equal(writes[0].material_type, 'PETG')
  assert.equal(writes[0].diameter_mm, 2.85)
  assert.equal(writes[0].filamentdb_spool_profile_id, null)
  assert.deepEqual(writes[0].colors, [{ color_id: 11, position: 1 }])

  await page.goto(new URL('/filaments/10', base).href)
  await page.locator('#btn-enter-filament-edit').waitFor()
  assert.equal(await launch.isVisible(), false)
  await page.goto(new URL('/filaments/10?edit=1', base).href)
  const edit = await openPlugin('editor')
  const editing = await message(edit, 'filaman:filament-context')
  assert.equal(editing.mode, 'edit')
  assert.equal(editing.filament_id, 10)
  assert.equal(editing.record_token, first.record_token)
  assert.equal(editing.fields.manufacturer_name, manufacturer.name)
  const linked = await message(edit, 'filaman:filament-stage', { units: [
    { material_type: { old: 'Wrong PLA', value: 'PETG' }, material_subgroup: { old: null, value: 'Matte' } },
    { density_g_cm3: { old: editing.fields.density_g_cm3, value: 1.24 } },
    { manufacturer_color_name: { old: editing.fields.manufacturer_color_name, value: 'Fixture Red' } },
    { default_spool_weight_g: { old: editing.fields.default_spool_weight_g, value: 177.5 } },
    { material_type: { old: editing.fields.material_type, value: 'ß'.repeat(26) } },
    { manufacturer_sku: { old: editing.fields.manufacturer_sku, value: 'S'.repeat(256) } },
    { datasheet_url: { old: editing.fields.datasheet_url, value: 'javascript:alert(1)' } },
  ] })
  assert.deepEqual(linked.staged, ['density_g_cm3', 'manufacturer_color_name'])
  assert.deepEqual(linked.skipped, [
    'material_type', 'material_subgroup', 'default_spool_weight_g', 'material_type', 'manufacturer_sku', 'datasheet_url',
  ])
  assert.equal(await field('material_subgroup').inputValue(), '')
  assert.equal(await field('density_g_cm3').inputValue(), '1.24')
  assert.equal(writes.length, 1)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/filaments/10')), field('submit-btn').click()])
  assert.equal(writes[1].manufacturer_color_name, 'Fixture Red')
  assert.equal(writes[1].density_g_cm3, 1.24)
  assert.equal('datasheet_url' in writes[1], false)

  await field('btn-edit-filament').click()
  await field('btn-enter-filament-edit').waitFor()
  const originalToken = first.record_token
  first.record_token = 'replacement-record-token'
  await field('btn-enter-filament-edit').click()
  const reopened = await openPlugin('editor')
  assert.equal((await message(reopened, 'filaman:filament-context')).record_token, first.record_token)
  await dialog.getByRole('button', { name: 'Close' }).click()
  first.record_token = originalToken

  await page.goto(new URL('/filaments', base).href)
  await page.locator('[data-filament-id="10"]').waitFor()
  await page.locator('[data-filament-id="10"]').check()
  assert.equal(await page.locator('#filaments-table input').count(), 50)
  await page.locator('#filaments-table input').last().scrollIntoViewIfNeeded()
  await page.locator('[data-filament-id="12"]').waitFor()
  assert.equal(await field('bulk-select-all').evaluate(el => el.indeterminate), true)
  assert.equal(await field('bulk-select-all').getAttribute('aria-label'), 'Select loaded filaments')
  await page.locator('[data-filament-id="12"]').check()
  await page.getByRole('heading', { name: 'Filaments', level: 1, exact: true }).scrollIntoViewIfNeeded()
  const selection = await openPlugin('selection')
  const selected = await message(selection, 'filaman:filament-context')
  assert.equal(selected.mode, 'selection')
  assert.deepEqual(selected.filament_ids, [10, 12])
  assert.deepEqual(selected.expected_filaments, [inventory[0], inventory[50]].map(
    ({ id, manufacturer_id, designation, material_type, record_token }) =>
      ({ id, manufacturer_id, designation, material_type, record_token }),
  ))
  assert.equal('fields' in selected, false)
  assert.equal(new URL(selection.url()).searchParams.has('filament_ids'), false)
  await dialog.getByRole('button', { name: 'Close' }).click()
  failFilamentLoad = true
  await field('filter-search').fill('Trigger failed search')
  await field('filaments-table').getByText('Failed to load filaments').waitFor()
  assert.equal(await field('bulk-select-all').isChecked(), false)
  assert.equal(await field('bulk-select-all').getAttribute('aria-label'), 'Select loaded filaments')
  failFilamentLoad = false
  console.log('Filament plugin hooks: create and edit staging, source and origin checks, native Save, and selection across loaded batches passed')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(new URL('/filament-picker/', base).href)
  const secondRow = page.locator('tr:has([data-filament-id="21"])')
  await secondRow.waitFor()
  const rowManufacturer = secondRow.locator('.col-designation').getByText('Other Manufacturer', { exact: true })
  assert.equal(await page.locator('th.col-manufacturer').isVisible(), false)
  assert.equal(await rowManufacturer.isVisible(), true)
  await field('btn-columns').click()
  const manufacturerColumn = field('columns-dropdown').locator('input[data-col="manufacturer"]')
  await manufacturerColumn.check()
  assert.equal(await rowManufacturer.isVisible(), false)
  assert.equal(await secondRow.locator('.col-manufacturer').isVisible(), true)
  await manufacturerColumn.uncheck()
  assert.equal(await rowManufacturer.isVisible(), true)

  await page.route('**/picker-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><iframe title="Picker" src="/filament-picker/" style="width:100%;height:650px"></iframe>',
  }))
  await page.goto(new URL('/picker-fixture', base).href)
  const picker = page.frameLocator('iframe[title="Picker"]')
  const pickerHeader = picker.locator('#bulk-select-all')
  const pickerRows = picker.locator('#filaments-table input[data-filament-id]')
  await pickerRows.last().scrollIntoViewIfNeeded()
  await picker.locator('[data-filament-id="70"]').waitFor()
  await page.evaluate(() => {
    window.addEventListener('message', event => {
      if (event.source === document.querySelector('iframe').contentWindow) window.latestPickerSelection = event.data
    })
  })
  await pickerHeader.click()
  assert.equal(await pickerRows.count(), 51)
  assert.equal(await picker.locator('#filaments-table input:checked').count(), 50)
  await picker.getByRole('status').filter({ hasText: '50 of 50 filaments selected' }).waitFor({ timeout: 1000 })
  assert.equal(await pickerRows.last().isDisabled(), true)
  assert.equal(await pickerHeader.isChecked(), false)
  assert.equal(await pickerHeader.evaluate(el => el.indeterminate), true)
  await page.waitForFunction(() => window.latestPickerSelection?.filament_ids.length === 50)
  assert.equal(await page.evaluate(() => window.latestPickerSelection.expected_filaments[0].record_token), pickerFilaments[0].record_token)
  await pickerRows.first().uncheck()
  assert.equal(await pickerRows.last().isEnabled(), true)
  await pickerRows.last().check()
  await page.waitForFunction(() => window.latestPickerSelection?.filament_ids.includes(70))
  await page.evaluate(() => {
    document.querySelector('iframe').contentWindow.postMessage({ type: 'filaman:filament-picker-clear-selection' }, location.origin)
  })
  await page.waitForFunction(() => window.latestPickerSelection?.filament_ids.length === 0)
  assert.equal(await picker.locator('#filaments-table input:checked').count(), 0)
  await pickerRows.first().check()
  await pickerRows.nth(1).check()
  await page.waitForFunction(() => window.latestPickerSelection?.filament_ids.length === 2)
  pickerFilaments[1].record_token = 'replacement-21'
  const staleRows = await picker.locator('body').evaluate(() => {
    window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'filaments_changed' } }))
    return document.querySelectorAll('#filaments-table input[data-filament-id]').length
  })
  assert.equal(staleRows, 0)
  await page.waitForFunction(() => window.latestPickerSelection?.inventory_changed)
  assert.deepEqual(await page.evaluate(() => window.latestPickerSelection.filament_ids), [20])
  await pickerRows.nth(1).waitFor()
  assert.equal(await pickerRows.nth(1).isChecked(), false)

  await page.evaluate(() => localStorage.setItem('filaman-columns-filaments-compact', '["type","colors"]'))
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto(new URL('/filaments', base).href)
  const manufacturerFilter = page.locator('th.col-manufacturer .fm-header-filter-trigger')
  await manufacturerFilter.focus()
  await page.setViewportSize({ width: 390, height: 844 })
  const grouping = page.getByRole('checkbox', { name: 'Group by Manufacturer' })
  await grouping.waitFor()
  assert.equal(await grouping.evaluate(el => document.activeElement === el), true)
  await page.setViewportSize({ width: 1280, height: 844 })
  await grouping.waitFor({ state: 'hidden' })
  assert.equal(await manufacturerFilter.evaluate(el => document.activeElement === el), true)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/plugins/fixture/?*', route => route.fulfill({
    contentType: 'text/html',
    body: '<button style="position:absolute;left:12px;top:12px;width:32px;height:32px" onclick="this.textContent=\'Clicked\'">Go</button>',
  }))
  await page.goto(new URL('/plugin-view/fixture', base).href)
  const mobileControl = page.frameLocator('#plugin-iframe').getByRole('button', { name: 'Go' })
  await mobileControl.click()
  await page.frameLocator('#plugin-iframe').getByRole('button', { name: 'Clicked' }).waitFor()
  console.log('Integration shell: mobile plugin controls remain clickable')
} finally {
  await browser.close()
}
