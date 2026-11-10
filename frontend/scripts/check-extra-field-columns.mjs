/** Run against Astro dev or the compiled app. API responses use fixtures. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const examples = [
  ['PLA Matte', { checked: true }, '✓'],
  ['PLA Silk', { checked: false }, '✗'],
  ['PETG Translucent', { checked: 'true' }, '✓'],
  ['PETG Black', { checked: 'false' }, '✗'],
  ['ABS Natural', {}, '✗'],
]
const fields = [
  [{ key: 'quality.verified', label: 'Verified', field_type: 'checkbox' }, '✓'],
  [{ key: 'temperature', label: 'Temperature range', field_type: 'range', config: { unit: '°C' } }, '190–220 °C'],
  [{ key: 'sample_weight', label: 'Sample weight', field_type: 'number', config: { unit: 'g', decimal_places: 2 } }, '3.10 g'],
  [{ key: 'finishes', label: 'Finishes', field_type: 'multiselect', options: ['Matte', 'Silk'] }, 'Matte, Silk'],
  [{ key: 'notes', label: 'Notes', field_type: 'text' }, '<b>Inspect</b>'],
]
const spacedField = { key: 'vendor note', label: 'Vendor note', field_type: 'text' }
const filaments = examples.map(([designation, custom_fields], index) => ({
  id: index + 1, designation, material_type: designation.split(' ')[0], diameter_mm: 1.75,
  manufacturer: { id: 1, name: 'Example Materials' }, colors: [],
  custom_fields: {
    ...custom_fields,
    ...(index === 0 ? {
      quality: { verified: 'true' }, temperature: { min: 190, max: 220 },
      sample_weight: '3.1', finishes: ['Matte', 'Silk'], notes: '<b>Inspect</b>', 'vendor note': 'Sample from vendor',
    } : index === 2 ? { 'quality.verified': true, sample_weight: 12 } : {}),
  },
}))
const spools = filaments.map(filament => ({
  id: filament.id, filament_id: filament.id, filament, status_id: 1, custom_fields: filament.custom_fields,
}))

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(15000)
  const errors = []
  const requests = []
  let fillInventory = false
  let checkboxAvailable = true
  let definitionsAvailable = true
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    localStorage.setItem('filaman-columns-filaments', JSON.stringify(['type']))
    localStorage.setItem('filaman-columns-spools', JSON.stringify(['id', 'status']))
    for (const list of ['filaments', 'spools']) {
      localStorage.setItem(`filaman-column-widths-${list}`, JSON.stringify({ 'cf_vendor note': 220 }))
    }
  })
  await page.route(/\/(?:api\/|auth\/me$)/, async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/system-extra-fields') && !definitionsAvailable) return route.fulfill({ status: 503 })
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/system-extra-fields')) json = [
      ...(checkboxAvailable ? [{ key: 'checked', label: 'Quality checked', field_type: 'checkbox' }] : []),
      ...fields.map(([field]) => field),
      spacedField,
    ]
    else if (path.endsWith('/public-info')) json = { currency: 'EUR' }
    else if (path.endsWith('/print-requests/pending')) json = null
    else if (path.endsWith('/status')) json = { active: false }
    else if (path.endsWith('/spools/statuses')) json = [{ id: 1, key: 'opened', label: 'Opened' }]
    else if (path.endsWith('/spools/filter-options')) json = { used_status_ids: [1], by_status: {} }
    else if (path === '/api/v1/filaments' || path === '/api/v1/spools') {
      requests.push(url)
      if (url.searchParams.get('sort_by')?.startsWith('cf_')) return route.fulfill({ status: 422 })
      const items = path.endsWith('/filaments') ? filaments : spools
      const inventory = fillInventory ? [
        ...items,
        ...Array.from({ length: 196 }, (_, index) => ({
          ...items[0], id: index + 6, custom_fields: { checked: index < 195 },
        })),
      ] : items
      const size = Number(url.searchParams.get('page_size'))
      const offset = (Number(url.searchParams.get('page')) - 1) * size
      json = { items: inventory.slice(offset, offset + size), total: inventory.length }
    }
    await route.fulfill({ json })
  })

  for (const list of ['filaments', 'spools']) {
    fillInventory = false
    checkboxAvailable = true
    await page.goto(new URL(`/${list}`, base).href, { waitUntil: 'domcontentloaded' })
    await page.locator('th.col-cf_checked').waitFor({ state: 'attached' })
    await page.locator('#btn-columns').click()
    await page.locator('#columns-dropdown').getByLabel('Quality checked', { exact: true }).check()
    await page.locator('#btn-columns').click()
    for (const [designation, , expected] of examples) {
      const row = page.locator(`#${list}-table tr`).filter({ hasText: designation })
      const cell = row.locator('td.col-cf_checked')
      await cell.waitFor()
      assert.equal(await cell.textContent(), expected, `${list}: ${designation}`)
    }
    await page.locator('#btn-columns').click()
    for (const [field] of fields) {
      await page.locator('#columns-dropdown').getByLabel(field.label, { exact: true }).check()
    }
    await page.locator('#btn-columns').click()
    const firstRow = page.locator(`#${list}-table tr`).filter({ hasText: 'PLA Matte' })
    const cells = fields.map(([field]) => firstRow.locator(`td[class~="col-cf_${field.key}"]`))
    assert.deepEqual(await Promise.all(cells.map(cell => cell.textContent())),
      fields.map(([, display]) => display), `${list}: typed field display`)
    assert.equal(await cells.at(-1).locator('b').count(), 0, `${list}: custom text stays text`)
    if (process.env.SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1920, height: 780 })
      await page.locator('th.col-cf_notes').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${list}-checkbox-column.png` })
    }

    const spacedHeader = page.locator('th[data-sort="cf_vendor note"]')
    assert.equal(await spacedHeader.isVisible(), false, `${list}: a spaced key starts hidden`)
    await page.locator('#btn-columns').click()
    await page.locator('#columns-dropdown').getByLabel('Vendor note', { exact: true }).check()
    await page.locator('#btn-columns').click()
    await spacedHeader.locator('.fm-header-filter-trigger').waitFor()
    assert.equal(await spacedHeader.getAttribute('draggable'), 'true')
    assert.equal(await spacedHeader.locator('.col-resize-handle').count(), 1)
    const spacedCell = firstRow.locator('td[data-column-key="cf_vendor%20note"]')
    assert.equal(await spacedCell.textContent(), 'Sample from vendor')
    assert.equal(await spacedCell.evaluate(el => getComputedStyle(el).maxWidth), '220px')

    const verifiedHeader = page.locator('th[data-sort="cf_quality.verified"]')
    await verifiedHeader.locator('.fm-header-filter-trigger').click()
    const panel = page.locator('.fm-header-filter-panel.open')
    await panel.getByLabel('Yes', { exact: true }).check()
    await panel.getByRole('button', { name: 'Apply', exact: true }).click()
    const rows = page.locator(`#${list}-table tr[onclick]`)
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length === 2, list)
    assert.match(await rows.nth(0).textContent(), /PLA Matte/)
    assert.match(await rows.nth(1).textContent(), /PETG Translucent/)
    await page.getByRole('button', { name: 'Clear column filters', exact: true }).click()
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length === 5, list)

    await spacedHeader.locator('.fm-header-filter-trigger').click()
    await panel.locator('.fm-header-filter-value:visible').fill('Sample from vendor')
    await panel.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length !== 5, list)
    assert.equal(await rows.count(), 1, `${list}: a spaced key filters its own values`)
    await page.getByRole('button', { name: 'Clear column filters', exact: true }).click()
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length === 5, list)

    await page.locator('th.col-cf_temperature .fm-header-filter-trigger').click()
    await panel.locator('.fm-header-filter-operator').selectOption('equals')
    await panel.locator('.fm-header-filter-value:visible').fill(await firstRow.locator('.col-cf_temperature').innerText())
    await panel.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length !== 5, list)
    assert.equal(await rows.count(), 1, `${list}: the range filter accepts the exact displayed text`)
    assert.match(await rows.first().textContent(), /PLA Matte/)
    await page.getByRole('button', { name: 'Clear column filters', exact: true }).click()
    await page.waitForFunction(list => document.querySelectorAll(`#${list}-table tr[onclick]`).length === 5, list)

    fillInventory = true
    const beforeSort = requests.length
    await page.locator('th.col-cf_checked .fm-header-sort-trigger').click()
    await page.locator(`#${list}-table .bulk-checkbox[data-${list === 'spools' ? 'spool' : 'filament'}-id="201"]`).waitFor()
    assert.deepEqual(await rows.locator('.col-cf_checked').allTextContents().then(values => values.slice(0, 4)),
      ['✗', '✗', '✗', '✗'], `${list}: unchecked values sort together across API pages`)
    assert.deepEqual(requests.slice(beforeSort).map(url => [
      url.searchParams.get('page'), url.searchParams.get('page_size'), url.searchParams.get('sort_by'),
    ]), [['1', '200', null], ['2', '200', null]])

    await page.reload({ waitUntil: 'domcontentloaded' })
    await rows.first().waitFor()
    assert.match(await page.locator('th.col-cf_checked').getAttribute('class'), /\bsort-asc\b/,
      `${list}: restored sorting shows the active direction on the dynamic column`)

    const storageKey = `filaman-sort-${list}`
    definitionsAvailable = false
    const beforeUnavailableReload = requests.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await rows.first().waitFor()
    assert.deepEqual(requests.slice(beforeUnavailableReload).map(url => url.searchParams.get('page_size')),
      ['50'], `${list}: an unavailable field catalog keeps server pagination`)
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).key, storageKey), 'cf_checked')
    definitionsAvailable = true
    await page.reload({ waitUntil: 'domcontentloaded' })
    await rows.first().waitFor()
    assert.match(await page.locator('th.col-cf_checked').getAttribute('class'), /\bsort-asc\b/)

    checkboxAvailable = false
    const beforeReload = requests.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await rows.first().waitFor()
    assert.deepEqual(requests.slice(beforeReload).map(url => url.searchParams.get('page_size')),
      ['50'], `${list}: deleting the sorted field restores server pagination`)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null)

    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ key: {}, direction: 'asc' })), storageKey)
    const beforeMalformedReload = requests.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await rows.first().waitFor()
    assert.deepEqual(requests.slice(beforeMalformedReload).map(url => url.searchParams.get('sort_by')),
      [null], `${list}: malformed saved sort is ignored`)
  }
  assert.deepEqual(errors, [])
  console.log('Extra-field columns display typed values safely and filter and sort across API pages.')
} finally {
  await browser.close()
}
