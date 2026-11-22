import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
const stalledRoutes = []
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let theme = 'dark'
  let authGate
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    window.themePaints = []
    function sample() {
      let visible = Boolean(document.body)
      for (let frame = window; frame !== frame.parent; frame = frame.parent) {
        if (frame.parent.getComputedStyle(frame.frameElement).visibility === 'hidden') visible = false
      }
      if (visible && window.themePaints.length < 200) window.themePaints.push(document.documentElement.dataset.theme)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.route(/\/(api|auth)\//, async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
    if (path.endsWith('/me')) {
      if (authGate) await authGate.promise
      return route.fulfill({
        headers: { 'X-Filaman-Theme': theme },
        json: { id: 1, email: 'theme@example.test', language: 'en', is_superadmin: true, permissions: [], roles: [] },
      })
    }
    if (path.endsWith('/me/preferences/sidebar')) {
      if (route.request().method() === 'PATCH') theme = route.request().postDataJSON().theme ?? theme
      return route.fulfill({ json: { sidebar: null, theme, expanded: false } })
    }
    if (path.endsWith('/filaments')) return route.fulfill({ json: { items: [], total: 0 } })
    return route.fulfill({ json: [] })
  })
  await page.route('**/theme-paint-blocker', async route => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await route.fulfill({ status: 204 })
  })
  // Old FilaBrain restores the retired key asynchronously and embeds the native picker.
  await page.route('**/plugin-page/old-filabrain', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><html data-theme="brand"><head><title>Old FilaBrain</title>
    <style>
      :root { --bg-elevated: #13261d }
      :root[data-theme=dark] { --bg-elevated: #141825 }
      :root[data-theme=light] { --bg-elevated: #fff }
      body { background: var(--bg-elevated) }
    </style></head><body><input id="draft" value="Keep draft"><img hidden src="/theme-paint-blocker">
    <iframe title="Filament picker" src="/filament-picker/" style="width:100%;height:600px;border:0"></iframe>
    <script>setTimeout(() => { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'brand' }, 250)</script>
    </body></html>` }))

  await page.goto(new URL('/settings', base).href)
  await page.locator('.settings-appearance button[data-theme="dark"]:enabled').waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('theme')), null)
  assert.equal(await page.evaluate(() => localStorage.getItem('filaman-theme-cache')), 'dark')
  authGate = Promise.withResolvers()
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/me')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await requested
  await page.waitForFunction(() => window.themePaints.length > 2)
  assert.deepEqual(await page.evaluate(() => [...new Set(window.themePaints)]), ['dark'], 'Reload paints the cached account theme while authentication is pending')
  authGate.resolve()
  authGate = undefined
  await page.locator('.settings-appearance button[data-theme="dark"]:enabled').waitFor()

  await page.goto(new URL('/plugin-view?p=old-filabrain', base).href)
  const plugin = page.frameLocator('#plugin-frame')
  const picker = plugin.frameLocator('iframe')
  await picker.locator('#fm-page').waitFor()
  await plugin.locator('html[data-theme="dark"]').waitFor()
  for (const selected of ['dark', 'light', 'brand', 'dark']) {
    if (selected !== 'dark' || theme !== 'dark') await page.locator(`.fm-sidebar button[data-theme="${selected}"]`).click()
    await page.waitForFunction(selected => document.querySelector(`.fm-sidebar button[data-theme="${selected}"]`)?.getAttribute('aria-disabled') !== 'true', selected)
    await plugin.locator(`html[data-theme="${selected}"]`).waitFor()
    await picker.locator(`html[data-theme="${selected}"]`).waitFor()
    const background = await picker.locator('#fm-page').evaluate(el => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).backgroundColor }))
    assert.equal(background.image, 'none', 'Embedded pickers never render the full-page gradient')
    assert.equal(background.color, await plugin.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'Picker matches the old plugin panel in every theme')
    assert.equal(await plugin.locator('#draft').inputValue(), 'Keep draft')
  }
  await plugin.locator('html').evaluate(root => { root.dataset.theme = 'brand' })
  await picker.locator('html[data-theme="dark"]').waitFor()
  await plugin.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(await plugin.locator('html').evaluate(() => [...new Set(window.themePaints.slice(0, 2))]), ['dark'], 'Old plugins first become visible with the selected theme')
  const oldFrame = page.frames().find(frame => frame.url().includes('/plugin-page/old-filabrain'))
  assert.ok(oldFrame)
  await Promise.all([oldFrame.waitForNavigation({ waitUntil: 'load' }), oldFrame.evaluate(() => location.reload())])
  await oldFrame.waitForFunction(() => window.themePaints.length > 2)
  assert.deepEqual(await oldFrame.evaluate(() => [...new Set(window.themePaints)]), ['dark'], 'In-frame reloads also conceal the initial default theme')

  // These requests never finish while the plugin is being checked.
  await page.route('**/theme-stalled-resource*', route => { stalledRoutes.push(route) })
  await page.route('**/plugin-page/stalled-theme-fixture*', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><html data-theme="brand"><body>
    <input aria-label="Plugin draft"><button onclick="document.querySelector('output').textContent = document.querySelector('input').value">Apply draft</button><output></output>
    <a href="/plugin-page/stalled-theme-fixture?next=1">Next plugin page</a>
    <a href="/filaments">Open FilaMan filaments</a>
    <img src="/theme-stalled-resource${new URL(route.request().url()).search}">
    <script>window.pluginLoaded = false; addEventListener('load', () => { window.pluginLoaded = true })</script>
    </body></html>` }))
  await page.goto(new URL('/plugin-view?p=stalled-theme-fixture', base).href, { waitUntil: 'domcontentloaded' })
  async function checkStalledPlugin() {
    await plugin.getByRole('button', { name: 'Apply draft' }).waitFor({ state: 'attached' })
    await page.locator('#plugin-frame').waitFor({ state: 'visible', timeout: 2000 })
    await plugin.locator('html[data-theme="dark"]').waitFor()
    assert.equal(await plugin.locator('html').evaluate(() => window.pluginLoaded), false, 'Plugin remains usable before the full load event')
    await plugin.getByRole('textbox', { name: 'Plugin draft' }).fill('Usable while an image is stalled')
    await plugin.getByRole('button', { name: 'Apply draft' }).click()
    assert.equal(await plugin.locator('output').textContent(), 'Usable while an image is stalled')
    await plugin.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await plugin.locator('html').evaluate(() => [...new Set(window.themePaints)]), ['dark'], 'Early reveal never exposes the default theme')
  }
  await checkStalledPlugin()
  assert.equal(stalledRoutes.length, 1)
  await plugin.locator('html').evaluate(() => window.stop())
  assert.equal(await page.locator('#plugin-frame').isVisible(), true, 'Stopping subresource loading does not hide the plugin')
  await plugin.getByRole('link', { name: 'Next plugin page' }).click({ noWaitAfter: true })
  await page.waitForFunction(() => document.querySelector('#plugin-frame')?.contentWindow.location.search === '?next=1')
  await checkStalledPlugin()
  assert.equal(stalledRoutes.length, 2)
  assert.equal(await plugin.locator('html').evaluate(() => window.pluginLoaded), false)
  await plugin.getByRole('link', { name: 'Open FilaMan filaments' }).click({ noWaitAfter: true })
  await page.waitForURL(new URL('/filaments', base).href)
  assert.equal(new URL(page.url()).pathname, '/filaments', 'A usable plugin routes native links out of the iframe before full load')
  assert.deepEqual(errors, [])
  console.log('Theme paint: cached reload, legacy nested picker, all themes, draft preservation, and usable themed plugins with permanently stalled resources passed.')
} finally {
  await Promise.all(stalledRoutes.map(route => route.abort().catch(() => {})))
  await browser.close()
}
