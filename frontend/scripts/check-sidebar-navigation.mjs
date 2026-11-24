import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const origin = new URL(process.argv[2] || 'http://127.0.0.1:4321').origin
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE_PATH,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(10000)
  const errors = []
  const requests = []
  const problemSpools = []
  const pluginDeletes = []
  let pendingPrint = null
  let previewGate
  let claimGate
  let sessionExpired = false
  let inventoryUnavailable = false
  let authFailure
  let pendingAuth
  let heldPanelAuth
  let heldDestinationHtml
  let heldSidebarSave
  let sidebarPreferences = { sidebar: null, theme: 'dark', expanded: null }
  let versionCheckAvailable = false
  let showOtherPlugin = true
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.text().startsWith('Could not initialize panel:')) errors.push(message.text())
  })
  await page.addInitScript(forceFallback => {
    window.addEventListener('pageshow', event => { window.restoredFromCache = event.persisted })
    localStorage.setItem('lang', 'de')
    localStorage.setItem('theme', 'dark')
    if (forceFallback) Object.defineProperty(document, 'startViewTransition', { value: undefined })
  }, process.env.FORCE_ASTRO_SWAP === '1')

  const user = { id: 1, display_name: 'Preview', language: 'de', is_superadmin: false, permissions: [], roles: [] }
  const inventory = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1, name: `Item ${String(i).padStart(3, '0')}`, hex_code: i ? '112233' : 'abcdef', usage_count: 0,
  }))
  await page.context().route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    requests.push(url.pathname)
    if (route.request().method() === 'DELETE' && url.pathname.startsWith('/api/v1/admin/system/plugins/')) {
      pluginDeletes.push(url.pathname)
      return route.fulfill({ status: 204 })
    }
    if (url.pathname === '/spools/3/print') return route.fulfill({ contentType: 'text/html', body: '<title>Label editor</title>' })
    if (url.pathname === '/api/v1/plugin-nav' && requests.filter(path => path === url.pathname).length === 1) {
      return route.fulfill({ status: 503 })
    }
    if (url.pathname === '/api/v1/admin/system/version-check' && !versionCheckAvailable) {
      return route.fulfill({ status: 503 })
    }
    if (url.pathname.startsWith('/plugin-page/')) return route.fulfill({ contentType: 'text/html', body: '<title>Example plugin</title>' })
    if (url.pathname === '/printers' && heldDestinationHtml) {
      await heldDestinationHtml
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Try again' })
    }
    if (url.pathname === '/plugins/native-example/') return route.fulfill({ contentType: 'text/html', body: '<title>Native plugin</title>' })
    if (!/^\/(api|auth)\//.test(url.pathname)) return route.continue()
    if (url.pathname === '/api/v1/me') {
      if (sessionExpired) return route.fulfill({ status: 401 })
      if (pendingAuth) {
        const wait = pendingAuth
        pendingAuth = undefined
        await wait
        return route.abort().catch(() => {})
      }
      if (heldPanelAuth) await heldPanelAuth
      if (authFailure) {
        const failure = authFailure
        authFailure = undefined
        return failure === 'reset' ? route.abort('connectionreset') : route.fulfill({ status: 503 })
      }
    }
    if (url.pathname === '/api/v1/me/preferences/sidebar' && route.request().method() === 'PATCH') {
      const saved = route.request().postDataJSON()
      if (saved.sidebar && heldSidebarSave && !await heldSidebarSave) return route.fulfill({ status: 503 })
      sidebarPreferences = { ...sidebarPreferences, ...saved }
      return route.fulfill({ json: sidebarPreferences })
    }
    if (url.pathname === '/api/v1/spools' && url.searchParams.get('low_or_empty') === 'true') {
      problemSpools.push(url)
      return route.fulfill({ json: {
        total: 1,
        items: [{ id: 3, remaining_weight_g: 50, filament: { designation: 'Sample PLA', material_type: 'PLA' } }],
      } })
    }
    if (url.pathname === '/api/v1/labels/spool/3/print-request') {
      pendingPrint = { id: 7, spool_id: 3, preset_id: 42, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }
      return route.fulfill({ status: 201, json: pendingPrint })
    }
    if (url.pathname === '/api/v1/labels/print-requests/7/preview') {
      await previewGate
      return route.fulfill({ contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'),
        headers: { 'X-Label-Width-Mm': '40', 'X-Label-Height-Mm': '30' },
      })
    }
    if (url.pathname === '/api/v1/labels/print-requests/7/claim') {
      await claimGate
      pendingPrint = null
      return route.fulfill({ status: 204 })
    }
    if (inventoryUnavailable && ['/api/v1/spools', '/api/v1/filaments'].includes(url.pathname)) {
      return route.fulfill({ status: 503 })
    }
    const data = {
      '/api/v1/me': user,
      '/auth/me': user,
      '/api/v1/me/label-presets/migrate': [],
      '/api/v1/me/preferences': { dashboard_hidden_widgets: [] },
      '/api/v1/me/preferences/sidebar': sidebarPreferences,
      '/api/v1/app-settings/public-info': { currency: 'EUR' },
      '/api/v1/admin/system/version-check': { update_available: true, latest_version: '9.0.0' },
      '/api/v1/manufacturers': { items: inventory, total: inventory.length },
      '/api/v1/colors': { items: inventory, total: inventory.length },
      '/api/v1/admin/system/plugins': [
        { plugin_key: 'filabrain', name: 'FilaBrain', page_url: '/plugin-page/filabrain', version: '0.1.18', plugin_type: 'integration', is_active: true, installed_by: 1 },
      ],
      '/api/v1/plugin-nav': [
        { plugin_key: 'filabrain', name: 'FilaBrain', page_url: '/plugin-page/filabrain' },
        { plugin_key: 'example', name: 'Example', page_url: '/plugin-page/example' },
        ...(showOtherPlugin ? [{ plugin_key: 'other', name: 'Other', page_url: '/plugin-page/other' }] : []),
        { plugin_key: 'native', name: 'Native', page_url: '/plugin-view/native-example' },
        { plugin_key: 'filamentdb', name: 'FilamentDB', page_url: '/admin/system/filamentdb-import' },
      ],
      '/api/v1/display': { printers: [] },
      '/api/v1/spools/statuses': [],
      '/api/v1/spools/filter-options': { used_status_ids: [], by_status: {} },
      '/api/v1/filaments/filter-options': { manufacturers: [], types: [], colors: [] },
      '/api/v1/system-extra-fields': [],
      '/api/v1/devices/active': [],
      '/api/v1/filamentdb/status': { active: true },
      '/api/v1/tag/readers': [],
      '/api/v1/dashboard/stats': {
        spool_count_total: 2, filament_count_total: 1, filament_count_active: 1, filament_count_used: 1,
        spool_distribution: { full: 1, normal: 0, low: 1, critical: 0, empty: 0 },
        total_value_available: 3, valuation: { remaining_value: 1.2, unknown_spool_count: 1 }, filament_stats: [], location_stats: [], manufacturers_with_spools: [], low_stock_spools: [],
      },
      '/api/v1/labels/print-requests/pending': pendingPrint,
    }
    if (url.pathname === '/api/v1/events/stream') return route.fulfill({ status: 204 })
    await route.fulfill({ json: url.pathname in data ? data[url.pathname] : { items: [], total: 0, page: 1 } })
  })

  const sidebar = page.locator('.fm-sidebar')
  const dismissChangelog = async () => {
    if (await page.locator('#fm-changelog-overlay').evaluate(dialog => dialog.open)) {
      await page.locator('#fm-changelog-close').click()
    }
  }
  const clickNav = async (path, link = sidebar.locator(`a[href="${path}"]:visible:not(#sidebar-version-update)`)) => {
    const before = await page.locator('main').elementHandle()
    await link.click()
    const target = new URL(path, origin)
    await page.waitForURL(url => url.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') && url.search === target.search)
    const sidebarPath = path === '/admin/system' ? '/admin' : path
    assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true, path)
    await sidebar.locator(`a[href="${sidebarPath}"].active`).waitFor()
    assert.equal(await before.evaluate(main => main.isConnected), false)
    await before.dispose()
    await page.locator('main').waitFor()
    await page.locator('.astro-route-announcer').waitFor({ state: 'attached' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    assert.equal(await page.locator('html').getAttribute('lang'), 'de')
  }
  await page.goto(origin)
  await sidebar.waitFor()
  await page.waitForFunction(() => document.getElementById('stat-total-spools')?.textContent === '2')
  await dismissChangelog()
  await page.locator('#stat-remaining-value').filter({ hasText: /1[,.]20/ }).waitFor()
  assert.match(await page.locator('#stat-total-value').textContent(), /3/)
  assert.equal(await page.locator('[data-i18n="dashboard.remainingValue"]').textContent(), 'Restwert (verfügbar)')
  assert.match(await page.locator('#stat-value-coverage').textContent(), /1 Spulen/)
  assert.equal(requests.some(path => path === '/api/v1/spools' || path === '/api/v1/filaments'), false)
  await page.locator('#problem-spools').click()
  await page.locator('#spool-modal a[href="/spools/3"]').first().waitFor()
  assert.equal(problemSpools.length, 1)
  await page.locator('#spool-modal [data-dialog-close]').click()
  await page.evaluate(() => { window.sidebarBefore = document.querySelector('.fm-sidebar') })
  const updateBadge = sidebar.locator('#sidebar-version-update')
  assert.equal(await updateBadge.isVisible(), false)
  versionCheckAvailable = true
  const versionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/system/version-check' && response.ok())
  void versionResponse.catch(() => {})
  await page.evaluate(() => {
    document.addEventListener('astro:before-swap', event => {
      if (document.startViewTransition) event.viewTransition.skipTransition()
    }, { once: true })
  })
  const dashboard = await page.locator('main').elementHandle()
  const spoolsAuth = Promise.withResolvers()
  heldPanelAuth = spoolsAuth.promise
  const spoolsSession = page.waitForRequest(req => new URL(req.url()).pathname === '/api/v1/me')
  const toSpools = clickNav('/spools')
  void toSpools.catch(() => {})
  try {
    await spoolsSession
    assert.equal(await dashboard.evaluate(main => main.isConnected && getComputedStyle(main).visibility === 'visible'),
      true, 'Dashboard remains visible while Spools checks the session')
  } finally {
    heldPanelAuth = undefined
    spoolsAuth.resolve()
  }
  await toSpools
  await dashboard.dispose()
  await versionResponse
  await updateBadge.waitFor()
  assert.equal(await updateBadge.getAttribute('target'), '_blank')
  assert.equal(await page.evaluate(() => typeof window.archiveSpool), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.__toggleSpoolSelection), 'undefined')
  await page.evaluate(() => localStorage.removeItem('changelog-seen-version'))
  for (const [failure, path] of [['reset', '/'], ['server', '/printers']]) {
    const summaryRequests = requests.filter(url => url === '/api/v1/dashboard/stats').length
    authFailure = failure
    await sidebar.locator(`a[href="${path}"]`).click()
    await page.waitForURL(origin + path)
    await page.locator('#session-check-retry').waitFor()
    assert.equal(await page.locator('main').isVisible(), false)
    if (path === '/') {
      await page.locator('.astro-route-announcer').waitFor({ state: 'attached' })
      assert.equal(requests.filter(url => url === '/api/v1/dashboard/stats').length, summaryRequests)
      assert.equal(await page.locator('#fm-changelog-overlay').evaluate(dialog => dialog.open), false)
    }
    await page.locator('#session-check-retry button').click()
    await page.locator('main').waitFor()
    assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
    if (path === '/') {
      await page.waitForFunction(() => document.getElementById('stat-total-spools')?.textContent === '2')
      await dismissChangelog()
    }
  }
  user.is_superadmin = true
  await clickNav('/spools')
  await updateBadge.and(sidebar.locator('a[href="/admin"]')).waitFor()
  assert.equal(await updateBadge.getAttribute('target'), null)
  assert.equal(await updateBadge.getAttribute('rel'), null)
  const search = page.locator('#filter-search')
  const searchFor = async term => {
    const request = page.waitForRequest(req => new URL(req.url()).searchParams.get('search') === term)
    await search.fill(term)
    await request
  }
  await searchFor('blue')
  await clickNav('/filaments')
  assert.equal(await page.evaluate(() => typeof window.__toggleFilamentSelection), 'undefined')
  await page.goBack()
  await page.waitForURL(/\/spools/)
  await sidebar.locator('a[href="/spools"].active').waitFor()
  await page.locator('.astro-route-announcer').waitFor({ state: 'attached' })
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
  await searchFor('red')
  await page.goBack()
  await page.waitForURL(origin + '/printers')
  await page.locator('main[data-panel="printers"]').waitFor()
  await page.goForward()
  await page.waitForURL(/\/spools/)
  await sidebar.locator('a[href="/spools"].active').waitFor()
  await page.waitForFunction(() => document.querySelector('#filter-search')?.value === 'red')
  await search.evaluate(input => {
    input.value = 'blue'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    history.back()
  })
  await page.locator('main[data-panel="printers"]').waitFor()
  await page.goForward()
  await page.waitForFunction(() => document.querySelector('#filter-search')?.value === 'blue')
  for (const path of ['/manufacturers', '/locations', '/printers', '/settings', '/admin', '/admin/system/filamentdb-import']) {
    await clickNav(path)
    if (path === '/settings' && await page.locator('#show-color-library').count()) {
      const toggle = page.locator('#show-color-library')
      const track = page.locator('.fm-toggle:has(#show-color-library)')
      await track.click()
      assert.equal(await toggle.isChecked(), false)
      assert.equal(await sidebar.locator('#sidebar-color-library').getAttribute('hidden'), '')
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-color-library')), 'false')
      await track.click()
      assert.equal(await toggle.isChecked(), true)
      await sidebar.locator('#sidebar-color-library').waitFor()
    }
  }

  await clickNav('/admin')
  await clickNav('/admin/system', page.locator('main a[href="/admin/system"]'))
  const filaBrainPath = '/plugin-view?p=filabrain'
  const filaBrainRow = page.locator('#plugins-table').getByRole('link', { name: 'FilaBrain', exact: true })
  await clickNav(filaBrainPath, filaBrainRow)
  await page.locator('#plugin-frame[src="/plugin-page/filabrain"]').waitFor()
  await page.goBack()
  await filaBrainRow.waitFor()
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
  await page.locator('#plugins-table .btn-delete').click()
  const uninstallDialog = page.locator('#fm-confirm-overlay')
  await uninstallDialog.waitFor()
  const uninstallMessage = await uninstallDialog.locator('#fm-confirm-message').textContent()
  await uninstallDialog.locator('#fm-confirm-ok').click()
  await page.waitForFunction(message => document.querySelector('#fm-confirm-message')?.textContent !== message, uninstallMessage)
  await page.goBack()
  await page.locator('main[data-panel="admin"][data-panel-authorized]').waitFor()
  assert.equal(await uninstallDialog.evaluate(dialog => dialog.open), false)
  assert.deepEqual(pluginDeletes, [], 'Back during the plugin data prompt must not send a DELETE request')
  await clickNav('/admin/system', page.locator('main a[href="/admin/system"]'))
  await clickNav(filaBrainPath)
  await page.locator('#plugin-frame[src="/plugin-page/filabrain"]').waitFor()
  await clickNav('/settings')
  await page.locator('main a[href="/settings/sidebar"]').click()
  const editor = page.locator('main[data-panel="sidebar-settings"][data-panel-authorized]')
  await editor.locator('#sidebar-reset:enabled').waitFor()
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
  const editorAuth = Promise.withResolvers()
  heldPanelAuth = editorAuth.promise
  const revalidation = page.waitForRequest(req => new URL(req.url()).pathname === '/api/v1/me')
  await sidebar.locator('#admin-nav a[href="/admin"]').click()
  await revalidation
  assert.equal(await editor.isVisible(), true, 'Sidebar settings stays visible while the next panel checks the session')
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
  heldPanelAuth = undefined
  editorAuth.resolve()
  await page.locator('main[data-panel="admin"][data-panel-authorized]').waitFor()
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)

  await page.goBack()
  await editor.locator('#sidebar-reset:enabled').waitFor()
  const save = editor.locator('button[type="submit"]')
  const compact = editor.locator('input[name="density"][value="compact"]')
  const comfortable = editor.locator('input[name="density"][value="comfortable"]')
  const editorStatus = editor.locator('#sidebar-settings-status')
  for (const [leave, saved] of [
    ['link', false], ['link', true], ['back', false], ['back', true], ['bounce', false],
    ['link-first', false], ['link-first', true], ['back-first', false], ['failed-before-auth', false], ['failed-before-html', false],
  ]) {
    const choice = await compact.isChecked() ? comfortable : compact
    await choice.check()
    const editorBeforeSave = await editor.elementHandle()
    const write = Promise.withResolvers()
    heldSidebarSave = write.promise
    const requested = page.waitForRequest(req => req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/v1/me/preferences/sidebar')
    const leavesByLink = leave.startsWith('link') || leave === 'failed-before-auth'
    const usesFallback = leave === 'failed-before-html'
    const leaveFirst = leave.endsWith('-first') || leave.startsWith('failed-before-')
    const destination = Promise.withResolvers()
    const leaveEditor = async () => {
      if (usesFallback) await sidebar.locator('a[href="/printers"]').click()
      else if (leavesByLink) await sidebar.locator('#admin-nav a[href="/admin"]').click()
      else {
        await page.evaluate(() => history.back())
        await page.waitForURL(url => url.pathname.replace(/\/$/, '') === '/settings')
        if (leave === 'bounce') {
          await page.evaluate(() => history.forward())
          await page.waitForURL(url => url.pathname.replace(/\/$/, '') === '/settings/sidebar')
        }
      }
    }
    try {
      if (leaveFirst) {
        if (usesFallback) heldDestinationHtml = destination.promise
        else heldPanelAuth = destination.promise
        const destinationPath = usesFallback ? '/printers' : '/api/v1/me'
        const navigating = page.waitForRequest(req => new URL(req.url()).pathname === destinationPath)
        await leaveEditor()
        await navigating
      }
      await save.click()
      await requested
      if (!leaveFirst) await leaveEditor()
      if (leave.startsWith('failed-before-')) {
        write.resolve(saved)
        await editorStatus.filter({ hasText: 'konnten nicht gespeichert werden' }).waitFor()
      }
      if (usesFallback) await page.evaluate(() => {
        window.canceledDeparture = false
        document.addEventListener('astro:page-load', () => { window.canceledDeparture = true }, { once: true })
      })
      heldPanelAuth = undefined
      heldDestinationHtml = undefined
      destination.resolve()
      if (usesFallback) await page.waitForFunction(() => window.canceledDeparture)
      // Give the router time to reach the swap if navigation bypasses the guard.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await editorBeforeSave.evaluate(main => main.isConnected && getComputedStyle(main).visibility === 'visible'),
        true, 'Wait for the sidebar save before swapping panels')
    } finally {
      destination.resolve()
      heldPanelAuth = undefined
      heldDestinationHtml = undefined
      write.resolve(saved)
      heldSidebarSave = undefined
    }
    if (saved) {
      const target = leavesByLink ? 'admin' : 'settings'
      await page.locator(`main[data-panel="${target}"][data-panel-authorized]`).waitFor()
      assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
      if (leavesByLink) await page.goBack()
      else await page.goForward()
      await editor.locator('#sidebar-reset:enabled').waitFor()
      assert.equal(await choice.isChecked(), true)
    } else {
      await page.waitForURL(url => url.pathname.replace(/\/$/, '') === '/settings/sidebar')
      await editorStatus.filter({ hasText: 'konnten nicht gespeichert werden' }).waitFor()
      assert.equal(await choice.isChecked(), true, 'A failed write retains the editor draft')
      assert.equal(await save.isEnabled(), true)
      assert.equal(await editorBeforeSave.evaluate(main => main.isConnected), true)
      await editor.locator('#sidebar-revert').click()
      assert.equal(await editorBeforeSave.evaluate(main => main.isConnected), true)
    }
    await editorBeforeSave.dispose()
  }
  await editor.locator('.fm-admin-back[href="/settings"]').click()
  await page.locator('main[data-panel="settings"][data-panel-authorized]').waitFor()
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)

  for (const [path, table] of [['/manufacturers', 'manufacturers'], ['/filaments/colors', 'colors']]) {
    await clickNav(path)
    const rows = page.locator(`#${table}-table tr`)
    await rows.nth(49).waitFor({ state: 'attached' })
    await page.evaluate(() => window.scrollTo(0, 800))
    await page.waitForFunction(() => window.scrollY === 800)
    await clickNav('/settings')
    await page.goBack()
    await page.waitForURL(url => url.pathname.replace(/\/$/, '') === path)
    await rows.nth(49).waitFor({ state: 'attached' })
    assert.equal(await page.evaluate(() => window.scrollY), 800, path)
    const outgoingScroll = await page.evaluate(() => {
      window.scrollTo(0, 1200)
      const top = window.scrollY
      history.forward()
      return top
    })
    await page.locator('main[data-panel="settings"][data-panel-authorized]').waitFor()
    await page.goBack()
    await rows.nth(49).waitFor({ state: 'attached' })
    // Font layout can adjust the browser's scroll anchor by one line.
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - outgoingScroll) <= 20, path)
  }
  await page.locator('#colors-list-table th.col-hex .fm-header-filter-trigger').click()
  const filterPanel = page.locator('.fm-header-filter-panel.open')
  await filterPanel.locator('input.fm-header-filter-value[type="text"]').fill('ABCDEF')
  await filterPanel.locator('.fm-btn-primary').click()
  const colorRows = page.locator('#colors-table tr')
  await colorRows.filter({ hasText: 'ABCDEF' }).waitFor()
  assert.equal(await colorRows.count(), 1)
  await clickNav('/settings')
  await page.goBack()
  await colorRows.filter({ hasText: 'ABCDEF' }).waitFor()
  assert.equal(await colorRows.count(), 1)
  await clickNav('/spool-log')
  await searchFor('PLA')
  await clickNav('/settings')
  const logRequest = page.waitForRequest(req => {
    const url = new URL(req.url())
    return url.pathname === '/api/v1/spools/all-events' && url.searchParams.get('search') === 'PLA'
  })
  await page.goBack()
  await logRequest
  let releasePreview
  let releaseClaim
  previewGate = new Promise(resolve => { releasePreview = resolve })
  claimGate = new Promise(resolve => { releaseClaim = resolve })
  const printPrompt = page.locator('#pc-print-prompt')
  const originalPrompt = await printPrompt.elementHandle()
  const previewRequest = page.waitForRequest(req => req.url().endsWith('/print-requests/7/preview'))
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/labels/spool/3/print-request', { method: 'POST' })).status), 201)
  await previewRequest
  await clickNav('/settings')
  const preview = printPrompt.locator('.pc-print-prompt-preview')
  assert.equal(await preview.isVisible(), false)
  releasePreview()
  await preview.waitFor()
  await preview.evaluate(image => image.decode())
  assert.equal(await originalPrompt.evaluate(prompt => prompt === document.querySelector('#pc-print-prompt')), true)
  await originalPrompt.dispose()
  const claimRequest = page.waitForRequest(req => req.url().endsWith('/print-requests/7/claim'))
  const popupEvent = page.waitForEvent('popup')
  await printPrompt.locator('.pc-print-prompt-edit').click()
  const popup = await popupEvent
  await claimRequest
  await clickNav('/spool-log')
  releaseClaim()
  await popup.waitForURL('**/spools/3/print?scale_print=1&preset_id=42', { waitUntil: 'commit' })
  await popup.close()
  await printPrompt.waitFor({ state: 'hidden' })
  assert.equal(requests.filter(path => path.endsWith('/print-requests/7/preview')).length, 1)
  assert.equal(requests.filter(path => path.endsWith('/print-requests/7/claim')).length, 1)
  await clickNav('/display')
  await page.locator('#ams-printers .ams-note').waitFor()
  await clickNav('/plugin-view?p=example')
  await page.locator('#plugin-frame[src="/plugin-page/example"]').waitFor()
  await clickNav('/plugin-view?p=other')
  await page.locator('#plugin-frame[src="/plugin-page/other"]').waitFor()
  showOtherPlugin = false
  await clickNav('/plugin-view/native-example')
  await page.locator('#plugin-iframe[src^="/plugins/native-example/"]').waitFor()
  await sidebar.locator('a[href="/plugin-view?p=other"]').waitFor({ state: 'detached' })
  const displayRequests = requests.filter(path => path === '/api/v1/display').length
  await page.setViewportSize({ width: 390, height: 850 })
  await page.locator('#sidebar-toggle[aria-expanded="false"]').click()
  await sidebar.locator('a[href="/spool-log"]').click()
  await page.waitForURL(origin + '/spool-log')
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)
  await page.locator('#sidebar-toggle[aria-expanded="false"]').waitFor()
  assert.equal(await page.locator('main').evaluate(main => main.inert), false)
  assert.ok(requests.filter(path => path === '/api/v1/plugin-nav').length > 2)
  await page.waitForTimeout(5100)
  assert.equal(requests.filter(path => path === '/api/v1/display').length, displayRequests)
  await page.locator('#sidebar-toggle[aria-expanded="false"]').click()
  sessionExpired = true
  await sidebar.locator('a[href="/spools"]').click()
  await page.waitForURL(url => url.pathname === '/login' && url.searchParams.get('next') === '/spools')
  await page.locator('#login-form').waitFor()
  sessionExpired = false
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin + '/filaments/colors')
  await page.locator('main').waitFor()
  await page.evaluate(() => { window.sidebarBefore = document.querySelector('.fm-sidebar') })
  let releaseAuth
  pendingAuth = new Promise(resolve => { releaseAuth = resolve })
  const delayedAuth = page.waitForRequest(req => new URL(req.url()).pathname === '/api/v1/me')
  await sidebar.locator('a[href="/settings"]').click()
  await delayedAuth
  assert.equal(new URL(page.url()).pathname, '/filaments/colors')
  await page.goto(origin + '/login')
  releaseAuth()
  await page.goBack({ waitUntil: 'commit' })
  await page.locator('main[data-panel="colors"]').waitFor()
  assert.equal(await page.evaluate(() => window.restoredFromCache), true)
  assert.equal(await page.evaluate(() => window.sidebarBefore === document.querySelector('.fm-sidebar')), true)

  await page.evaluate(() => localStorage.setItem('filaman-label-print-pdf-v1', 'true'))
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/labels/spool/3/print-request', { method: 'POST' })).status), 201)
  await preview.waitFor()
  await printPrompt.locator('.pc-print-prompt-print').click()
  const download = printPrompt.locator('a[download]')
  await download.waitFor()
  const oldPdf = await download.getAttribute('href')
  assert.ok(oldPdf?.startsWith('blob:'))

  user.id = 2
  user.display_name = 'Second account'
  await sidebar.locator('a[href="/printers"]').click()
  await page.locator('#user-name').getByText('Second account').waitFor()
  assert.equal(await printPrompt.isVisible(), false)
  assert.equal(await page.evaluate(url => fetch(url).then(() => true, () => false), oldPdf), false)

  await page.goto(origin)
  await page.waitForFunction(() => document.getElementById('stat-total-spools')?.textContent === '2')
  await dismissChangelog()
  await page.locator('#problem-spools').click()
  const detail = page.locator('#spool-modal a[href="/spools/3"]').first()
  const detailRequests = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/spools/3') detailRequests.push(request.resourceType())
  })
  await detail.click()
  await page.waitForURL('**/spools/3', { waitUntil: 'domcontentloaded' })
  assert.deepEqual(detailRequests, ['document'])
  await page.locator('#user-name').getByText('Second account').waitFor()
  authFailure = 'server'
  await page.goBack({ waitUntil: 'commit' })
  await page.locator('#session-check-retry button').click()
  await page.locator('main[data-panel="dashboard"]').waitFor()
  assert.equal(await page.evaluate(() => window.restoredFromCache), true)
  assert.equal(await page.locator('#spool-modal').evaluate(dialog => dialog.open), false)

  for (const inventory of ['spools', 'filaments']) {
    const listResponse = response => new URL(response.url()).pathname === `/api/v1/${inventory}` && response.ok()
    const initialList = page.waitForResponse(listResponse)
    await page.goto(origin + '/' + inventory)
    await initialList
    await page.goto(origin + '/' + inventory + '/new')
    await page.locator('#user-name').getByText('Second account').waitFor()
    authFailure = 'server'
    inventoryUnavailable = true
    await page.goBack({ waitUntil: 'commit' })
    const retry = page.locator('#session-check-retry button')
    await retry.waitFor()
    assert.equal(await page.evaluate(() => window.restoredFromCache), true)
    inventoryUnavailable = false
    const refreshedList = page.waitForResponse(listResponse)
    await retry.click()
    await refreshedList
  }
  const connectionPath = '/api/v1/admin/system/spoolman-import/test-connection'
  let releaseConnection
  const connectionGate = new Promise(resolve => { releaseConnection = resolve })
  let holdConnection = true
  await page.context().route(`**${connectionPath}`, async route => {
    if (holdConnection) await connectionGate
    await route.fulfill({ json: { status: 'ok', url: 'http://spoolman.test', info: {} } }).catch(() => {})
  })
  try {
    await page.goto(origin + '/admin/system/spoolman-import')
    await page.locator('main[data-panel-authorized]').waitFor()
    await page.locator('#spoolman-url').fill('http://spoolman.test')
    const connectionRequest = page.waitForRequest(request => new URL(request.url()).pathname === connectionPath)
    await page.locator('#btn-test').click()
    await connectionRequest
    await page.locator('main a.fm-admin-back').click()
    await page.waitForURL('**/admin/system', { waitUntil: 'domcontentloaded' })
    await page.goBack({ waitUntil: 'commit' })
    await page.locator('main[data-panel="spoolman-import"]').waitFor()
    assert.equal(await page.evaluate(() => window.restoredFromCache), true)
    await page.waitForFunction(() => !document.getElementById('btn-test').disabled)
    holdConnection = false
    const retriedConnection = page.waitForResponse(response => new URL(response.url()).pathname === connectionPath && response.ok())
    await page.locator('#btn-test').click()
    await retriedConnection
    await page.locator('#connection-result .fm-alert-success').waitFor()
  } finally {
    releaseConnection()
  }
  assert.deepEqual(errors, [])
  console.log('Sidebar persists through navigation and Back. Filters, plugin panels, mobile focus, polling cleanup and the print popup passed.')
} finally {
  await browser.close()
}
