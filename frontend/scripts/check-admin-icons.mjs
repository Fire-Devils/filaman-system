/** Exercise an upgrade with the previous sprite still in Chrome's HTTP cache. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
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
        : path.endsWith('/version-check') ? { installed_version: '2.0.1', latest_version: '2.0.1', update_available: false, latest_plugins: [] }
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
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
