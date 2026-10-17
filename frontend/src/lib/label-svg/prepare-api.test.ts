import { expect, it } from 'vitest'
import { prepareSvgApiInput } from './prepare-api'
import { buildSpoolDataFromApiSpool } from '../label-designer'
import { createDefaultLabelDesign } from '../freeform-label/defaults'
import { API_DEFAULT_LABEL_SETTINGS } from '../label-standard'
import type { ApiLabelRenderPayload } from './prepare-api'
import { readFile } from 'node:fs/promises'
import { createSvgRuntime } from './runtime.mjs'
import { renderSvgLabel } from './core.mjs'

export const payload: ApiLabelRenderPayload = {
  spool: { id: 295, remaining_weight_g: 432, purchase_date: '2026-10-05',
    filament: { id: 8, designation: 'Grüße', manufacturer: { name: 'Bambu Lab' },
      type: 'PLA', extra: { article: '11101' } }, extra: { note: 'Ä Ö Ü ß' } },
  preset: null, fieldDefinitions: { spool: {}, filament: {} }, assets: {},
  pixelWidth: 480, pixelHeight: 320, thermal: false,
}

it.each([null, { version: 1, settings: { label: { width: 40, height: 30 } } },
  { version: 2, design: createDefaultLabelDesign('spool') }])('prepares Default, V1 and V2 without changing input', preset => {
  const value = { ...structuredClone(payload), preset }, before = structuredClone(value)
  const result = prepareSvgApiInput(value, 'https://labels.example.test', {})
  expect(result.data).toEqual(buildSpoolDataFromApiSpool(value.spool, undefined, value.fieldDefinitions))
  expect(result.origin).toBe('https://labels.example.test')
  expect(result.preset.version).toBe(2)
  expect(result.assets).toEqual({})
  expect(value).toEqual(before)
  if (preset === null) {
    expect(result.preset.design.label).toMatchObject({ widthMm: API_DEFAULT_LABEL_SETTINGS.widthMm, heightMm: API_DEFAULT_LABEL_SETTINGS.heightMm })
    expect(result.preset.design.elements.filter(e => e.type === 'text').map(e => e.template).join('\n')).toContain('Remaining')
  }
})

it('resolves only supplied embedded assets and rejects invalid origins', () => {
  const logo = { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }
  expect(prepareSvgApiInput({ ...payload, logoUrl: '/manufacturer.png', assets: { photo: '/photo.png' } },
    'https://fila.test', { '/manufacturer.png': logo, '/photo.png': logo }).assets).toEqual({ logo, photo: logo })
  expect(() => prepareSvgApiInput(payload, 'file:///etc/passwd', {})).toThrow(/origin/i)
})

it('prepares filament values and QR targets without spool fields in Default', () => {
  const result = prepareSvgApiInput({ ...payload, spool: undefined, filament: {
    id: 8, designation: 'Filament only', material_type: 'PETG',
    manufacturer: { name: 'Maker' }, custom_fields: { article: 'SKU-42' },
  } }, 'https://fila.test', {})
  expect(result.data.id).toBe('8')
  expect(result.data['filament.id']).toBe('8')
  expect(result.data['filament.name']).toBe('Filament only')
  expect(result.data.extra?.['filament.article']).toBe('SKU-42')
  expect(result.entityPath).toBe('filaments')
  const templates = result.preset.design.elements.filter(e => e.type === 'text').map(e => e.template).join('\n')
  expect(templates).toContain('ID: {id}')
  expect(templates).not.toContain('remaining_weight_g')
})

it('retains the built-in Default color swatch in actual raster output', async () => {
  const value = { ...payload, spool: { id: 295, filament: { designation: 'Red and blue',
    colors: [{ color: { hex_code: 'FF0000' } }, { color: { hex_code: '0000FF' } }] } } }
  const input = prepareSvgApiInput(value, 'https://fila.test', {})
  expect(input.data['filament.color_hexes']).toBe('FF0000, 0000FF')
  const runtime = await createSvgRuntime((path: string) => readFile(`node_modules/${path}`))
  const output = renderSvgLabel(input, runtime)
  expect(output.pixels.some((channel: number, i: number) => i % 4 === 0 && channel > 200 && output.pixels[i + 1] < 50)).toBe(true)
  expect(output.pixels.some((channel: number, i: number) => i % 4 === 2 && channel > 200 && output.pixels[i - 2] < 50)).toBe(true)
})
