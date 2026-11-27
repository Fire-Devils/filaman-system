/** Check a cached-sprite upgrade and the mobile Admin, SQLite backup, and FilaMan-DB layouts. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const backupName = 'filaman_20261127_195341_30e73a705f7d49f796af0038d6620e47.db'
const sprite = await readFile(new URL('../public/icons.svg', import.meta.url), 'utf8')
// v2.0.0 has the old navigation symbols, but lacks these five Admin symbols.
const legacySprite = sprite.replace(/<symbol id="icon-(?:users|device|fields|database|lock)"[\s\S]*?<\/symbol>/g, '')
let upgraded = false
let spriteRequests = 0
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/icons.svg') {
    spriteRequests++
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': upgraded ? 'no-cache' : 'public, max-age=31536000, immutable' })
    return response.end(upgraded ? sprite : legacySprite)
  }
  if (path === '/prime') {
    response.setHeader('Content-Type', 'text/html')
    return response.end('<svg width="22" height="22"><use href="/icons.svg#icon-admin" /></svg>')
  }
  if (path.startsWith('/auth/') || path.startsWith('/api/')) {
    response.setHeader('Content-Type', 'application/json')
    const json = path.endsWith('/me') ? { id: 1, email: 'preview@example.test', display_name: 'Hotfix Preview', is_superadmin: true, permissions: [], roles: [], language: 'en' }
      : path.endsWith('/public-info') ? { login_enabled: false }
        : path.endsWith('/version-check') ? {
          installed_version: '2.0.1', latest_version: '2.0.1', update_available: false, latest_plugins: [],
          firmware_updates: ['2.7.1', '2.8.1'].map(latest_version => ({ latest_version, update_available: true })),
        }
        : path.endsWith('/filamentdb/status') ? { active: true }
        : path.endsWith('/sqlite-list') ? { is_sqlite: true, backups: [{ filename: backupName, size_bytes: 2097152, created_at: '2026-11-27T19:53:41Z' }] }
        : path.endsWith('/print-requests/pending') ? null : []
    return response.end(JSON.stringify(json))
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
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  // Do not intercept requests with Playwright: interception disables the HTTP cache.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${origin}/prime`)
  await page.waitForFunction(() => document.querySelector('use').getBBox().width > 0)
  assert.equal(spriteRequests, 1, 'warm the original immutable sprite URL')
  upgraded = true
  await page.goto(`${origin}/admin`, { waitUntil: 'networkidle' })
  await page.locator('.admin-navigation h2 svg').first().waitFor({ state: 'attached' })
  const icons = await page.locator('.admin-navigation h2 svg').evaluateAll(nodes => nodes.map(svg => {
    const glyph = svg.querySelector('use').getBBox()
    const box = svg.getBoundingClientRect()
    return { href: svg.querySelector('use').getAttribute('href'), width: box.width, height: box.height, glyphWidth: glyph.width, glyphHeight: glyph.height }
  }))
  console.log(JSON.stringify({ spriteRequests, icons }, null, 2))
  assert.equal(icons.length, 8, 'all Admin navigation cards are covered')
  for (const icon of icons) {
    assert.ok(icon.glyphWidth > 0 && icon.glyphHeight > 0, `${icon.href}: glyph survives an upgrade from a cached old sprite`)
    assert.equal(icon.width, 22, `${icon.href}: icon retains its intended width`)
    assert.equal(icon.height, 22, `${icon.href}: icon retains its intended height`)
  }
  assert.ok(spriteRequests > 1, 'upgrade fetches the current sprite despite the old immutable cache entry')
  if (process.env.SCREENSHOT_PATH) await page.locator('.admin-navigation').screenshot({ path: process.env.SCREENSHOT_PATH })
  console.log('Admin icons survive a cached-sprite upgrade.')

  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto(`${origin}/admin/backup`)
  const backup = page.locator('#sqlite-backups-tbody tr').filter({ hasText: backupName })
  const filename = await backup.getByText(backupName).boundingBox()
  const date = await backup.locator('td').nth(1).boundingBox()
  assert.ok(filename && date && filename.y + filename.height <= date.y, 'Phone layout gives long filenames a separate line above the date')
  assert.ok(await page.locator('#sqlite-backups-table-wrap').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'SQLite backups fit without horizontal scrolling')
  const confirm = page.getByRole('dialog')
  for (const name of ['Restore', 'Delete']) {
    await backup.getByRole('button', { name }).click()
    await confirm.getByText(backupName, { exact: false }).waitFor()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
  }

  for (const path of ['/admin', '/filamentdb/']) {
    await page.goto(`${origin}${path}`)
    await page.locator('main .fm-help-btn').waitFor()
    if (path === '/admin') await page.locator('#firmware-update-text').filter({ hasText: '2.8.1' }).waitFor()
    else await page.locator('[data-state-item="plugin"][data-ok="true"]').waitFor()
    const widths = await page.locator('main').evaluate(main => ({
      panelOverflow: main.scrollWidth - main.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    assert.ok(Math.max(widths.panelOverflow, widths.documentOverflow) <= 1, `${path} fits at 320px (${JSON.stringify(widths)})`)
  }
  await page.getByRole('link', { name: 'Connect now' }).click()
  await page.waitForURL(url => url.hash === '#setup')
  await page.locator('.fdbp-faq summary').first().click()
  assert.notEqual(await page.locator('.fdbp-faq').first().getAttribute('open'), null)
  console.log('Admin, SQLite Backups, and FilaMan-DB fit at phone width.')
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
