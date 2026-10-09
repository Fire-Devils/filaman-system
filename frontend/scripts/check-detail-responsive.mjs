/**
 * Check detail and edit layouts against the running local preview.
 * TEST_EMAIL=... TEST_PASSWORD=... CHROME_EXECUTABLE_PATH=... \
 *   node scripts/check-detail-responsive.mjs http://127.0.0.1:8088
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4321'
const email = process.env.TEST_EMAIL
const password = process.env.TEST_PASSWORD
if (!email || !password) throw new Error('Set TEST_EMAIL and TEST_PASSWORD for the local preview')

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } })
  await page.addInitScript(() => {
    localStorage.setItem('sidebar-collapsed', 'false')
    localStorage.setItem('changelog-seen-version', '1.2.20')
  })
  await page.goto(new URL('/login', baseUrl).href)
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'))

  async function inspect(path, gridSelector) {
    await page.goto(new URL(path, baseUrl).href)
    await page.locator(`${gridSelector} > .filament-spec-card`).first().waitFor()
    return page.evaluate(selector => {
      const grid = document.querySelector(selector)
      const main = document.querySelector('main')
      const cards = [...grid.children].filter(child => child.classList.contains('filament-spec-card'))
      const first = cards[0].getBoundingClientRect()
      const second = cards[1].getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      return {
        collapsed: document.documentElement.classList.contains('sidebar-collapsed'),
        savedSidebarState: localStorage.getItem('sidebar-collapsed'),
        stacked: second.top > first.top + 1,
        fits: grid.getBoundingClientRect().right <= mainRect.right - 30 &&
          [...cards].every(card => card.getBoundingClientRect().right <= mainRect.right - 30),
      }
    }, gridSelector)
  }

  for (const [path, gridSelector, editing] of [
    ['/filaments/10?edit=1', '.filament-form-sections', true],
    ['/spools/16?edit=1', '#spool-inline-form > .filament-spec-grid', true],
    ['/filaments/10', '#filament-content .filament-spec-grid', false],
    ['/spools/16', '#spool-inline-form > .filament-spec-grid', false],
  ]) {
    const result = await inspect(path, gridSelector)
    assert.equal(result.collapsed, editing, `${path}: editor should borrow sidebar space without changing view preference`)
    assert.equal(result.savedSidebarState, 'false', `${path}: temporary collapse must not change saved preference`)
    assert.equal(result.stacked, true, `${path}: cards should stack when content is narrow`)
    assert.equal(result.fits, true, `${path}: cards should fit inside the main content area`)
  }

  await page.locator('#btn-edit-spool').click()
  assert.equal(await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')), true, 'inline spool edit should collapse sidebar')
  assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', 'inline edit should not save the temporary collapse')
  await page.locator('#btn-cancel-edit').click()
  assert.equal(await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')), false, 'canceling inline edit should restore sidebar')
  assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-collapsed')), 'false', 'canceling inline edit should preserve the sidebar preference')

  await page.setViewportSize({ width: 1440, height: 900 })
  for (const [path, gridSelector] of [
    ['/filaments/10?edit=1', '.filament-form-sections'],
    ['/spools/16?edit=1', '#spool-inline-form > .filament-spec-grid'],
    ['/filaments/10', '#filament-content .filament-spec-grid'],
    ['/spools/16', '#spool-inline-form > .filament-spec-grid'],
  ]) {
    const result = await inspect(path, gridSelector)
    assert.equal(result.stacked, false, `${path}: cards should use available desktop width`)
    assert.equal(result.fits, true, `${path}: cards should not overflow at desktop width`)
  }
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [path, gridSelector] of [
      ['/filaments/10?edit=1', '.filament-form-sections'],
      ['/spools/16?edit=1', '#spool-inline-form > .filament-spec-grid'],
      ['/filaments/10', '#filament-content .filament-spec-grid'],
      ['/spools/16', '#spool-inline-form > .filament-spec-grid'],
    ]) {
      const result = await inspect(path, gridSelector)
      assert.equal(result.stacked, true, `${path}: cards should stack at ${width}px`)
      assert.equal(result.fits, true, `${path}: cards should fit at ${width}px`)
    }
  }
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto(new URL('/filaments/10?edit=1', baseUrl).href)
  await page.locator('#sidebar-toggle').click()
  assert.equal(await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')), false, 'manual expansion should remain available in full edit')
  console.log('Detail and edit layouts fit at 1440px, 1024px, 768px, and 390px for filaments and spools')
} finally {
  await browser.close()
}
