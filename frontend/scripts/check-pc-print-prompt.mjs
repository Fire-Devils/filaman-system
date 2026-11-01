/** Run with CHROME_EXECUTABLE_PATH set, like check-label-layout.mjs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import { build, createServer } from 'vite'
import { chromium } from 'playwright-core'
import { fixtures, data } from '../tests/label-rendering/fixtures.mjs'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const layout = await readFile(`${frontend}src/layouts/Layout.astro`, 'utf8')
const printStyles = await readFile(`${frontend}src/components/LabelPrintBaseStyles.astro`, 'utf8')
const icons = await readFile(`${frontend}public/icons.svg`, 'utf8')
const markup = layout.slice(layout.indexOf('<div class="pc-print-prompt-stack"'), layout.indexOf('<!-- Global confirm'))
const css = await compile(await readFile(`${frontend}src/styles/global.css`, 'utf8'), {
  base: `${frontend}src/styles`, onDependency() {},
})
const bundle = await build({ configFile: false, root: frontend, logLevel: 'error', build: {
  write: false, minify: false,
  lib: { entry: `${frontend}src/lib/label-pc-print-prompt.ts`, name: 'printPrompt', formats: ['iife'] },
} })
// Keep this SSR fixture from invalidating the running Astro server's optimized modules.
const loader = await createServer({ configFile: false, root: frontend, cacheDir: `${frontend}node_modules/.vite-pc-print-check`, server: { middlewareMode: true } })
const core = await loader.ssrLoadModule('/tests/label-rendering/render.mjs')
const runtime = await core.createSvgRuntime(path => readFile(`${frontend}node_modules/${path}`))
await loader.close()
const preset = structuredClone(fixtures.find(f => f.id === 'thermal').preset)
preset.design.elements.find(e => e.type === 'qr').mode = 'simple'
let dimensions = { widthMm: 40, heightMm: 30 }
let raster
function renderPreview() {
  preset.design.label = { ...preset.design.label, ...dimensions }
  raster = core.renderSvgLabelPng({ preset, data: { ...data, id: 73 }, assets: {}, origin: 'http://print.test',
    entityPath: 'spools', thermal: false, pixelWidth: Math.round(dimensions.widthMm * 600 / 25.4),
    pixelHeight: Math.round(dimensions.heightMm * 600 / 25.4) }, runtime).png
}
renderPreview()
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
const errors = []
try {
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  let pending = null
  let previewRequests = 0
  let nextId = 1
  const newRequest = kind => ({ id: nextId++, [`${kind}_id`]: 73, preset_id: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(), expires_at: new Date(Date.now() + 55 * 60_000).toISOString() })
  await page.route('http://print.test/**', route => {
    if (route.request().url().endsWith('/preview')) {
      previewRequests++
      return route.fulfill({ contentType: 'image/png', body: Buffer.from(raster),
      headers: { 'X-Label-Width-Mm': String(dimensions.widthMm), 'X-Label-Height-Mm': String(dimensions.heightMm) } })
    }
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
  const built = Array.isArray(bundle) ? bundle[0] : bundle
  await page.addScriptTag({ content: built.output.find(item => item.type === 'chunk').code })
  await page.evaluate(() => window.printPrompt.setupPcPrintPrompt())
  assert.equal(await prompt.isVisible(), false, 'empty queue must stay hidden')
  for (const kind of ['spool', 'filament']) {
    pending = newRequest(kind)
    await prompt.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('.pc-print-prompt-print').disabled)
    assert.equal(await prompt.locator('.pc-print-prompt-preview').isVisible(), true)
    // Both age states must remain readable in every supported theme.
    for (const theme of ['brand', 'light', 'dark']) {
      for (const expiring of [false, true]) {
        const contrast = await prompt.evaluate((card, { theme, expiring }) => {
          document.documentElement.dataset.theme = theme
          const badge = card.querySelector('.pc-print-prompt-age')
          badge.classList.toggle('is-expiring', expiring)
          const luminance = color => {
            const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
              c /= 255
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
            })
            return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
          }
          const a = luminance(getComputedStyle(badge).color)
          const b = luminance(getComputedStyle(card).backgroundColor)
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        }, { theme, expiring })
        assert(contrast >= 4.5, `${theme} ${expiring ? 'red' : 'yellow'} age contrast is only ${contrast.toFixed(2)}:1`)
      }
    }
    await prompt.evaluate(card => {
      document.documentElement.dataset.theme = 'brand'
      card.querySelector('.pc-print-prompt-age').classList.remove('is-expiring')
    })
    // Print pages add global button styles; test those as well as the shared layout.
    for (const printPage of [false, true]) {
      if (printPage) await page.addStyleTag({ content: printStyles.replace(/<\/?style[^>]*>/g, '') })
      for (const width of [320, 390, 560, 561, 1100]) {
        await page.setViewportSize({ width, height: 700 })
        const boxes = await prompt.locator('button, .pc-print-prompt-header, .pc-print-prompt-message, .pc-print-prompt-note, .pc-print-prompt-preview').evaluateAll(elements =>
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
    if (kind === 'spool') {
      const rendered = previewRequests
      pending = { ...pending, has_more: true }
      const waiting = page.locator('#pc-print-prompt-waiting')
      await waiting.waitFor({ state: 'visible' })
      assert.equal(previewRequests, rendered, 'waiting request rendered before becoming active')
      const cardBox = await prompt.boundingBox()
      const waitingBox = await waiting.boundingBox()
      assert(waitingBox.y >= cardBox.y + cardBox.height, 'waiting strip overlaps the label card')
      if (process.env.LABEL_EVIDENCE_DIR) await page.locator('.pc-print-prompt-stack').screenshot({ path: `${process.env.LABEL_EVIDENCE_DIR}/queued-print-prompt.png` })
      pending = { ...pending, has_more: false }
      await waiting.waitFor({ state: 'hidden' })
    }
    if (process.env.LABEL_EVIDENCE_DIR) await prompt.screenshot({ path: `${process.env.LABEL_EVIDENCE_DIR}/${kind}-print-prompt.png` })
    await page.locator('.pc-print-prompt-close').click()
    await prompt.waitFor({ state: 'hidden' })
  }
  // Large portrait and wide labels must shrink in both axes without distortion.
  for (const size of [[30, 100], [300, 10]]) {
    dimensions = { widthMm: size[0], heightMm: size[1] }
    renderPreview()
    pending = newRequest('spool')
    await prompt.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('.pc-print-prompt-print').disabled)
    const bounds = await prompt.locator('.pc-print-prompt-preview').boundingBox()
    assert(bounds.width <= 260 && bounds.height <= 200, 'preview exceeds its X/Y limits')
    assert(Math.abs(bounds.width / bounds.height - dimensions.widthMm / dimensions.heightMm) < 0.05, 'preview aspect ratio changed')
    await page.locator('.pc-print-prompt-close').click()
    await prompt.waitFor({ state: 'hidden' })
  }
  // Check actual browser print CSS and ensure only the label is passed to print.
  dimensions = { widthMm: 40, heightMm: 30 }
  renderPreview()
  pending = newRequest('filament')
  await prompt.waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('.pc-print-prompt-print').disabled)
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = document.querySelector('#filaman-label-print-host img')?.src } })
  const preview = await prompt.locator('.pc-print-prompt-preview').getAttribute('src')
  await page.locator('.pc-print-prompt-print').click()
  await page.waitForFunction(() => document.body.dataset.printed)
  assert.equal(await page.evaluate(() => document.body.dataset.printed), preview, 'print differs from the displayed preview')
  assert((await page.locator('#filaman-label-print-style').textContent()).includes('@page { size: 40mm 30mm; margin: 0; }'))
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await prompt.waitFor({ state: 'hidden' })
  pending = newRequest('spool')
  await page.evaluate(() => localStorage.setItem('filaman-label-print-pdf-v1', 'true'))
  await prompt.waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('.pc-print-prompt-print').disabled)
  const pagesBeforePdf = page.context().pages().length
  await page.locator('.pc-print-prompt-print').click()
  const download = prompt.getByRole('link', { name: 'Download PDF' })
  await download.waitFor({ state: 'visible' })
  assert.equal(page.context().pages().length, pagesBeforePdf, 'PDF mode opened another window')
  assert.equal(await prompt.locator('.pc-print-prompt-preview').isVisible(), true)
  assert.equal(await prompt.locator('.pc-print-prompt-print').isVisible(), false)
  const pdfText = await download.evaluate(async link => {
    const response = await fetch(link.href)
    return response.text()
  })
  assert(pdfText.startsWith('%PDF-'), 'PDF print preference did not produce a PDF')
  const mediaBox = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdfText)
  assert(mediaBox && Math.abs(Number(mediaBox[1]) - 40 * 72 / 25.4) < 0.01 && Math.abs(Number(mediaBox[2]) - 30 * 72 / 25.4) < 0.01,
    'PDF physical dimensions differ from the label')
  const downloaded = page.waitForEvent('download')
  await download.click()
  assert.equal((await downloaded).suggestedFilename(), 'label.pdf')
  assert.equal(await prompt.isVisible(), true, 'download hid the label preview')
  if (process.env.LABEL_EVIDENCE_DIR) await prompt.screenshot({ path: `${process.env.LABEL_EVIDENCE_DIR}/pdf-print-prompt.png` })
  for (const lang of ['en', 'de', 'fr']) {
    const translations = JSON.parse(await readFile(`${frontend}src/i18n/${lang}.json`, 'utf8'))
    await prompt.locator('.pc-print-prompt-download span').evaluate((span, text) => { span.textContent = text }, translations.labelPrint.downloadPdf)
    await prompt.locator('.pc-print-prompt-edit span').evaluate((span, text) => { span.textContent = text }, translations.common.edit)
    for (const width of [320, 1100]) {
      await page.setViewportSize({ width, height: 700 })
      const fits = await prompt.locator('.pc-print-prompt-actions').evaluate(row =>
        [...row.children].filter(e => !e.hidden).every(e => e.scrollWidth <= e.clientWidth))
      assert(fits, `${lang} PDF controls overflow at ${width}px`)
    }
  }
  await prompt.locator('.pc-print-prompt-close').click()
  await prompt.waitFor({ state: 'hidden' })
  pending = newRequest('spool')
  await prompt.waitFor({ state: 'visible' })
  pending = null
  await prompt.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log('PC print popup: spool/filament previews, mobile/desktop spacing, X/Y bounds, exact browser print pixels, PDF dimensions, dismiss and queue passed')
} finally {
  await browser.close()
}
