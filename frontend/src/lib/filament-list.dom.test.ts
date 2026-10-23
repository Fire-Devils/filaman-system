// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { transpileModule } from 'typescript'
import { afterEach, expect, it } from 'vitest'
import { escapeHtml, formatNumericRange } from './extra-fields'
import { toColorSwatchBackground } from './colors'
import { formatPrice } from './format'

const source = readFileSync('src/pages/filaments/index.astro', 'utf8')
const script = source.slice(source.indexOf('    function renderColorDots'), source.indexOf('    function getPageNumbers'))
const render = new Function('escapeHtml', 'formatNumericRange', 'toColorSwatchBackground', 'formatPrice', `
  const selectedFilamentIds = new Set(), getCurrency = () => 'EUR', t = () => '';
  const filReorder = { applyOrder() {} }, filResize = { refreshColumns() {} };
  ${transpileModule(script, {}).outputText}
  return { renderFilaments, renderGroupedFilaments };
`)(escapeHtml, formatNumericRange, toColorSwatchBackground, formatPrice)

afterEach(() => { document.body.innerHTML = '' })

it.each(['renderFilaments', 'renderGroupedFilaments'])('%s renders stored text without interpreting markup', mode => {
  document.body.innerHTML = '<table><tbody id="filaments-table"></tbody></table>'
  const text = '<img src=x onerror=alert(1)> &lt;svg&gt; A&B "grade"'
  const attribute = '" onload="alert(1)'
  render[mode]([{
    id: 1, manufacturer_id: 1, manufacturer: { name: text, logo_url: attribute },
    designation: text, material_type: 'PLA', diameter_mm: 1.75,
    manufacturer_sku: text, ams_compatibility: [text, 'AMS'],
    build_plate_compatibility: [text], spool_material: text,
    colors: [{ color: { name: attribute, hex_code: '#FF0000' } }],
  }])
  for (const column of ['sku', 'build_plates', 'spool_material', 'manufacturer', 'designation']) {
    expect(document.querySelector(`.col-${column}`)?.textContent?.trim()).toBe(text)
  }
  expect(document.querySelector('.col-ams')?.textContent).toBe(`${text}, AMS`)
  expect(document.querySelectorAll('img')).toHaveLength(1)
  expect(document.querySelector('img')?.getAttribute('src')).toBe(attribute)
  expect(document.querySelectorAll('[onload], svg, script')).toHaveLength(0)
  expect(document.querySelector('.col-colors span')?.getAttribute('title')).toBe(attribute)
  const group = document.querySelector<HTMLElement>('tr[data-group]')
  group?.click()
  group?.click()
  expect(document.querySelectorAll('img')).toHaveLength(1)
  if (group) expect(group.textContent).toContain(text)
})

it('preserves missing-value fallbacks and normal text', () => {
  document.body.innerHTML = '<table><tbody id="filaments-table"></tbody></table>'
  render.renderFilaments([{ id: 1, designation: 'PLA <silk>', material_type: 'PLA', diameter_mm: 1.75,
    ams_compatibility: [], build_plate_compatibility: null, colors: [] }])
  expect(document.querySelector('.col-designation')?.textContent?.trim()).toBe('PLA <silk>')
  for (const column of ['sku', 'ams', 'build_plates', 'spool_material']) {
    expect(document.querySelector(`.col-${column}`)?.textContent).toBe('-')
  }
})
