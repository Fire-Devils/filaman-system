/**
 * Run against a local Astro server; API data stays inside the browser fixture.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core CHROME_EXECUTABLE_PATH=/path/to/chrome \
 * node scripts/check-editor-workspace.mjs http://127.0.0.1:4321
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const design = { version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 2, border: false }, elements: [
      { id: 'text', type: 'text', x: 3, y: 3, w: 54, h: 20, z: 0, template: '{filament.name}', fontFamily: 'Space Grotesk', fontSizeMm: 3, fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000', wrap: false, fitToWidth: false, minFontSizeMm: 2 },
    ] }
    for (const entity of ['spool', 'filament']) localStorage.setItem(`filaman-${entity}-label-designer-v1`, JSON.stringify({ version: 2, design }))
    localStorage.setItem('sidebar-collapsed', 'true')
  })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const filament = { id: 10, designation: 'Ocean Blue PLA', material: 'PLA', color_name: 'Ocean Blue', color_hex: '0088cc', custom_fields: {} }
    let data = []
    if (path.endsWith('/me')) data = { id: 1, email: 'layout@example.test', display_name: 'Layout check', language: 'en', roles: ['user'], permissions: [] }
    if (/\/filaments\/\d+$/.test(path)) data = { ...filament, id: Number(path.split('/').at(-1)) }
    if (/\/spools\/\d+$/.test(path)) data = { id: Number(path.split('/').at(-1)), filament_id: 10, filament, custom_fields: {} }
    if (path.endsWith('/events/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })
  let cases = 0
  for (const path of ['/spools/101/print', '/filaments/10/print', '/spools/print?ids=101,102', '/filaments/print?ids=10,11']) {
    console.log(`Checking ${path}`)
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(new URL(path, process.argv[2] || 'http://127.0.0.1:4321').href)
    await page.locator('#tab-btn-designer').click()
    await page.locator('#preview-zoom-input').fill('100')
    await page.locator('#preview-zoom-input').press('Tab')
    if (path.includes('?ids=')) {
      await page.locator('[data-preview-step="1"]').click()
      const representative = await page.locator('.is-designer-representative').getAttribute('id')
      for (let pass = 0; pass < 2; pass++) {
        await page.locator('#tab-btn-sheets').click()
        await page.locator('.label-sheet-page').first().waitFor()
        await page.locator('#tab-btn-designer').click()
        await page.waitForFunction(id => document.querySelector('#freeform-canvas-host .label-wrapper')?.id === id, representative)
        await page.locator('#freeform-canvas-host [data-label-element-id="text"]').first().click()
        await page.locator('#freeform-json-expand').click()
        const json = page.locator('#freeform-element-json')
        const element = JSON.parse(await json.inputValue())
        element.x = 4 + pass
        await json.fill(JSON.stringify(element))
        await page.locator('#freeform-json-apply').click()
        await page.locator('#freeform-json-section [popovertarget="freeform-json-section"]').click()
        await page.waitForFunction(({ id, x }) => document.querySelector(`#${id} [data-label-element-id="text"]`)?.style.left === `${x}mm`, { id: representative, x: element.x })
      }
      console.log(`Sheet round trip and visible-label JSON edit passed: ${path}`)
    }
    await page.locator('#freeform-canvas-host [data-label-element-id="text"]').first().click()
    await page.locator('#freeform-field-dock-toggle').click()
    for (const width of [390, 900, 1024, 1280, 1600]) {
      await page.setViewportSize({ width, height: 900 })
      for (const collapsed of width <= 768 ? [true] : [true, false, true]) {
        if (await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')) !== collapsed) await page.locator('#sidebar-toggle').click()
        // Wait for the sidebar transition and the resulting container observers.
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => {})))
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        for (const zoom of [100, 200, 500]) {
          await page.locator('#preview-zoom-input').fill(String(zoom))
          await page.locator('#preview-zoom-input').press('Tab')
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const errors = await page.evaluate(() => {
            const errors = []
            const workspace = document.querySelector('#freeform-designer-workspace')
            const region = document.querySelector('.freeform-canvas-region').getBoundingClientRect()
            const editable = workspace.dataset.editorEditable === 'true'
            const inside = (node, bounds) => {
              const rect = node.getBoundingClientRect()
              if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) errors.push(`${node.id || node.className} outside workspace`)
            }
            inside(workspace, { left: 0, right: innerWidth })
            const label = document.querySelector('#freeform-canvas-host').getBoundingClientRect()
            const inspector = document.querySelector('#freeform-element-inspector')
            const sideBySide = inspector.checkVisibility() && !document.querySelector('.freeform-canvas-row').classList.contains('is-geometry-below')
            const groupRight = sideBySide ? inspector.getBoundingClientRect().right : label.right
            const centered = (left, right) => Math.abs((left + right) / 2 - (region.left + region.right) / 2) <= 1
            if (groupRight - label.left <= region.width - 36 && !centered(label.left, groupRight)) errors.push('label and inspector group off center')
            if (label.left < region.left - 1) errors.push('label left edge unreachable')
            for (const selector of ['.freeform-text-toolbar', '#freeform-field-dock', '#freeform-element-inspector']) {
              const node = document.querySelector(selector)
              if (!editable && node.checkVisibility()) errors.push(`${selector} visible in preview-only mode`)
              if (editable && node.checkVisibility()) {
                inside(node, region)
                const rect = node.getBoundingClientRect()
                if (selector !== '#freeform-element-inspector' && !centered(rect.left, rect.right)) errors.push(`${selector} off center`)
              }
            }
            for (const node of workspace.querySelectorAll('.freeform-command-bar button, .freeform-command-bar input')) if (node.checkVisibility()) inside(node, workspace.getBoundingClientRect())
            return errors
          })
          cases++
          assert.deepEqual(errors, [], JSON.stringify({ path, width, collapsed, zoom }))
        }
      }
    }
  }
  console.log(`Editor workspace: ${cases}/${cases} cases passed`)
} finally {
  await browser.close()
}
