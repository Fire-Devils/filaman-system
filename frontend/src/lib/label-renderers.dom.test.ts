// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DESIGNER_DEFAULTS,
  renderDesignerLabel,
} from './label-designer'
import { renderStandardLabel } from './label-standard'

const PAGE_STYLE_SENTINEL = '/* pre-existing page style */'
let pageStyle: HTMLStyleElement

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="label"></div>'
  pageStyle = document.createElement('style')
  pageStyle.id = 'page-style'
  pageStyle.textContent = PAGE_STYLE_SENTINEL
  document.head.appendChild(pageStyle)
  Object.assign(window, { QRCode: {} })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'QRCode')
})

function expectNoBrowserPrintCss() {
  expect(document.querySelector('#page-style')).toBe(pageStyle)
  expect(pageStyle.textContent).toBe(PAGE_STYLE_SENTINEL)
  expect([...document.head.querySelectorAll('style')].some(
    style => style.textContent?.includes('@page'),
  )).toBe(false)
}

describe('label renderers', () => {
  it('does not add browser print CSS when rendering a standard label', async () => {
    await renderStandardLabel({
      element: document.querySelector<HTMLElement>('#label')!,
      data: {
        id: '1',
        designation: 'Sample PLA',
        manufacturer: 'FilaMan',
        material: 'PLA',
        colorName: 'Black',
        hexCode: '000000',
        colorHexes: '#000000',
        multiColorStyle: 'bands',
        extraFields: [],
      },
      settings: {
        widthMm: 60,
        heightMm: 40,
        fontScale: 1,
        qrSizeMm: 18,
        showLogo: false,
        showQR: false,
        showID: true,
        showManufacturer: true,
        showMaterial: true,
        showColor: true,
        showColorSwatch: true,
        showColorHex: true,
      },
    })

    expectNoBrowserPrintCss()
  })

  it('does not add browser print CSS when rendering a Designer label', async () => {
    await renderDesignerLabel({
      element: document.querySelector<HTMLElement>('#label')!,
      data: {
        id: '1',
        'filament.id': '1',
        'filament.name': 'Sample PLA',
        'filament.material': 'PLA',
        'filament.color': 'Black',
        'filament.colors': 'Black',
        'filament.color_hex': '#000000',
        'filament.color_hexes': '#000000',
        'filament.manufacturer': 'FilaMan',
        'filament.manufacturer_id': '1',
        'filament.color_mode': 'single',
        'filament.multi_color_style': 'bands',
        'filament.extruder_temp': '210',
        'filament.bed_temp': '60',
        'filament.raw_material_weight_g': '1000',
        'filament.weight': '1000',
      },
      settings: {
        ...DESIGNER_DEFAULTS,
        qr: { ...DESIGNER_DEFAULTS.qr, show: false },
      },
    })

    expectNoBrowserPrintCss()
  })
})
