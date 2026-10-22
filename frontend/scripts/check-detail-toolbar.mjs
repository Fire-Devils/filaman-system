/** All API writes are intercepted; run against Astro dev or the compiled UI. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const filament = { id: 10, designation: 'Fixture PLA', material_type: 'PLA', diameter_mm: 1.75, manufacturer_id: 7, manufacturer: { id: 7, name: 'Fixture Brand' }, color_mode: 'single', colors: [{ color_id: 11, position: 1, color: { id: 11, name: 'Red', hex_code: '#FF0000' } }] }
const spool = { id: 16, filament_id: 10, filament, status_id: 1, remaining_weight_g: 800, initial_total_weight_g: 1200, empty_spool_weight_g: 200, custom_fields: {}, custom_field_definitions: {} }
const printerHealth = { connected: true, slots: Array.from({ length: 4 }, (_, index) => ({ slot_index: `0-${index}`, slot_kind: 'ams', present: true, tray_type: 'PLA', tray_color: 'FF0000' })) }
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  const writes = []
  await page.addInitScript(data => {
    localStorage.setItem('lang', 'en')
    sessionStorage.setItem('filaman_duplicate_filament', JSON.stringify(data))
  }, filament)
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/me/label-presets/migrate')) return route.fulfill({ json: [] })
    if (request.method() !== 'GET') {
      writes.push({ path, body: request.postDataJSON() })
      return route.fulfill({ status: 422, json: { detail: { message: 'Fixture save rejected' } } })
    }
    let json = []
    if (path.endsWith('/me')) json = { id: 1, language: 'en', is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/filaments/10')) json = filament
    else if (path.endsWith('/spools/16')) json = spool
    else if (path.endsWith('/spools/16/events')) json = { items: [], total: 0 }
    else if (path.endsWith('/filaments')) json = { items: [filament], total: 1 }
    else if (path.endsWith('/manufacturers')) json = { items: [filament.manufacturer], total: 1 }
    else if (path.endsWith('/types')) json = ['PLA']
    else if (path.endsWith('/colors')) json = { items: [filament.colors[0].color], total: 1 }
    else if (path.endsWith('/spools/statuses')) json = [{ id: 1, key: 'opened', label: 'Opened' }]
    else if (path.endsWith('/printers')) json = { items: [{ id: 1, name: 'Online AMS printer' }], total: 1 }
    else if (path.endsWith('/driver/health')) json = printerHealth
    else if (path.endsWith('/spools') || path.endsWith('/locations')) json = { items: [], total: 0 }
    else if (path.endsWith('/public-info')) json = { filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    await route.fulfill({ json })
  })
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [url, ready, toggle] of [
      ['/filaments/10', '.detail-page-actions:visible', null],
      ['/spools/16', '#btn-edit-spool', null],
      ['/filaments/new', '#designation', null],
      ['/filaments/10?edit=1', '#designation', '#btn-edit-filament'],
      ['/spools/16?edit=1', '#btn-cancel-edit', '#btn-edit-spool'],
    ]) {
      await page.goto(new URL(url, baseUrl).href, { waitUntil: 'domcontentloaded' })
      await page.locator(ready).waitFor()
      if (url.startsWith('/spools')) await page.locator('#printer-slots-inline .fm-card').waitFor()
      const scrollIdentity = page.locator('.detail-scroll-identity')
      const hasIdentity = !url.endsWith('new')
      assert.equal(await scrollIdentity.count(), hasIdentity ? 1 : 0, `${url}: only existing records have a scroll identity`)
      if (hasIdentity) assert.equal(await scrollIdentity.getAttribute('aria-hidden'), 'true', `${url}: hero identity is not duplicated at the top`)
      if (url.includes('filaments/') && (url.includes('edit=1') || url.endsWith('new'))) {
        await page.waitForFunction(() => document.querySelector('#designation')?.value === 'Fixture PLA')
        if (toggle) await page.locator('#designation').fill('Changed PLA')
      }
      if (toggle) {
        assert.equal(await page.locator(toggle).getAttribute('aria-pressed'), 'true', `${url}: Edit remains pressed`)
        assert.equal(await page.locator(toggle).evaluate(el => getComputedStyle(el).backgroundColor === getComputedStyle(el.closest('.detail-page-toolbar')).backgroundColor), false, `${url}: Edit is highlighted`)
      }
      await page.evaluate(() => { document.querySelector('main').scrollTop = 0 })
      const identitySource = page.locator(url.includes('filaments/') && toggle ? '#filament-editor-title' : '.detail-record-name')
      const identityContentTop = hasIdentity ? await identitySource.evaluate(title => title.getBoundingClientRect().top + title.closest('main').scrollTop) : 0
      const initialTop = await page.locator('.detail-page-toolbar').evaluate(toolbar => toolbar.getBoundingClientRect().top)
      assert.ok(Math.abs(initialTop) < 2, `${width} ${url}: toolbar is flush before scrolling, got ${initialTop}px`)
      await page.evaluate(() => { document.querySelector('main').scrollTop = 600 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const layout = await page.locator('.detail-page-toolbar').evaluate(toolbar => {
        const rect = toolbar.getBoundingClientRect()
        const controls = [...toolbar.querySelectorAll('.detail-back-link, .filament-change-pill, button, .detail-icon-button, .fm-btn')].filter(el => el.getBoundingClientRect().width && !el.closest('.hidden'))
        return { sticky: getComputedStyle(toolbar).position, top: rect.top, bottom: rect.bottom, mainTop: toolbar.parentElement.getBoundingClientRect().top, scrolled: toolbar.parentElement.scrollTop, controls: controls.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, mid: (r.top + r.bottom) / 2 } }) }
      })
      assert.equal(layout.sticky, 'sticky', `${width} ${url}: persistent toolbar`)
      assert.ok(layout.scrolled > 100 && layout.top >= 0 && layout.top < 2, `${width} ${url}: toolbar stays at the viewport top: ${JSON.stringify(layout)}`)
      assert.ok(layout.controls.every(c => c.left >= 0 && c.right <= width && Math.abs(c.mid - layout.controls[0].mid) < 2), `${width} ${url}: all controls stay on one visible row`)
      if (hasIdentity) {
        await page.waitForFunction(() => document.querySelector('.detail-scroll-identity')?.getAttribute('aria-hidden') === 'false')
        assert.ok((await scrollIdentity.locator('.detail-scroll-id').textContent()).endsWith(url.startsWith('/spools') ? '16' : '10'), `${url}: strip identifies the current record, not its linked entity`)
        assert.equal(await scrollIdentity.locator('.detail-scroll-name').textContent(), await identitySource.textContent(), `${url}: scroll strip uses the current hero name`)
        const identityLayout = await scrollIdentity.evaluate(strip => {
          const bounds = strip.getBoundingClientRect()
          const toolbar = strip.parentElement.getBoundingClientRect()
          const swatch = strip.querySelector('.detail-scroll-swatch').getBoundingClientRect()
          return { left: bounds.left, right: bounds.right, top: bounds.top, toolbarBottom: toolbar.bottom, height: bounds.height, swatchWidth: swatch.width, swatchHeight: swatch.height, duration: getComputedStyle(strip).transitionDuration }
        })
        assert.ok(identityLayout.left >= 0 && identityLayout.right <= width && Math.abs(identityLayout.top - identityLayout.toolbarBottom) <= 1 && identityLayout.height <= 30, `${width} ${url}: one compact identity line fits below the action bar: ${JSON.stringify(identityLayout)}`)
        assert.ok(identityLayout.swatchWidth > 0 && identityLayout.swatchWidth <= 40 && identityLayout.swatchHeight <= 14, `${url}: color pill stays small`)
        assert.ok(identityLayout.duration.split(',').some(value => parseFloat(value) > 0 && parseFloat(value) <= .2), 'Identity appears with a quick fade')
        assert.ok(Math.abs(await identitySource.evaluate(title => title.getBoundingClientRect().top + title.closest('main').scrollTop) - identityContentTop) < 1, 'Showing identity does not shift page content')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        assert.ok((await scrollIdentity.evaluate(strip => getComputedStyle(strip).transitionDuration)).split(',').every(value => parseFloat(value) === 0), 'Reduced motion skips the fade')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
      }
      await page.evaluate(() => { document.querySelector('main').scrollTop = 0 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.ok(Math.abs(await page.locator('.detail-page-toolbar').evaluate(toolbar => toolbar.getBoundingClientRect().top)) < 2, `${width} ${url}: toolbar stays flush after scrolling back`)
      if (hasIdentity) await page.waitForFunction(() => document.querySelector('.detail-scroll-identity')?.getAttribute('aria-hidden') === 'true')
      if (url.includes('edit=1') || url.endsWith('new')) {
        const submit = page.locator('.detail-page-toolbar [type="submit"]')
        const before = writes.length
        await submit.click()
        const error = url.startsWith('/spools') ? '#spool-edit-error' : '#error-message'
        await page.locator(error).filter({ hasText: 'Fixture save rejected' }).waitFor()
        assert.equal(writes.length, before + 1, `${url}: header save submits exactly once`)
        assert.equal(await submit.isEnabled(), true, `${url}: save recovers after rejection`)
      }
      if (toggle) {
        await page.locator(toggle).click()
        if (url.startsWith('/spools')) await page.locator('#btn-cancel-edit').waitFor({ state: 'hidden' })
        else await page.locator('#filament-editor').waitFor({ state: 'hidden' })
        assert.equal(await page.locator('.detail-page-actions [aria-pressed="true"]').count(), 0, `${url}: Edit toggles off`)
      }
    }
  }
  console.log('PASS flush one-row detail actions before/after scrolling at 390/1024/1440px, pressed Edit toggles, external Save/Create validation and failure recovery; all API writes intercepted')
} finally {
  await browser.close()
}
