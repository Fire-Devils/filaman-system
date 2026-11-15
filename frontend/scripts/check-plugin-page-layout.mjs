import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const screenshots = process.env.PLUGIN_LAYOUT_SCREENSHOTS
const plugins = ['driver', 'integration', 'import'].map((type, index) => ({
  plugin_key: `example_${index}`, name: `Example ${type}`, plugin_type: type,
  version: '2.10.1', author: 'Niko11111', is_active: true, installed_by: 1,
  installed_at: '2026-01-01', page_url: `/plugin-page/example-${index}`,
  description: index === 0
    ? 'Connects FilaMan to your Klipper printers. Import printer details, track active print jobs and sync filament usage after each print.'
    : index === 1 ? 'Syncs spool usage.' : '',
}))
let zipReplaced = false
const iconUrl = () => `/api/v1/plugin-icons/example_0?v=${plugins[0].version}`
const releases = ['3.0.0', '4.0.0'].map((version, i) => ({
  ...plugins[i], version, is_installed: true, publisher: 'Niko11111', min_filaman_version: '2.0.3',
  is_compatible: true, release_id: `example-release-${i}`, repository_url: 'https://github.com/example/example-plugin',
}))
const installAttempts = []
let failFirstUpdate
const firstUpdate = new Promise(resolve => { failFirstUpdate = resolve })
let finishStatusChange
const statusChange = new Promise(resolve => { finishStatusChange = resolve })
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/api/v1/plugin-icons/example_0') {
    const shape = zipReplaced ? '<path d="M12 4 20 20H4Z"/>' : request.url === '/api/v1/plugin-icons/example_0?v=2.10.1'
      ? '<circle cx="12" cy="12" r="8"/>'
      : '<rect x="4" y="4" width="16" height="16"/>'
    response.setHeader('Content-Type', 'image/svg+xml')
    response.setHeader('Cache-Control', 'private, no-cache')
    return response.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shape}</svg>`)
  }
  if (path.startsWith('/auth/') || path.startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json')
    if (path === '/api/v1/admin/system/plugins/install' && request.method === 'POST') {
      zipReplaced = true
      request.resume()
      response.setHeader('Content-Type', 'application/json')
      return response.end(JSON.stringify({ plugin: plugins[0], message: 'ZIP replaced' }))
    }
    if (path.endsWith('/install-from-registry')) {
      let body = ''
      for await (const chunk of request) body += chunk
      const selection = JSON.parse(body)
      installAttempts.push(selection.plugin_key)
      if (installAttempts.length === 1) {
        await firstUpdate
        response.writeHead(502)
        return response.end(JSON.stringify({ detail: 'Download unavailable. Try again.' }))
      }
      const plugin = plugins.find(p => p.plugin_key === selection.plugin_key)
      plugin.version = selection.version
      return response.end(JSON.stringify({ plugin, message: 'Erfolgreich aktualisiert' }))
    }
    if (request.method === 'PATCH' && path.endsWith('/active')) {
      await statusChange
      plugins[0].is_active = false
      return response.end(JSON.stringify({ plugin: plugins[0] }))
    }
    const data = path.endsWith('/me') ? { id: 1, display_name: 'Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] }
      : path.endsWith('/public-info') ? { login_enabled: false }
        : path.endsWith('/version-check') ? { update_available: false }
          : path.endsWith('/print-requests/pending') ? null
            : path.endsWith('/plugin-nav') ? [{ ...plugins[0], icon_url: iconUrl() }]
            : path.endsWith('/system/plugins') ? plugins
              : path.endsWith('/available') ? releases.map((release, i) => ({
                ...release, installed_version: plugins[i].version, update_available: release.version !== plugins[i].version,
              })) : []
    return response.end(JSON.stringify(data))
  }
  try {
    const upstream = await fetch(new URL(request.url, baseUrl))
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' })
    response.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (error) {
    response.writeHead(502)
    response.end(String(error))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/system`, { waitUntil: 'networkidle' })
  await page.locator('#plugins-table tr').first().waitFor()
  const sidebar = await page.locator('.fm-sidebar').elementHandle()
  const sidebarIcon = page.locator('#plugin-nav .fm-plugin-icon-mask')
  await sidebarIcon.waitFor()
  assert.match(await sidebarIcon.getAttribute('style'), /v=2\.10\.1/)
  await page.locator('#btn-check-updates').click()
  await page.getByRole('button', { name: 'Update to v3.0.0' }).waitFor()
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    const layout = await page.locator('#plugins-table').evaluate(tbody => {
      const brokenWords = []
      for (const row of tbody.rows) {
        for (const cell of [...row.cells].slice(1)) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(walker.currentNode)
            if (range.getClientRects().length > 1) brokenWords.push(walker.currentNode.textContent.trim())
          }
        }
      }
      const card = tbody.closest('.fm-card')
      return {
        tableLayout: getComputedStyle(tbody).display === 'table-row-group',
        overlappingActions: [...tbody.querySelectorAll('.plugin-actions')].some(actions =>
          actions.getBoundingClientRect().left < actions.closest('tr').querySelector('.plugin-state').getBoundingClientRect().right
        ),
        brokenWords,
        crushedActions: [...tbody.querySelectorAll('.plugin-actions > *')].filter(el => el.getBoundingClientRect().width < 24).length,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        tableScroll: card.scrollWidth > card.clientWidth,
      }
    })
    if (layout.tableLayout) assert.deepEqual(layout.brokenWords, [], `${width}px: desktop metadata stays on one line`)
    if (layout.tableLayout) assert.ok(!layout.overlappingActions, `${width}px: desktop actions clear the status column`)
    if (width === 1440) assert.ok(layout.tableLayout, 'wide desktop retains the table')
    if (width === 1440 && screenshots) {
      await page.screenshot({ path: join(screenshots, '08-desktop.png') })
    }
    if (width <= 390) assert.ok(!layout.tableLayout, 'phone stacks plugins into cards')
    assert.equal(layout.crushedActions, 0, `${width}px: row actions retain their width`)
    assert.equal(layout.pageOverflow, false, `${width}px: the page does not overflow`)
    assert.equal(layout.tableScroll, false, `${width}px: every plugin control fits without horizontal scrolling`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const row = page.locator('#plugins-table tr').first()
  const update = row.getByRole('button', { name: 'Update to v3.0.0' })
  const confirm = page.getByRole('dialog', { name: 'Confirm update' })
  const updateAll = page.getByRole('button', { name: 'Update All', exact: true }).and(page.locator('#btn-update-all'))
  const browse = page.getByRole('button', { name: 'Browse Plugins' })
  const browseBox = await browse.boundingBox()
  const updateAllBox = await updateAll.boundingBox()
  assert.equal(browseBox.y, updateAllBox.y, 'phone: Browse Plugins and Update All share a row')
  assert.ok(browseBox.x + browseBox.width <= updateAllBox.x)
  for (const button of [updateAll, update, ...await page.locator('.plugin-toolbar-actions button').all()]) {
    const icon = button.locator('svg[aria-hidden="true"]')
    assert.ok((await icon.boundingBox())?.width >= 16, 'the action icon is visible')
  }
  const caret = row.getByRole('button', { name: 'Description' })
  await caret.waitFor()
  assert.equal(await page.locator('#plugins-table tr').nth(1).getByRole('button', { name: 'Description' }).count(), 0)
  for (const control of [update, caret, row.getByRole('button', { name: 'Details' }), row.getByRole('link', { name: 'Open Example driver' }), row.locator('.fm-toggle')]) {
    const bounds = await control.boundingBox()
    assert.ok(bounds?.width >= 44 && bounds?.height >= 44, 'phone: controls have 44px touch targets')
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'phone: controls are horizontally visible')
  }
  const description = row.locator('.plugin-description')
  const isClipped = () => description.evaluate(el => el.scrollHeight > el.clientHeight)
  assert.ok(await isClipped(), 'phone: long description is clamped')
  assert.equal(await description.evaluate(el => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight))), 2)
  if (screenshots) await page.screenshot({ path: join(screenshots, '03-phone.png') })
  await caret.click()
  assert.equal(await caret.getAttribute('aria-expanded'), 'true')
  assert.equal(await isClipped(), false)
  if (screenshots) await page.screenshot({ path: join(screenshots, '04-expanded.png') })
  await caret.click()
  assert.ok(await isClipped())
  await page.getByRole('button', { name: 'Browse Plugins' }).click()
  const catalog = page.getByRole('dialog', { name: 'Browse Plugins' })
  const catalogUpdate = catalog.getByRole('button', { name: 'Update to v3.0.0' })
  const catalogAll = catalog.locator('header').getByRole('button', { name: 'Update All' })
  const catalogClose = catalog.locator('header').getByRole('button', { name: 'Close' })
  const batchConfirm = page.getByRole('dialog', { name: 'Update All' })
  await catalogUpdate.waitFor()
  assert.ok((await catalogUpdate.boundingBox())?.height >= 44)
  assert.notEqual(await catalog.getByRole('searchbox').evaluate(el => document.activeElement === el), true)
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    const allBounds = await catalogAll.boundingBox()
    const closeBounds = await catalogClose.boundingBox()
    assert.ok(allBounds && closeBounds && allBounds.y === closeBounds.y, `${width}px: Update All and Close share the title bar`)
    assert.ok(allBounds.x + allBounds.width <= closeBounds.x && closeBounds.x + closeBounds.width <= width)
    const iconBounds = await catalogAll.locator('svg').boundingBox()
    const labelBounds = await catalogAll.locator('span').boundingBox()
    assert.ok(iconBounds && labelBounds && iconBounds.x + iconBounds.width <= labelBounds.x,
      `${width}px: the catalog Update All icon sits beside its label`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  if (screenshots) await page.screenshot({ path: join(screenshots, '07-catalog.png') })
  await catalogAll.click()
  await batchConfirm.getByText(/Example driver v3\.0\.0.*Example integration v4\.0\.0/s).waitFor()
  await batchConfirm.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(installAttempts.length, 0)
  assert.equal(await catalogAll.evaluate(el => document.activeElement === el), true)
  await catalogUpdate.click()
  await confirm.getByText('Update Example driver to v3.0.0 from Niko11111?').waitFor()
  assert.equal(installAttempts.length, 0)
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await catalogUpdate.evaluate(el => document.activeElement === el), true)
  await catalog.getByRole('button', { name: 'Close' }).click()
  await update.click()
  await confirm.getByText('Update Example driver to v3.0.0 from Niko11111?').waitFor()
  if (screenshots) await page.screenshot({ path: join(screenshots, '05-confirm.png') })
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(installAttempts.length, 0)
  assert.equal(await update.evaluate(el => document.activeElement === el), true)
  await update.click()
  await confirm.getByRole('button', { name: 'Update to v3.0.0' }).click()
  const pending = row.getByRole('button', { name: 'Updating...' })
  await pending.waitFor()
  assert.ok(await pending.isDisabled())
  const secondRow = page.locator('#plugins-table tr').nth(1)
  const secondUpdate = secondRow.getByRole('button', { name: 'Update to v4.0.0' })
  assert.ok(await secondUpdate.isDisabled())
  failFirstUpdate()
  await row.getByRole('alert').getByText('Download unavailable. Try again.').waitFor()
  if (screenshots) await page.screenshot({ path: join(screenshots, '06-update-error.png') })
  await updateAll.click()
  await batchConfirm.getByText(/Example driver v3\.0\.0.*Example integration v4\.0\.0/s).waitFor()
  assert.deepEqual(installAttempts, ['example_0'])
  if (screenshots) await page.screenshot({ path: join(screenshots, '09-update-all-confirm.png') })
  await batchConfirm.getByRole('button', { name: 'Update All' }).click()
  await row.getByRole('status').getByText('Success · v3.0.0').waitFor()
  await row.locator('.plugin-version').getByText('3.0.0', { exact: true }).waitFor()
  await secondRow.locator('.plugin-version').getByText('4.0.0', { exact: true }).waitFor()
  assert.equal(await update.count(), 0)
  assert.equal(await updateAll.count(), 0)
  assert.equal((await browse.boundingBox()).width, (await page.locator('.plugin-toolbar-actions').boundingBox()).width)
  assert.deepEqual(installAttempts, ['example_0', 'example_0', 'example_1'])
  await row.locator('.fm-toggle').click()
  const spinner = row.locator('.toggle-spinner')
  await spinner.waitFor({ state: 'visible' })
  const spinnerBounds = await spinner.boundingBox()
  assert.ok(spinnerBounds.width >= 16 && spinnerBounds.height >= 16)
  finishStatusChange()
  await row.getByText('Inactive', { exact: true }).waitFor()
  await spinner.waitFor({ state: 'hidden' })

  await page.locator('#plugin-nav .fm-plugin-icon-mask[style*="v=3.0.0"]').waitFor({ state: 'attached' })
  const registryMask = await sidebarIcon.getAttribute('style')
  const observerPage = await page.context().newPage()
  await observerPage.goto(page.url(), { waitUntil: 'networkidle' })
  const observerIcon = observerPage.locator('#plugin-nav .fm-plugin-icon-mask')
  await observerIcon.waitFor()
  const observerMask = await observerIcon.getAttribute('style')
  await page.locator('#btn-install').click()
  await page.locator('#file-input').setInputFiles({
    name: 'replacement.zip', mimeType: 'application/zip', buffer: Buffer.from('mock plugin ZIP'),
  })
  await page.locator('#install-submit').click()
  await page.locator('#validation-details').getByText('ZIP replaced').waitFor()
  await page.locator('#install-cancel').click()
  await page.waitForFunction(previous => {
    const mask = document.querySelector('#plugin-nav .fm-plugin-icon-mask')
    return mask && mask.getAttribute('style') !== previous
  }, registryMask)
  assert.equal(await sidebarIcon.count(), 1)
  assert.equal(await sidebar.evaluate(element => element.isConnected), true)
  await observerPage.waitForFunction(previous => {
    const mask = document.querySelector('#plugin-nav .fm-plugin-icon-mask')
    return mask && mask.getAttribute('style') !== previous
  }, observerMask, { timeout: 10000 })
  assert.equal(await observerIcon.count(), 1)
  assert.equal(await observerIcon.getAttribute('style'), await sidebarIcon.getAttribute('style'))
  await observerPage.close()
  console.log('The sidebar loads the new icon after a registry upgrade and a same-version ZIP replacement, including another open tab.')

  const longVersion = '123456789.123456789.123456789'
  plugins[1].version = longVersion
  plugins[1].author = 'A long plugin author name with many words that is valid metadata for the Plugins page'
  releases[0].version = longVersion
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('#btn-check-updates').click()
  await page.getByRole('button', { name: `Update to v${longVersion}` }).waitFor()

  for (const width of [320, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    const fits = await secondRow.evaluate(el => {
      const cell = selector => el.querySelector(selector).getBoundingClientRect()
      const list = el.closest('.plugin-list')
      return list.scrollWidth <= list.clientWidth
        && cell('.plugin-version').right <= cell('.plugin-type').left
        && cell('.plugin-type span').right <= cell('.plugin-status').left
    })
    assert.ok(fits, `${width}px: long versions, author names and update labels fit`)
  }
  console.log('Plugin layouts fit 320–1440px. Phone button icons, confirmation, cancel, retry, Update All, and catalog passed.')
} finally {
  finishStatusChange()
  failFirstUpdate()
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
