/**
 * Run against a local Astro server; API data stays inside the browser fixture.
 * CHROME_EXECUTABLE_PATH=/path/to/chrome \
 * node scripts/check-editor-workspace.mjs http://127.0.0.1:4321
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(error))
  const logo = await readFile(new URL('../public/logo-qr.png', import.meta.url))
  await page.addInitScript(() => {
    const design = { version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 2, border: false }, elements: [
      { id: 'text', type: 'text', x: 3, y: 3, w: 54, h: 20, z: 0, template: '{filament.name}', fontFamily: 'Space Grotesk', fontSizeMm: 3, fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000', wrap: false, fitToWidth: false, minFontSizeMm: 2 },
      { id: 'logo', type: 'manufacturerLogo', x: 3, y: 27, w: 25, h: 8, z: 1, objectFit: 'contain', collapseWhenEmpty: true },
      { id: 'qr', type: 'qr', x: 41, y: 22, w: 15, h: 15, z: 2, mode: 'simple', linkMode: 'spool', urlTemplate: '' },
    ] }
    for (const entity of ['spool', 'filament']) localStorage.setItem(`filaman-${entity}-label-designer-v1`, JSON.stringify({ version: 2, design }))
    localStorage.setItem('sidebar-collapsed', 'true')
    localStorage.setItem('filaman-label-active-tab', location.search.includes('ids=') ? 'designer' : 'standard')
  })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    const filament = { id: 10, manufacturer_id: 1, manufacturer: { id: 1, name: 'Logo maker' }, designation: 'Ocean Blue PLA', material: 'PLA', color_name: 'Ocean Blue', color_hex: '0088cc', custom_fields: {} }
    let data = []
    if (path.endsWith('/me')) data = { id: 1, email: 'layout@example.test', display_name: 'Layout check', language: 'en', roles: ['user'], permissions: [] }
    if (/\/filaments\/\d+$/.test(path)) data = { ...filament, id: Number(path.split('/').at(-1)) }
    if (/\/spools\/\d+$/.test(path)) data = { id: Number(path.split('/').at(-1)), filament_id: 10, filament, custom_fields: {} }
    if (path.endsWith('/events/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' })
    if (path.endsWith('/label-logo')) return route.fulfill({ contentType: 'image/png', body: logo })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) })
  })
  let cases = 0
  for (const path of ['/spools/101/print', '/filaments/10/print', '/spools/print?ids=101,102', '/filaments/print?ids=10,11']) {
    console.log(`Checking ${path}`)
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(new URL(path, process.argv[2] || 'http://127.0.0.1:4321').href)
    if (!path.includes('?ids=')) {
      await page.locator('#label-preview .label-designation').waitFor({ state: 'attached' })
      await page.locator('#tab-btn-designer').click()
    }
    await page.locator('#freeform-canvas-host [data-label-svg-raster]').first().waitFor().catch(async error => {
      console.error(await page.locator('[data-label-output-error]').evaluateAll(nodes => nodes.map(node => node.dataset.labelOutputError)))
      throw error
    })
    assert.equal(await page.locator('#freeform-canvas-host [data-label-output-error]').count(), 0)
    if (path.includes('?ids=')) {
      const surface = page.locator('#freeform-canvas-host .label-preview').first()
      assert.equal(await page.evaluate(() => typeof window.QRCode), 'undefined')
      await surface.locator('[data-label-element-id="logo"]').waitFor()
      await surface.locator('[data-label-element-id="qr"]').click()
      await page.waitForFunction(() => document.querySelector('#freeform-qr-readability-recommendation')?.textContent.includes('200 DPI:'))
      assert.equal(await page.locator('#freeform-qr-readability-warning').isVisible(), true)
      console.log(`Direct Designer load with cached logo and QR guidance passed: ${path}`)
    }
    await page.locator('#preview-zoom-input').fill('100')
    await page.locator('#preview-zoom-input').press('Tab')
    const surface = page.locator('#freeform-canvas-host .label-preview').first()
    await page.locator('.freeform-canvas-region').click({ position: { x: 8, y: 8 } })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const anchor = await surface.boundingBox()
    for (const editing of [true, false]) {
      if (editing) await surface.locator('[data-label-element-id="text"]').click()
      else await page.locator('.freeform-canvas-region').click({ position: { x: 8, y: 8 } })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.locator('#freeform-element-inspector').isVisible(), editing)
      const current = await surface.boundingBox()
      assert.ok(Math.abs(current.x - anchor.x) <= 1 && Math.abs(current.y - anchor.y) <= 1,
        `${path}: ${editing ? 'showing' : 'hiding'} edit controls moved the label`)
    }
    if (path.includes('?ids=')) {
      const previous = await page.locator('.is-designer-representative').getAttribute('id')
      await page.locator('[data-preview-step="1"]').click()
      await page.waitForFunction(id => document.querySelector('.is-designer-representative')?.id !== id, previous)
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
    if (await page.locator('#freeform-field-dock').getAttribute('data-open') !== 'true') await page.locator('#freeform-field-dock-toggle').click()
    // Shared workspace geometry gets full single/batch coverage on the spool routes.
    const viewports = path.startsWith('/spools')
      ? [[390, 900], [900, 900], [1024, 900], [1280, 900], [1600, 900], [1600, 600], [1600, 1400], [390, 600]]
      : [[390, 900], [1600, 900]]
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      // Media-query listeners must run before deciding whether to toggle the sidebar.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      if (width === 390 && path.includes('?ids=')) assert.equal(await page.locator('[data-shape-menu-trigger] .freeform-tool-label').isVisible(), false, `${path}: Shape collapses with the compact add tools`)
      for (const collapsed of width < 600 ? [true] : width === 1600 && height === 900 ? [true, false, true] : [true, false]) {
        if (await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')) !== collapsed) await page.locator('#sidebar-toggle').click()
        // Wait for the sidebar transition and the resulting container observers.
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => {})))
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        assert.equal(await page.locator('#fm-page').evaluate(node => node.classList.contains('collapsed')), collapsed, 'Sidebar reaches the requested state after responsive changes')
        if (await page.locator('#freeform-designer-workspace').getAttribute('data-editor-editable') === 'true') {
          await page.locator('#freeform-canvas-host [data-label-element-id="text"]').first().click()
          if (await page.locator('#freeform-field-dock').getAttribute('data-open') !== 'true') await page.locator('#freeform-field-dock-toggle').click()
        }
        for (const zoom of [100, 200, 500]) {
          await page.locator('#preview-zoom-input').fill(String(zoom))
          await page.locator('#preview-zoom-input').press('Tab')
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const errors = await page.evaluate(() => {
            const errors = []
            const workspace = document.querySelector('#freeform-designer-workspace')
            const region = document.querySelector('.freeform-canvas-region').getBoundingClientRect()
            const editable = workspace.dataset.editorEditable === 'true'
            const dock = document.querySelector('#freeform-field-dock')
            if (editable && dock.dataset.open === 'true') {
              const clip = dock.querySelector('.freeform-field-dock-clip')
              if (clip.scrollHeight > clip.clientHeight + 1) errors.push('token dock clips content instead of using workspace scroll')
              if (getComputedStyle(dock).maxHeight !== 'none') errors.push('token dock has a height cap')
            }
            const inside = (node, bounds) => {
              const rect = node.getBoundingClientRect()
              if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
                errors.push(`${node.id || node.className} outside workspace (${rect.left.toFixed(1)}–${rect.right.toFixed(1)} vs ${bounds.left.toFixed(1)}–${bounds.right.toFixed(1)})`)
              }
            }
            inside(workspace, { left: 0, right: innerWidth })
            const label = document.querySelector('#freeform-canvas-host').getBoundingClientRect()
            const inspector = document.querySelector('#freeform-element-inspector')
            const sideBySide = inspector.checkVisibility() && !document.querySelector('.freeform-canvas-row').classList.contains('is-geometry-below')
            if (sideBySide) {
              const geometry = inspector.querySelector('.freeform-geometry-grid').getBoundingClientRect()
              if (geometry.width > 171) errors.push(`geometry inputs stretched with guidance (${geometry.width.toFixed(1)}px)`)
            }
            const centered = (left, right) => Math.abs((left + right) / 2 - (region.left + region.right) / 2) <= 1
            // Controls occupy spare space; they must not re-center the label as a group.
            if (label.width <= region.width - 36 && !centered(label.left, label.right)) {
              errors.push(`label off center (${label.left.toFixed(1)}–${label.right.toFixed(1)} vs ${region.left.toFixed(1)}–${region.right.toFixed(1)})`)
            }
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
          assert.deepEqual(errors, [], JSON.stringify({ path, width, height, collapsed, zoom }))
          if (process.env.EDITOR_SCREENSHOT_DIR && path === '/spools/101/print' && zoom === 100 && collapsed && [600, 1400].includes(height)) {
            await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOT_DIR}/editor-${width}x${height}.png` })
          }
        }
      }
    }
    await page.locator('#tab-btn-print').click()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.locator('#btn-print').waitFor()
    assert.ok(await page.locator('.action-buttons .fm-btn').evaluateAll(buttons => buttons.length > 0 && buttons.every(button => {
      const bounds = button.getBoundingClientRect()
      return bounds.width >= 44 && bounds.height >= 44
    })), `${path}: mobile output actions remain touch-sized`)
  }
  console.log(`Editor workspace: ${cases}/${cases} cases passed`)
} finally {
  await browser.close()
}
