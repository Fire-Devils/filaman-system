/** Dummy credentials only. Run against Astro dev or the compiled application. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const credentials = { email: 'login-check@example.invalid', password: 'dummy-login-check-only' }
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  for (const scenario of ['settings-pending', 'no-script', 'settings-failure', 'automatic']) {
    const context = await browser.newContext({ javaScriptEnabled: scenario !== 'no-script' })
    const settings = deferred(), oidc = deferred()
    const writes = [], navigations = [], errors = []
    try {
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (request.isNavigationRequest()) navigations.push(request.url()) })
      await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
      await context.route('**/api/v1/app-settings/public-info', async route => {
        if (scenario === 'settings-failure') return route.abort('failed')
        await settings.promise
        await route.fulfill({ json: { login_disabled: scenario === 'automatic' } }).catch(() => {})
      })
      await context.route('**/api/v1/oidc/public-info', async route => {
        await oidc.promise
        // Successful login can cancel this optional request.
        await route.fulfill({ json: { enabled: false } }).catch(() => {})
      })
      await context.route('**/auth/login', async route => {
        const request = route.request()
        writes.push({ method: request.method(), type: request.headers()['content-type'], body: request.postDataJSON() })
        await route.fulfill({ json: { user_id: 1 } })
      })
      await context.route(url => url.origin === new URL(base).origin && url.pathname === '/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Signed in</p>' }))
      if (scenario !== 'settings-pending') settings.resolve()
      await page.goto(new URL('/login', base).href, { waitUntil: 'domcontentloaded' })
      const initialNavigations = navigations.length
      if (scenario === 'automatic') {
        await page.waitForURL(url => url.pathname === '/')
        assert.deepEqual(writes.map(write => write.body), [{ email: 'auto@login', password: 'disabled' }])
      } else {
        await page.locator('#email').fill(credentials.email)
        await page.locator('#password').fill(credentials.password)
        if (scenario !== 'settings-failure') {
          await page.locator('#password').press('Enter')
          await page.waitForTimeout(100)
          assert.equal(navigations.length, initialNavigations, `${scenario}: Enter must not submit before initialization`)
          assert.equal(new URL(page.url()).search, '', `${scenario}: credentials must never enter the URL`)
          assert.equal(await page.locator('#login-form').getAttribute('method'), 'post')
          assert.equal(await page.locator('#submit-btn').isDisabled(), true)
          assert.deepEqual(writes, [])
        }
        if (scenario !== 'no-script') {
          settings.resolve()
          await page.waitForFunction(() => !document.getElementById('submit-btn').disabled)
          if (scenario === 'settings-failure') await page.locator('#password').press('Enter')
          else await page.locator('#submit-btn').click()
          await page.waitForURL(url => url.pathname === '/')
          assert.deepEqual(writes, [{ method: 'POST', type: 'application/json', body: credentials }])
        }
      }
      assert.ok(navigations.every(value => !new URL(value).searchParams.has('password') && !new URL(value).searchParams.has('email')))
      assert.deepEqual(errors, [])
    } finally {
      settings.resolve(); oidc.resolve()
      await context.close()
    }
  }
  console.log('Login: blocked native submission before initialization, JSON sign-in after slow/failed settings, optional SSO independence and automatic login passed')
} finally {
  await browser.close()
}
