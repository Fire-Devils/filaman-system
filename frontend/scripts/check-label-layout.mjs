/**
 * Real layout acceptance (happy-dom cannot measure text).
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
    contents: `export { renderFreeformLabel } from './src/lib/freeform-label/render';
      export { migrateV1PresetData, normalizeDesignerPresetData } from './src/lib/freeform-label/migrate-v1';`,
    resolveDir: frontend,
    loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'labelLayout', platform: 'browser', write: false,
})
const fonts = await Promise.all([
  ['space-grotesk', 'Space Grotesk', 400], ['space-grotesk', 'Space Grotesk', 700],
  ['fraunces', 'Fraunces', 700], ['space-mono', 'Space Mono', 700],
  ['roboto-condensed', 'Roboto Condensed', 700],
].map(async ([packageName, family, weight]) => {
  const font = await readFile(`${frontend}node_modules/@fontsource/${packageName}/files/${packageName}-latin-${weight}-normal.woff2`)
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${font.toString('base64')})}`
}))
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>${fonts.join('')}</style>`)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const results = await page.evaluate(async () => {
    const results = []
    const check = (name, test) => {
      try { test(); results.push({ name, pass: true }) }
      catch (error) { results.push({ name, pass: false, error: error.message }) }
    }
    const expect = (value, message) => { if (!value) throw Error(message) }
    const near = (actual, expected, message) => expect(Math.abs(actual - expected) < 0.15, `${message}: ${actual} != ${expected}`)
    const pxPerMm = 96 / 25.4
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
      { template: 'One\nTwo', error: true },
      { template: 'One\n\nThree', wrap: true, error: true },
      { template: 'One\nTwo\nThree', wrap: true, error: true },
      { template: '==One\nTwo\nThree==', wrap: true, error: true },
      { template: 'Long text will never fit', w: 4, error: true },
      { template: '[size=200]Text[/size]', h: 2, error: true },
      { template: '[size=200]Text[/size]', h: 6, shrink: true },
      { template: 'A long title to shrink', w: 26, shrink: true },
      { template: 'One two three four five six seven eight', wrap: true, w: 26, shrink: true },
    )
    for (const [index, spec] of nativeCases.entries()) {
      const root = document.createElement('div')
      // Also exercises the detached root used by exports.
      const design = {
        version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 1, border: false },
        elements: [{
          id: 'text', type: 'text', x: 1, y: 1, w: 50, h: 20, z: 0, fontFamily: 'Space Grotesk',
          fontSizeMm: 4, fontWeight: 700, italic: false, underline: false, align: 'left',
          color: '#000000', wrap: false, fitToWidth: true, minFontSizeMm: 2, ...spec,
        }],
      }
      await labelLayout.renderFreeformLabel({ element: root, design, data: {}, previewBorder: false })
      document.body.replaceChildren(root)
      const node = root.firstElementChild
      const content = node.firstElementChild
      check(`native ${index}: ${JSON.stringify(spec)}`, () => {
        expect(!!node.dataset.labelOutputError === !!spec.error, `error=${node.dataset.labelOutputError}, font=${node.style.fontSize}`)
        if (spec.expectSize) near(parseFloat(node.style.fontSize), spec.expectSize, 'font size')
        if (spec.error) near(parseFloat(node.style.fontSize), 2, 'minimum size')
        if (spec.shrink) expect(parseFloat(node.style.fontSize) >= 2 && parseFloat(node.style.fontSize) < 4, 'must shrink within bounds')
        if (!spec.error) {
          expect(content.scrollHeight <= node.clientHeight, 'content height exceeds box')
          expect(content.scrollWidth <= node.clientWidth, 'content width exceeds box')
        }
      })
    }
    // Literal line heights and gaps from the V1 flow contract: 4mm base title,
    // line-height 1, symmetric row margins, and one CSS pixel per divider.
    const legacyCases = [
      ['Plain title', 4], ['[size=200]Big title[/size]', 8], ['First line\nSecond line', 8],
      ['[size=150]{filament.name}[/size]', 6], ['==[size=150]Big title[/size]==', 6],
      ['[font=Fraunces][size=200]Big[/size][/font] small', 8],
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
        const root = document.createElement('div')
        await labelLayout.renderFreeformLabel({ element: root, design, data, previewBorder: false })
        document.body.replaceChildren(root)
        check(`V1 ${field}: ${template}, fit=${fitToWidth}, present=${present}`, () => {
          const empty = !present && template.includes('{filament.name}')
          const titles = design.elements.filter(element => element.legacyTextRole === 'title')
          const info = design.elements.find(element => element.legacyTextRole === 'info')
          let cursorPx = pxPerMm
          for (const [index, title] of titles.entries()) {
            cursorPx += 1 // The above-divider remains even for an empty title.
            const selected = index === (field === 'title' ? 0 : 1)
            const node = root.querySelector(`[data-label-element-id="${title.id}"]`)
            if (selected && empty) { expect(node.style.display === 'none', 'missing field should collapse'); continue }
            const margin = index === 0 ? 0.5 : 0.25
            cursorPx += margin * pxPerMm
            near(node.getBoundingClientRect().y - root.getBoundingClientRect().y, cursorPx, 'title top')
            const height = (selected ? heightMm : 4) * pxPerMm
            near(node.getBoundingClientRect().height, height, 'title height')
            near(node.firstElementChild.getBoundingClientRect().height, height, 'title natural height')
            cursorPx += height + margin * pxPerMm + 1
          }
          const infoNode = root.querySelector(`[data-label-element-id="${info.id}"]`)
          near(infoNode.getBoundingClientRect().y - root.getBoundingClientRect().y, cursorPx, 'info top')
          near(infoNode.getBoundingClientRect().bottom - root.getBoundingClientRect().y, 39 * pxPerMm, 'info bottom')
          const rules = [...root.children].filter(node => node.dataset.labelElementType === 'shape' && node.clientWidth > node.clientHeight && node.style.display !== 'none')
          expect(rules.length === (empty ? 3 : 4), 'visible divider count')
          const separator = [...root.children].find(node => node.dataset.labelElementType === 'shape' && node.clientHeight > node.clientWidth)
          near(separator.getBoundingClientRect().y, infoNode.getBoundingClientRect().y, 'vertical divider top')
          near(separator.getBoundingClientRect().height, infoNode.getBoundingClientRect().height, 'vertical divider height')
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
