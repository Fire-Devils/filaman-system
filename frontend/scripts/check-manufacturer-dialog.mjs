/** Run against Astro dev. All API requests are fixtures; no inventory is changed. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  for (const width of [1440, 390]) for (const linked of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    page.setDefaultTimeout(10000)
    const errors = [], writes = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('lang', 'en'))
    let manufacturer = { id: 7, name: 'Local maker', custom_fields: linked ? { filamentdb_id: 100 } : {} }
    const catalog = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `Catalog maker ${i + 1}`, website: 'https://example.test', description: 'Catalog profile', is_active: true }))
    await page.route(/\/(?:api\/|auth\/me$)/, async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path.endsWith('/me/label-presets/migrate')) return route.fulfill({ json: {} })
      if (request.method() !== 'GET') {
        writes.push({ path, body: request.postDataJSON() })
        assert.equal(path, '/api/v1/manufacturers/7')
        manufacturer = { ...manufacturer, ...request.postDataJSON() }
        return route.fulfill({ json: manufacturer })
      }
      let json = []
      if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
      if (path.endsWith('/me')) json = { id: 1, email: 'preview@example.test', display_name: 'Hotfix Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] }
      else if (path.endsWith('/public-info')) json = { currency: 'USD' }
      else if (path === '/api/v1/filamentdb/status') json = { active: true }
      else if (path === '/api/v1/filamentdb/manufacturers') json = { items: catalog, total: catalog.length }
      else if (path === '/api/v1/filamentdb/manufacturers/100') json = catalog[0]
      else if (path === '/api/v1/manufacturers') json = { items: [manufacturer], total: 1 }
      return route.fulfill({ json })
    })
    await page.goto(new URL('/manufacturers', base).href, { waitUntil: 'domcontentloaded' })
    await page.locator('.manufacturer-row').click()
    await page.locator('.manufacturer-lookup-details summary').click()
    const input = page.locator('.fdb-lookup-input')
    await input.fill('Catalog')
    await page.waitForFunction(() => document.querySelectorAll('.fdb-lookup-item').length === 20)
    assert.equal(await page.locator('.fdb-lookup-dropdown').evaluate(el => {
      const list = el.getBoundingClientRect(), section = el.closest('.manufacturer-source').getBoundingClientRect()
      return list.top >= section.top && list.bottom <= section.bottom
    }), true, `${width}/${linked}: the complete result list fits inside its clipping container`)
    const first = page.locator('.fdb-lookup-item').first()
    await first.scrollIntoViewIfNeeded()
    assert.equal(await first.evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
    }), true, `${width}/${linked}: search results must be painted and clickable inside the popup`)
    assert.notEqual(await input.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)', 'view mode keeps the search input visible')
    const last = page.locator('.fdb-lookup-item').last()
    await last.click()
    const nameChoice = page.locator('[data-catalog-field="name"]')
    await nameChoice.check()
    await page.locator('[data-catalog-apply]').click()
    assert.equal(await page.locator('[data-manufacturer-name]').inputValue(), 'Catalog maker 20')
    assert.equal(writes.length, 0, 'selection stays a draft until Save')
    await page.locator('[data-manufacturer-cancel]').click()
    assert.equal(await page.locator('[data-manufacturer-name]').inputValue(), 'Local maker')
    assert.equal(writes.length, 0)

    await page.locator('.manufacturer-lookup-details summary').click()
    await page.locator('.fdb-lookup-input').fill('Catalog')
    await page.locator('.fdb-lookup-item').last().click()
    await page.locator('[data-catalog-field="name"]').check()
    await page.locator('[data-catalog-apply]').click()
    await page.locator('[data-manufacturer-submit]').click()
    await page.waitForFunction(() => document.querySelector('[data-manufacturer-name]')?.readOnly && !document.querySelector('[data-manufacturer-form]')?.inert)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].body.custom_fields.filamentdb_id, 119)
    assert.equal(writes[0].body.custom_fields.catalog_sources.filamentdb.id, 119)
    assert.equal(await page.locator('[data-manufacturer-name]').inputValue(), 'Catalog maker 20')
    assert.deepEqual(errors, [])
    if (process.env.SCREENSHOT_DIR && !linked) {
      await page.locator('.manufacturer-lookup-details summary').click()
      await page.locator('.fdb-lookup-input').fill('Catalog')
      await page.locator('.fdb-lookup-dropdown').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/catalog-search-${width}.png` })
    }
    await page.close()
  }
  console.log('Manufacturer catalog: view search, 20-result scrolling, select/apply/cancel/save pass on desktop/mobile for linked and unlinked records.')
} finally { await browser.close() }
