/** Verify that an authenticated icon preload and CSS mask share one request. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { ModuleKind, transpileModule } from 'typescript'

const source = await readFile(new URL('../src/lib/plugin-icon.ts', import.meta.url), 'utf8')
const script = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
const sprite = await readFile(new URL('../public/icons.svg', import.meta.url))
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>'
let requests = []
let failInitialLoad = false

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/api/v1/plugin-icons/example') {
    requests.push({ mode: request.headers['sec-fetch-mode'], cookie: request.headers.cookie })
    response.setHeader('Cache-Control', 'private, no-cache')
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.headers.cookie !== 'session_id=icon-probe') {
      response.writeHead(401)
      return response.end()
    }
    // A second fetch must not erase a successful preload's puzzle fallback.
    if (failInitialLoad || requests.length > 1) {
      response.writeHead(503)
      return response.end()
    }
    response.setHeader('Content-Type', 'image/svg+xml')
    return response.end(svg)
  }
  if (path === '/icon.js') {
    response.setHeader('Content-Type', 'text/javascript')
    return response.end(script)
  }
  if (path === '/icons.svg') {
    response.setHeader('Content-Type', 'image/svg+xml')
    return response.end(sprite)
  }
  response.setHeader('Content-Type', 'text/html')
  response.end(`<!doctype html><meta charset="utf-8"><style>
    .fm-plugin-icon, .fm-plugin-icon svg { display:block; width:22px; height:22px; }
    .fm-plugin-icon-mask { display:block; width:100%; height:100%; background:currentColor; mask:no-repeat center/contain; }
  </style><script type="module">
    import { createPluginIcon } from '/icon.js';
    document.cookie = 'session_id=icon-probe; Path=/';
    document.body.append(createPluginIcon('/api/v1/plugin-icons/example?v=1.0.0'));
  </script>`)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
  for (const fail of [false, true]) {
    requests = []
    failInitialLoad = fail
    const page = await browser.newPage()
    try {
      await page.goto(origin, { waitUntil: 'networkidle' })
      assert.equal(requests.length, 1, 'preload and mask must share one authenticated request')
      assert.equal(requests[0].mode, 'cors')
      assert.equal(requests[0].cookie, 'session_id=icon-probe')
      assert.equal(await page.locator('.fm-plugin-icon-mask').count(), fail ? 0 : 1)
      assert.equal(await page.locator('.fm-plugin-icon svg').count(), fail ? 1 : 0)
      if (fail) assert.equal(await page.locator('use').getAttribute('href'), '/icons.svg?v=2#icon-plugin')
    } finally {
      await page.close()
    }
  }
  console.log('Plugin preload/mask share one authenticated request; failed loads retain the puzzle fallback.')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
