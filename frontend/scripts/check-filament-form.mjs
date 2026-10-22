/** Run against Astro dev: node scripts/check-filament-form.mjs [base URL]. All API writes are intercepted. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const floats = { drying_time_hours: 6.25, max_volumetric_speed_mm3_s: 18.55, flow_ratio: 0.9755, pressure_advance_k: 0.0456, drying_temp_c: 55.25, chamber_temp_c: 45.75, softening_temp_c: 85.5 }
const ranges = { extruder_temp: { min: 195.25, max: 220.75 }, bed_temp: { min: 55.25, max: 65.75 }, cooling_fan: { min: 30.25, max: 80.75 } }
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => console.error(error.message))
  const writes = []
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    sessionStorage.setItem('filaman_duplicate_filament', JSON.stringify({ manufacturer_id: 7, designation: 'Precision PLA', material_type: 'PLA', diameter_mm: 1.75, color_mode: 'multi', multi_color_style: null, colors: [{ color_id: 11, position: 1 }], default_spool_weight_g: 237, spool_material: 'Cardboard', spool_outer_diameter_mm: 203, spool_width_mm: 69 }))
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/me/label-presets/migrate')) return route.fulfill({ json: {} })
    if (request.method() !== 'GET') {
      writes.push({ path, body: request.postDataJSON() })
      await route.fulfill({ status: 422, json: { detail: { message: 'Fixture intercepted save' } } })
      return
    }
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/public-info')) json = { filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    else if (path.endsWith('/manufacturers')) json = { items: [{ id: 7, name: 'Fixture Brand', empty_spool_weight_g: 210, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 65 }], total: 1 }
    else if (path.endsWith('/types')) json = ['PLA']
    else if (path.endsWith('/colors')) json = { items: [{ id: 11, name: 'Red', hex_code: '#FF0000' }, { id: 12, name: 'Blue', hex_code: '#0000FF' }], total: 2 }
    await route.fulfill({ json })
  })
  await page.goto(new URL('/filaments/new', baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForFunction(() => document.querySelector('#designation')?.value === 'Precision PLA', null, { timeout: 15000 })
  // Native validation uses the rendered Astro inputs, not a reconstructed form.
  for (const [id, value] of Object.entries(floats)) await page.locator(`#${id}`).fill(String(value))
  for (const [prefix, value] of Object.entries(ranges)) {
    await page.locator(`#${prefix}_value`).fill(String(value.min))
    await page.locator(`#${prefix}_to`).fill(String(value.max))
  }
  const inputIds = [...Object.keys(floats), ...Object.keys(ranges).flatMap(prefix => [`${prefix}_value`, `${prefix}_to`])]
  const invalidFloats = await page.evaluate(ids => ids.filter(id => !document.getElementById(id).checkValidity()), inputIds)
  assert.deepEqual(invalidFloats, [], 'native float precision must pass step validation')
  assert.equal(await page.locator('#multi_color_style').inputValue(), 'striped')
  await page.locator('#manufacturer_id').focus()
  await page.locator('#manufacturer_id').selectOption('__add_manufacturer__')
  await page.locator('[data-manufacturer-cancel]').click()
  assert.equal(await page.locator('#manufacturer_id').inputValue(), '7')
  assert.equal(await page.locator('#manufacturer_id').evaluate(el => el === document.activeElement), true)
  for (const [id, value] of Object.entries({ default_spool_weight_g: '237', spool_material: 'Cardboard', spool_outer_diameter_mm: '203', spool_width_mm: '69' })) assert.equal(await page.locator(`#${id}`).inputValue(), value)
  await page.locator('#filament-color-launcher').click()
  // A visible DOM node alone does not prove it paints above a native showModal top layer.
  const swatch = page.locator('#color-grid button[aria-label="Blue (#0000FF)"]')
  const tooltip = page.locator('.fm-color-tooltip')
  for (const interaction of ['hover', 'focus']) {
    await page.locator('#filament-color-dialog-close').focus()
    await page.mouse.move(0, 0)
    await swatch[interaction]()
    assert.equal(await tooltip.isVisible(), true, `${interaction}: tooltip is displayed`)
    assert.equal(await tooltip.textContent(), 'Blue (#0000FF)')
    const paint = await tooltip.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      // Only for hit-testing: production tooltips intentionally ignore pointer input.
      element.style.pointerEvents = 'auto'
      const painted = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      element.style.removeProperty('pointer-events')
      return { onTop: painted === element, withinViewport: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight }
    })
    assert.equal(paint.withinViewport, true, `${interaction}: tooltip is within viewport`)
    assert.equal(paint.onTop, true, `${interaction}: tooltip paints above the native modal`)
    if (interaction === 'focus') assert.equal(await swatch.evaluate(el => el === document.activeElement), true)
  }
  await page.locator('#color-filter-button').click()
  const panel = page.locator('#filament-color-dialog .fm-header-filter-panel.open')
  await panel.waitFor()
  await panel.locator('input').first().focus()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#filament-color-dialog').evaluate(el => el.open), true)
  assert.equal(await page.locator('#color-filter-button').evaluate(el => el === document.activeElement), true)
  assert.equal(await page.locator('.fm-header-filter-panel.open').count(), 0)
  await page.locator('#new-color-disclosure summary').click()
  await page.waitForFunction(() => !document.querySelector('#new-color-name').disabled)
  assert.equal(await page.locator('#new-color-name').getAttribute('required'), '')
  await page.locator('#filament-color-dialog-done').click()
  assert.equal(await page.locator('#new-color-disclosure').evaluate(el => el.open), false)
  assert.equal(await page.locator('#new-color-name').isDisabled(), true)
  assert.equal(await page.locator('#filament-color-launcher').evaluate(el => el === document.activeElement), true)
  assert.equal(await page.locator('#filament-form').evaluate(el => el.checkValidity()), true)
  // Reopening restores the existing picker; native Escape follows the same cleanup path.
  await page.locator('#filament-color-launcher').click()
  await page.locator('#new-color-disclosure summary').click()
  await page.waitForFunction(() => !document.querySelector('#new-color-name').disabled)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#filament-color-dialog').evaluate(el => el.open), false)
  assert.equal(await page.locator('#new-color-name').isDisabled(), true)
  if (process.env.SCREENSHOT_PATH) {
    await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' })
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  }
  await page.locator('#designation').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('#error-message')?.textContent.includes('Fixture intercepted save'))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/v1/filaments')
  for (const [id, value] of Object.entries(floats)) assert.equal(writes[0].body[id], value)
  for (const [prefix, value] of Object.entries(ranges)) assert.deepEqual(writes[0].body[`${prefix}_range_${prefix === 'cooling_fan' ? 'percent' : 'c'}`], value)
  assert.equal(writes[0].body.multi_color_style, 'striped')
  console.log('PASS production filament form: native modal tooltip hover/focus paint order, float precision, nullable pattern, manufacturer Cancel/focus, nested filter Escape, inline editor cleanup, native Enter submission; all API writes intercepted')
} catch (error) {
  console.error(error)
  throw error
} finally {
  await browser.close()
}
