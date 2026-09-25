// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getDesignerLabelDimensions,
  renderDesignerLabel,
} from './label-designer'
import { renderStandardLabel } from './label-standard'
import type { LabelDesignV2 } from './freeform-label/types'

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
  it('reads physical dimensions from a v2 freeform design', () => {
    expect(getDesignerLabelDimensions({
      version: 2,
      label: { widthMm: 72, heightMm: 36, marginMm: 1, border: false },
      elements: [],
    })).toEqual({ widthMm: 72, heightMm: 36 })
  })

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

  it('rejects legacy settings instead of retaining the old runtime renderer', async () => {
    await expect(renderDesignerLabel({
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
      settings: {},
    } as unknown as Parameters<typeof renderDesignerLabel>[0]))
      .rejects.toThrow('A version 2 label design is required')
  })

  it('renders v2 freeform designs through the shared Designer entry point', async () => {
    const design: LabelDesignV2 = {
      version: 2,
      label: { widthMm: 72, heightMm: 35, marginMm: 1, border: false },
      elements: [{
        id: 'title',
        type: 'text',
        x: 2,
        y: 3,
        w: 50,
        h: 8,
        z: 0,
        template: '{filament.name}',
        fontFamily: 'Space Grotesk',
        fontSizeMm: 4,
        fontWeight: 700,
        italic: false,
        underline: false,
        align: 'left',
        color: '#000000',
        wrap: false,
      }],
    }
    const root = document.querySelector<HTMLElement>('#label')!

    await renderDesignerLabel({
      element: root,
      design,
      data: {
        id: '1',
        'filament.id': '1',
        'filament.name': 'Freeform PLA',
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
    })

    expect(root.style.width).toBe('72mm')
    expect(root.querySelector('[data-label-element-id="title"]')?.textContent).toBe('Freeform PLA')
    expectNoBrowserPrintCss()
  })
})
