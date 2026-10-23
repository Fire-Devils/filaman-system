/** Browser API writes and catalog images are intercepted; no inventory is changed. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const filament = { id: 10, designation: 'Catalog PLA', material_type: 'PLA', diameter_mm: 1.75, manufacturer_id: 7, manufacturer: { id: 7, name: 'Catalog Brand' }, color_mode: 'single', colors: [], raw_material_weight_g: 1000, default_spool_weight_g: 170, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 68, filamentdb_spool_image_file: '735.png' }
const spool = { id: 16, filament_id: 10, filament, status_id: 1, remaining_weight_g: 800, initial_total_weight_g: 1200, empty_spool_weight_g: 200, custom_fields: {} }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmF8AAAAASUVORK5CYII=', 'base64')
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  let imageStatus = 200
  await page.addInitScript(() => localStorage.setItem('lang', 'en'))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/print-requests/pending')) return route.fulfill({ json: null })
    if (path.endsWith('/me/label-presets/migrate')) return route.fulfill({ json: [] })
    if (request.method() !== 'GET') return route.fulfill({ status: 422, json: { detail: 'Fixture writes blocked' } })
    if (path.endsWith('/spool-profile-image')) return route.fulfill({ status: imageStatus, contentType: imageStatus === 200 ? 'image/png' : 'application/json', body: imageStatus === 200 ? png : '{"detail":"Image not found"}' })
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'review@example.com', language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/filaments/10')) json = filament
    else if (path.endsWith('/spools/16')) json = spool
    else if (path.endsWith('/filaments')) json = { items: [filament], total: 1 }
    else if (path.endsWith('/manufacturers')) json = { items: [filament.manufacturer], total: 1 }
    else if (path.endsWith('/types')) json = ['PLA']
    else if (path.endsWith('/colors') || path.endsWith('/spools') || path.endsWith('/locations') || path.endsWith('/printers') || path.endsWith('/events')) json = { items: [], total: 0 }
    else if (path.endsWith('/spools/statuses')) json = [{ id: 1, key: 'opened', label: 'Opened' }]
    else if (path.endsWith('/public-info')) json = { filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    await route.fulfill({ json })
  })
  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const path of ['/filaments/10', '/spools/16', '/spools/16?edit=1']) {
      await page.goto(new URL(path, baseUrl).href, { waitUntil: 'domcontentloaded' })
      const photo = page.locator('.filament-spool-image:visible')
      await photo.waitFor()
      await photo.scrollIntoViewIfNeeded()
      const thumbnail = await photo.locator('img').isVisible()
      if (thumbnail) await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('.filament-spool-image img')].filter(image => image.checkVisibility())
        return images.length === 1 && images[0].complete && images[0].naturalWidth > 0
      })
      assert.equal(await photo.count(), 1, `${path}: image appears once`)
      if (path.startsWith('/spools')) assert.equal(await page.locator('.spool-filament-panel .filament-spool-image').count(), 1, 'Only the linked filament owns the image')
      const card = await photo.locator('xpath=ancestor::section[1]').elementHandle()
      await page.evaluate(() => document.fonts.ready)
      const height = (await card.boundingBox()).height
      const rowHeights = await card.evaluate(section => [...section.querySelectorAll('.filament-spec-row')].map(row => row.getBoundingClientRect().height))
      const geometry = await photo.evaluate(figure => {
        const image = figure.querySelector('img').getBoundingClientRect()
        const caption = figure.querySelector('code')
        const bounds = caption.getBoundingClientRect()
        return { captionFits: (!image.width || (bounds.left >= image.left - 1 && bounds.right <= image.right + 1)) && caption.scrollWidth <= caption.clientWidth, right: figure.getBoundingClientRect().right }
      })
      assert.ok(geometry.captionFits && geometry.right <= width, `${width} ${path}: caption fits beneath image`)
      if (thumbnail) assert.ok(await photo.evaluate(figure => {
        const rows = figure.parentElement.querySelectorAll('.filament-spec-row')
        const container = figure.parentElement.getBoundingClientRect()
        const bounds = figure.getBoundingClientRect()
        return Math.abs((bounds.top + bounds.bottom) / 2 - (container.top + container.bottom) / 2) <= 1 && [...rows].every(row => row.getBoundingClientRect().right < bounds.left)
      }), `${width} ${path}: every row reserves image space and the photo is vertically centered`)
      assert.ok(await photo.locator('a').isVisible(), `${width} ${path}: catalog image remains accessible`)
      if (!thumbnail) {
        assert.ok(await photo.evaluate(figure => {
          const link = figure.getBoundingClientRect()
          return [...figure.parentElement.querySelectorAll('.filament-spec-label, .filament-spec-value')].every(element => {
            const bounds = element.getBoundingClientRect()
            return bounds.bottom <= link.top || bounds.top >= link.bottom || bounds.right <= link.left || bounds.left >= link.right
          })
        }), `${width} ${path}: compact link does not cover field text`)
      }
      await photo.evaluate(figure => figure.remove())
      const heightWithoutImage = (await card.boundingBox()).height
      const rowsWithoutImage = await card.evaluate(section => [...section.querySelectorAll('.filament-spec-row')].map(row => row.getBoundingClientRect().height))
      assert.ok(height <= heightWithoutImage + 1, `${width} ${path}: image must not increase card height (${height} vs ${heightWithoutImage}; rows: ${rowHeights} vs ${rowsWithoutImage})`)
      console.log(`${width} ${path}: ${thumbnail ? 'thumbnail' : 'source link'} fits; no card expansion`)
    }
  }
  imageStatus = 404
  await page.goto(new URL('/filaments/10', baseUrl).href)
  await page.locator('#filament-content .filament-spec-grid').waitFor()
  await page.waitForFunction(() => !document.querySelector('#filament-content .filament-spool-image'))
  await page.goto(new URL('/filaments/10?edit=1', baseUrl).href)
  await page.locator('#designation').waitFor()
  assert.equal(await page.locator('#filament-form .filament-spool-image').count(), 0, 'Editing controls retain their full width')
  console.log('PASS one filament-owned image, unchanged card heights and caption bounds at 320/390/760/1440px, no duplicate physical-spool photo, missing-image fallback and full-width edit controls')
} finally {
  await browser.close()
}
