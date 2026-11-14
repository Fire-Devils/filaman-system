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
let accountPreferences = { sidebar: null, theme: null, expanded: null }
let failNextSave = false
let admin
let failNextAdminNav = false
let failedPluginNav = false
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
  const routeApi = route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/me/preferences/sidebar')) {
      if (route.request().method() === 'PATCH') {
        if (failNextSave) {
          failNextSave = false
          return route.fulfill({ status: 503 })
        }
        const { sidebar, theme, expanded, expected_sidebar, import_legacy } = route.request().postDataJSON()
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
    const data = path.endsWith('/me') ? { id: 1, email: 'preview@example.test', display_name: 'Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] }
      : path.endsWith('/plugin-nav') || path.endsWith('/system/plugins') ? plugins
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
    await target.getByRole('button', { name: 'Save changes' }).click()
    await target.locator('#sidebar-settings-status').filter({ hasText: 'Saved' }).waitFor()
  }
  await page.goto(settings)
  await page.getByRole('heading', { name: 'Sidebar settings' }).waitFor()
  const pluginSection = page.locator('#sidebar-plugins-section')
  await pluginSection.getByRole('checkbox', { name: 'Preview plugins on hover' }).waitFor()
  await pluginSection.getByRole('checkbox', { name: 'Remember expanded plugins' }).waitFor()
  const nav = page.locator('#sidebar-nav')
  const color = page.getByRole('checkbox', { name: 'Show Color Library' })
  const showPlugins = page.getByRole('checkbox', { name: 'Show Plugins', exact: true })
  await showPlugins.uncheck()
  await saveSettings(page)
  await page.reload()
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
  await page.mouse.move(to.x + to.width / 2, to.y + 5, { steps: 12 })
  await page.mouse.up()
  assert.equal((await order())[1], '/locations')
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
  await nav.getByRole('link', { name: 'Swatch' }).waitFor()
  assert.equal(await heading.getAttribute('aria-expanded'), 'true')
  assert.equal((await order())[0], '/manufacturers')
  await screenshot('desktop')

  const navigationSection = page.locator('#sidebar-navigation-section')
  const colorModeRow = navigationSection.locator('[data-id="sidebar-color-mode"]')
  const colorPreview = colorModeRow.locator('.fm-theme-preview')
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
      getComputedStyle(layout).gridTemplateColumns
      await Promise.allSettled(layout.getAnimations().map(animation => animation.finished))
    })
    await colorModeRow.waitFor()
    await assertFits(width)
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
  assert.equal(await pluginsTab.getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByRole('tabpanel', { name: 'Plugins' }).isVisible(), true)
  await page.getByRole('checkbox', { name: 'Pin Swatch' }).waitFor()
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
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal(await page.locator('#sidebar-plugins-order li').first().getAttribute('data-id'), 'swatch')
  assert.ok(await swatchRow.locator('.sidebar-item-label').evaluate(label => {
    const range = document.createRange()
    range.selectNodeContents(label)
    const lines = [...range.getClientRects()].filter(box => box.width > 0)
    return lines.length === 1
  }), 'the 320px layout leaves room for the plugin name')
  await screenshot('mobile')
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await page.waitForFunction(() => !document.querySelector('#sidebar-content').inert)
  await tap(heading)
  assert.equal(await nav.getByRole('link', { name: 'Swatch' }).count(), 0)
  await tap(heading)
  await nav.getByRole('link', { name: 'Swatch' }).waitFor()
  assert.ok((await nav.getByRole('link', { name: 'Swatch' }).boundingBox()).height >= 44)
  await screenshot('mobile-drawer')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Reset to defaults' }).click()
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
  await colorModeRow.getByRole('checkbox', { name: 'Show Color mode' }).uncheck()
  const sidebarTheme = page.locator('#sidebar-color-mode')
  assert.equal(await sidebarTheme.isVisible(), false)
  failNextSave = true
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('status').filter({ hasText: 'Could not save your account preferences' }).waitFor()
  assert.equal(accountPreferences.sidebar.showColorMode, true)
  await saveSettings(page)
  assert.equal(await colorPreview.locator('.fm-theme-option svg').count(), 3)
  assert.equal(await colorPreview.getByRole('button').count(), 0)
  await page.goto(new URL('/settings', baseUrl).href)
  const appearance = page.getByRole('region', { name: 'Appearance' })
  assert.equal(await appearance.locator('button svg').count(), 3)
  await appearance.getByRole('button', { name: 'Light' }).click()
  await page.waitForFunction(() => document.querySelector('.settings-appearance button[data-theme="light"]:enabled'))
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  assert.equal(await sidebarTheme.isVisible(), false)
  const otherBrowser = await browser.newContext()
  try {
    await otherBrowser.route(/\/(api|auth)\//, routeApi)
    const freshPage = await otherBrowser.newPage()
    await freshPage.goto(settings)
    const freshColorRow = freshPage.locator('#sidebar-navigation-section [data-id="sidebar-color-mode"]')
    await freshColorRow.waitFor()
    assert.equal(await freshPage.locator('html').getAttribute('data-theme'), 'light')
    assert.equal(await freshColorRow.getByRole('checkbox', { name: 'Show Color mode' }).isChecked(), false)
    assert.deepEqual(await navOrder(freshPage), await navOrder(page))
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
  assert.ok((await appearance.getByRole('button', { name: 'Dark' }).boundingBox()).height >= 44)
  await appearance.getByRole('button', { name: 'Dark' }).click()
  await page.waitForFunction(() => document.querySelector('.settings-appearance button[data-theme="dark"]:enabled'))
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
  await page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = page.getByRole('dialog', { name: 'Sidebar settings changed' })
  await conflict.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await page.getByRole('radio', { name: 'Compact' }).isChecked(), true)
  assert.equal(await otherSettings.getByRole('checkbox', { name: 'Show Swatch' }).isChecked(), false)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await conflict.waitFor()
  await otherSettings.getByRole('checkbox', { name: 'Preview plugins on hover' }).uncheck()
  await saveSettings(otherSettings)
  await conflict.getByRole('button', { name: 'Overwrite' }).click()
  await page.getByRole('status').filter({ hasText: 'Sidebar settings changed again' }).waitFor()
  assert.equal(await otherSettings.getByRole('checkbox', { name: 'Show Swatch' }).isChecked(), false)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await conflict.getByRole('button', { name: 'Overwrite' }).click()
  await otherSettings.locator('#sidebar-nav').getByRole('link', { name: 'Swatch' }).waitFor()
  const remember = page.getByRole('checkbox', { name: 'Remember expanded plugins' })
  await remember.check()
  await saveSettings(page)
  const otherHeading = otherSettings.locator('#sidebar-plugin-heading')
  const showDashboard = page.getByRole('checkbox', { name: 'Show Dashboard' })
  await showDashboard.focus()
  await otherHeading.click()
  await page.waitForFunction(() => document.querySelector('#sidebar-plugin-heading').getAttribute('aria-expanded') === 'true')
  assert.ok(await showDashboard.evaluate(input => input === document.activeElement))
  const moonrakerLink = nav.getByRole('link', { name: 'Moonraker' })
  await moonrakerLink.focus()
  await otherHeading.click()
  await moonrakerLink.waitFor({ state: 'hidden' })
  assert.ok(await heading.evaluate(button => button === document.activeElement))
  await page.getByRole('radio', { name: 'Comfortable' }).check()
  await otherHeading.click()
  await saveSettings(page)
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
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
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
  assert.deepEqual(errors, [])
  console.log('Sidebar settings passed from 320px to desktop, including touch and keyboard tabs, reorder, disclosure, and color mode persistence.')
} finally {
  await browser.close()
}
