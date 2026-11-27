/** Seeded UI regression; intercepts all inventory requests and never changes real data. */
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright-core'
import { PNG } from 'pngjs'

const base = process.argv[2] || 'http://127.0.0.1:4321'
const browser = process.env.BROWSER_ENGINE === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  for (const width of (process.env.BROWSER_ENGINE === 'webkit' ? [390] : [1440, 1024, 850, 780, 390])) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 700 : 1000 }, hasTouch: width === 390, isMobile: width === 390 })
    page.setDefaultTimeout(10000)
    const errors = [], writes = []
    let rejectCombine = false
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('lang', 'en'))
    let colors = Array.from({ length: 75 }, (_, i) => ({
      id: i + 1, name: `Library color ${String(i + 1).padStart(2, '0')}`, hex_code: i < 3 ? '#ABCDEF' : `#${(i * 7319).toString(16).padStart(6, '0')}`,
      usage_count: i === 0 ? 2 : 0, token: String(i + 1).padStart(64, '0'),
    }))
    await page.route(/\/(?:api\/|auth\/me$)/, async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      if (path.endsWith('/events/stream')) return route.fulfill({ status: 204 })
      if (request.method() !== 'GET') {
        if (path.endsWith('/me/label-presets/migrate') || path.includes('/me/preferences/')) return route.fulfill({ json: {} })
        const body = request.postDataJSON(); writes.push({ path, body })
        if (path.endsWith('/colors/combine')) {
          if (rejectCombine) return route.fulfill({ status: 409, json: { detail: { code: 'color_review_changed', message: 'Colors changed. Refresh and review again.' } } })
          const sourceIds = body.records.map(record => record.id).filter(id => id !== body.survivor_id)
          colors = colors.filter(color => !sourceIds.includes(color.id)).map(color => color.id === body.survivor_id ? { ...color, name: body.name, hex_code: body.hex_code, usage_count: 2 } : color)
          return route.fulfill({ json: { changed: sourceIds.length } })
        }
        if (path.endsWith('/colors/bulk-delete')) {
          const ids = body.records.map(record => record.id)
          assert.ok(colors.filter(color => ids.includes(color.id)).every(color => color.usage_count === 0))
          colors = colors.filter(color => !ids.includes(color.id))
          return route.fulfill({ json: { changed: ids.length } })
        }
        return route.fulfill({ json: body })
      }
      let json = []
      if (path.endsWith('/me')) json = { id: 1, email: 'preview@example.test', display_name: 'Preview', language: 'en', is_superadmin: true, permissions: [], roles: [] }
      else if (path.endsWith('/public-info')) json = { currency: 'USD' }
      else if (path === '/api/v1/colors/cleanup') json = { items: colors, groups: colors.filter(color => color.hex_code === '#ABCDEF').length > 1 ? [[1, 2, 3]] : [] }
      else if (path === '/api/v1/colors') {
        const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('page_size') || 50)
        json = { items: colors.slice((page - 1) * size, page * size).map(({ token, ...color }) => color), total: colors.length }
      }
      return route.fulfill({ json })
    })
    await page.goto(new URL('/filaments/colors', base).href, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]')?.textContent === '75 colors')
    if (width === 1440) {
      const usedDelete = page.locator('#colors-table tr').first().getByRole('button', { name: 'Delete', exact: true })
      assert.equal(await usedDelete.isDisabled(), true, 'Used colors cannot be deleted from the table')
      assert.match(await usedDelete.getAttribute('title'), /used by filaments.*cannot be deleted/s)
      assert.equal(writes.length, 0)
      assert.equal(await page.locator('#colors-table tr').first().locator('a.color-usage-link').first().textContent(), '2 filament assignments')
    }
    const clearSelection = page.getByRole('button', { name: 'Clear selection', exact: true })
    const deleteSelection = page.getByRole('button', { name: 'Delete selected', exact: true })
    assert.equal(await clearSelection.count(), 0)
    assert.equal(await deleteSelection.count(), 0)
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await clearSelection.waitFor()
    await deleteSelection.waitFor()
    assert.equal(await deleteSelection.locator('use').getAttribute('href'), '/icons.svg?v=4#icon-trash')
    assert.ok(await deleteSelection.evaluate(button => button.classList.contains('fm-btn-danger')))
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/selection-actions.png' })
    await clearSelection.click()
    assert.equal(await clearSelection.count(), 0)
    assert.equal(await deleteSelection.count(), 0)
    const table = page.locator('#colors-list-table')
    assert.equal(await table.locator('tbody tr').first().locator('td').count(), 5)
    if (width >= 1024) {
      const dimensions = await table.evaluate(table => ({ table: table.getBoundingClientRect().width, main: table.closest('main').getBoundingClientRect().width, whitespace: getComputedStyle(table.querySelector('tbody td:nth-child(2)')).whiteSpace }))
      assert.ok(dimensions.table <= dimensions.main, JSON.stringify(dimensions))
      assert.equal(dimensions.whitespace, 'nowrap')
    }
    if (width === 1440) {
      const nameWidth = await table.locator('th.col-name').evaluate(cell => cell.getBoundingClientRect().width)
      assert.ok(nameWidth >= 320, `Large-screen name column ${nameWidth}px`)
      const alignment = await page.locator('.fm-list-controls').evaluate(controls => ({ controls: controls.getBoundingClientRect().right, table: document.querySelector('.fm-colors-table').getBoundingClientRect().right }))
      assert.ok(Math.abs(alignment.controls - alignment.table) < 2, JSON.stringify(alignment))
      await page.screenshot({ path: '../_pr_artifacts/color-library/library-layout.png' })
    }
    if (width === 780) {
      const nameWidth = await table.locator('th.col-name').evaluate(cell => cell.getBoundingClientRect().width)
      assert.ok(nameWidth < 320, `Name column contracts before scrolling: ${nameWidth}px`)
    }
    // The last header action (the help button) ends at the table edge
    const actionRight = await page.locator('.fm-list-controls').evaluate(controls => controls.lastElementChild.getBoundingClientRect().right)
    const tableRight = await page.locator('.fm-colors-table').evaluate(card => card.getBoundingClientRect().right)
    assert.ok(Math.abs(actionRight - tableRight) < 2, `Action/table edges at ${width}px: ${actionRight}/${tableRight}`)
    const padding = await table.locator('tbody td').first().evaluate(cell => parseFloat(getComputedStyle(cell).paddingRight) + parseFloat(getComputedStyle(cell.nextElementSibling).paddingLeft))
    assert.ok(padding >= 24, `column gap ${padding}px at ${width}px must be at least one swatch width`)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page must not overflow horizontally')
    assert.equal(await table.getByRole('button', { name: 'Used in filaments', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Filter Usage', exact: true }).click()
    const usagePopup = page.getByRole('dialog', { name: 'Filter Usage', exact: true })
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/usage-filter.png' })
    await usagePopup.getByRole('button', { name: 'Used in filaments', exact: true }).click()
    assert.equal(await usagePopup.isVisible(), false)
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]').textContent === '1 of 75 colors')
    await page.getByRole('button', { name: 'Select all matching', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Clear column filters', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]').textContent === '75 colors')
    await page.getByRole('button', { name: 'Duplicates', exact: true }).click()
    const cleanup = page.getByRole('dialog', { name: 'Color cleanup' })
    await cleanup.locator('[data-merge-entry]').first().waitFor()
    assert.equal(await cleanup.locator('[data-merge-entry]').count(), 3)
    await cleanup.locator('#cleanup-survivor').selectOption('2')
    await cleanup.locator('#cleanup-name').fill('Combined blue')
    await cleanup.locator('[data-merge-entry="1"]').uncheck()
    await cleanup.locator('[data-merge-entry="1"]').check()
    assert.equal(await cleanup.locator('#cleanup-name').inputValue(), 'Combined blue')
    if (width === 1440) {
      await cleanup.locator('.fm-section-body').evaluate(body => { body.scrollTop = 0 })
      await page.screenshot({ path: '../_pr_artifacts/color-library/duplicate-review.png' })
    }
    await cleanup.getByRole('button', { name: 'Merge selected colors', exact: true }).click()
    await cleanup.getByText('No more duplicate colors to review.', { exact: true }).waitFor()
    assert.equal(writes[0].body.survivor_id, 2)
    assert.equal(writes[0].body.name, 'Combined blue')
    assert.equal(writes[0].body.records.length, 3)
    await cleanup.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Add Color', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Add Color' })
    await editor.locator('#color-name').fill('Wheel draft')
    assert.equal(await editor.locator('[data-color-picker-wheel]').isVisible(), false)
    const trigger = editor.locator('#color-picker-trigger')
    const nativePicker = editor.getByLabel('Edit RGB color', { exact: true })
    const swatchSize = await trigger.locator('[data-color-picker-swatch]').boundingBox()
    assert.ok(swatchSize.width >= 96 && swatchSize.height === 32, 'Color pill retains its requested size')
    assert.equal((await trigger.textContent()).trim(), 'RGB', 'The pencil identifies the native RGB control')
    assert.equal(await nativePicker.getAttribute('type'), 'color', 'The original native picker is retained')
    const pickerBounds = await nativePicker.boundingBox(), triggerBounds = await trigger.boundingBox()
    assert.ok(pickerBounds.width >= triggerBounds.width - 2 && pickerBounds.height >= triggerBounds.height - 2, 'The whole pill and pencil open the native picker')
    assert.equal(await nativePicker.evaluate(input => input.closest('form')?.id), 'modal-form')
    assert.equal(await editor.locator('[data-color-rgb], [role="tablist"]').count(), 0, 'No replacement RGB form')
    await editor.locator('#color-hex').fill('#4A90E2')
    await editor.locator('#color-hex').press('Tab')
    await nativePicker.click()
    await page.waitForFunction(() => document.querySelector('#color-picker').matches(':open'))
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/picker-native-open.png' })
    await editor.getByLabel('Color Name', { exact: true }).click()
    assert.equal(await editor.isVisible(), true, 'Dismissing the native picker keeps the color form open')
    await nativePicker.evaluate(input => { input.value = '#ff0000'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    assert.equal(await editor.locator('#color-hex').inputValue(), '#FF0000')
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/picker-native.png' })
    const wheelButton = editor.getByRole('button', { name: 'Color wheel', exact: true })
    assert.equal(await wheelButton.evaluate(button => button.parentElement.classList.contains('fm-color-picker-actions')), true, 'The color-circle button shares the pill with RGB')
    assert.equal(await wheelButton.locator('.fm-color-library-icon').count(), 1)
    const rgbBounds = await trigger.boundingBox(), wheelBounds = await wheelButton.boundingBox()
    assert.ok(wheelBounds.x >= rgbBounds.x + rgbBounds.width, 'Wheel button sits to the right of the pencil/RGB control')
    await wheelButton.click()
    const pickerPopup = page.getByRole('dialog', { name: 'Color wheel', exact: true })
    await pickerPopup.waitFor()
    await page.waitForFunction(mobile => document.activeElement === document.querySelector(mobile ? '#color-picker-popup [data-wheel-close]' : '#color-picker-popup [data-wheel-hex]'), width === 390)
    const adjustments = pickerPopup.locator('.fm-picker-adjustments')
    assert.equal(await adjustments.evaluate(panel => panel.open), width > 480, 'Mobile opens with sliders collapsed')
    const layout = await pickerPopup.evaluate(popup => ({ wheel: popup.querySelector('.fm-header-color-wheel-wrap').getBoundingClientRect().bottom, complement: popup.querySelector('.fm-picker-complement-row').getBoundingClientRect().top, adjustments: popup.querySelector('.fm-picker-adjustments').getBoundingClientRect().top }))
    assert.ok(layout.complement >= layout.wheel && layout.adjustments > layout.complement, 'Complementary color is directly under the wheel, before sliders')
    if (width === 390) {
      await pickerPopup.screenshot({ path: '../_pr_artifacts/color-library/picker-mobile-compact.png' })
      await adjustments.locator('summary').click()
    }
    if (width === 390) {
      for (const phoneWidth of [320, 360, 390]) {
        await page.setViewportSize({ width: phoneWidth, height: 700 })
        await page.waitForFunction(() => parseFloat(document.querySelector('[data-color-picker-popup]:popover-open').style.getPropertyValue('--picker-viewport-width')) === visualViewport.width)
        const fit = await pickerPopup.evaluate(popup => {
          const box = popup.getBoundingClientRect()
          return { left: box.left, right: box.right, viewport: innerWidth, overflow: popup.scrollWidth - popup.clientWidth }
        })
        if (fit.left < 0 || fit.right > fit.viewport || fit.overflow > 1) await page.screenshot({ path: '../_pr_artifacts/color-library/safari-mobile-before.png' })
        const hexFit = await pickerPopup.locator('[data-wheel-hex]').evaluate(input => {
          const style = getComputedStyle(input), context = document.createElement('canvas').getContext('2d')
          context.font = style.font
          return { width: input.getBoundingClientRect().width, needed: context.measureText('#AABBCCDD').width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2 }
        })
        assert.ok(hexFit.width <= 120 && hexFit.width >= hexFit.needed - 1, `${phoneWidth}px: compact hex input fits the full opacity value`)
        assert.ok(fit.left >= 0 && fit.right <= fit.viewport && fit.overflow <= 1, `${phoneWidth}px phone popup fits horizontally: ${JSON.stringify(fit)}`)
      }
      assert.ok(await pickerPopup.locator('[data-color-neutral]').first().evaluate(button => button.getBoundingClientRect().height >= 44), 'Mobile mode buttons have touch-sized targets')
      if (process.env.BROWSER_ENGINE !== 'webkit') {
        const cdp = await page.context().newCDPSession(page)
        const wheelBounds = await pickerPopup.locator('.fm-header-color-wheel').boundingBox()
        const scrollBefore = await pickerPopup.evaluate(popup => ({ popup: popup.scrollTop, page: window.scrollY }))
        const colorBefore = await pickerPopup.locator('[data-wheel-hex]').inputValue()
        const x = wheelBounds.x + wheelBounds.width / 2 + 30, y = wheelBounds.y + wheelBounds.height / 2
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + 40, id: 1 }] })
        for (const offset of [20, 0, -20, -40]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + offset, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        assert.notEqual(await pickerPopup.locator('[data-wheel-hex]').inputValue(), colorBefore, 'A real touch drag selects colors')
        assert.deepEqual(await pickerPopup.evaluate(popup => ({ popup: popup.scrollTop, page: window.scrollY })), scrollBefore, 'Wheel dragging does not scroll the popup or the page')
        await pickerPopup.locator('[data-wheel-hex]').fill('#FF0000')
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 })
        await page.waitForFunction(() => document.querySelector('[data-color-picker-popup]:popover-open').getBoundingClientRect().right <= visualViewport.offsetLeft + visualViewport.width)
        const zoomFit = await pickerPopup.evaluate(popup => {
          const box = popup.getBoundingClientRect(), viewport = visualViewport
          return { left: box.left, right: box.right, viewportLeft: viewport.offsetLeft, viewportRight: viewport.offsetLeft + viewport.width }
        })
        assert.ok(zoomFit.left >= zoomFit.viewportLeft && zoomFit.right <= zoomFit.viewportRight, `Zoomed phone popup fits the visible viewport: ${JSON.stringify(zoomFit)}`)
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
        await page.waitForFunction(() => document.querySelector('[data-color-picker-popup]:popover-open').getBoundingClientRect().width >= 359)
        await cdp.detach()
      }
      await page.setViewportSize({ width: 844, height: 390 })
      await page.waitForFunction(() => parseFloat(document.querySelector('[data-color-picker-popup]:popover-open').style.getPropertyValue('--picker-viewport-width')) === visualViewport.width)
      await pickerPopup.evaluate(popup => { popup.scrollTop = popup.scrollHeight })
      const landscapeCancel = await pickerPopup.locator('[data-wheel-cancel]').boundingBox()
      assert.ok(landscapeCancel.y >= 0 && landscapeCancel.y + landscapeCancel.height <= 390, 'Landscape phone keeps Cancel visible')
      assert.ok(await pickerPopup.locator('[data-color-neutral]').first().evaluate(button => button.getBoundingClientRect().height >= 44), 'Landscape phone retains touch-sized presets')
      await page.setViewportSize({ width, height: 520 })
      await page.waitForFunction(() => parseFloat(document.querySelector('[data-color-picker-popup]:popover-open').style.getPropertyValue('--picker-viewport-width')) === visualViewport.width)
      await pickerPopup.evaluate(popup => { popup.scrollTop = popup.scrollHeight })
      const cancel = await pickerPopup.locator('[data-wheel-cancel]').boundingBox()
      assert.ok(cancel.y >= 0 && cancel.y + cancel.height <= 520, 'Cancel stays visible while a short mobile popup scrolls')
      assert.ok(await pickerPopup.evaluate(popup => popup.scrollTop > 0), 'Short mobile popup scrolls within the viewport')
      await pickerPopup.locator('[data-wheel-hex]').fill('#4A90E223')
      await pickerPopup.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await wheelButton.tap()
      if (!await adjustments.evaluate(panel => panel.open)) await adjustments.locator('summary').tap()
      await page.setViewportSize({ width, height: 700 })
      await pickerPopup.evaluate(popup => { popup.scrollTop = 0 })
    }
    const popupBounds = await pickerPopup.boundingBox()
    const visibleCenter = await page.evaluate(() => visualViewport.offsetLeft + visualViewport.width / 2)
    assert.ok(Math.abs(popupBounds.x + popupBounds.width / 2 - visibleCenter) < 2, 'Wheel is centered within the visible viewport')
    if (width === 1440) {
      const surface = pickerPopup.locator('.fm-header-color-wheel')
      for (const [mode, min, max, saturationTo] of [['black', 0, 20, 20], ['grey', 35, 65, 10], ['white', 80, 100, 10]]) {
        await pickerPopup.locator('[data-wheel-hex]').fill('#4A90E223')
        await pickerPopup.locator(`[data-color-neutral="${mode}"]`).click()
        assert.equal(await surface.locator('[data-color-window]').count(), 0, 'The whole neutral wheel is selectable without a crosshatch mask')
        const paletteValues = await surface.evaluate(async (wheel, saturationTo) => {
          const background = getComputedStyle(wheel).getPropertyValue('--picker-neutral-palette').trim()
          const image = new Image()
          image.src = background.slice(5, -2)
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.width; canvas.height = image.height
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0)
          const pixels = context.getImageData(0, 0, image.width, image.height).data
          let min = 255, max = 0, oversaturated = 0
          const shades = new Set()
          for (let i = 0; i < pixels.length; i += 4) {
            const value = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
            min = Math.min(min, value); max = Math.max(max, value)
            if ((value - Math.min(pixels[i], pixels[i + 1], pixels[i + 2])) * 100 > value * saturationTo) oversaturated++
            shades.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
          }
          return { min: min / 255 * 100, max: max / 255 * 100, shades: shades.size, oversaturated }
        }, saturationTo)
        assert.ok(paletteValues.min >= min && paletteValues.max <= max, `${mode}: every displayed shade belongs to its brightness band`)
        assert.equal(paletteValues.oversaturated, 0, `${mode}: every shade stays within the search saturation limit`)
        assert.ok(paletteValues.shades > 100, `${mode}: full circle offers a range of subtly tinted shades`)
        const bounds = await surface.boundingBox()
        const pointerOffset = process.env.BROWSER_ENGINE === 'webkit' ? 0 : .5
        const points = [[.08, .06], [-.4, .3], [0, -.91]].map(([x, y]) => ({
          x: Math.floor(bounds.x + 1 + (bounds.width - 2) / 2 * (1 + x)) + pointerOffset,
          y: Math.floor(bounds.y + 1 + (bounds.height - 2) / 2 * (1 - y)) + pointerOffset,
        }))
        const painted = PNG.sync.read(await page.screenshot())
        const checkPixel = async point => {
          const index = (Math.floor(point.y) * painted.width + Math.floor(point.x)) * 4
          const expected = [...painted.data.subarray(index, index + 3)]
          const hex = await pickerPopup.locator('[data-wheel-hex]').inputValue()
          const actual = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
          // Fractional popup positioning can blend neighboring display pixels.
          assert.ok(actual.every((channel, i) => Math.abs(channel - expected[i]) <= 4), `${mode}: shown ${expected}, selected ${actual} at ${JSON.stringify(point)}`)
          assert.equal(hex.slice(7), '23')
          const value = Math.max(...actual) / 255 * 100
          assert.ok(value >= min && value <= max, `${mode}: brightness ${value} outside ${min}–${max}`)
          assert.equal(await surface.getAttribute('data-neutral-mode'), mode, 'Gesture retains the same palette')
          const marker = await pickerPopup.locator(`[data-color-marker="${hex}"]`).evaluate(marker => ({ x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) }))
          // WebKit rounds pointer positions to whole CSS pixels.
          assert.ok(Math.abs(marker.x - (point.x - bounds.x) / bounds.width * 100) < .6, 'Reference ring follows the sampled x coordinate')
          assert.ok(Math.abs(marker.y - (point.y - bounds.y) / bounds.height * 100) < .6, 'Reference ring follows the sampled y coordinate')

        }
        for (const point of points) {
          await page.mouse.click(point.x, point.y)
          await checkPixel(point)
        }
        await page.mouse.move(points[0].x, points[0].y)
        await page.mouse.down()
        await page.mouse.move(points[2].x, points[2].y)
        await page.mouse.up()
        await checkPixel(points[2])
        const brightness = pickerPopup.locator('[data-wheel-brightness]')
        assert.equal(await brightness.getAttribute('aria-valuemin'), String(min))
        assert.equal(await brightness.getAttribute('aria-valuemax'), String(max))
        await brightness.fill('0')
        assert.ok(Number(await brightness.inputValue()) >= min)
        await brightness.fill('100')
        assert.ok(Number(await brightness.inputValue()) <= max)
        await page.screenshot({ path: `../_pr_artifacts/color-library/picker-neutral-${mode}.png` })
        await pickerPopup.getByRole('button', { name: 'Color', exact: true }).click()
        assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), '#4A90E223')
      }
      await pickerPopup.locator('[data-wheel-hex]').fill('#FF0000')
    }
    for (const [neutral, expected] of [['white', '#FFFFFF'], ['grey', '#808080'], ['black', '#000000']]) {
      await pickerPopup.locator(`[data-color-neutral="${neutral}"]`).click()
      assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), expected)
      assert.equal(await editor.locator('#color-hex').inputValue(), expected)
    }
    assert.equal(await pickerPopup.locator('.fm-header-color-wheel').evaluate(wheel => wheel.classList.contains('is-neutral')), true)
    await pickerPopup.getByRole('button', { name: 'Color', exact: true }).click()
    assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), '#FF0000', 'Color returns to the previous chromatic choice')
    await pickerPopup.locator('[data-color-neutral="black"]').click()
    await pickerPopup.locator('.fm-header-color-wheel').click({ position: { x: 96, y: 90 } })
    assert.notEqual(await editor.locator('#color-hex').inputValue(), '#000000', 'Clicking a wheel spot after Black selects a visible color')
    assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), await editor.locator('#color-hex').inputValue())
    assert.equal(await pickerPopup.locator('[data-wheel-hue]').isDisabled(), false)
    await pickerPopup.getByRole('button', { name: 'Color', exact: true }).click()
    assert.equal(await pickerPopup.locator('.fm-header-color-wheel').evaluate(wheel => wheel.classList.contains('is-neutral')), false)
    await pickerPopup.locator('[data-wheel-hue]').fill('120')
    await pickerPopup.locator('[data-wheel-saturation]').fill('100')
    await pickerPopup.locator('[data-wheel-brightness]').fill('100')
    assert.equal(await editor.locator('#color-hex').inputValue(), '#00FF00')
    await pickerPopup.getByRole('button', { name: 'Done', exact: true }).click()
    await editor.locator('#color-hex').fill('#FF000080')
    await editor.locator('#color-hex').press('Tab')
    await wheelButton.click()
    await pickerPopup.locator('[data-wheel-hue]').fill('120')
    assert.equal(await editor.locator('#color-hex').inputValue(), '#00FF0080')
    assert.equal(await nativePicker.inputValue(), '#00ff00')
    assert.equal(await pickerPopup.locator('[data-wheel-complement]').textContent(), '#FF00FF80')
    await pickerPopup.locator('[data-color-neutral="white"]').click()
    assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), '#FFFFFF80')
    await pickerPopup.getByRole('button', { name: 'Color', exact: true }).click()
    assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), '#00FF0080')
    await pickerPopup.locator('[data-wheel-saturation]').fill('100')
    assert.equal(await pickerPopup.locator('[data-wheel-hex]').inputValue(), '#00FF0080')

    const wheelHex = pickerPopup.getByRole('textbox', { name: 'Selected', exact: true })
    await wheelHex.fill('#12')
    assert.equal(await editor.locator('#modal-form').evaluate(form => form.checkValidity()), false, 'Invalid popup hex blocks saving through the original field')
    await wheelHex.fill('')
    await wheelHex.pressSequentially('#00ff0080')
    assert.equal(await wheelHex.inputValue(), '#00ff0080', 'Typing through shorthand lengths keeps the text editable')
    assert.equal(await editor.locator('#color-hex').inputValue(), '#00FF0080')
    await pickerPopup.locator('[data-select-complement]').click()
    assert.equal(await wheelHex.inputValue(), '#FF00FF80')
    assert.equal(await nativePicker.inputValue(), '#ff00ff')
    await pickerPopup.locator('[data-select-complement]').click()
    assert.equal(await wheelHex.inputValue(), '#00FF0080')
    const controlStyles = await pickerPopup.evaluate(popup => {
      const selected = popup.querySelector('.fm-picker-selected-color')
      const color = popup.querySelector('[data-wheel-color]')
      const neutral = popup.querySelector('[data-color-neutral]')
      const range = popup.querySelector('.fm-picker-brightness-range')
      const track = getComputedStyle(range, '::before')
      return {
        brightnessAlignment: Math.abs(parseFloat(track.top) + parseFloat(track.height) / 2 + new DOMMatrix(track.transform).m42 - range.getBoundingClientRect().height / 2),
        font: getComputedStyle(selected).fontSize,
        sliderFont: getComputedStyle(popup.querySelector('.fm-picker-wheel-sliders label')).fontSize,
        complementFont: getComputedStyle(popup.querySelector('[data-select-complement]').parentElement).fontSize,
        colorHeight: color.getBoundingClientRect().height,
        neutralHeight: neutral.getBoundingClientRect().height,
        pills: [...popup.querySelectorAll('.filament-color-dot')].map(pill => ({ width: pill.getBoundingClientRect().width, height: pill.getBoundingClientRect().height })),
      }
    })
    assert.ok(controlStyles.brightnessAlignment < 1, 'Brightness track and thumb stay vertically aligned')
    assert.equal(controlStyles.font, controlStyles.sliderFont)
    assert.equal(controlStyles.font, controlStyles.complementFont)
    assert.equal(controlStyles.colorHeight, controlStyles.neutralHeight)
    assert.ok(controlStyles.pills.every(pill => pill.width >= 3 * pill.height))
    if (width === 1440 || width === 390) await page.screenshot({ path: `../_pr_artifacts/color-library/picker-wheel-${width}.png` })
    await wheelHex.fill('#ABCDEF23')
    await pickerPopup.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await pickerPopup.isVisible(), false)
    assert.equal(await editor.locator('#color-hex').inputValue(), '#FF000080', 'Cancel restores the opening color')
    assert.equal(await editor.locator('#color-alpha-hex').inputValue(), '80', 'Cancel restores exact opacity')
    if (width === 1440) {
      await editor.locator('#color-hex').fill('#12')
      await wheelButton.click()
      assert.equal(await wheelHex.inputValue(), '#12', 'Popup mirrors an invalid main-field draft')
      assert.equal(await wheelHex.getAttribute('aria-invalid'), 'true')
      await wheelHex.fill('#ABCDEF23')
      await pickerPopup.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.locator('#color-hex').inputValue(), '#12')
      assert.equal(await editor.locator('#color-alpha-hex').inputValue(), '80')
    }
    await editor.locator('#color-hex').fill('#00FF0080')
    await wheelButton.click()
    await pickerPopup.locator('[data-select-complement]').click()
    await pickerPopup.getByRole('button', { name: 'Done', exact: true }).click()
    assert.equal(await editor.locator('#color-hex').inputValue(), '#FF00FF80', 'Done retains the chosen color')
    await wheelButton.click()
    await pickerPopup.locator('[data-select-complement]').click()

    await page.keyboard.press('Escape')
    await pickerPopup.waitFor({ state: 'hidden' })
    assert.equal(await editor.isVisible(), true, 'Escape closes the optional wheel before the parent form')
    await nativePicker.evaluate(input => { input.value = '#00ff20'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    assert.equal(await editor.locator('#color-hex').inputValue(), '#00FF2080')
    await nativePicker.evaluate(input => { input.value = '#00ff00'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    assert.equal(await editor.locator('#color-hex').inputValue(), '#00FF0080')
    await wheelButton.press('Shift+Tab')
    const focusClearance = await trigger.evaluate(button => {
      const label = button.closest('.fm-color-editor-picker').querySelector('.fm-label').getBoundingClientRect()
      const style = getComputedStyle(button)
      const extension = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
      return button.getBoundingClientRect().top - extension - label.bottom
    })
    assert.ok(focusClearance >= 0, 'The color pill focus outline must stay clear of its label')
    assert.equal(await editor.locator('.fm-opacity-preview').count(), 0, 'The color pill is the only opacity preview')
    const opacityBounds = await editor.locator('#color-alpha').boundingBox()
    assert.ok(opacityBounds.width >= 140, 'Opacity slider remains usable')
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/color-form.png' })
    await wheelButton.click()
    await editor.locator('#modal-cancel').evaluate(button => button.click())
    await pickerPopup.waitFor({ state: 'hidden' })
    await editor.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Filter Usage', exact: true }).click()
    await usagePopup.getByRole('button', { name: 'Unused', exact: true }).click()
    assert.equal(await usagePopup.isVisible(), false)
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]').textContent === '72 of 73 colors')
    await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
    assert.equal(await page.locator('#color-selection-count').textContent(), '72 selected')
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/filtered-library.png' })
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await cleanup.getByText('Delete these 72 colors?', { exact: false }).waitFor()
    assert.equal(writes.length, 1, 'Opening the confirmation must not delete anything')
    await cleanup.locator('#color-cleanup-content').getByText('This cannot be undone.', { exact: false }).waitFor()
    if (width === 1440) await page.screenshot({ path: '../_pr_artifacts/color-library/delete-confirmation.png' })
    await cleanup.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]').textContent === '0 of 1 colors')
    assert.equal(await page.locator('#color-select-loaded').isDisabled(), true)
    assert.equal(await page.locator('#color-select-loaded').isChecked(), false)
    assert.equal(writes[1].body.records.length, 72)
    assert.equal(colors[0].usage_count, 2)
    colors = [colors[0],
      { id: 101, name: 'Red', hex_code: '#FF0000', usage_count: 1, token: 'a'.repeat(64) },
      { id: 102, name: 'Blue', hex_code: '#0000FF', usage_count: 2, token: 'b'.repeat(64) },
      { id: 103, name: 'Translucent gold', hex_code: '#E3B34180', usage_count: 1, token: 'c'.repeat(64) },
    ]
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]')?.textContent === '4 colors')
    const mergeSelection = page.getByRole('button', { name: 'Merge', exact: true })
    assert.equal(await mergeSelection.count(), 0)
    await page.locator('[data-color-select="101"]').check()
    assert.equal(await mergeSelection.count(), 0)
    await page.locator('[data-color-select="102"]').check()
    await page.locator('[data-color-select="103"]').check()
    await mergeSelection.click()
    const selectedMerge = page.getByRole('dialog', { name: 'Merge selected colors', exact: true })
    await selectedMerge.locator('[data-merge-entry]').first().waitFor()
    assert.equal(await selectedMerge.locator('[data-merge-entry]').count(), 3)
    assert.match(await selectedMerge.locator('[data-cleanup-merge]').evaluate(button => getComputedStyle(button).display), /^(inline-)?flex$/, 'Merge icon and label stay on the same row')
    const writesBefore = writes.length
    await selectedMerge.evaluate(dialog => {
      dialog.dataset.resultSubmits = '0'
      dialog.querySelector('[data-cleanup-merge-form]').addEventListener('submit', () => { dialog.dataset.resultSubmits = String(Number(dialog.dataset.resultSubmits) + 1) })
    })
    await selectedMerge.locator('#cleanup-name').press('Enter')
    await selectedMerge.locator('#cleanup-hex').press('Enter')
    assert.equal(await selectedMerge.getAttribute('data-result-submits'), '0', 'Enter in result fields must not confirm a merge')
    assert.equal(writes.length, writesBefore)
    await selectedMerge.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(writes.length, writesBefore)
    await mergeSelection.click()
    await selectedMerge.locator('[data-merge-entry]').first().waitFor()
    await selectedMerge.locator('#cleanup-survivor').selectOption('102')
    assert.equal(await selectedMerge.locator('#cleanup-hex').inputValue(), '#0000FF')
    const mergeWheel = selectedMerge.locator('#cleanup-picker-popup')
    for (const makeChange of [false, true]) {
      await selectedMerge.getByRole('button', { name: 'Color wheel', exact: true }).click()
      await mergeWheel.waitFor({ state: 'visible' })
      if (makeChange) await mergeWheel.locator('[data-wheel-hex]').fill('#11223380')
      await mergeWheel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await selectedMerge.locator('#cleanup-survivor').selectOption('103')
      assert.equal(await selectedMerge.locator('#cleanup-hex').inputValue(), '#E3B34180', 'Cancel leaves the result HEX eligible for prefill')
      await selectedMerge.locator('#cleanup-survivor').selectOption('102')
    }
    await selectedMerge.locator('#cleanup-name').fill('Combined violet')
    await selectedMerge.locator('#cleanup-hex').fill('#7654AB80')
    await selectedMerge.locator('#cleanup-survivor').selectOption('103')
    assert.equal(await selectedMerge.locator('#cleanup-name').inputValue(), 'Combined violet')
    assert.equal(await selectedMerge.locator('#cleanup-hex').inputValue(), '#7654AB80')
    await selectedMerge.locator('#cleanup-survivor').selectOption('102')
    await selectedMerge.getByRole('button', { name: 'Color wheel', exact: true }).click()
    await mergeWheel.waitFor({ state: 'visible' })
    assert.equal(await mergeWheel.locator('[data-wheel-hex]').inputValue(), '#7654AB80')
    await mergeWheel.locator('[data-wheel-hex]').fill('#11223380')
    await mergeWheel.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await selectedMerge.locator('#cleanup-hex').inputValue(), '#7654AB80')
    await selectedMerge.locator('[data-cleanup-warning]').scrollIntoViewIfNeeded()
    assert.match(await selectedMerge.locator('[data-cleanup-warning]').textContent(), /cannot be undone/)
    if (width === 1440 || width === 390) await selectedMerge.screenshot({ path: `../_pr_artifacts/merge-selected-colors/review-${width}.png` })
    rejectCombine = true
    await selectedMerge.getByRole('button', { name: 'Merge selected colors', exact: true }).click()
    const error = selectedMerge.getByRole('alert').filter({ hasText: 'Colors changed' })
    const refresh = selectedMerge.getByRole('button', { name: 'Refresh and review again', exact: true })
    await error.waitFor()
    for (const control of [error, refresh]) {
      assert.ok(await control.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const dialog = el.closest('dialog')
        const header = dialog.querySelector('header').getBoundingClientRect()
        return rect.top >= header.bottom && rect.bottom <= Math.min(innerHeight, dialog.getBoundingClientRect().bottom) + 1
      }), 'Merge failure and refresh must be visible without scrolling')
    }
    await refresh.click()
    await selectedMerge.locator('[data-merge-entry]').first().waitFor()
    assert.equal(await selectedMerge.locator('#cleanup-name').inputValue(), 'Combined violet')
    assert.equal(await selectedMerge.locator('#cleanup-hex').inputValue(), '#7654AB80')
    rejectCombine = false
    await selectedMerge.getByRole('button', { name: 'Merge selected colors', exact: true }).click()
    await selectedMerge.waitFor({ state: 'hidden' })
    assert.deepEqual(writes.at(-1).body.records.map(record => record.id), [101, 102, 103])
    assert.equal(writes.at(-1).body.hex_code, '#7654AB80')
    assert.equal(writes.at(-1).body.survivor_id, 102)
    await page.waitForFunction(() => document.querySelector('[data-inventory-count]').textContent === '2 colors')
    assert.equal(await page.locator('#color-selection-count').textContent(), '0 selected')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Selected merge does not cause page overflow')
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`Color library ${width}px: counts, usage filters, three-way merge, wheel alpha and bulk deletion passed`)
  }
} finally { await browser.close() }
