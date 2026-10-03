/** Run with CHROME_EXECUTABLE_PATH set, like check-label-layout.mjs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const layout = await readFile(`${frontend}src/layouts/Layout.astro`, 'utf8')
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
    if (route.request().url().endsWith('/pending')) return route.fulfill({ json: pending })
    if (route.request().url().endsWith('/claim')) {
      pending = null
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ contentType: 'text/html', body: markup })
  })
  await page.goto('http://print.test/')
  await page.addStyleTag({ content: css.build(['hidden']) })
  const prompt = page.locator('#pc-print-prompt')
  assert.equal(await prompt.isVisible(), false, 'popup must be hidden before initialization')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => window.printPrompt.setupPcPrintPrompt())
  assert.equal(await prompt.isVisible(), false, 'empty queue must stay hidden')
  pending = { id: 7, spool_id: 73, preset_id: null }
  await prompt.waitFor({ state: 'visible' })
  await page.locator('.pc-print-prompt-close').click()
  await prompt.waitFor({ state: 'hidden' })
  pending = { id: 8, spool_id: 74, preset_id: null }
  await prompt.waitFor({ state: 'visible' })
  pending = null
  await prompt.waitFor({ state: 'hidden' })
  console.log('PC print popup: initial, pending, close, new request, empty queue passed')
} finally {
  await browser.close()
}
