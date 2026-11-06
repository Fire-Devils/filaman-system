import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const plugins = ['driver', 'integration', 'import'].map((type, index) => ({
  plugin_key: `example_${index}`, name: `Example ${type}`, plugin_type: type,
  version: '2.10.1', author: 'Niko11111', is_active: true, installed_by: 1,
  installed_at: '2026-01-01', page_url: `/plugin-page/example-${index}`,
  description: 'Plugin description with enough detail to wrap across several lines. '.repeat(6),
}))
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path.startsWith('/auth/') || path.startsWith('/api/')) {
    const data = path.endsWith('/me') ? { id: 1, display_name: 'Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] }
      : path.endsWith('/public-info') ? { login_enabled: false }
        : path.endsWith('/version-check') ? { update_available: false }
          : path.endsWith('/print-requests/pending') ? null
            : path.endsWith('/system/plugins') ? plugins
              : path.endsWith('/available') ? [{ plugin_key: 'example_0', version: '3.0.0', update_available: true, download_url: 'https://example.test/plugin.zip' }] : []
    response.setHeader('Content-Type', 'application/json')
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
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/system`, { waitUntil: 'networkidle' })
  await page.locator('#plugins-table tr').first().waitFor()
  await page.locator('#btn-check-updates').click()
  await page.locator('.btn-update').waitFor()
  for (const width of [1440, 1024, 390]) {
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
        brokenWords,
        crushedActions: [...tbody.querySelectorAll('.plugin-actions > *')].filter(el => el.getBoundingClientRect().width < 24).length,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        tableScroll: card.scrollWidth > card.clientWidth,
      }
    })
    assert.deepEqual(layout.brokenWords, [], `${width}px: metadata and action labels remain on one line`)
    assert.equal(layout.crushedActions, 0, `${width}px: row actions retain their width`)
    assert.equal(layout.pageOverflow, false, `${width}px: the page does not overflow`)
    if (width === 390) assert.equal(layout.tableScroll, true, 'phone: the table scrolls within its card')
  }
  console.log('Plugin metadata, update controls and row actions fit desktop, tablet and phone layouts.')
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
