import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => console.error(error.message))
  const spool = { id: 16, filament_id: 10, filament: { id: 10, designation: 'Fixture PLA', material_type: 'PLA', manufacturer: { id: 1, name: 'Fixture' } }, custom_fields: {}, custom_field_definitions: {} }
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: [] })
    const path = new URL(route.request().url()).pathname
    let json = []
    if (path.endsWith('/me')) json = { id: 1, language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/spools/16')) json = spool
    else if (path.endsWith('/public-info')) json = { currency: 'USD', filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    else if (path.endsWith('/locations') || path.endsWith('/events')) json = { items: [], total: 0 }
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    await route.fulfill({ json })
  })
  await page.goto(`${process.env.BASE_URL || 'http://localhost:4321'}/spools/16`)
  await page.locator('#btn-print-label[href*="designation="]').waitFor()
  await page.goto(new URL(await page.locator('#btn-print-label').getAttribute('href'), page.url()).href)
  const checkbox = page.locator('[id="check-ef-purchase_currency"]')
  await checkbox.check()
  await page.waitForFunction(() => document.querySelector('#label-preview')?.textContent.includes('USD'))
  assert.match(await page.locator('#label-preview').textContent(), /USD/)
  console.log('Single Standard selected Purchase Currency renders initialized USD')
} finally {
  await browser.close()
}
