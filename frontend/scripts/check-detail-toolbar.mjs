/** All API writes are intercepted; run against Astro dev or the compiled UI. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const language = process.env.CHECK_LANGUAGE || 'en'
const filament = { id: 10, designation: 'Fixture PLA', material_type: 'PLA', diameter_mm: 1.75, manufacturer_id: 7, manufacturer: { id: 7, name: 'Fixture Brand' }, color_mode: 'single', colors: [{ color_id: 11, position: 1, color: { id: 11, name: 'Red', hex_code: '#FF0000' } }] }
const spool = { id: 16, filament_id: 10, filament, status_id: 1, remaining_weight_g: 800, initial_total_weight_g: 1200, empty_spool_weight_g: 200, custom_fields: {}, custom_field_definitions: {} }
const heroFilament = { ...filament, designation: 'Premium Performance Matte PLA Carbon Fiber Reinforced', manufacturer: { ...filament.manufacturer, logo_url: 'https://fixture.invalid/logo.svg' } }
const identityColors = [{ id: 21, name: 'Orange', hex_code: '#FF7A1A' }, { id: 22, name: 'Blue', hex_code: '#2563EB' }, { id: 23, name: 'Translucent', hex_code: '#E8F0F880' }]
const printerHealth = { connected: true, slots: Array.from({ length: 4 }, (_, index) => ({ slot_index: `0-${index}`, slot_kind: 'ams', present: true, tray_type: 'PLA', tray_color: 'FF0000' })) }
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  const writes = []
  let checkHero = true
  let identityFilament = filament
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
    else if (path.endsWith('/filaments/10')) json = checkHero ? heroFilament : identityFilament
    else if (path.endsWith('/spools/16')) json = { ...spool, filament: checkHero ? heroFilament : identityFilament }
    else if (path.endsWith('/spools/16/events')) json = { items: [], total: 0 }
    else if (path.endsWith('/filaments')) json = { items: [filament], total: 1 }
    else if (path.endsWith('/manufacturers')) json = { items: [filament.manufacturer], total: 1 }
    else if (path.endsWith('/types')) json = ['PLA']
    else if (path.endsWith('/colors')) json = { items: [filament.colors[0].color, ...identityColors], total: 4 }
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
  for (const width of [320, 390, 599, 600, 768, 900, 1000, 1024, 1280, 1440]) {
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
      if (width <= 768) assert.ok(layoutCards[1].top > layoutCards[0].top, `${width} ${url}: narrow sections stack`)
      if (width >= 900) assert.ok(Math.abs(layoutCards[1].top - layoutCards[0].top) < 1, `${width} ${url}: tablet/desktop sections use two columns`)
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', `${url}: temporary editor collapse preserves the saved preference`)
      if (toggle) {
        if (url.startsWith('/filaments')) await page.waitForFunction(() => document.querySelector('#designation')?.value === 'Fixture PLA')
        assert.equal(await page.locator('.detail-page-toolbar [type="submit"]').isDisabled(), true, `${url}: unchanged editor starts with Save disabled`)
        assert.ok(await page.locator('.detail-page-toolbar [type="submit"]').evaluate(save => getComputedStyle(save).backgroundColor !== getComputedStyle(save.closest('.detail-page-actions').querySelector('[aria-pressed="true"]')).backgroundColor), `${url}: clean Save is muted, not highlighted like Edit`)
      }
      const scrollIdentity = page.locator('.detail-scroll-identity')
      const hasIdentity = !url.endsWith('new')
      assert.equal(await scrollIdentity.count(), hasIdentity ? 1 : 0, `${url}: only existing records have a scroll identity`)
      if (hasIdentity) assert.equal(await scrollIdentity.getAttribute('aria-hidden'), 'true', `${url}: hero identity is not duplicated at the top`)
      if (width <= 390 && (toggle || url.endsWith('new'))) {
        const text = page.locator(url.startsWith('/spools') ? '[name="lot_number"]' : '#designation')
        const original = await text.inputValue()
        await text.fill('Long typed value '.repeat(24))
        assert.ok(await text.evaluate(input => input.getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth), `${width} ${url}: long typed text stays inside its field without widening the page`)
        await text.fill(original)
      }
      assert.equal(await page.locator('#sidebar-toggle .sidebar-menu-icon').isVisible(), width < 600, `${width}: hamburger on phones only`)
      assert.equal(await page.locator('#sidebar-toggle .sidebar-chevron-icon').isVisible(), width >= 600, `${width}: larger screens keep their collapse chevron`)
      if (width < 600) {
        assert.ok(await page.locator('main').evaluate(main => main.getBoundingClientRect().left < 1), `${width} ${url}: closed phone navigation reserves no content column`)
        assert.ok(await page.locator('main').evaluate(main => parseFloat(getComputedStyle(main).paddingLeft) <= 24), `${width} ${url}: responsive margins`)
      }
      if (width === 320 && url === '/filaments/10') {
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
            await page.locator(`#${id}`).fill(id.endsWith('_to') ? '220.75' : '198.125')
            assert.ok(await page.locator(`#${id}`).evaluate(input => input.scrollWidth <= input.clientWidth + 1), `${width} ${url}: ${id} shows the complete decimal value`)
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
      if (width === 390 && (url.includes('edit=1') || url.endsWith('new'))) {
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
  await page.setViewportSize({ width: 320, height: 900 })
  for (const [style, colors] of [['striped', identityColors.slice(0, 2)], ['gradient', identityColors.slice(0, 2)], ['single', [identityColors[2]]], ['single', []]]) {
    identityFilament = { ...heroFilament, designation: 'Very long product name '.repeat(12), color_mode: colors.length > 1 ? 'multi' : 'single', multi_color_style: style, colors: colors.map((color, index) => ({ color_id: color.id, position: index + 1, color })) }
    for (const url of ['/filaments/10', '/filaments/10?edit=1', '/spools/16', '/spools/16?edit=1']) {
      await page.goto(new URL(url, baseUrl).href, { waitUntil: 'domcontentloaded' })
      await page.locator(url.includes('filaments/') && url.includes('edit=1') ? '#filament-editor:not(.hidden)' : '.detail-record-name').waitFor()
      const source = page.locator(url.includes('filaments/') && url.includes('edit=1') ? '#filament-editor-hero' : '.filament-hero:visible')
      const scrollPastTitle = () => source.locator('.detail-record-name, #filament-editor-title').evaluate(title => {
        title.closest('main').scrollTop += title.getBoundingClientRect().bottom - document.querySelector('.detail-page-toolbar').getBoundingClientRect().bottom + 8
      })
      await scrollPastTitle()
      await page.waitForFunction(() => document.querySelector('.detail-scroll-identity')?.getAttribute('aria-hidden') === 'false')
      const strip = page.locator('.detail-scroll-identity')
      const pill = strip.locator('.detail-scroll-swatch')
      assert.equal(await pill.isVisible(), colors.length > 0, `${style} ${url}: missing colors do not invent a pill`)
      if (colors.length) assert.equal(await pill.evaluate(el => getComputedStyle(el).backgroundImage), await source.locator('.filament-color-dot').evaluate(el => getComputedStyle(el).backgroundImage), `${style} ${url}: small pill preserves the actual hero fill`)
      assert.ok(await strip.evaluate(el => el.scrollWidth <= el.clientWidth), `${url}: very long names truncate inside the strip`)
      if (style === 'gradient' && url === '/filaments/10?edit=1') {
        await page.locator('#designation').fill('Updated draft name')
        await page.waitForFunction(() => document.querySelector('.detail-scroll-name').textContent === 'Updated draft name')
        const before = await pill.getAttribute('style')
        await page.locator('#filament-color-launcher').click()
        await page.getByRole('button', { name: 'Blue (#2563EB)', exact: true }).click()
        await page.locator('#filament-color-dialog-done').click()
        await scrollPastTitle()
        await page.waitForFunction(old => document.querySelector('.detail-scroll-swatch').getAttribute('style') !== old, before)
        assert.equal(await pill.evaluate(el => getComputedStyle(el).backgroundImage), await source.locator('.filament-color-dot').evaluate(el => getComputedStyle(el).backgroundImage), 'Live color edits update the small pill')
      }
      if (style === 'striped' && url === '/spools/16') {
        await page.locator('#btn-edit-spool').click()
        await page.locator('#btn-cancel-edit').waitFor()
        await scrollPastTitle()
        await page.waitForFunction(() => document.querySelector('.detail-scroll-identity')?.getAttribute('aria-hidden') === 'false')
        assert.equal(await strip.locator('.detail-scroll-name').textContent(), await page.locator('.detail-record-name').textContent(), 'Spool view/edit rerender reconnects the strip to the replacement hero')
      }
    }
  }
  console.log(`PASS ${language}: responsive toolbar/drawer/Save checks plus fading scroll identity, reduced motion, no content shift, long-name truncation, single/multi/transparent/missing swatches, live draft updates and spool rerender; all API writes intercepted`)
} finally {
  await browser.close()
}
