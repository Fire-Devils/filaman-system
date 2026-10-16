/**
 * Production SVG layout acceptance in a browser, using real bundled fonts.
 * Run from frontend: PLAYWRIGHT_MODULE=/path/to/playwright-core \
 * CHROME_EXECUTABLE_PATH=/path/to/chrome node scripts/check-label-layout.mjs
 * Uses installed esbuild, bundled fonts, and an existing Playwright/Chrome runtime.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const frontend = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: {
    contents: `export { renderSvgLabelPng, initWasm, loadFonts, fontFiles } from './src/lib/label-svg/core.mjs';
      export { migrateV1PresetData, normalizeDesignerPresetData } from './src/lib/freeform-label/migrate-v1';`,
    resolveDir: frontend,
    loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'labelLayout', platform: 'browser', write: false,
})
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const assets = {}
  // Keep the browser's font loader identical to production, without a test server.
  for (const { file } of await page.evaluate(() => labelLayout.fontFiles)) {
    assets[file] = (await readFile(`${frontend}node_modules/${file}`)).toString('base64')
  }
  assets.wasm = (await readFile(`${frontend}node_modules/@resvg/resvg-wasm/index_bg.wasm`)).toString('base64')
  await page.evaluate(async assets => {
    const bytes = key => Uint8Array.from(atob(assets[key]), c => c.charCodeAt(0))
    await labelLayout.initWasm(bytes('wasm'))
    window.labelRuntime = { fonts: await labelLayout.loadFonts(bytes) }
  }, assets)
  const results = await page.evaluate(async () => {
    const results = []
    const check = (name, test) => {
      try { test(); results.push({ name, pass: true }) }
      catch (error) { results.push({ name, pass: false, error: error.message }) }
    }
    const expect = (value, message) => { if (!value) throw Error(message) }
    const near = (actual, expected, message) => expect(Math.abs(actual - expected) < 0.15, `${message}: ${actual} != ${expected}`)
    const render = (design, data) => labelLayout.renderSvgLabelPng({
      preset: { version: 2, design }, data, assets: {}, origin: 'https://fila.test', thermal: false,
      pixelWidth: 600, pixelHeight: 400,
    }, window.labelRuntime)
    const nativeCases = []
    for (const template of [
      'Normal text', '[size=150]Big text[/size]', '[size=200]Big text[/size]',
      '[font=Fraunces][size=200]Big[/size][/font] [i]small[/i]',
      '[font=Space Mono][size=150]Big[/size][/font] [b]small[/b]',
      '==[size=150]Big[/size]== [font=Roboto Condensed]small[/font]',
    ]) for (const wrap of [false, true]) for (const verticalAlign of ['top', 'middle', 'bottom']) {
      nativeCases.push({ template, wrap, verticalAlign, expectSize: 4 })
    }
    nativeCases.push(
      { template: '[size=300]A[/size][size=50]b[/size]', expectSize: 4 },
      { template: '[size=50]b[/size][font=Fraunces][size=300]A[/size][/font]', expectSize: 4 },
      { template: '[size=200]One[/size]\n[font=Space Mono]two[/font]', wrap: true, expectSize: 4 },
      { template: 'One\nTwo', expectSize: 4 },
      { template: 'One\n\nThree', wrap: true },
      { template: 'One\nTwo\nThree', wrap: true },
      { template: '==One\nTwo\nThree==', wrap: true },
      { template: 'Long text will never fit', w: 4, error: true },
      { template: '[size=200]Text[/size]', h: 2, error: true },
      { template: '[size=200]Text[/size]', h: 6, shrink: true },
      { template: 'A long title to shrink', w: 26, shrink: true },
      { template: 'One two three four five six seven eight', wrap: true, w: 26, expectSize: 4 },
      { template: 'One two three four five six seven eight', wrap: true, w: 26, h: 10, shrink: true },
    )
    for (const [index, spec] of nativeCases.entries()) {
      const design = {
        version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 1, border: false },
        elements: [{
          id: 'text', type: 'text', x: 1, y: 1, w: 50, h: 20, z: 0, fontFamily: 'Space Grotesk',
          fontSizeMm: 4, fontWeight: 700, italic: false, underline: false, align: 'left',
          color: '#000000', wrap: false, fitToWidth: true, minFontSizeMm: 2, ...spec,
        }],
      }
      check(`native ${index}: ${JSON.stringify(spec)}`, () => {
        let output, error
        try { output = render(design, {}) } catch (caught) { error = caught }
        if (spec.error) {
          expect(/fit/i.test(error?.message), `expected overflow error, got ${error?.message}`)
          return
        }
        if (error) throw error
        const text = output.text[0]
        if (spec.expectSize) near(text.size, spec.expectSize, 'font size')
        if (spec.shrink) expect(text.size >= 2 && text.size < 4, 'must shrink within bounds')
        expect(text.height <= design.elements[0].h, 'content height exceeds box')
        expect(output.png.length > 100, 'render must produce actual pixels')
      })
    }
    // Base titles retain 4mm rows. Enlarged inline runs use real font ascent +
    // descent: Space Grotesk 1.276 em, Fraunces 1.233 em. Dividers stay one CSS px.
    const legacyCases = [
      ['Plain title', 4], ['[size=200]Big title[/size]', 10.208], ['First line\nSecond line', 8],
      ['[size=150]{filament.name}[/size]', 7.656], ['==[size=150]Big title[/size]==', 7.656],
      ['[font=Fraunces][size=200]Big[/size][/font] small', 9.864],
    ]
    for (const [template, heightMm] of legacyCases) for (const fitToWidth of [false, true]) {
      for (const field of ['title', 'title2']) for (const present of [false, true]) {
        const settings = {
          label: { width: 60, height: 40, marginMm: 1, border: false }, logo: { show: false },
          title: { show: true, template: 'Top', sizeMm: 4, fitToWidth, marginMm: 0.5, dividerAbove: true, dividerBelow: true },
          title2: { show: true, template: 'Sub', sizeMm: 4, fitToWidth, marginMm: 0.25, dividerAbove: true, dividerBelow: true },
          qr: { show: false }, info: { show: true, template: 'INFO', vAlign: 'top' },
          info2: { show: true, template: 'SECOND', vAlign: 'top', vsep: true },
        }
        settings[field].template = template
        const data = { 'filament.name': present ? 'Visible name' : '' }
        const preset = labelLayout.migrateV1PresetData({ settings }, 'spool')
        const { design } = labelLayout.normalizeDesignerPresetData(JSON.parse(JSON.stringify(preset)), 'spool')
        check(`V1 ${field}: ${template}, fit=${fitToWidth}, present=${present}`, () => {
          const output = render(design, data)
          const empty = !present && template.includes('{filament.name}')
          const titles = design.elements.filter(element => element.legacyTextRole === 'title')
          const info = design.elements.find(element => element.legacyTextRole === 'info')
          let cursor = 1
          for (const [index, title] of titles.entries()) {
            cursor += 25.4 / 96 // The above-divider remains even for an empty title.
            const selected = index === (field === 'title' ? 0 : 1)
            const box = output.boxes.find(box => box.id === title.id)
            if (selected && empty) { expect(box.hidden, 'missing field should collapse'); continue }
            const margin = index === 0 ? 0.5 : 0.25
            cursor += margin
            near(box.y, cursor, 'title top')
            const height = selected ? heightMm : 4
            near(box.h, height, 'title height')
            near(output.text.find(text => text.id === title.id).height, height, 'title natural height')
            cursor += height + margin + 25.4 / 96
          }
          const infoBox = output.boxes.find(box => box.id === info.id)
          near(infoBox.y, cursor, 'info top')
          near(infoBox.y + infoBox.h, 39, 'info bottom')
          const shapes = output.boxes.filter(box => !box.hidden && design.elements.find(e => e.id === box.id).type === 'shape')
          const rules = shapes.filter(box => box.w > box.h)
          expect(rules.length === (empty ? 3 : 4), 'visible divider count')
          const separator = shapes.find(box => box.h > box.w)
          near(separator.y, infoBox.y, 'vertical divider top')
          near(separator.h, infoBox.h, 'vertical divider height')
        })
      }
    }
    return results
  })
  const failures = results.filter(result => !result.pass)
  if (failures.length) console.error(JSON.stringify(failures, null, 2))
  console.log(`Label layout: ${results.length - failures.length}/${results.length} cases passed`)
  assert.equal(failures.length, 0, 'label layout acceptance failures')
} finally {
  await browser.close()
}
