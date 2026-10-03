// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const raster = vi.hoisted(() => ({ toCanvas: vi.fn() }))
vi.mock('html-to-image', () => ({ toCanvas: raster.toCanvas }))

import { renderApiLabel, type ApiLabelRenderPayload } from './label-api-render'
import type { LabelDesignV2 } from './freeform-label/types'

const spool = {
  id: 42, filament_id: 8,
  location: { name: 'Rack A' }, status: { label: 'Opened' },
  remaining_weight_g: 712.5, spool_core_weight_g: 42,
  stocked_in_at: '2026-01-03T12:34:56Z',
  custom_fields: { storage: { note: 'Keep dry' }, dry: false },
  custom_field_definitions: { dry: { label: 'Dry', field_type: 'checkbox' } },
  filament: {
    id: 8, designation: 'Galaxy PLA', material_type: 'PLA', manufacturer_id: 5,
    manufacturer: { id: 5, name: 'Example Filaments' },
    raw_material_weight_g: 1000, diameter_mm: 1.75,
    colors: [{ display_name_override: 'Galaxy Blue', color: { name: 'Blue', hex_code: '#123456' } }],
    custom_fields: { temperature: { min: 190, max: 220 }, tags: ['silk', 'sparkle'] },
  },
}
const design: LabelDesignV2 = {
  version: 2,
  label: { widthMm: 60, heightMm: 40, marginMm: 1, border: true },
  elements: [{
    id: 'text', type: 'text', x: 2, y: 2, w: 56, h: 36, z: 0,
    template: '[b]{filament.raw_material_weight_g}[/b]|{filament.weight}|{filament.color}|{location}|{status}|{remaining_weight_g}|{spool_core_weight_g}|{stocked_in_at}|{extra.spool.storage.note}|{extra.spool.dry}|{extra.filament.temperature}|{extra.filament.tags}|{Missing: {external_id}}',
    fontFamily: 'Fraunces', fontSizeMm: 3, fontWeight: 400, italic: false,
    underline: false, align: 'left', color: '#000000', wrap: true,
  }],
}
const payload: ApiLabelRenderPayload = {
  spool, preset: { version: 2, design },
  fieldDefinitions: { filament: {
    temperature: { id: 1, key: 'temperature', label: 'Temperature', field_type: 'range', config: { unit: '°C' } },
    tags: { id: 2, key: 'tags', label: 'Tags', field_type: 'multiselect' },
  } },
  assets: {}, pixelWidth: 1024, pixelHeight: 2048,
}
let captured: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  raster.toCanvas.mockReset().mockImplementation(async (element: HTMLElement) => {
    captured = element.cloneNode(true) as HTMLElement
    return {
      width: 16, height: 1,
      getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(64) }) }),
      toDataURL: () => 'data:image/png;base64,rendered',
    }
  })
  Object.assign(window, { QRCode: class {
    static CorrectLevel: { H: string } = { H: 'H' }
    constructor(root: HTMLElement, options: { text: string }) {
      const marker = document.createElement('span')
      marker.dataset.qrText = options.text
      root.appendChild(marker)
    }
  } })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'QRCode')
  vi.restoreAllMocks()
})

it('captures shared rendering of canonical, nested and typed native spool values', async () => {
  await expect(renderApiLabel(payload)).resolves.toBe('data:image/png;base64,rendered')
  expect(captured.textContent).toBe('1000|1000|Galaxy Blue|Rack A|Opened|712.5|42|2026-01-03T12:34:56Z|Keep dry|✗|190–220 °C|silk, sparkle|')
  expect(captured.querySelector('strong')?.textContent).toBe('1000')
  expect(captured.querySelector<HTMLElement>('[data-label-element-id="text"]')?.style.fontFamily).toContain('Fraunces')
  expect(captured.querySelector('[data-label-editor-chrome]')).toBeNull()
  expect(raster.toCanvas.mock.calls[0][1]).toMatchObject({ pixelRatio: 1, canvasWidth: 1024, canvasHeight: 2048 })
  expect(document.body.children).toHaveLength(0)
})

it('migrates saved v1 settings through the shared designer before capture', async () => {
  await renderApiLabel({ ...payload, preset: { settings: {
    label: { width: 72, height: 36 }, logo: { show: false }, qr: { show: false },
    title: { template: '{filament.raw_material_weight_g}', fitToWidth: false },
    info: { template: '{extra.spool.storage.note}' },
  } } })
  expect(captured.style.width).toBe('72mm')
  expect(captured.style.height).toBe('36mm')
  expect(captured.textContent).toBe('1000Keep dry')
})

it('renders Default with the existing standard layout and native spool values', async () => {
  await renderApiLabel({ ...payload, preset: null })
  expect(captured.style.width).toBe('60mm')
  expect(captured.style.height).toBe('40mm')
  expect(captured.querySelector('.label-designation')?.textContent).toBe('Galaxy PLA PLA')
  expect(captured.querySelector('.label-mfr-text')?.textContent).toBe('Example Filaments')
  expect(captured.querySelector('.label-extra-fields')?.textContent).toContain('712.5 g')
  expect(captured.querySelector<HTMLElement>('[data-qr-text]')?.dataset.qrText).toBe(`${window.location.origin}/spools/42`)
})

it('rejects a missing authorized asset instead of returning a partial label', async () => {
  await expect(renderApiLabel({ ...payload, preset: { version: 2, design: {
    ...design,
    elements: [...design.elements, { id: 'image', type: 'image', x: 2, y: 2, w: 10, h: 10, z: 1, assetId: 'missing', objectFit: 'contain' }],
  } } })).rejects.toThrow(/missing/)
  expect(raster.toCanvas).not.toHaveBeenCalled()
  expect(document.body.children).toHaveLength(0)
})
