/** Run with CHROME_EXECUTABLE_PATH set, like check-label-layout.mjs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const layout = await readFile(`${frontend}src/layouts/Layout.astro`, 'utf8')
const printStyles = await readFile(`${frontend}src/components/LabelPrintBaseStyles.astro`, 'utf8')
const icons = await readFile(`${frontend}public/icons.svg`, 'utf8')
const markup = layout.slice(layout.indexOf('<div id="pc-print-prompt"'), layout.indexOf('<!-- Global confirm'))
const css = await compile(await readFile(`${frontend}src/styles/global.css`, 'utf8'), {
  base: `${frontend}src/styles`, onDependency() {},
})
const bundle = await build({
  entryPoints: [`${frontend}src/lib/label-pc-print-prompt.ts`],
  bundle: true, format: 'iife', globalName: 'printPrompt', write: false,
})
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  let pending = null
  await page.route('http://print.test/**', route => {
    if (route.request().url().endsWith('/icons.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: icons })
    if (route.request().url().endsWith('/pending')) return route.fulfill({ json: pending })
    if (route.request().url().endsWith('/claim')) {
      pending = null
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en" data-theme="brand"><body>${markup}</body></html>` })
  })
  await page.goto('http://print.test/')
  await page.addStyleTag({ content: css.build(['hidden']) })
  const prompt = page.locator('#pc-print-prompt')
  assert.equal(await prompt.isVisible(), false, 'popup must be hidden before initialization')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => window.printPrompt.setupPcPrintPrompt())
  assert.equal(await prompt.isVisible(), false, 'empty queue must stay hidden')
  for (const kind of ['spool', 'filament']) {
    pending = { id: 7, [`${kind}_id`]: 73, preset_id: null }
    await prompt.waitFor({ state: 'visible' })
    // Print pages add global button styles; test those as well as the shared layout.
    for (const printPage of [false, true]) {
      if (printPage) await page.addStyleTag({ content: printStyles.replace(/<\/?style[^>]*>/g, '') })
      for (const width of [320, 390, 560, 561, 1100]) {
        await page.setViewportSize({ width, height: 700 })
        const boxes = await prompt.locator('button, .pc-print-prompt-copy').evaluateAll(elements =>
          elements.map(element => {
            const { left, right, top, bottom } = element.getBoundingClientRect()
            return { left, right, top, bottom }
          }))
        for (let i = 0; i < boxes.length; i++) {
          const a = boxes[i]
          assert(a.left >= 0 && a.right <= width, `popup control outside ${width}px viewport`)
          for (const b of boxes.slice(i + 1)) {
            assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
              `popup controls overlap at ${width}px (${printPage ? 'print page' : 'shared layout'})`)
          }
        }
      }
    }
    if (process.env.LABEL_EVIDENCE_DIR) await prompt.screenshot({ path: `${process.env.LABEL_EVIDENCE_DIR}/${kind}-print-prompt.png` })
    await page.locator('.pc-print-prompt-close').click()
    await prompt.waitFor({ state: 'hidden' })
  }
  pending = { id: 8, spool_id: 74, preset_id: null }
  await prompt.waitFor({ state: 'visible' })
  pending = null
  await prompt.waitFor({ state: 'hidden' })
  console.log('PC print popup: initial, pending, close, new request, empty queue passed')
} finally {
  await browser.close()
}
