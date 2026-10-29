/** API writes stay inside fixtures. Run against Astro dev or the compiled app. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const filament = { id: 10, manufacturer_id: 7, manufacturer: { id: 7, name: 'Fixture Brand' },
    designation: 'Long product name '.repeat(5), material_type: 'PLA', color_mode: 'multi', multi_color_style: 'striped',
    colors: [{ position: 1, color: { hex_code: '#B15821', name: 'Copper' } }, { position: 2, color: { hex_code: '#FFBB00', name: 'Gold' } }] }
  const spool = { id: 16, filament_id: 10, status_id: 1, filament, location_id: 2, remaining_weight_g: 500,
    initial_total_weight_g: 1250, empty_spool_weight_g: 250, low_weight_threshold_g: 100,
    custom_fields: {}, custom_field_definitions: {}, metrics: { remaining_percent: 50, remaining_length_m: 167.6418097083822 } }
  const inventory = Array.from({ length: 51 }, (_, i) => ({ ...spool, id: i + 1,
    metrics: { remaining_percent: [5, 50, 90][i % 3], remaining_length_m: [17, 168, 302][i % 3] } }))
  const requests = [], patches = []
  let showPrinter = false
  let failPrinter = false
  let emptySlots = false
  let driverConnected = true, failHealth = false
  let printerCount = 1, amsCount = 1
  let failSpoolRead = false
  let spoolReads = 0, printerReads = 0
  let holdWeightRead = null
  let locationName = 'Shelf A'
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    localStorage.setItem('filaman-pagesize-spools', '25')
  })
  await page.route(/\/(?:api\/|auth\/me$)/, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (request.method() !== 'GET') {
      if (path.endsWith('/spools/16')) patches.push(request.postDataJSON())
      return route.fulfill({ json: spool })
    }
    let json = []
    if (path.endsWith('/me')) json = { id: 1, email: 'fixture@example.invalid', language: 'en', is_superadmin: true, roles: [], permissions: [] }
    else if (path.endsWith('/printers')) {
      printerReads++
      if (failPrinter) return route.fulfill({ status: 503, json: { detail: 'Fixture driver unavailable' } })
      json = { items: showPrinter ? Array.from({ length: printerCount }, (_, i) => ({ id: i + 1, name: `Fixture Printer ${i + 1}` })) : [] }
    }
    else if (/\/printers\/\d+\/driver\/health$/.test(path)) {
      if (failHealth) return route.fulfill({ status: 503, json: { detail: 'Fixture health unavailable' } })
      json = { connected: driverConnected, slots: emptySlots ? [] : [
      { slot_index: '255-0', tray_color: '#FFBB00', present: true },
      ...Array.from({ length: amsCount * 4 }, (_, i) => ({ slot_index: `${Math.floor(i / 4)}-${i % 4}`, tray_color: '#FFBB00', present: true })),
      ] }
    }
    else if (path.endsWith('/print-requests/pending')) json = null
    else if (path.endsWith('/spools/16')) {
      spoolReads++
      if (holdWeightRead) await holdWeightRead
      if (failSpoolRead) return route.fulfill({ status: 503, json: { detail: 'Fixture temporarily unavailable' } })
      json = spool
    }
    else if (path.endsWith('/spools/16/events')) json = { items: [], total: 0 }
    else if (path.endsWith('/spools/filter-options')) json = { used_status_ids: [1], by_status: { 1: {
      manufacturers: [{ value: '7', label: 'Fixture Brand' }], materials: ['PLA'], locations: [{ value: '2', label: 'Shelf A' }], has_empty_location: false,
    } } }
    else if (path.endsWith('/spools/statuses')) json = [{ id: 1, key: 'opened', label: 'Opened' }]
    else if (path.endsWith('/locations')) json = { items: [{ id: 2, name: locationName }], total: 1 }
    else if (path.endsWith('/filaments')) json = { items: [filament], total: 1 }
    else if (path.endsWith('/public-info')) json = { currency: 'EUR', filament_lookup_source: 'disabled' }
    else if (path.endsWith('/status')) json = { active: false }
    else if (path.endsWith('/spools')) {
      requests.push(url)
      let rows = inventory.filter(row => ['remaining_percent', 'remaining_length_m'].every(key => {
        const min = url.searchParams.get(`${key}_min`), max = url.searchParams.get(`${key}_max`)
        return (min === null || row.metrics[key] >= Number(min)) && (max === null || row.metrics[key] <= Number(max))
      }))
      const key = url.searchParams.get('sort_by')
      if (key?.startsWith('remaining_') && key !== 'remaining_weight_g') rows.sort((a, b) =>
        (a.metrics[key] - b.metrics[key]) * (url.searchParams.get('sort_order') === 'desc' ? -1 : 1) || a.id - b.id)
      if (key === 'effective_remaining_weight_g') rows.sort((a, b) =>
        ((a.metrics.effective_remaining_weight_g ?? a.remaining_weight_g) - (b.metrics.effective_remaining_weight_g ?? b.remaining_weight_g))
          * (url.searchParams.get('sort_order') === 'desc' ? -1 : 1) || a.id - b.id)
      const size = Number(url.searchParams.get('page_size') || 50), start = (Number(url.searchParams.get('page') || 1) - 1) * size
      json = { items: rows.slice(start, start + size), total: rows.length, page: start / size + 1, page_size: size }
    }
    await route.fulfill({ json })
  })

  await page.goto(new URL('/spools', base).href)
  await page.locator('#spools-table tr[data-group-row], #spools-table tr[onclick]').first().waitFor()
  assert.equal(requests.at(-1).searchParams.get('include_metrics'), 'true', 'Native table explicitly requests metrics')
  await page.locator('#btn-columns').click()
  await page.locator('#columns-dropdown').getByLabel('Remaining %', { exact: true }).check()
  await page.locator('#columns-dropdown').getByLabel('Estimated remaining length (m)', { exact: true }).check()
  await page.locator('#btn-columns').click()
  await page.reload()
  await page.locator('#spools-table .col-remaining_percent').first().waitFor()
  assert.equal(await page.locator('th.col-remaining_percent').isVisible(), true, 'Optional columns survive reload')
  assert.equal(await page.locator('th.col-remaining_length_m').isVisible(), true)
  const beforeSort = requests.length
  await page.locator('th.col-remaining_percent').click({ position: { x: 8, y: 8 } })
  await page.waitForFunction(() => document.querySelector('th.col-remaining_percent')?.classList.contains('sort-asc'))
  await page.locator('#spools-table .col-remaining_percent').first().filter({ hasText: '5%' }).waitFor()
  assert.equal(requests.at(-1).searchParams.get('sort_by'), 'remaining_percent')
  assert.equal(requests.length - beforeSort, 1, 'Sorting requests one server page, not the whole inventory')
  await page.locator('th.col-remaining_length_m .fm-header-filter-trigger').click()
  const panel = page.locator('.fm-header-filter-panel.open')
  await panel.locator('.fm-header-filter-operator').selectOption('between')
  await panel.locator('.fm-header-filter-value').first().fill('150')
  await panel.locator('.fm-header-filter-value').nth(1).fill('200')
  await panel.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.locator('#spools-table .col-remaining_length_m').first().filter({ hasText: '168' }).waitFor()
  assert.equal(requests.at(-1).searchParams.get('remaining_length_m_min'), '150')
  assert.equal(requests.at(-1).searchParams.get('remaining_length_m_max'), '200')
  assert.ok(requests.every(url => Number(url.searchParams.get('page_size')) === 25), 'Metric filters never select the all-pages path')

  await page.goto(new URL('/spools/16', base).href)
  await page.locator('.spool-remaining-grams').filter({ hasText: '500 g' }).waitFor()
  const fullReelPaths = await page.locator('.spool-reel-corner path').count()
  await page.waitForTimeout(300)
  const printerReadsBeforeWeight = printerReads
  spool.remaining_weight_g = 250
  spool.metrics = { remaining_percent: 25, remaining_length_m: 84 }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } })))
  await page.locator('.spool-remaining-grams').filter({ hasText: '250 g' }).waitFor({ timeout: 5000 })
  assert.equal(printerReads, printerReadsBeforeWeight, 'Inventory weight events do not query every printer')
  let releaseWeight
  holdWeightRead = new Promise(resolve => { releaseWeight = resolve })
  const beforeBurst = spoolReads
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } })))
    await page.waitForTimeout(250)
  }
  assert.equal(spoolReads - beforeBurst, 1, 'Only one weight request runs while a slow response is pending')
  const trailing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/spools/16') && spoolReads === beforeBurst + 2)
  holdWeightRead = null
  releaseWeight()
  await trailing
  assert.equal(spoolReads - beforeBurst, 2, 'Events during the pending request coalesce into one trailing refresh')
  assert.equal(await page.locator('.spool-remaining-percent').textContent(), '25%')
  assert.match(await page.locator('.spool-remaining-length').textContent(), /84/)
  assert.ok(await page.locator('.spool-reel-corner path').count() < fullReelPaths, 'The reel updates with the remaining values')
  assert.equal(new URL(await page.locator('#btn-print-label').getAttribute('href'), base).searchParams.get('remaining_wt'), '250', 'Existing print data stays current too')
  await page.locator('#btn-edit-spool').click()
  const draft = page.locator('[name="lot_number"]')
  await draft.fill('UNSAVED LOT')
  await draft.focus()
  await draft.evaluate(input => { window.fixtureDraftInput = input })
  for (const [weight, percent, length] of [[125, 12.5, 42], [null, null, null], [0, 0, 0]]) {
    spool.remaining_weight_g = weight
    spool.metrics = { remaining_percent: percent, remaining_length_m: length }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } })))
    await page.locator('.spool-remaining-grams').filter({ hasText: weight === null ? '—' : `${weight} g` }).waitFor()
    assert.equal(await draft.inputValue(), 'UNSAVED LOT')
    assert.ok(await draft.evaluate(input => input === window.fixtureDraftInput && document.activeElement === input), 'Refresh retains the original focused draft input')
    assert.equal(await page.locator('[form="spool-inline-form"][type="submit"]').isDisabled(), false, 'Refresh does not reset dirty Save state')
    assert.equal(await page.locator('.spool-remaining-percent').count(), percent === null ? 0 : 1)
  }
  assert.equal(await page.locator('.spool-reel-corner path').count(), 0, 'Zero remaining empties the reel')
  await page.locator('#btn-cancel-edit').click()
  await page.locator('#btn-edit-spool').click()
  spool.remaining_weight_g = 100
  spool.metrics = { remaining_percent: 10, remaining_length_m: 34 }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } })))
  await page.locator('.spool-remaining-grams').filter({ hasText: '100 g' }).waitFor()
  assert.equal(await page.locator('[form="spool-inline-form"][type="submit"]').isDisabled(), true, 'Read-only refresh does not dirty a clean editor')
  failSpoolRead = true
  const failedRefresh = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/spools/16') && response.status() === 503)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'spools_changed' } })))
  await failedRefresh
  assert.equal(await page.locator('.spool-remaining-grams').textContent(), '100 g', 'A failed refresh preserves the last good display')
  assert.equal(await page.locator('[form="spool-inline-form"][type="submit"]').isDisabled(), true)
  failSpoolRead = false
  await page.goto(new URL('/spools/16', base).href)
  await page.locator('.spool-remaining-grams').filter({ hasText: '100 g' }).waitFor()
  spool.remaining_weight_g = 50
  spool.metrics = { remaining_percent: 5, remaining_length_m: 17 }
  await page.locator('.spool-remaining-grams').filter({ hasText: '50 g' }).waitFor({ timeout: 30000 })
  assert.equal(patches.length, 0, 'Live refresh never writes inventory or saves a draft')
  spool.remaining_weight_g = 500
  spool.metrics = { remaining_percent: 50, remaining_length_m: 167.6418097083822 }

  for (const unavailable of ['removed', 'offline', 'empty', 'list-error', 'health-error']) {
    showPrinter = true
    await page.goto(new URL('/spools/16', base).href)
    await page.locator('#printer-slots-inline .slot-dot').first().waitFor()
    await page.locator('#printer-slots-inline .slot-dot').first().click()
    await page.locator('.ctx-item').first().waitFor()
    showPrinter = unavailable !== 'removed'
    driverConnected = unavailable !== 'offline'
    emptySlots = unavailable === 'empty'
    failPrinter = unavailable === 'list-error'
    failHealth = unavailable === 'health-error'
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'printer_update' } })))
    await page.locator('#printer-slots-inline').waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(await page.locator('#printer-slots-inline .slot-dot').count(), 0, `${unavailable}: stale slots are removed`)
    assert.equal(await page.locator('.ctx-item').count(), 0, `${unavailable}: stale slot actions close too`)
    driverConnected = true
    emptySlots = failPrinter = failHealth = false
    showPrinter = true
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('filaman:data-changed', { detail: { event: 'printer_update' } })))
    await page.locator('#printer-slots-inline .slot-dot').first().waitFor()
  }

  filament.manufacturer.logo_url = '/favicon.png'
  const longDesignation = filament.designation
  filament.designation = 'Fixture PLA'
  showPrinter = true
  for (const [width, printers, units] of [[320, 1, 1], [390, 1, 1], [768, 1, 1], [1280, 1, 1], [1440, 1, 1], [1440, 2, 2], [390, 2, 2]]) {
    printerCount = printers
    amsCount = units
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(new URL('/spools/16', base).href)
    await page.locator('#printer-slots-inline .slot-dot').first().waitFor()
    assert.equal(await page.locator('#printer-slots-inline .slot-dot').count(), printers * (1 + units * 4), 'All printers and AMS slots remain available')
    const cards = await page.locator('.printer-slot-cards > .fm-card').evaluateAll(es => es.map(e => e.getBoundingClientRect().toJSON()))
    assert.equal(cards.length, printers, 'Each printer has a separate card')
    if (printers > 1) assert.ok(width >= 992 ? Math.abs(cards[1].top - cards[0].top) < 1 : cards[1].top >= cards[0].bottom, `${width}: multiple printer cards spread across wide screens and stack on mobile`)
    const geometry = await page.evaluate(() => {
      const hero = document.querySelector('.spool-hero'), logo = hero.querySelector('.filament-hero-logo')
      const bounds = hero.getBoundingClientRect(), mark = logo.getBoundingClientRect()
      const reel = hero.querySelector('.spool-reel-corner').getBoundingClientRect()
      const strip = document.querySelector('#printer-slots-inline').getBoundingClientRect()
      const actions = document.querySelector('#actions-section').getBoundingClientRect()
      const panels = document.querySelector('.spool-action-panels')?.getBoundingClientRect()
      const wide = (panels?.width ?? bounds.width) >= 62 * parseFloat(getComputedStyle(document.documentElement).fontSize) && !document.querySelector('#printer-slots-inline').classList.contains('has-multiple-printers')
      const printerCard = document.querySelector('#printer-slots-inline .fm-card').getBoundingClientRect()
      const buttons = document.querySelector('.detail-quick-action-buttons').getBoundingClientRect()
      const printerTitle = document.querySelector('#printer-slots-inline h2').getBoundingClientRect()
      const padding = parseFloat(getComputedStyle(hero).paddingTop)
      logo.style.transform = 'none'
      const unshiftedHeight = hero.getBoundingClientRect().height
      return { height: bounds.height, unshiftedHeight, inset: mark.top - bounds.top, padding,
        inside: mark.top > bounds.top && mark.right < bounds.right,
        clear: mark.bottom + 4 <= reel.top || mark.right + 4 <= reel.left,
        stripFits: wide ? strip.right <= actions.left && Math.abs(strip.top - actions.top) < 1 : strip.top >= actions.bottom,
        stripBelowHero: strip.top >= bounds.bottom,
        centered: !wide || Math.abs((printerCard.top + printerCard.bottom - buttons.top - buttons.bottom) / 2) < 1,
        titleGap: !wide || printerCard.top - printerTitle.bottom <= 8,
        overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.equal(geometry.height, geometry.unshiftedHeight, `${width}: logo shift adds no hero height`)
    assert.ok(geometry.inset < geometry.padding && geometry.inside && geometry.clear, `${width}: logo uses outer margin and clears the reel: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.stripFits && geometry.stripBelowHero && !geometry.overflow, `${width}: printer slots sit beside compact actions or stack below without overflow`)
    assert.ok(geometry.centered && geometry.titleGap, `${width}: buttons center against the printer card with a compact heading gap`)
  }
  delete filament.manufacturer.logo_url
  filament.designation = longDesignation
  showPrinter = false
  for (const [available, failed] of [[false, false], [false, true], [true, false]]) {
    showPrinter = available
    emptySlots = true
    failPrinter = failed
    const loaded = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(available ? '/printers/1/driver/health' : '/printers'))
    await page.goto(new URL('/spools/16', base).href)
    await loaded
    await page.locator('#actions-section:visible').waitFor()
    assert.equal(await page.locator('#printer-slots-inline').isVisible(), false, 'No empty printer panel without an available driver')
    const widths = await page.evaluate(() => ['.spool-action-panels', '#actions-section'].map(s => document.querySelector(s).getBoundingClientRect().width))
    assert.equal(widths[0], widths[1], 'Quick Actions reclaim the entire row without a printer')
  }
  showPrinter = false
  emptySlots = false
  failPrinter = false

  // SVG semantics have unit coverage; these cases pin responsive page integration.
  for (const [width, mode, fraction] of [
    [320, 'solid', 1], [390, 'striped', .5], [768, 'gradient', .05],
    [1440, 'alpha', 1], [1440, 'colorless', .5], [390, 'solid', 0],
    [390, 'gradient', null], [1440, 'alpha', 0], [1440, 'alpha', null],
  ]) {
    await page.setViewportSize({ width, height: 1000 })
    filament.color_mode = mode === 'solid' ? 'single' : 'multi'
    filament.multi_color_style = mode === 'gradient' || mode === 'alpha' ? 'gradient' : 'striped'
    filament.colors = (mode === 'colorless' ? [] : mode === 'solid' ? ['#FFBB00'] : mode === 'alpha' ? ['#E8558299', '#7265E0CC', '#27CEAE80'] : ['#B15821', '#FFBB00'])
      .map((hex_code, i) => ({ position: i + 1, color: { hex_code, name: `Color ${i + 1}` } }))
    spool.remaining_weight_g = fraction === null ? null : fraction * 1000
    spool.metrics = { remaining_percent: fraction === null ? null : fraction * 100,
      remaining_length_m: fraction === null ? null : fraction * 335.2836194167644 }
    await page.goto(new URL('/spools/16', base).href)
    await page.locator('.spool-reel-corner').waitFor({ state: 'attached' })
    assert.equal(await page.getByRole('heading', { name: 'Inventory', exact: true }).count(), 0)
    if (fraction !== null) assert.equal(await page.locator('.spool-remaining-percent').textContent(), `${fraction * 100}%`)
    else assert.equal(await page.locator('.spool-remaining-percent').count(), 0)
    assert.equal(await page.locator('.spool-reel-corner path').count() > 0, fraction !== 0, 'Unknown uses a full visual placeholder; known zero remains empty')
    if (fraction !== 0 && (mode === 'colorless' || mode === 'alpha')) {
      assert.equal(await page.locator('.spool-reel-corner pattern').count(), 1, 'Unknown colors and transparency keep visible checkerboard windings')
    }
    if (fraction === null) {
      assert.equal(await page.locator('.spool-remaining-grams').textContent(), '—')
      assert.equal(await page.locator('.spool-remaining-length').textContent(), '—')
    }
    const geometry = await page.locator('.filament-hero').evaluate(hero => {
      const reel = hero.querySelector('.spool-reel-corner'), before = hero.getBoundingClientRect()
      const rect = reel.getBoundingClientRect(), style = getComputedStyle(reel)
      const amount = hero.querySelector('.spool-remaining-grams'), title = hero.querySelector('h1')
      reel.remove()
      const heightWithout = hero.getBoundingClientRect().height
      hero.append(reel)
      return { height: before.height, heightWithout, width: rect.width, position: style.position,
        right: rect.right, bottom: rect.bottom, heroRight: before.right, heroBottom: before.bottom,
        amountSize: parseFloat(getComputedStyle(amount).fontSize), titleSize: parseFloat(getComputedStyle(title).fontSize),
        overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.equal(geometry.height, geometry.heightWithout, `${width} ${mode}: reel adds no height`)
    assert.equal(geometry.width, width <= 640 ? 56 : width >= 1200 ? 110 : 88)
    assert.equal(geometry.position, 'absolute')
    assert.ok(Math.abs(geometry.right - geometry.heroRight) < 2 && Math.abs(geometry.bottom - geometry.heroBottom) < 2)
    assert.ok(geometry.amountSize < geometry.titleSize && !geometry.overflow, `${width} ${mode}: hierarchy and viewport fit`)
  }

  spool.remaining_weight_g = null
  spool.metrics = { remaining_percent: 100, remaining_length_m: 335, effective_remaining_weight_g: 1000 }
  await page.goto(new URL('/spools/16', base).href)
  await page.locator('.spool-remaining-grams').filter({ hasText: '1000 g' }).waitFor()
  assert.equal(await page.locator('.spool-remaining-percent').textContent(), '100%', 'Server-resolved New weight is displayed without rewriting canonical grams')
  inventory[0].remaining_weight_g = null
  inventory[0].metrics = spool.metrics
  await page.goto(new URL('/spools', base).href)
  await page.locator('#filter-clear').click()
  await page.locator('th.col-remaining').click({ position: { x: 8, y: 8 } })
  await page.locator('th.col-remaining.sort-asc').waitFor()
  await page.locator('th.col-remaining').click({ position: { x: 8, y: 8 } })
  await page.locator('th.col-remaining.sort-desc').waitFor()
  await page.locator('#spools-table .col-remaining').filter({ hasText: '1000g' }).waitFor()
  assert.equal(requests.at(-1).searchParams.get('sort_by'), 'effective_remaining_weight_g')

  locationName = 'BasementShelfPrinterMaterialsStorageLocationForBlueSilkAndSpecialtyFilaments'
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.includes('cache') && key.includes('locations')) localStorage.removeItem(key)
  })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(new URL('/spools/16', base).href)
    await page.locator('.spool-hero-facts').getByText(locationName).waitFor()
    const fits = await page.locator('.spool-hero-facts').evaluate(facts => {
      const bounds = facts.closest('.spool-hero').getBoundingClientRect()
      return [...facts.querySelectorAll('span')].every(span => {
        const text = span.getBoundingClientRect()
        return text.left >= bounds.left && text.right <= bounds.right
      })
    })
    assert.ok(fits, `${width}: long location text stays inside the hero`)
  }
  await page.goto(new URL('/spools/16?edit=1', base).href)
  await page.locator('[name="low_weight_threshold_g"]').fill('120')
  assert.equal(await page.locator('[name="remaining_percent"], [name="remaining_length_m"], [name="metrics"]').count(), 0)
  await page.locator('[form="spool-inline-form"][type="submit"]').click()
  await page.locator('#btn-edit-spool[aria-pressed="false"]').waitFor()
  assert.equal(patches.at(-1).low_weight_threshold_g, 120)
  assert.equal('metrics' in patches.at(-1), false)
  assert.deepEqual(errors, [])
  console.log('PASS native metric table columns/persistence/server pagination, detailed reel modes/fill states/responsive geometry, read-only estimates and retained threshold editing; fixture writes only')
} finally {
  await browser.close()
}
