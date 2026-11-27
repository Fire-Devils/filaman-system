/** Dashboard card sizes in grid and masonry. API is mocked. Run against Astro dev or the compiled app.
 *  Usage: node scripts/check-dashboard-sizes.mjs [baseUrl] [screenshotDir] */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const shots = process.argv[3] || ''
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined, channel: process.env.CHROME_EXECUTABLE_PATH ? undefined : 'chrome', headless: true })
try {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `2026-${String(i + 1).padStart(2, '0')}`, spend: 20 + ((i * 37) % 80), consumption_g: 300 + ((i * 91) % 900),
    spool_count: 10 + i, total_weight_g: 8000 + i * 400, stock_value: 200 + i * 15,
  }))
  const stats = {
    spool_count_total: 24, filament_count_total: 12, filament_count_active: 9, filament_count_used: 7,
    spool_distribution: { full: 6, normal: 12, low: 4, critical: 1, empty: 1 }, total_value_available: 480,
    valuation: { remaining_value: 310, unknown_spool_count: 0 }, manufacturers_with_spools: [],
    low_stock_spools: Array.from({ length: 12 }, (_, i) => ({ spool_id: i + 1, filament_designation: `Sample ${i}`, filament_type: 'PLA', manufacturer_name: 'Maker', remaining_weight_g: 50 })),
    low_stock_filaments: [], filament_types: [], location_stats: [], filament_stats: [{ filament_type: 'PLA', spool_count: 8, total_weight_g: 6000 }],
  }
  let prefs = { dashboard_hidden_widgets: [], dashboard_widget_order: [], dashboard_layout: 'grid', dashboard_widget_sizes: {} }
  const patches = []
  const open = async (width, layout, sizes) => {
    prefs = { ...prefs, dashboard_layout: layout, dashboard_widget_sizes: sizes }
    const page = await browser.newPage({ viewport: { width, height: 1100 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('lang', 'en'))
    await page.route(/\/(?:api\/|auth\/me$)/, async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (request.method() !== 'GET') {
        if (path.endsWith('/me/preferences')) { const body = request.postDataJSON(); patches.push(body); prefs = { ...prefs, ...body } ; return route.fulfill({ json: prefs }) }
        return route.fulfill({ json: {} })
      }
      let json = {}
      if (path.endsWith('/me/preferences')) json = prefs
      else if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, roles: [], permissions: [] }
      else if (path.endsWith('/dashboard/stats')) json = stats
      else if (path.endsWith('/dashboard/history')) json = { months }
      else if (path.endsWith('/dashboard/locations')) json = []
      else if (path.endsWith('/public-info')) json = { currency: 'EUR' }
      else if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
      await route.fulfill({ json })
    })
    await page.goto(new URL('/', base).href)
    await page.locator('#chart-spend svg').waitFor()
    await page.waitForTimeout(400)
    return { page, errors }
  }
  const box = (page, id) => page.locator(`[data-widget="${id}"]`).evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  const sizes = { chartSpend: { w: 2, h: 'm' }, lowStockSpools: { w: 1, h: 's' }, spoolStatus: { w: 'full', h: 'auto' } }

  for (const layout of ['grid', 'masonry']) {
    for (const width of [1440, 390]) {
      const { page, errors } = await open(width, layout, sizes)
      const wide = await box(page, 'chartSpend'), low = await box(page, 'lowStockSpools'), container = await page.locator('#dashboard-widgets').boundingBox()
      assert.equal(Math.round(wide.h), 360, `${layout}/${width}: medium card is 360px`)
      assert.equal(Math.round(low.h), 240, `${layout}/${width}: small card is 240px`)
      if (width === 1440) assert.ok(wide.w > low.w * 1.5, `${layout}/${width}: 2-column card is wider than a 1-column card`)
      else assert.ok(Math.abs(wide.w - container.width) < 2, `${layout}/${width}: one column ignores widths`)
      const svgHeight = await page.locator('#chart-spend svg').evaluate(el => el.getBoundingClientRect().height)
      assert.ok(svgHeight > 200, `${layout}/${width}: chart fills the taller card (${svgHeight})`)
      if (layout === 'masonry') {
        const rows = await page.locator('#dashboard-widgets > [data-widget]').evaluateAll(els => els.map(el => el.style.gridRow))
        assert.ok(rows.every(row => /^span \d+$/.test(row)), `${layout}/${width}: every card has a row span`)
      }
      if (shots) await page.screenshot({ path: `${shots}/dashboard-${layout}-${width}.png`, fullPage: true })
      assert.deepEqual(errors, [])
      await page.close()
    }
  }

  // Arrange mode: selects and resize handle (grid and masonry at desktop width).
  for (const layout of ['grid', 'masonry']) {
    const { page, errors } = await open(1440, layout, {})
    patches.length = 0
    await page.locator('#widget-menu-btn').click()
    await page.locator('#widget-arrange-btn').click()
    const select = page.locator('[data-widget="chartConsumption"] select[data-size="h"]')
    await select.selectOption('l')
    await page.waitForTimeout(200)
    assert.equal(Math.round((await box(page, 'chartConsumption')).h), 520, `${layout}: select sets the large height`)
    assert.deepEqual(patches.at(-1).dashboard_widget_sizes.chartConsumption.h, 'l')

    const grip = page.locator('[data-widget="chartSpend"] .dashboard-resize-handle')
    await grip.scrollIntoViewIfNeeded()
    const g = await grip.boundingBox(), before = await box(page, 'chartSpend')
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await page.mouse.down()
    await page.mouse.move(g.x + g.width / 2 + 420, g.y + g.height / 2 + 200, { steps: 8 })
    const live = await box(page, 'chartSpend')
    assert.ok(live.w > before.w + 100 && live.h > before.h + 30, `${layout}: live preview while dragging`)
    if (shots) await page.screenshot({ path: `${shots}/dashboard-${layout}-arrange-drag.png` })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const saved = patches.at(-1).dashboard_widget_sizes.chartSpend
    assert.ok(saved && (saved.w === 'full' || saved.w >= 2) && saved.h !== 'auto', `${layout}: resize saved (${JSON.stringify(saved)})`)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('Dashboard sizes: grid + masonry, desktop + phone, selects and resize handle passed')
} finally {
  await browser.close()
}
