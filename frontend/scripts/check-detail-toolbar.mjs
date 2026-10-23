/** All API writes are intercepted; run against Astro dev or the compiled UI. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const language = process.env.CHECK_LANGUAGE || 'en'
const filament = { id: 10, designation: 'Fixture PLA', material_type: 'PLA', diameter_mm: 1.75, manufacturer_id: 7, manufacturer: { id: 7, name: 'Fixture Brand' }, color_mode: 'single', colors: [{ color_id: 11, position: 1, color: { id: 11, name: 'Red', hex_code: '#FF0000' } }] }
const spool = { id: 16, filament_id: 10, filament, status_id: 1, remaining_weight_g: 800, initial_total_weight_g: 1200, empty_spool_weight_g: 200, custom_fields: {}, custom_field_definitions: {} }
const heroFilament = { ...filament, designation: 'Premium Performance Matte PLA Carbon Fiber Reinforced', manufacturer: { ...filament.manufacturer, logo_url: 'https://fixture.invalid/logo.svg' } }
const printerHealth = { connected: true, slots: Array.from({ length: 4 }, (_, index) => ({ slot_index: `0-${index}`, slot_kind: 'ams', present: true, tray_type: 'PLA', tray_color: 'FF0000' })) }
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  const writes = []
  let checkHero = true
  await page.addInitScript(({ data, language }) => {
    localStorage.setItem('lang', language)
    localStorage.setItem('sidebar-collapsed', 'false')
    sessionStorage.setItem('filaman_duplicate_filament', JSON.stringify(data))
  }, { data: filament, language })
  await page.route('https://fixture.invalid/logo.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="black"/></svg>' }))
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
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language, is_superadmin: true, permissions: [], roles: [] }
    else if (path.endsWith('/print-requests/pending')) json = null
    else if (path.endsWith('/filaments/10')) json = checkHero ? heroFilament : filament
    else if (path.endsWith('/spools/16')) json = checkHero ? { ...spool, filament: heroFilament } : spool
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
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    for (const url of ['/filaments/10', '/spools/16']) {
      await page.goto(new URL(url, baseUrl).href, { waitUntil: 'domcontentloaded' })
      await page.locator('.filament-hero-logo img').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const hero = await page.locator('.filament-hero-title-row').evaluate(row => {
        const bounds = element => {
          const { left, right, top, bottom, width } = element.getBoundingClientRect()
          return { left, right, top, bottom, width }
        }
        return { row: bounds(row), id: bounds(row.querySelector('.detail-record-id')), name: bounds(row.querySelector('.detail-record-name')), logo: bounds(row.querySelector('.filament-hero-logo')), overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.equal(hero.overflow, false, `${width} ${url}: long product name and logo do not overflow`)
      if (width <= 390) {
        assert.ok(Math.abs(hero.name.width - hero.row.width) < 1, `${width} ${url}: product name uses the full hero row: ${JSON.stringify(hero)}`)
        assert.ok(hero.name.top >= Math.max(hero.id.bottom, hero.logo.bottom) - 1, `${width} ${url}: product name sits below ID and logo`)
        assert.ok(hero.id.right <= hero.logo.left && Math.abs(hero.logo.right - hero.row.right) < 1 && hero.logo.top < hero.id.bottom, `${width} ${url}: logo stays top-right beside ID`)
      } else {
        assert.ok(hero.name.right < hero.logo.left && hero.name.top < hero.logo.bottom, `${url}: desktop keeps the product name beside the logo`)
      }
    }
  }
  checkHero = false
  for (const width of [320, 390, 640, 768, 1024, 1440]) {
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
      const grid = page.locator(url.startsWith('/spools') ? '#spool-inline-form > .filament-spec-grid' : (toggle || url.endsWith('new')) ? '.filament-form-sections' : '#filament-content .filament-spec-grid')
      const layoutCards = await grid.locator(':scope > .filament-spec-card').evaluateAll(cards => cards.map(card => {
        const { left, right, top } = card.getBoundingClientRect()
        return { left, right, top }
      }))
      assert.ok(layoutCards.length >= 2, `${url}: populated specification sections`)
      assert.ok(layoutCards.every(card => card.left >= 0 && card.right <= width + 1), `${width} ${url}: all cards fit the viewport`)
      if (width <= 1024) assert.ok(layoutCards[1].top > layoutCards[0].top, `${width} ${url}: narrow sections stack`)
      if (width === 1440) assert.ok(Math.abs(layoutCards[1].top - layoutCards[0].top) < 1, `${url}: desktop sections use available width`)
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', `${url}: temporary editor collapse preserves the saved preference`)
      if (toggle) {
        if (url.startsWith('/filaments')) await page.waitForFunction(() => document.querySelector('#designation')?.value === 'Fixture PLA')
        assert.equal(await page.locator('.detail-page-toolbar [type="submit"]').isDisabled(), true, `${url}: unchanged editor starts with Save disabled`)
        assert.ok(await page.locator('.detail-page-toolbar [type="submit"]').evaluate(save => getComputedStyle(save).backgroundColor !== getComputedStyle(save.closest('.detail-page-actions').querySelector('[aria-pressed="true"]')).backgroundColor), `${url}: clean Save is muted, not highlighted like Edit`)
      }
      assert.equal(await page.locator('#sidebar-toggle .sidebar-menu-icon').isVisible(), width <= 768, `${width}: hamburger on phones only`)
      assert.equal(await page.locator('#sidebar-toggle .sidebar-chevron-icon').isVisible(), width > 768, `${width}: desktop keeps its collapse chevron`)
      if (width <= 768) {
        assert.ok(await page.locator('main').evaluate(main => main.getBoundingClientRect().left < 1), `${width} ${url}: closed phone navigation reserves no content column`)
        assert.ok(await page.locator('main').evaluate(main => parseFloat(getComputedStyle(main).paddingLeft) <= 24), `${width} ${url}: responsive margins`)
        await page.locator('#sidebar-toggle').click()
        assert.equal(await page.locator('main').evaluate(main => main.inert), true, 'Open drawer makes background inactive')
        assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true')
        await page.keyboard.press('Shift+Tab')
        assert.equal(await page.locator('.fm-sidebar a[href]').last().evaluate(link => link === document.activeElement), true, 'Drawer traps backwards focus')
        await page.keyboard.press('Tab')
        assert.equal(await page.locator('#sidebar-toggle').evaluate(toggle => toggle === document.activeElement), true, 'Drawer wraps forwards focus')
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('main').evaluate(main => main.inert), false)
        assert.equal(await page.locator('#sidebar-toggle').evaluate(toggle => toggle === document.activeElement), true)
        await page.locator('#sidebar-toggle').click()
        await page.locator('#sidebar-backdrop').click({ position: { x: width - 5, y: 300 } })
        assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false')
        assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', 'Mobile navigation preserves desktop preference')
      }
      if (url.startsWith('/spools')) {
        assert.ok(await page.locator('#btn-rfid').evaluate(button => {
          const rect = button.getBoundingClientRect()
          const artwork = button.querySelector('svg').getBBox()
          return Math.abs(rect.width - rect.height) < .1 && Math.abs(artwork.width - artwork.height) < .1 && getComputedStyle(button).flexShrink === '0'
        }), `${width} ${url}: RFID button and artwork are circular, without flex compression`)
        if (toggle) {
          assert.ok(await page.locator('#spool-inline-form .filament-spec-row:has(.spool-edit-input)').evaluateAll(rows => rows.every(row => {
            const label = row.querySelector('.filament-spec-label').getBoundingClientRect()
            const control = row.querySelector('.spool-core-edit, .spool-input-unit, .spool-edit-input').getBoundingClientRect()
            const bounds = row.getBoundingClientRect()
            return label.width > 20 && control.left >= bounds.left - 1 && control.right <= bounds.right + 1 && (label.bottom <= control.top + 1 || label.right <= control.left - 5)
          })), `${width} ${url}: spool labels and complete controls stay separate inside their cards`)
          const coreName = await page.locator('[name="spool_core_weight_g"]').getAttribute('aria-label')
          assert.ok(coreName, 'Core weight has an accessible name')
          assert.notEqual(await page.locator('[name="spool_core_weight_g"]').getAttribute('placeholder'), 'common.default', 'The short default hint is translated')
          assert.equal(await page.getByRole('spinbutton', { name: coreName, exact: true }).count(), 1)
          const weight = page.locator('[name="initial_total_weight_g"]')
          if (width === 390) {
            assert.ok(await weight.evaluate(input => {
              const label = input.closest('.filament-spec-row').querySelector('.filament-spec-label').getBoundingClientRect()
              const rect = input.getBoundingClientRect()
              return rect.width < 120 && label.right < rect.left && label.top < rect.bottom && label.bottom > rect.top
            }), 'Spool weight stays compact beside its label on phones')
          }
          await weight.fill('1234567')
          const save = page.locator('.detail-page-toolbar [type="submit"]')
          assert.equal(await save.isEnabled(), true, 'Spool change enables Save')
          assert.ok(await weight.evaluate(input => input.scrollWidth <= input.clientWidth + 1), 'Large numeric values remain readable')
          await weight.fill('1200')
          assert.equal(await save.isDisabled(), true, 'Reverting spool changes disables Save again')
          await weight.fill('1234567')
        }
      }
      if (url.includes('filaments/') && (url.includes('edit=1') || url.endsWith('new'))) {
        await page.waitForFunction(() => document.querySelector('#designation')?.value === 'Fixture PLA')
        assert.ok(await page.locator('.filament-form-check').evaluate(row => row.querySelector('span').getBoundingClientRect().right < row.querySelector('input').getBoundingClientRect().left), 'Checkbox label stays on the left, consistent with numeric rows')
        assert.ok(await page.locator('.filament-form-number').evaluateAll(rows => rows.every(row => {
          const bounds = row.getBoundingClientRect()
          const label = row.querySelector('.fm-label').getBoundingClientRect()
          const controls = [...row.querySelectorAll('input[type="number"]')].map(input => input.getBoundingClientRect())
          return controls.every(control => control.left >= bounds.left && control.right <= bounds.right + 1 && (label.bottom <= control.top + 1 || label.right <= control.left - 4))
        })), `${width} ${url}: filament numbers stay inside their rows without overlapping labels`)
        if (width === 390) {
          for (const id of ['diameter_mm', 'raw_material_weight_g', 'drying_temp_c']) {
            assert.ok(await page.locator(`#${id}`).evaluate(input => {
              const row = input.closest('[data-dirty-key]')
              const label = row.querySelector('.fm-label').getBoundingClientRect()
              const rect = input.getBoundingClientRect()
              return rect.width < 120 && label.right < rect.left && label.top < rect.bottom && label.bottom > rect.top
            }), `${id}: filament numbers stay compact beside labels on phones`)
          }
        }
        if (toggle) {
          const save = page.locator('.detail-page-toolbar [type="submit"]')
          const rangeRows = page.locator('[data-filament-section="temperatures"] .filament-form-number').filter({ has: page.locator('.filament-range-inputs') })
          const cleanEdges = await rangeRows.evaluateAll(rows => rows.map(row => ({
            left: row.querySelector('.fm-label').getBoundingClientRect().left,
            right: row.querySelector('.filament-unit-input').getBoundingClientRect().right,
          })))
          for (const id of ['extruder_temp_value', 'extruder_temp_to', 'bed_temp_value', 'bed_temp_to']) {
            await page.locator(`#${id}`).fill(id.endsWith('_to') ? '220.75' : '195.25')
          }
          const highlights = await page.locator('[data-filament-section="temperatures"] .is-dirty').evaluateAll(rows => rows.map(row => {
            const rect = row.getBoundingClientRect()
            const style = getComputedStyle(row)
            const outset = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
            return {
              top: rect.top - outset, bottom: rect.bottom + outset,
              leftGap: row.querySelector('.fm-label').getBoundingClientRect().left - rect.left,
              rightGap: rect.right - row.querySelector('.filament-unit-input').getBoundingClientRect().right,
              left: row.querySelector('.fm-label').getBoundingClientRect().left,
              right: row.querySelector('.filament-unit-input').getBoundingClientRect().right,
            }
          }))
          assert.equal(highlights.length, 2, 'Both edited temperature ranges show their changed state')
          assert.ok(highlights[0].bottom <= highlights[1].top + .5, `${width} ${url}: adjacent changed-field outlines do not overlap: ${JSON.stringify(highlights)}`)
          assert.ok(highlights.every(row => row.leftGap >= 4 && row.rightGap >= 4), `${width} ${url}: change outlines leave breathing room beside labels and controls: ${JSON.stringify(highlights)}`)
          assert.deepEqual(highlights.map(({ left, right }) => ({ left, right })), cleanEdges, 'Change decoration does not shift labels or narrow controls')
          for (const id of ['extruder_temp_value', 'extruder_temp_to', 'bed_temp_value', 'bed_temp_to']) await page.locator(`#${id}`).fill('')
          await page.locator('#designation').fill('Changed PLA')
          assert.equal(await save.isEnabled(), true, 'Filament change enables Save')
          await page.locator('#designation').fill('Fixture PLA')
          assert.equal(await save.isDisabled(), true, 'Reverting filament changes disables Save again')
          await page.locator('#designation').fill('Changed PLA')
        }
      }
      if (toggle) {
        assert.equal(await page.locator(toggle).getAttribute('aria-pressed'), 'true', `${url}: Edit remains pressed`)
        assert.equal(await page.locator(toggle).evaluate(el => getComputedStyle(el).backgroundColor === getComputedStyle(el.closest('.detail-page-toolbar')).backgroundColor), false, `${url}: Edit is highlighted`)
      }
      await page.evaluate(() => { document.querySelector('main').scrollTop = 0 })
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
      await page.evaluate(() => { document.querySelector('main').scrollTop = 0 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.ok(Math.abs(await page.locator('.detail-page-toolbar').evaluate(toolbar => toolbar.getBoundingClientRect().top)) < 2, `${width} ${url}: toolbar stays flush after scrolling back`)
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
        else {
          await page.waitForURL(new URL('/filaments/10', baseUrl).href)
          await page.locator('#btn-duplicate-filament').waitFor()
          await page.locator('#filament-editor').waitFor({ state: 'hidden' })
        }
        assert.equal(await page.locator('.detail-page-actions [aria-pressed="true"]:visible').count(), 0, `${url}: Edit toggles off`)
      }
    }
  }
  console.log(`PASS ${language}: full-width mobile hero names beside top-right logos, unchanged desktop hero layout, full-width mobile content, accessible drawer/focus/backdrop, circular RFID button/artwork, compact inline numbers in both editors without label overlap, flush actions and rejected-save recovery at 320/390/640/768/1024/1440px; all API writes intercepted`)
} finally {
  await browser.close()
}
