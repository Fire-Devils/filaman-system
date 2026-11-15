import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
const base = process.argv[2] || 'http://127.0.0.1:4321'
const at = path => url => url.pathname.replace(/\/$/, '') === path
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // External font CSS blocks module startup and can outlast the request assertion.
  await context.route('https://fonts.googleapis.com/**', route => route.abort())
  let account = {
    sidebar: { navigation: [], plugins: [{ id: 'moonraker', shown: true, pinned: false }],
      remember: true, compact: false, hover: false, showColorMode: true },
    theme: 'dark', expanded: false,
  }
  let holdWrite
  let holdRead
  let holdStartupRead
  let startupTab
  let scanSeq = 1
  let holdLogout
  let preferenceWrites = 0
  let failLegacyImport = false
  let holdExpansion
  let failWrites = false
  let failReads = false
  let rejectHeldWrite = false
  await context.route(/\/(api|auth)\//, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/tag/last-scan') return route.fulfill({ json: { seq: scanSeq, spool_id: 7, uid: 'fixture' } })
    if (path === '/auth/logout' && holdLogout) {
      await holdLogout
      return route.fulfill({ json: {} })
    }
    if (path.endsWith('/me/preferences/sidebar')) {
      if (request.method() === 'PATCH') {
        preferenceWrites++
        if (failWrites) return route.fulfill({ status: 503 })
        const body = request.postDataJSON()
        if (body.import_legacy && failLegacyImport) {
          failLegacyImport = false
          return route.fulfill({ status: 503 })
        }
        if (body.expanded !== undefined && holdExpansion) await holdExpansion
        else if (holdWrite) await holdWrite
        if (rejectHeldWrite) return route.fulfill({ status: 503 })
        account = { ...account, ...request.postDataJSON() }
      } else {
        if (failReads) return route.fulfill({ status: 503 })
        if (holdStartupRead && request.frame().page() === startupTab) {
          const snapshot = account
          await holdStartupRead
          return route.fulfill({ json: snapshot })
        }
        if (holdRead) await holdRead
      }
      return route.fulfill({ json: account })
    }
    if (path.endsWith('/me')) return route.fulfill({
      json: { id: 1, email: 'review@example.test', display_name: 'Review', roles: [], permissions: [], language: 'en', is_superadmin: true },
      headers: { 'X-Filaman-Theme': account.theme },
    })
    if (path.endsWith('/plugin-nav')) return route.fulfill({ json: [
      { plugin_key: 'moonraker', name: 'Moonraker', page_url: '/plugin-page/moonraker' },
      { plugin_key: 'example', name: 'Example', page_url: '/plugin-page/example' },
    ] })
    return route.fulfill({ json: [] })
  })
  await context.route('**/plugin-page/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Plugin fixture</h1>' }))
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const ready = () => page.waitForFunction(() => {
    const button = document.querySelector('#sidebar-color-mode button[data-theme="dark"]')
    return button?.getClientRects().length && getComputedStyle(button).visibility === 'visible'
      && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
  })
  const patch = () => page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/me/preferences/sidebar'))
  const settingsLink = page.locator('a.fm-settings-link[href="/settings/sidebar"]')
  const firstRead = Promise.withResolvers()
  holdRead = firstRead.promise
  try {
    const requested = page.waitForRequest(request => request.method() === 'GET' && request.url().includes('/me/preferences/sidebar'))
    await page.goto(base + '/settings')
    await requested
    await page.locator('#sidebar-pinned-plugins a[href="/plugin-view?p=example"]').waitFor()
    await settingsLink.click()
    await page.locator('main[data-panel="sidebar-settings"][data-panel-authorized]').waitFor()
  } finally {
    holdRead = undefined
    firstRead.resolve()
  }
  await page.locator('#sidebar-reset:enabled').waitFor()
  assert.equal(await page.locator('#sidebar-plugins-empty').isHidden(), true, 'The editor uses the already loaded plugin list')
  const heading = page.locator('#sidebar-plugin-heading')
  const profileGear = page.locator('#sidebar-profile a[href="/settings"]')
  const pluginSettings = page.locator('#sidebar-plugin-settings-link')
  await profileGear.and(page.locator('[aria-current="page"]')).waitFor()
  const gearStyle = () => profileGear.evaluate(async gear => {
    const current = () => getComputedStyle(gear)
    current().backgroundColor
    await Promise.allSettled(gear.getAnimations().map(animation => animation.finished))
    return [current().backgroundColor, current().borderColor]
  })
  const activeGear = await gearStyle()
  await heading.click()
  await pluginSettings.and(page.locator('[aria-current="page"]:visible')).waitFor()
  const inactiveGear = await gearStyle()
  const collapse = Promise.withResolvers()
  holdExpansion = collapse.promise
  try {
    const writing = patch()
    await heading.click()
    await writing
    await page.evaluate(() => history.back())
    await page.waitForURL(at('/settings'))
    rejectHeldWrite = true
    collapse.resolve()
    await page.waitForURL(at('/settings/sidebar'))
    await pluginSettings.and(page.locator('[aria-current="page"]:visible')).waitFor()
    assert.notDeepEqual(activeGear, inactiveGear, 'The active Settings gear has a visible indicator')
  } finally {
    collapse.resolve()
    holdExpansion = undefined
    rejectHeldWrite = false
  }
  const initialClose = page.waitForResponse(response => response.request().method() === 'PATCH'
    && response.request().postDataJSON()?.expanded === false)
  await heading.click()
  await initialClose
  const openingWrite = Promise.withResolvers()
  holdExpansion = openingWrite.promise
  try {
    const opening = patch()
    await heading.click()
    await opening
    const save = page.getByRole('button', { name: 'Save', exact: true })
    const compact = page.getByRole('radio', { name: 'Compact' })
    const comfortable = page.getByRole('radio', { name: 'Comfortable' })
    await compact.check()
    await comfortable.check()
    assert.equal(await save.isDisabled(), true)
    assert.equal(await heading.getAttribute('aria-expanded'), 'true', 'A clean draft preserves the pending caret state')
    await compact.check()
    await heading.click()
    await comfortable.check()
    assert.equal(await save.isEnabled(), true, 'Returning layout to baseline retains a caret edit that follows a pending caret write')
    openingWrite.resolve()
    holdExpansion = undefined
    await save.click()
    await page.locator('#sidebar-settings-status').filter({ hasText: 'Saved' }).waitFor()
    assert.equal(account.expanded, false)
  } finally {
    openingWrite.resolve()
    holdExpansion = undefined
  }
  await page.goBack()
  await ready()
  const light = page.locator('.settings-appearance button[data-theme="light"]')
  startupTab = await context.newPage()
  const initialRead = Promise.withResolvers()
  holdStartupRead = initialRead.promise
  try {
    await startupTab.addInitScript(() => {
      window.addEventListener('storage', event => {
        if (event.key === 'sidebar-preferences-changed') document.documentElement.dataset.preferenceNotified = 'true'
      })
    })
    const requested = startupTab.waitForRequest(request => request.method() === 'GET' && request.url().includes('/me/preferences/sidebar'))
    await startupTab.goto(base + '/settings')
    await requested
    await light.click()
    await startupTab.locator('html[data-preference-notified="true"]').waitFor()
    holdStartupRead = undefined
    initialRead.resolve()
    await startupTab.locator('html[data-theme="light"]').waitFor()
  } finally {
    holdStartupRead = undefined
    initialRead.resolve()
    await startupTab.close()
  }
  await page.locator('.settings-appearance button[data-theme="dark"]').click()
  await page.waitForFunction(() => document.querySelector('.settings-appearance [aria-pressed="true"]')?.dataset.theme === 'dark'
    && !document.querySelector('.settings-appearance [aria-disabled="true"]'))
  const savedTheme = Promise.withResolvers()
  holdWrite = savedTheme.promise
  const themeStarted = patch()
  await light.waitFor()
  await light.focus()
  await light.press('Enter')
  await themeStarted
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await light.evaluate(button => button === document.activeElement), true, 'Theme saves retain keyboard focus')
  // Use a real same-tab link in the settings page while its theme write is held.
  await settingsLink.click({ noWaitAfter: true })
  await page.waitForTimeout(150)
  assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), '/settings', 'Navigation waits for the pending account write')
  savedTheme.resolve()
  holdWrite = undefined
  await page.waitForURL(at('/settings/sidebar'))
  await ready()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  const savedExpansion = Promise.withResolvers()
  holdWrite = savedExpansion.promise
  const opening = patch()
  await heading.click()
  await opening
  const plugin = page.locator('#sidebar-nav a[href="/plugin-view?p=moonraker"]')
  await plugin.click({ noWaitAfter: true })
  await page.waitForTimeout(150)
  assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), '/settings/sidebar', 'Plugin navigation waits for remembered expansion')
  savedExpansion.resolve()
  holdWrite = undefined
  await page.waitForURL(url => at('/plugin-view')(url) && url.searchParams.get('p') === 'moonraker')
  await ready()
  await heading.and(page.locator('[aria-expanded="true"]')).waitFor()

  // Hide then show the current plugin without changing the installed-plugin response.
  account.sidebar = { ...account.sidebar, plugins: [{ id: 'moonraker', shown: false, pinned: false }] }
  await page.reload()
  await ready()
  await plugin.waitFor({ state: 'detached' })
  account.sidebar = { ...account.sidebar, plugins: [{ id: 'moonraker', shown: true, pinned: false }] }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await plugin.waitFor()
  assert.equal(await plugin.evaluate(link => link.classList.contains('active')), true, 'Re-shown current plugin is highlighted')

  await page.goto(base + '/settings/sidebar')
  await ready()
  const firstSave = Promise.withResolvers()
  holdWrite = firstSave.promise
  const closing = patch()
  await heading.click()
  await closing
  await heading.click()
  failWrites = true
  failReads = true
  const failedRecovery = page.waitForResponse(response => response.request().method() === 'GET'
    && response.url().includes('/me/preferences/sidebar') && response.status() === 503)
  firstSave.resolve()
  holdWrite = undefined
  await failedRecovery
  assert.equal(account.expanded, false)
  assert.equal(await heading.getAttribute('aria-expanded'), 'false', 'Failed queued caret save restores last successful write')
  failWrites = false
  failReads = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // A preceding theme response must not erase the newer optimistic caret state.
  const themeResponse = Promise.withResolvers()
  const expansionResponse = Promise.withResolvers()
  holdWrite = themeResponse.promise
  holdExpansion = expansionResponse.promise
  const themeRequest = patch()
  await page.locator('#sidebar-color-mode button[data-theme="dark"]').click()
  await themeRequest
  await heading.click()
  const expansionStarted = patch()
  themeResponse.resolve()
  holdWrite = undefined
  await expansionStarted
  assert.equal(await heading.getAttribute('aria-expanded'), 'true', 'Older theme response preserves a queued caret action')
  await heading.click()
  const lastExpansion = page.waitForResponse(response => response.request().method() === 'PATCH'
    && response.request().postDataJSON()?.expanded === false)
  expansionResponse.resolve()
  holdExpansion = undefined
  await lastExpansion
  await heading.and(page.locator('[aria-expanded="false"]')).waitFor()
  assert.equal(account.expanded, false)

  // A failed save must remain visible instead of disappearing during navigation.
  const rejectedTheme = Promise.withResolvers()
  holdWrite = rejectedTheme.promise
  const rejectedRequest = patch()
  await page.locator('#sidebar-color-mode button[data-theme="brand"]').click()
  await rejectedRequest
  await page.locator('.fm-admin-back[href="/settings"]').click({ noWaitAfter: true })
  rejectHeldWrite = true
  rejectedTheme.resolve()
  holdWrite = undefined
  await page.locator('#sidebar-settings-status').filter({ hasText: 'Could not save' }).waitFor()
  await page.waitForTimeout(150)
  assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), '/settings/sidebar', 'Failed save cancels the waiting navigation')
  rejectHeldWrite = false

  // Returning through history must leave controls usable after a deferred navigation.
  await page.goBack()
  await ready()
  const changedTheme = patch()
  await page.locator('#sidebar-color-mode button[data-theme="brand"]').click()
  await changedTheme
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'brand')
  account = { sidebar: null, theme: 'brand', expanded: null }
  failLegacyImport = true
  await page.evaluate(() => localStorage.setItem('sidebar-color-library', 'false'))
  await page.goto(base + '/settings/sidebar')
  await page.locator('#sidebar-settings-status').filter({ hasText: 'Could not load' }).waitFor()
  assert.equal(await page.locator('#sidebar-reset').isDisabled(), true, 'A failed migration leaves the editor disabled until it can retry')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('#sidebar-reset:enabled').waitFor()
  assert.equal(account.sidebar.navigation.find(row => row.id === '/filaments/colors').shown, false)
  assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-color-library')), null)
  await profileGear.click()
  await page.locator('main[data-panel="settings"][data-panel-authorized]').waitFor()
  const logout = Promise.withResolvers()
  holdLogout = logout.promise
  try {
    const leaving = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/logout')
    await page.locator('#logout-btn').click()
    await leaving
    await page.evaluate(() => history.back())
    const editor = page.locator('main[data-panel="sidebar-settings"][data-panel-authorized] #sidebar-settings-form')
    await editor.waitFor()
    assert.equal(await editor.evaluate(form => Boolean(form.closest('[inert]'))), true,
      'A panel mounted through Back stays locked until sign-out completes')
    const beforeLogout = preferenceWrites
    await editor.dispatchEvent('submit', { bubbles: true, cancelable: true })
    assert.equal(preferenceWrites, beforeLogout)
  } finally {
    logout.resolve()
    holdLogout = undefined
  }
  await page.waitForURL(at('/login'))

  await page.evaluate(() => localStorage.setItem('tag-scanner-auto-open', 'true'))
  const scanResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tag/last-scan')
  const firstScan = scanResponse()
  await page.goto(base + '/spools/')
  await firstScan
  await ready()
  const themeWrite = Promise.withResolvers()
  const queuedLogout = Promise.withResolvers()
  holdWrite = themeWrite.promise
  holdLogout = queuedLogout.promise
  try {
    const writing = patch()
    await page.locator('#sidebar-color-mode button[data-theme="dark"]').click()
    await writing
    const leaving = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/logout')
    void leaving.catch(() => {})
    await page.locator('#logout-btn').click()
    const secondScan = scanResponse()
    scanSeq++
    await secondScan
    await page.locator('#tag-scan-note').waitFor()
    holdWrite = undefined
    themeWrite.resolve()
    await leaving
    const thirdScan = scanResponse()
    scanSeq++
    await thirdScan
    assert.equal(at('/spools')(new URL(page.url())), true)
  } finally {
    themeWrite.resolve()
    queuedLogout.resolve()
    holdWrite = undefined
    holdLogout = undefined
  }
  await page.waitForURL(at('/login'))
  assert.deepEqual(errors, [])
  console.log('Sidebar lifecycle: pending navigation, theme keyboard focus, active plugin restoration, and queued save rollback passed.')
} finally {
  await browser.close()
}
