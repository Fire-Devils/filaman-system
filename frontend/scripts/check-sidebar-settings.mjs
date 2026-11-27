import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const settings = new URL('/settings/sidebar', baseUrl).href
const moonrakerKey = 'moonraker'
const installed = ['Moonraker', 'Bambuddy', 'Swatch'].map(name => ({
  plugin_key: name.toLowerCase(), name, page_url: '/plugin-page/' + name.toLowerCase(),
  icon_url: '/api/v1/plugin-icons/' + name.toLowerCase(),
  version: '1.0.0', description: '', plugin_type: 'integration', is_active: true, installed_by: 1,
}))
let plugins = [...installed]
let accountPreferences = { sidebar: null, theme: 'light', expanded: null }
let failNextSave = false
let holdNextSidebarSave
let admin
let failNextAdminNav = false
let failedPluginNav = false
const firstPreferencesResponse = Promise.withResolvers()
let firstPreferences = true
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('legacy-fixture') === null) {
      sessionStorage.setItem('legacy-fixture', 'true')
      localStorage.setItem('sidebar-color-library', 'false')
    }
  })
  const routeApi = async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/me/preferences/sidebar')) {
      if (route.request().method() === 'GET' && firstPreferences) {
        firstPreferences = false
        await firstPreferencesResponse.promise
        return route.fulfill({ status: 503 })
      }
      if (route.request().method() === 'PATCH') {
        if (failNextSave) {
          failNextSave = false
          return route.fulfill({ status: 503 })
        }
        const { sidebar, theme, expanded, expected_sidebar, import_legacy } = route.request().postDataJSON()
        if (sidebar && (sidebar.navigation.length > 128 || sidebar.plugins.length > 512)) return route.fulfill({ status: 422 })
        if (sidebar && holdNextSidebarSave) await holdNextSidebarSave
        try {
          if (expected_sidebar !== undefined) assert.deepEqual(expected_sidebar, accountPreferences.sidebar)
        } catch {
          return route.fulfill({ status: 409 })
        }
        if (sidebar && (!import_legacy || !accountPreferences.sidebar)) accountPreferences.sidebar = sidebar
        if (theme && (!import_legacy || !accountPreferences.theme)) accountPreferences.theme = theme
        if (!accountPreferences.sidebar?.remember) accountPreferences.expanded = null
        else if (expanded !== undefined) accountPreferences.expanded = expanded
      }
      return route.fulfill({ json: accountPreferences })
    }
    if (path.includes('/plugin-icons/')) {
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
      })
    }
    if (path.endsWith('/plugins/' + moonrakerKey) && route.request().method() === 'DELETE') {
      plugins = plugins.filter(plugin => plugin.plugin_key !== moonrakerKey)
      failNextAdminNav = true
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith('/plugin-nav') && failNextAdminNav && route.request().frame().page() === admin) {
      failNextAdminNav = false
      failedPluginNav = true
      return route.fulfill({ status: 503 })
    }
    if (path.endsWith('/plugins/install') && route.request().method() === 'POST') {
      plugins = [...installed]
      return route.fulfill({ json: { plugin: installed[0], message: 'Plugin installed' } })
    }
    if (path.endsWith('/backup/sqlite-list')) {
      return route.fulfill({ json: { is_sqlite: true, backups: [{ filename: 'fixture.db', size_bytes: 1024, created_at: '2026-11-14' }] } })
    }
    if (path.endsWith('/backup/import') || path.endsWith('/backup/sqlite-restore')) {
      plugins = path.endsWith('/import') ? installed.filter(plugin => plugin.plugin_key !== 'swatch') : [...installed]
      return route.fulfill({ json: { message: 'Fixture restored' } })
    }
    if (path.endsWith('/me')) return route.fulfill({
      json: { id: 1, email: 'preview@example.test', display_name: 'Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] },
      headers: { 'X-Filaman-Theme': accountPreferences.theme },
    })
    const data = path.endsWith('/plugin-nav') || path.endsWith('/system/plugins') ? plugins
      : path.endsWith('/public-info') ? { login_enabled: false } : []
    return route.fulfill({ json: data })
  }
  await context.route(/\/(api|auth)\//, routeApi)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const shots = process.env.SIDEBAR_SCREENSHOTS
  async function screenshot(name) {
    if (shots) await page.screenshot({
      path: `${shots}/${name}.png`,
      animations: 'disabled',
      style: 'astro-dev-toolbar { display: none !important; }',
    })
  }
  async function saveSettings(target) {
    await target.getByRole('button', { name: 'Save' }).click()
    await target.locator('#sidebar-settings-status').filter({ hasText: 'Saved' }).waitFor()
  }
  const waitForSettings = target => target.getByRole('button', { name: 'Defaults' }).and(target.locator(':enabled')).waitFor()
  const firstPreferencesRequest = page.waitForRequest('**/me/preferences/sidebar?*')
  await page.goto(settings)
  await firstPreferencesRequest
  await page.getByRole('heading', { name: 'Sidebar settings' }).waitFor({ timeout: 2000 })
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'The saved theme applies before sidebar settings finish loading')
  const reset = page.getByRole('button', { name: 'Defaults' })
  assert.equal(await reset.isDisabled(), true)
  assert.equal(await page.getByRole('checkbox', { name: 'Show Dashboard' }).evaluate(input => {
    input.focus()
    return document.activeElement === input
  }), false)
  firstPreferencesResponse.resolve()
  await page.getByRole('status').filter({ hasText: 'Could not load your account preferences' }).waitFor()
  assert.equal(await reset.isDisabled(), true)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitForSettings(page)
  const save = page.getByRole('button', { name: 'Save' })
  const revert = page.getByRole('button', { name: 'Revert' })
  assert.equal(await save.isDisabled(), true)
  assert.equal(await revert.isDisabled(), true)
  assert.ok(await save.evaluate(button => button.getBoundingClientRect().bottom <= innerHeight))
  await page.getByRole('radio', { name: 'Compact' }).check()
  await page.getByRole('radio', { name: 'Comfortable' }).check()
  assert.equal(await save.isDisabled(), true, 'Changing spacing back to the saved value clears the draft')
  assert.equal(await revert.isDisabled(), true)
  await page.getByRole('radio', { name: 'Compact' }).check()
  await page.getByRole('status').filter({ hasText: 'Unsaved changes' }).waitFor()
  assert.equal(await save.isEnabled(), true)
  async function assertStickyToolbar() {
    const title = page.getByRole('heading', { name: 'Sidebar settings' })
    const toolbar = title.locator('xpath=ancestor::header')
    const pinnedToolbar = toolbar.and(page.locator('[data-stuck]'))
    await page.evaluate(() => window.scrollTo(0, 0))
    await pinnedToolbar.waitFor({ state: 'detached' })
    assert.equal(await toolbar.evaluate(header => getComputedStyle(header, '::before').content), 'none')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    assert.ok(await page.evaluate(() => scrollY > 0), 'The settings page scrolled')
    await pinnedToolbar.waitFor()
    assert.equal(await toolbar.evaluate(header => getComputedStyle(header, '::before').borderBottomWidth), '1px')
    assert.ok(await toolbar.evaluate(header => {
      const pinned = getComputedStyle(header, '::before')
      const pageBackground = getComputedStyle(header.closest('.fm-page'))
      return pinned.backgroundImage === pageBackground.backgroundImage &&
        pinned.backgroundAttachment === pageBackground.backgroundAttachment
    }), 'The pinned toolbar continues the page background behind the divider')
    assert.ok(await toolbar.evaluate(header => {
      const bounds = header.getBoundingClientRect()
      return bounds.top >= 0 && bounds.bottom <= innerHeight
    }), 'The title remains visible after scrolling')
    assert.ok(await toolbar.evaluate(header => {
      const tables = header.parentElement.querySelector('.sidebar-settings-lists').getBoundingClientRect()
      const feedback = header.querySelector('.sidebar-settings-feedback').getBoundingClientRect()
      const buttons = header.querySelector('.fm-list-controls').getBoundingClientRect()
      // The controls row (Save, Defaults, help button) ends at the table edge
      if (Math.abs(tables.right - buttons.right) >= 1) return false
      const centerY = rect => rect.top + rect.height / 2
      if (innerWidth <= 599) return feedback.bottom <= buttons.top
      return feedback.right <= buttons.left && Math.abs(centerY(feedback) - centerY(buttons)) < 1 &&
        Math.abs(centerY(header.getBoundingClientRect()) - centerY(buttons)) < 1
    }), 'Toolbar actions align with the table edge and keep feedback before Save')
    for (const button of [save, revert, reset]) {
      assert.ok(await toolbar.locator('button').and(button).isVisible(), 'All actions are in the sticky header')
      assert.ok(await button.locator('svg use').isVisible(), 'Each action uses a shared sprite icon')
      assert.ok(await button.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      }), 'Each action is reachable while scrolled')
    }
    await page.evaluate(() => window.scrollTo(0, 0))
    await pinnedToolbar.waitFor({ state: 'detached' })
  }
  await assertStickyToolbar()
  await revert.click()
  assert.equal(await page.getByRole('radio', { name: 'Comfortable' }).isChecked(), true)
  assert.equal(await save.isDisabled(), true)
  plugins = [installed[0]]
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('checkbox', { name: 'Show Swatch' }).waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('checkbox', { name: 'Pin Moonraker' }).isDisabled(), true)

  const moonrakerInMain = page.getByRole('checkbox', { name: 'Place Moonraker in main navigation' })
  const groupRow = page.locator('#sidebar-navigation-order [data-id="plugin-nav"]')
  const groupHeaderToggle = groupRow.getByRole('checkbox', { name: 'Show Plugins header' })
  const groupShowToggle = groupRow.getByRole('checkbox', { name: 'Show Plugins', exact: true })
  await groupHeaderToggle.uncheck()
  await moonrakerInMain.check()
  assert.equal(await groupHeaderToggle.isDisabled(), true, 'An empty Plugins group has no header to show')
  assert.equal(await groupShowToggle.isDisabled(), true)
  assert.equal(await groupRow.locator('.sidebar-settings-row').evaluate(row => getComputedStyle(row).filter), 'grayscale(1)')
  assert.equal(await groupRow.getByRole('button', { name: 'Move up' }).isEnabled(), true)
  await moonrakerInMain.uncheck()
  assert.equal(await groupHeaderToggle.isEnabled(), true)
  assert.equal(await groupHeaderToggle.isChecked(), false, 'Returning a plugin restores the draft header choice')
  assert.equal(await groupShowToggle.isEnabled(), true)
  await revert.click()
  plugins = [...installed]
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('checkbox', { name: 'Show Swatch' }).waitFor()
  const pluginSection = page.locator('#sidebar-plugins-section')
  await pluginSection.getByRole('checkbox', { name: 'Preview plugins on hover' }).waitFor()
  await pluginSection.getByRole('checkbox', { name: 'Remember expanded plugins' }).waitFor()
  const freshSettings = await context.newPage()
  const importedSidebar = accountPreferences.sidebar
  accountPreferences.sidebar = null
  try {
    await freshSettings.goto(settings)
    const promote = freshSettings.getByRole('checkbox', { name: 'Place Moonraker in main navigation' })
    await promote.and(freshSettings.locator(':enabled')).waitFor()
    const navigationIds = () => freshSettings.locator('#sidebar-navigation-order > li')
      .evaluateAll(rows => rows.map(row => row.dataset.id))
    const beforePromotion = await navigationIds()
    await promote.check()
    const withPromotion = await navigationIds()
    assert.deepEqual(withPromotion.filter(id => id !== 'plugin/moonraker'), beforePromotion)
    assert.equal(withPromotion.at(-2), 'plugin/moonraker', 'First promotion belongs before the footer profile')
  } finally {
    accountPreferences.sidebar = importedSidebar
    await freshSettings.close()
  }
  const nav = page.locator('#sidebar-nav')
  const previewFor = id => page.locator(`#sidebar-navigation-order [data-id="${id}"] .sidebar-block-preview`)
  const profilePreview = previewFor('sidebar-profile')
  await profilePreview.waitFor()
  assert.match(await profilePreview.textContent(), /Preview/)
  assert.equal(await page.locator('#user-name').count(), 1)
  assert.equal(await profilePreview.locator('a[href="/settings"]').count(), 1)
  assert.equal(await nav.locator('a[href="/settings"]').count(), 0)
  assert.equal(await page.locator('#sidebar-navigation-order [data-id="/settings"]').count(), 0)
  assert.equal(await profilePreview.evaluate(block => block.inert), true)
  assert.equal(await page.locator('#sidebar-navigation-order [data-id="sidebar-profile"] .sidebar-show').count(), 0)
  const adminPreview = previewFor('/admin')
  assert.equal(await adminPreview.locator('[data-i18n="nav.admin"]').textContent(), 'Admin')
  assert.equal((await adminPreview.locator('a[href="/admin"]').textContent()).trim(), 'Admin Panel')
  const pluginsPreview = previewFor('plugin-nav')
  assert.equal(await pluginsPreview.locator('.sidebar-plugin-label').textContent(), 'Plugins')
  const filamentDb = { ...installed[0], plugin_key: 'filamentdb_import', name: 'FilamentDB Import',
    page_url: '/admin/system/filamentdb-import' }
  plugins.push(filamentDb)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const filamentPin = page.getByRole('checkbox', { name: 'Pin FilamentDB Import' })
  await filamentPin.waitFor()
  await filamentPin.uncheck()
  assert.equal(await pluginsPreview.locator('.sidebar-plugin-heading').count(), 1)
  assert.equal(await pluginsPreview.locator('.sidebar-plugin-count').textContent(), '1')
  await nav.locator('#sidebar-plugin-heading').click()
  const filamentDbMenu = nav.locator('#sidebar-plugin-preview')
  await filamentDbMenu.getByRole('link', { name: 'FilamentDB Import' }).waitFor()
  await filamentDbMenu.getByRole('link', { name: 'Sidebar settings' }).click()
  await waitForSettings(page)
  assert.equal(await filamentPin.isChecked(), false, 'Opening Sidebar settings keeps the draft pin choice')
  const adminHeader = page.getByRole('checkbox', { name: 'Show Admin header' })
  const pluginsHeader = page.getByRole('checkbox', { name: 'Show Plugins header' })
  const showColumn = await page.locator('#sidebar-navigation-order [data-id="/spool-log"] .fm-toggle').evaluate(track => {
    const { left, width } = track.getBoundingClientRect()
    return left + width / 2
  })
  for (const header of [adminHeader, pluginsHeader]) {
    const { labelRight, checkboxLeft, checkboxCenter, headerBottom, showTop, showCenter } = await header.evaluate(input => {
      const checkbox = input.getBoundingClientRect()
      const show = input.closest('.sidebar-settings-row').querySelector('.sidebar-show .fm-toggle').getBoundingClientRect()
      return {
        labelRight: input.closest('label').querySelector('span').getBoundingClientRect().right,
        checkboxLeft: checkbox.left,
        checkboxCenter: checkbox.left + checkbox.width / 2,
        headerBottom: input.closest('label').getBoundingClientRect().bottom,
        showTop: show.top,
        showCenter: show.left + show.width / 2,
      }
    })
    assert.ok(labelRight <= checkboxLeft, 'Show header text sits left of the checkbox')
    assert.ok(headerBottom <= showTop, 'Show header sits above the row’s Show switch')
    assert.ok(Math.abs(checkboxCenter - showColumn) < 1 && Math.abs(showCenter - showColumn) < 1,
      'Header checkboxes and Show switches align across rows')
  }
  await adminHeader.uncheck()
  await pluginsHeader.uncheck()
  assert.equal(await nav.locator('#admin-nav hr').isVisible(), false)
  assert.equal(await adminPreview.locator('[data-i18n="nav.admin"]').isVisible(), false)
  assert.equal(await nav.locator('#plugin-nav hr').isVisible(), false)
  assert.equal(await pluginsPreview.locator('.sidebar-plugin-heading').isVisible(), false)
  for (const spacing of ['Compact', 'Comfortable']) {
    await page.getByRole('radio', { name: spacing, exact: true }).check()
    assert.ok(await nav.evaluate(node => {
      const admin = node.querySelector('#admin-nav')
      const previous = admin.previousElementSibling
      const gap = admin.getBoundingClientRect().top - previous.getBoundingClientRect().bottom
      return Math.abs(gap - parseFloat(getComputedStyle(node).rowGap)) < 1
    }), `A headerless Admin Panel uses ${spacing} row spacing`)
  }
  await nav.locator('#sidebar-pinned-plugins').getByRole('link', { name: 'FilamentDB Import' }).waitFor()
  const promoteFilamentDb = page.getByRole('checkbox', { name: 'Place FilamentDB Import in main navigation' })
  async function assertPlacementRow(plugin) {
    const row = page.locator('#sidebar-plugins-order li').filter({ hasText: plugin })
    const centers = await row.locator('label:has(input[data-promote]), .sidebar-pin, .sidebar-show').evaluateAll(labels =>
      labels.map(label => { const { top, height } = label.getBoundingClientRect(); return top + height / 2 }))
    assert.equal(centers.length, 3)
    assert.ok(Math.max(...centers) - Math.min(...centers) < 2, 'Main navigation, Pin, and Show share a row')
  }
  await assertPlacementRow('FilamentDB Import')
  await promoteFilamentDb.check()
  const promotedLink = nav.locator(':scope > a').filter({ hasText: 'FilamentDB Import' })
  await promotedLink.waitFor()
  assert.equal(await filamentPin.isDisabled(), true)
  const promotedRow = page.locator('#sidebar-navigation-order [data-id="plugin/filamentdb_import"]')
  const previousId = await promotedRow.evaluate(row => row.previousElementSibling.dataset.id)
  await promotedRow.getByRole('button', { name: 'Move up' }).click()
  assert.equal(await promotedRow.evaluate(row => row.nextElementSibling.dataset.id), previousId)
  const showFilamentDb = page.locator('#sidebar-plugins-order').getByRole('checkbox', { name: 'Show FilamentDB Import' })
  await showFilamentDb.uncheck()
  for (const row of [promotedRow, page.locator('#sidebar-plugins-order [data-id="filamentdb_import"]')]) {
    assert.equal(await row.locator('.sidebar-item-label').evaluate(label => getComputedStyle(label).filter), 'grayscale(1)')
  }
  await showFilamentDb.check()
  assert.equal(await promotedRow.locator('.sidebar-item-label').evaluate(label => getComputedStyle(label).filter), 'none')
  await saveSettings(page)
  await page.reload()
  await waitForSettings(page)
  await promotedLink.waitFor()
  assert.equal(await promoteFilamentDb.isChecked(), true)
  assert.equal(await pluginsHeader.isChecked(), false)
  assert.equal(await adminHeader.isChecked(), false)
  await promoteFilamentDb.uncheck()
  await promotedLink.waitFor({ state: 'detached' })
  await adminHeader.check()
  await pluginsHeader.check()
  await filamentPin.check()
  plugins = plugins.filter(plugin => plugin !== filamentDb)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await filamentPin.waitFor({ state: 'detached' })
  const color = page.getByRole('checkbox', { name: 'Show Color Library' })
  const showPlugins = page.getByRole('checkbox', { name: 'Show Plugins', exact: true })
  await showPlugins.uncheck()
  await saveSettings(page)
  await page.reload()
  await waitForSettings(page)
  await page.locator('#sidebar-plugins-order [data-id="moonraker"]').waitFor()
  assert.equal(await nav.locator('#plugin-nav').isVisible(), false)
  assert.equal(await showPlugins.isChecked(), false)
  await showPlugins.check()
  assert.equal(await color.isChecked(), false, 'legacy Color Library setting is carried over')
  await color.check()
  assert.equal(await nav.getByRole('link', { name: 'Color Library' }).isVisible(), true)
  const order = () => nav.locator(':scope > a').evaluateAll(links => links.map(link => link.getAttribute('href')))
  const manufacturerRow = page.locator('#sidebar-navigation-order li').filter({ hasText: 'Manufacturers' })
  const moveUp = manufacturerRow.getByRole('button', { name: 'Move up' })
  assert.equal(await moveUp.innerText(), '', 'reorder buttons use arrow icons')
  assert.ok(await moveUp.locator('svg').isVisible())
  await moveUp.click()
  assert.equal((await order())[0], '/manufacturers')
  const from = await page.getByRole('button', { name: 'Reorder Locations' }).boundingBox()
  const to = await page.getByRole('button', { name: 'Reorder Dashboard' }).boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  const dashboardRow = page.locator('#sidebar-navigation-order [data-id="/"]')
  const locationsRow = page.locator('#sidebar-navigation-order [data-id="/locations"]')
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 5, { steps: 12 })
  assert.equal(await dashboardRow.getAttribute('data-drop-target'), 'after')
  await page.mouse.move(to.x + to.width / 2, to.y + 5, { steps: 5 })
  assert.equal(await dashboardRow.getAttribute('data-drop-target'), 'before')
  assert.equal(await locationsRow.getAttribute('data-dragging'), '')
  assert.notEqual(await dashboardRow.evaluate(row => getComputedStyle(row).boxShadow), 'none')
  await screenshot('desktop-drag')
  await page.mouse.up()
  assert.equal((await order())[1], '/locations')
  assert.equal(await page.locator('[data-dragging], [data-drop-target]').count(), 0)

  const auto = page.getByRole('radio', { name: 'Auto', exact: true })
  await auto.check()
  await page.setViewportSize({ width: 1440, height: 480 })
  await nav.and(page.locator('.sidebar-nav-compact')).waitFor()
  await page.setViewportSize({ width: 1440, height: 1400 })
  await nav.and(page.locator(':not(.sidebar-nav-compact)')).waitFor()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await saveSettings(page)
  assert.equal(accountPreferences.sidebar.compact, null)
  await page.reload()
  await waitForSettings(page)
  assert.equal(await auto.isChecked(), true)
  await page.getByRole('radio', { name: 'Compact' }).check()
  await auto.check()
  assert.equal(await save.isDisabled(), true, 'Auto remains clean when restored')
  await page.getByRole('checkbox', { name: 'Pin Swatch' }).uncheck()
  await page.getByRole('checkbox', { name: 'Show Bambuddy' }).uncheck()
  await page.getByRole('radio', { name: 'Compact' }).check()
  await page.getByRole('checkbox', { name: 'Remember expanded plugins' }).check()
  await saveSettings(page)
  const heading = nav.locator('#sidebar-plugin-heading')
  await heading.hover()
  const preview = page.locator('#sidebar-plugin-preview')
  await preview.getByRole('link', { name: 'Swatch' }).waitFor()
  await preview.getByRole('link', { name: 'Swatch' }).hover()
  assert.equal(await preview.isVisible(), true)
  await screenshot('desktop-hover')
  await page.keyboard.press('Escape')
  assert.equal(await preview.isVisible(), false)
  await heading.click()
  await nav.getByRole('link', { name: 'Swatch' }).waitFor()
  assert.equal(await heading.getAttribute('aria-expanded'), 'true')
  assert.equal(await nav.getByRole('link', { name: 'Bambuddy' }).count(), 0)
  await page.reload()
  await waitForSettings(page)
  await nav.getByRole('link', { name: 'Swatch' }).waitFor()
  assert.equal(await heading.getAttribute('aria-expanded'), 'true')
  assert.equal((await order())[0], '/manufacturers')
  await screenshot('desktop')

  const navigationSection = page.locator('#sidebar-navigation-section')
  const colorModeRow = navigationSection.locator('[data-id="sidebar-color-mode"]')
  const colorPreview = previewFor('sidebar-color-mode')
  assert.equal(await colorPreview.evaluate(element => getComputedStyle(element).overflow), 'visible')
  assert.deepEqual(await colorPreview.locator('[data-theme]').allTextContents().then(labels => labels.map(label => label.trim())),
    ['Default', 'Light', 'Dark'])
  assert.equal(await colorPreview.locator('svg').count(), 0, 'Color modes use text labels without icons')
  assert.equal(await colorPreview.locator('[data-theme="light"][aria-pressed="true"]').count(), 1)
  const sidebarTheme = page.locator('#sidebar-color-mode')
  async function assertThemeRow(picker) {
    await picker.waitFor()
    const options = picker.locator('button[data-theme]')
    assert.deepEqual(await options.allTextContents().then(labels => labels.map(label => label.trim())), ['Default', 'Light', 'Dark'])
    assert.equal(await options.locator('svg').count(), 0)
    const boxes = await options.evaluateAll(buttons => buttons.map(button => {
      const { top, height } = button.getBoundingClientRect()
      return { top, height, padding: getComputedStyle(button).padding }
    }))
    assert.equal(new Set(boxes.map(box => box.top)).size, 1, 'The expanded theme picker stays on one row')
    const margins = await options.evaluateAll(buttons => {
      const bounds = buttons[0].parentElement.getBoundingClientRect()
      return [buttons[0].getBoundingClientRect().left - bounds.left, bounds.right - buttons.at(-1).getBoundingClientRect().right]
    })
    assert.ok(Math.abs(margins[0] - margins[1]) < 2, 'Theme options are centered within the picker')
    assert.ok(boxes.every(box => box.padding === '6px 12px' && box.height >= 24), 'Uses the release theme button spacing')
  }
  await assertThemeRow(sidebarTheme)
  const tabs = page.getByRole('tablist', { name: 'Sidebar sections' })
  const navigationTab = tabs.getByRole('tab', { name: 'Navigation' })
  const pluginsTab = tabs.getByRole('tab', { name: 'Plugins' })
  async function assertFits(width) {
    assert.ok(await page.evaluate(() => {
      const main = document.querySelector('main')
      return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= innerWidth
    }), `Sidebar settings have no horizontal overflow at ${width}px`)
  }
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [390, 844], [320, 820]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(async () => {
      const layout = document.getElementById('fm-page')
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      void getComputedStyle(layout).gridTemplateColumns
      await Promise.allSettled(layout.getAnimations().map(animation => animation.finished))
    })
    await colorModeRow.waitFor()
    await assertFits(width)
    for (const preview of [colorPreview, profilePreview]) {
      const width = await preview.evaluate(element => element.getBoundingClientRect().width)
      assert.ok(width <= 223, 'Block previews fit within the live sidebar width')
    }
    if (width === 1024) {
      const gear = page.locator('aside').getByRole('link', { name: 'User Settings', exact: true })
      assert.equal(await gear.isVisible(), true, 'Settings remains accessible from the collapsed sidebar')
      assert.equal(await gear.getAttribute('href'), '/settings')
      assert.equal(await page.locator('#user-name').isVisible(), false)
      assert.equal(await page.locator('#logout-btn').isVisible(), true)
      for (const preview of [adminPreview, pluginsPreview]) {
        const text = preview.locator('.fm-nav-item > span:not(.fm-nav-icon)').first()
        assert.equal(await text.evaluate(element => getComputedStyle(element).clipPath), 'none')
      }
    }
    const row = await colorModeRow.boundingBox()
    const previewBounds = await colorPreview.boundingBox()
    assert.ok(previewBounds.x >= row.x && previewBounds.x + previewBounds.width <= row.x + row.width,
      `Color mode preview fits at ${width}px`)
    const tabbed = width <= 820
    assert.equal(await tabs.isVisible(), tabbed, `Settings tab visibility at ${width}px`)
    if (tabbed) {
      assert.equal(await pluginSection.isVisible(), false)
      await pluginsTab.click()
      assert.equal(await navigationSection.isVisible(), false)
      await assertFits(width)
      await navigationTab.click()
    } else {
      const navigationBounds = await navigationSection.boundingBox()
      const pluginBounds = await pluginSection.boundingBox()
      assert.equal(navigationBounds.y, pluginBounds.y)
      assert.ok(navigationBounds.x + navigationBounds.width < pluginBounds.x, 'Cards sit side by side')
    }
  }
  await assertStickyToolbar()
  const actionTops = await Promise.all([save, revert, reset].map(action => action.evaluate(button => button.getBoundingClientRect().top)))
  assert.equal(new Set(actionTops).size, 1, 'All three toolbar actions fit on one row at 320px')
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  async function tap(locator) {
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await navigationTab.focus()
  await navigationTab.press('ArrowRight')
  assert.equal(await pluginsTab.getAttribute('aria-selected'), 'true')
  await pluginsTab.press('ArrowLeft')
  assert.equal(await navigationTab.getAttribute('aria-selected'), 'true')
  await tap(pluginsTab)
  await pluginsTab.and(page.locator('[aria-selected="true"]')).waitFor()
  assert.equal(await page.getByRole('tabpanel', { name: 'Plugins' }).isVisible(), true)
  await page.getByRole('checkbox', { name: 'Pin Swatch' }).waitFor()
  await assertPlacementRow('Swatch')
  assert.equal(await pluginSection.locator('.sidebar-promotion-heading').evaluate(label => {
    const range = document.createRange()
    range.selectNodeContents(label)
    return [...range.getClientRects()].filter(box => box.width > 0).length
  }), 2, 'Main navigation fits on two lines without splitting a word')
  const rememberLabel = pluginSection.locator('label').filter({ hasText: 'Remember expanded plugins' })
  const optionStyle = await rememberLabel.evaluate(label => {
    const { fontSize, fontWeight } = getComputedStyle(label)
    return { fontSize, fontWeight, height: label.getBoundingClientRect().height }
  })
  const pluginStyle = await pluginSection.locator('.sidebar-item-label').first().evaluate(label => {
    const { fontSize, fontWeight } = getComputedStyle(label)
    return { fontSize, fontWeight }
  })
  assert.deepEqual({ fontSize: optionStyle.fontSize, fontWeight: optionStyle.fontWeight }, pluginStyle)
  assert.equal(optionStyle.height, 44, 'Remember expanded plugins fits in one mobile touch row')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const touchHandle = page.getByRole('button', { name: 'Reorder Swatch' })
  assert.ok((await touchHandle.boundingBox()).height >= 44)
  const swatchRow = page.locator('#sidebar-plugins-order li').filter({ hasText: 'Swatch' })
  for (const name of ['Move up', 'Move down']) {
    const arrow = await swatchRow.getByRole('button', { name }).boundingBox()
    const label = await swatchRow.locator('.sidebar-item-label').boundingBox()
    assert.ok(arrow.width >= 32 && arrow.height >= 44)
    assert.ok(arrow.x + arrow.width <= label.x)
  }
  assert.ok((await page.getByRole('checkbox', { name: 'Pin Swatch' }).boundingBox()).height >= 44)
  const swatch = await touchHandle.boundingBox()
  const moonraker = await page.getByRole('button', { name: 'Reorder Moonraker' }).boundingBox()
  const x = Math.round(swatch.x + swatch.width / 2)
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: Math.round(swatch.y + swatch.height / 2) }] })
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(moonraker.y + 5) }] })
  assert.equal(await swatchRow.getAttribute('data-dragging'), '')
  assert.equal(await page.locator('#sidebar-plugins-order [data-id="moonraker"]').getAttribute('data-drop-target'), 'before')
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal(await page.locator('#sidebar-plugins-order li').first().getAttribute('data-id'), 'swatch')
  assert.equal(await page.locator('[data-dragging], [data-drop-target]').count(), 0)
  assert.ok(await swatchRow.locator('.sidebar-item-label').evaluate(label => {
    const range = document.createRange()
    range.selectNodeContents(label)
    const lines = [...range.getClientRects()].filter(box => box.width > 0)
    return lines.length === 1
  }), 'the 320px layout leaves room for the plugin name')
  await screenshot('mobile')
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await page.waitForFunction(() => !document.querySelector('#sidebar-content').inert)
  await heading.and(page.locator('[aria-expanded="true"]')).waitFor()
  await heading.click()
  await nav.getByRole('link', { name: 'Swatch' }).waitFor({ state: 'hidden' })
  await heading.click()
  await nav.getByRole('link', { name: 'Swatch' }).waitFor()
  assert.ok((await nav.getByRole('link', { name: 'Swatch' }).boundingBox()).height >= 44)
  await assertThemeRow(sidebarTheme)
  await screenshot('mobile-drawer')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Defaults' }).click()
  await saveSettings(page)
  await page.reload()
  assert.equal((await order())[0], '/')
  await nav.getByRole('link', { name: 'Bambuddy', includeHidden: true }).waitFor({ state: 'attached' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Reorder Dashboard' }).waitFor()
  await colorModeRow.getByRole('button', { name: 'Move up' }).click()
  const navOrder = target => target.locator('#sidebar-nav').locator(':scope > *').evaluateAll(items =>
    items.map(item => item.id || item.getAttribute('href')))
  assert.ok((await navOrder(page)).indexOf('sidebar-color-mode') < (await navOrder(page)).indexOf('admin-nav'))
  const profileRow = page.locator('#sidebar-navigation-order [data-id="sidebar-profile"]')
  await profileRow.getByRole('button', { name: 'Move up' }).click()
  assert.ok((await navOrder(page)).indexOf('sidebar-profile') < (await navOrder(page)).indexOf('admin-nav'))
  await colorModeRow.getByRole('checkbox', { name: 'Show Color mode' }).uncheck()
  assert.equal(await sidebarTheme.isVisible(), false)
  failNextSave = true
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('status').filter({ hasText: 'Could not save your account preferences' }).waitFor()
  assert.equal(accountPreferences.sidebar.showColorMode, true)
  await saveSettings(page)
  assert.equal(await colorPreview.getByRole('button').count(), 0)
  await page.goto(new URL('/settings', baseUrl).href)
  const appearance = page.getByRole('region', { name: 'Appearance' })
  await assertThemeRow(appearance)
  await appearance.getByRole('button', { name: 'Light' }).click()
  await page.waitForFunction(() => document.querySelector('.settings-appearance button[data-theme="light"]:enabled:not([aria-disabled="true"])'))
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  assert.equal(await sidebarTheme.isVisible(), false)
  const otherBrowser = await browser.newContext()
  try {
    await otherBrowser.route(/\/(api|auth)\//, routeApi)
    const freshPage = await otherBrowser.newPage()
    await freshPage.goto(settings)
    await waitForSettings(freshPage)
    const freshColorRow = freshPage.locator('#sidebar-navigation-section [data-id="sidebar-color-mode"]')
    await freshColorRow.waitFor()
    assert.equal(await freshPage.locator('html').getAttribute('data-theme'), 'light')
    assert.equal(await freshColorRow.getByRole('checkbox', { name: 'Show Color mode' }).isChecked(), false)
    assert.deepEqual(await navOrder(freshPage), await navOrder(page))
    await appearance.getByRole('button', { name: 'Dark' }).click()
    await page.waitForFunction(() => document.querySelector('.settings-appearance button[data-theme="dark"]:enabled:not([aria-disabled="true"])'))
    await freshPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await freshPage.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  } finally {
    await otherBrowser.close()
  }
  await page.goto(settings)
  await colorModeRow.getByRole('checkbox', { name: 'Show Color mode' }).check()
  await saveSettings(page)
  await page.goto(new URL('/settings', baseUrl).href)
  await sidebarTheme.getByRole('button', { name: 'Default' }).click()
  assert.equal(await appearance.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed'), 'true')
  await screenshot('navigation-desktop')
  await page.setViewportSize({ width: 320, height: 820 })
  await assertThemeRow(appearance)
  await appearance.getByRole('button', { name: 'Dark' }).click()
  await page.waitForFunction(() => document.querySelector('.settings-appearance button[data-theme="dark"]:enabled:not([aria-disabled="true"])'))
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  if (shots) {
    await page.goto(settings)
    await colorModeRow.waitFor()
    await colorModeRow.scrollIntoViewIfNeeded()
    await screenshot('navigation-mobile')
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(settings)
  const pluginRows = page.locator('#sidebar-plugins-order li')
  const getPluginOrder = () => pluginRows.evaluateAll(rows => rows.map(row => row.dataset.id))
  const moonrakerRow = pluginRows.filter({ hasText: 'Moonraker' })
  await moonrakerRow.waitFor()
  await nav.getByRole('link', { name: 'Moonraker' }).locator('.fm-plugin-icon-mask').waitFor()
  await moonrakerRow.locator('.fm-plugin-icon-mask').waitFor({ state: 'attached' })
  assert.equal(await moonrakerRow.locator('.fm-plugin-icon > img').count(), 0)
  await moonrakerRow.getByRole('button', { name: 'Move down' }).click()
  await page.getByRole('checkbox', { name: 'Pin Moonraker' }).uncheck()
  await saveSettings(page)
  assert.deepEqual(await getPluginOrder(), ['bambuddy', moonrakerKey, 'swatch'])

  const otherSettings = await context.newPage()
  await otherSettings.goto(settings)
  await heading.click()
  await otherSettings.getByRole('checkbox', { name: 'Show Color Library' }).uncheck()
  await saveSettings(otherSettings)
  await nav.getByRole('link', { name: 'Color Library' }).waitFor({ state: 'hidden' })
  assert.equal(await heading.getAttribute('aria-expanded'), 'true')
  await heading.click()
  await page.getByRole('radio', { name: 'Compact' }).check()
  await otherSettings.getByRole('checkbox', { name: 'Show Swatch' }).uncheck()
  await saveSettings(otherSettings)
  await page.getByRole('button', { name: 'Save' }).click()
  const conflict = page.getByRole('dialog', { name: 'Sidebar settings changed' })
  await conflict.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await page.getByRole('radio', { name: 'Compact' }).isChecked(), true)
  assert.equal(await otherSettings.getByRole('checkbox', { name: 'Show Swatch' }).isChecked(), false)
  await page.getByRole('button', { name: 'Save' }).click()
  await conflict.waitFor()
  await otherSettings.getByRole('checkbox', { name: 'Preview plugins on hover' }).uncheck()
  await saveSettings(otherSettings)
  await conflict.getByRole('button', { name: 'Overwrite' }).click()
  await page.getByRole('status').filter({ hasText: 'Sidebar settings changed again' }).waitFor()
  assert.equal(await otherSettings.getByRole('checkbox', { name: 'Show Swatch' }).isChecked(), false)
  await page.getByRole('button', { name: 'Save' }).click()
  await conflict.getByRole('button', { name: 'Overwrite' }).click()
  await otherSettings.locator('#sidebar-nav').getByRole('link', { name: 'Swatch' }).waitFor()
  await page.getByRole('radio', { name: 'Comfortable' }).check()
  const remoteDashboard = otherSettings.getByRole('checkbox', { name: 'Show Dashboard' })
  await remoteDashboard.uncheck()
  await saveSettings(otherSettings)
  await save.click()
  await conflict.getByRole('button', { name: 'Cancel' }).click()
  await revert.click()
  assert.equal(await page.getByRole('checkbox', { name: 'Show Dashboard' }).isChecked(), false,
    'Revert shows the current saved layout after canceling a conflict')
  assert.equal(await save.isDisabled(), true)
  await remoteDashboard.check()
  await saveSettings(otherSettings)
  await nav.getByRole('link', { name: 'Dashboard' }).waitFor()

  const remember = page.getByRole('checkbox', { name: 'Remember expanded plugins' })
  await remember.check()
  await saveSettings(page)
  const otherHeading = otherSettings.locator('#sidebar-plugin-heading')
  const showDashboard = page.getByRole('checkbox', { name: 'Show Dashboard' })
  await showDashboard.focus()
  await otherHeading.click()
  await page.waitForFunction(() => document.querySelector('#sidebar-plugin-heading').getAttribute('aria-expanded') === 'true')
  assert.ok(await showDashboard.evaluate(input => input === document.activeElement))
  failNextSave = true
  await heading.click()
  await page.locator('#sidebar-settings-status').filter({ hasText: 'Could not save your account preferences' }).waitFor()
  assert.equal(accountPreferences.expanded, true)
  await heading.and(page.locator('[aria-expanded="true"]')).waitFor()
  const moonrakerLink = nav.getByRole('link', { name: 'Moonraker' })
  await moonrakerLink.focus()
  await otherHeading.click()
  await moonrakerLink.waitFor({ state: 'hidden' })
  assert.ok(await heading.evaluate(button => button === document.activeElement))
  await page.getByRole('radio', { name: 'Comfortable' }).check()
  await otherHeading.click()
  const saveResponse = Promise.withResolvers()
  holdNextSidebarSave = saveResponse.promise
  const sidebarSave = page.waitForRequest(request => request.method() === 'PATCH' && request.postDataJSON()?.sidebar)
  try {
    await page.getByRole('button', { name: 'Save' }).click()
    await sidebarSave
    assert.equal(await heading.isDisabled(), true, 'The disclosure cannot change while sidebar settings are saving')
    const wasExpanded = await heading.getAttribute('aria-expanded')
    await heading.dispatchEvent('click')
    assert.equal(await heading.getAttribute('aria-expanded'), wasExpanded)
  } finally {
    saveResponse.resolve()
    holdNextSidebarSave = undefined
  }
  await page.locator('#sidebar-settings-status').filter({ hasText: 'Saved' }).waitFor()
  assert.equal(await heading.isEnabled(), true)
  assert.equal(await otherHeading.getAttribute('aria-expanded'), 'true')

  admin = await page.context().newPage()
  admin.setDefaultTimeout(5000)
  await admin.goto(new URL('/admin/system', baseUrl).href)
  const adminRow = admin.locator('#plugins-table tr').filter({ hasText: 'Moonraker' })
  const adminMoonrakerLink = admin.locator('#sidebar-nav [href="/plugin-view?p=moonraker"]')
  await adminMoonrakerLink.waitFor({ state: 'attached' })
  const pinSwatch = page.getByRole('checkbox', { name: 'Pin Swatch' })
  await pinSwatch.focus()
  const sidebarSwatch = otherSettings.locator('#sidebar-nav').getByRole('link', { name: 'Swatch' })
  await sidebarSwatch.focus()
  await adminRow.locator('.btn-delete').click()
  await admin.locator('#fm-confirm-ok').click()
  await admin.locator('#fm-confirm-cancel').click()
  await adminRow.waitFor({ state: 'detached' })
  await adminMoonrakerLink.waitFor({ state: 'detached' })
  await moonrakerRow.waitFor({ state: 'detached' })
  assert.equal(failedPluginNav, true)
  assert.ok(await pinSwatch.evaluate(input => input === document.activeElement))
  assert.ok(await sidebarSwatch.evaluate(link => link === document.activeElement))
  await pinSwatch.press('Space')
  assert.equal(await pinSwatch.isChecked(), false)
  await pinSwatch.check()
  await page.getByRole('radio', { name: 'Compact' }).check()
  await saveSettings(page)

  await admin.locator('#btn-install').click()
  await admin.locator('#file-input').setInputFiles({ name: 'moonraker.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') })
  await admin.locator('#install-submit').click()
  await adminRow.waitFor()
  await moonrakerRow.waitFor()
  assert.deepEqual(await getPluginOrder(), ['bambuddy', moonrakerKey, 'swatch'])
  assert.equal(await page.getByRole('checkbox', { name: 'Pin Moonraker' }).isChecked(), false)
  await admin.close()

  await page.getByRole('checkbox', { name: 'Show Swatch' }).uncheck()
  const inlineSettingsLink = nav.getByRole('link', { name: 'Sidebar settings' })
  await inlineSettingsLink.focus()
  plugins = [{ ...installed[1], plugin_key: 'new-plugin', name: 'New Plugin', page_url: '/plugin-page/new-plugin' }, ...plugins]
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('checkbox', { name: 'Pin New Plugin' }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: 'Pin New Plugin' }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: 'Show Swatch' }).isChecked(), false)
  assert.ok(await inlineSettingsLink.evaluate(link => link === document.activeElement))
  const installedMoonraker = nav.getByRole('link', { name: 'Moonraker' })
  await installedMoonraker.focus()
  plugins = plugins.map(plugin => plugin.plugin_key === moonrakerKey
    ? { ...plugin, name: 'Moonraker Updated', icon_url: plugin.icon_url + '?v=2.0.0' } : plugin)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  const updatedMoonraker = nav.getByRole('link', { name: 'Moonraker Updated' })
  await updatedMoonraker.waitFor()
  assert.ok(await updatedMoonraker.evaluate(link => link === document.activeElement))
  const backup = await context.newPage()
  await backup.goto(new URL('/admin/backup', baseUrl).href)
  await backup.locator('#backup-file-input').setInputFiles({ name: 'fixture.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from('{}') })
  await backup.locator('#btn-import-backup').click()
  const dragFrom = await page.getByRole('button', { name: 'Reorder Swatch' }).boundingBox()
  const dragTo = await page.getByRole('button', { name: 'Reorder Bambuddy' }).boundingBox()
  await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragTo.x + dragTo.width / 2, dragTo.y + 5, { steps: 10 })
  const dropTarget = page.locator('#sidebar-plugins-order [data-drop-target]')
  await dropTarget.waitFor({ state: 'attached' })
  const moveMoonrakerDown = otherSettings.locator('#sidebar-plugins-order [data-id="moonraker"]').getByRole('button', { name: 'Move down' })
  await moveMoonrakerDown.focus()
  await backup.locator('#fm-confirm-ok').click()
  await page.getByRole('checkbox', { name: 'Show Swatch' }).waitFor({ state: 'detached' })
  await otherSettings.waitForFunction(() => document.querySelector('#sidebar-plugins-order [data-id="moonraker"] [data-step="1"]').disabled)
  assert.ok(await otherSettings.getByRole('heading', { name: 'Plugins', exact: true }).evaluate(el => el === document.activeElement))
  await page.mouse.move(6, 6)
  await page.mouse.up()
  await dropTarget.waitFor({ state: 'detached' })
  await backup.locator('#fm-confirm-ok').click()
  await backup.waitForEvent('load')
  await backup.getByRole('button', { name: 'Restore', exact: true }).click()
  await backup.locator('#fm-confirm-ok').click()
  await page.getByRole('checkbox', { name: 'Show Swatch' }).waitFor()
  await backup.close()
  await otherSettings.close()

  const archivedRows = (prefix, limit) => Array.from({ length: limit }, (_, index) => ({ id: prefix + index, shown: false }))
  accountPreferences.sidebar = {
    compact: false, hover: true, remember: false, showColorMode: true,
    navigation: [...archivedRows('/old-item-', 127), { id: '/filaments/colors', shown: false }],
    plugins: archivedRows('old-plugin-', 512),
  }
  await page.reload()
  await waitForSettings(page)
  await page.getByRole('radio', { name: 'Compact' }).check()
  await saveSettings(page)
  assert.equal(accountPreferences.sidebar.navigation.length, 128)
  assert.equal(accountPreferences.sidebar.navigation.find(row => row.id === '/filaments/colors').shown, false)
  assert.equal(accountPreferences.sidebar.plugins.length, 512)
  assert.ok(plugins.every(plugin => accountPreferences.sidebar.plugins.some(row => row.id === plugin.plugin_key)))
  plugins.push(...Array.from({ length: 5 }, (_, i) => ({
    ...installed[0], plugin_key: 'preview_' + i, name: 'Preview ' + i, page_url: '/plugin-page/preview_' + i,
  })))
  await page.reload()
  const pluginBlock = page.locator('#sidebar-navigation-order [data-id="plugin-nav"] .sidebar-block-preview')
  await pluginBlock.getByText('Preview 4', { exact: true }).waitFor({ state: 'attached' })
  assert.ok(await pluginBlock.evaluate(block => block.scrollHeight <= block.clientHeight), 'The whole Plugins group fits its reorder preview')

  const removedPlugin = nav.getByRole('link', { name: 'Preview 4', exact: true })
  await removedPlugin.focus()
  plugins = plugins.filter(plugin => plugin.plugin_key !== 'preview_4')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await removedPlugin.waitFor({ state: 'detached' })
  assert.ok(await nav.evaluate(element => element.contains(document.activeElement)), 'Removing a focused plugin keeps keyboard focus in the sidebar')

  await page.getByRole('checkbox', { name: 'Show Plugins header' }).uncheck()
  for (const plugin of plugins) await page.getByRole('checkbox', { name: 'Show ' + plugin.name, exact: true }).uncheck()
  await pluginBlock.getByText('Plugins', { exact: true }).waitFor()
  assert.equal(await nav.locator('#plugin-nav').isHidden(), true, 'The label belongs to the empty editor preview')
  assert.deepEqual(errors, [])
  console.log('Sidebar settings passed from 320px to desktop, including touch and keyboard tabs, reorder, disclosure, and color mode persistence.')
} finally {
  firstPreferencesResponse.resolve()
  await browser.close()
}
