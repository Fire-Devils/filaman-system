import { readFile } from 'node:fs/promises'
import { beforeAll, expect, it, vi } from 'vitest'
import { Resvg } from '@resvg/resvg-wasm'
import { renderSvgLabel, rasterize, rasterizePng, layoutText } from './core.mjs'
import { createSvgRuntime } from './runtime.mjs'
import type { SvgInput, SvgRuntime } from './types'
import { fixtures, data } from '../../../tests/label-rendering/fixtures.mjs'
import { LABEL_FONT_FAMILIES } from '../freeform-label/types'
import { prepareSvgApiInput } from './prepare-api'

let runtime: SvgRuntime
beforeAll(async () => {
  runtime = await createSvgRuntime((path: string) => readFile(`node_modules/${path}`))
})
const input = () => ({ preset: structuredClone(fixtures[0].preset), data, assets: {},
  pixelWidth: 641, pixelHeight: 481, origin: 'https://fila.test', entityPath: 'spools', thermal: false } as unknown as SvgInput)
const render = (value: SvgInput, threshold = 200) => renderSvgLabel(value, runtime, threshold)

it.each(['{extra.spool.missing}', '[if={missing}]ID: {id}[/if]', '**{extra.spool.missing}**',
  '==[font=Fraunces]{extra.spool.missing}[/font]=='])('renders migrated empty zero-area info: %s', template => {
  const payload = { spool: { id: 295, filament: {} }, preset: { version: 1, settings: {
    label: { width: 20, height: 40 }, logo: { show: false }, title: { show: false },
    qr: { sizeMm: 18, mode: 'simple' }, info: { template },
  } }, fieldDefinitions: { spool: {}, filament: {} }, assets: {}, pixelWidth: 400, pixelHeight: 800, thermal: false }
  const migrated = prepareSvgApiInput(payload, 'https://fila.test', {})
  const saved = prepareSvgApiInput({ ...payload, preset: migrated.preset }, 'https://fila.test', {})
  for (const value of [migrated, saved]) {
    const info = value.preset.design.elements.find(e => e.type === 'text')!
    expect(info).toMatchObject({ w: 0, h: 38, legacyTextRole: 'info' })
    const before = structuredClone(value)
    const result = render(value)
    const withoutInfo = structuredClone(value)
    withoutInfo.preset.design.elements = withoutInfo.preset.design.elements.filter(e => e.id !== info.id)
    expect(result.png).toEqual(render(withoutInfo).png)
    expect(result.qrs).toHaveLength(1)
    expect(result.boxes.find((box: { id: string }) => box.id === info.id)).toMatchObject({ w: 0, h: 38 })
    expect(value).toEqual(before)
  }
})

it('only permits empty zero-area legacy text, not invalid geometry or hidden content', () => {
  const value = input()
  value.preset.design.elements = [{ id: 'info', type: 'text', x: 1, y: 1, w: 5, h: 0, z: 0,
    template: '{missing}', fontSizeMm: 3, legacyTextRole: 'info' }] as SvgInput['preset']['design']['elements']
  expect(render(value).mono.every((byte: number) => byte === 0)).toBe(true)
  const empty = value.preset.design.elements[0]
  for (const patch of [{ template: 'Visible' }, { template: '{id}' }, { legacyTextRole: undefined },
    { template: '\u0301', w: 0, h: 30 }, { template: '\u0308', w: 0, h: 30 },
    { w: -1 }, { x: NaN }, { h: Infinity }]) {
    value.preset.design.elements[0] = { ...empty, ...patch } as typeof empty
    expect(() => render(value)).toThrow(/Invalid geometry|Text .*fit/)
  }
})

it.each(LABEL_FONT_FAMILIES)('renders typed checkbox fields with mixed markup, wrapping and fitting in %s', fontFamily => {
  const value = input()
  value.preset.design.elements = [{ id: 'text', type: 'text', x: 1, y: 1, w: 25, h: 25,
    template: 'Dry: {extra.spool.dry} ==**__*{extra.spool.dry}*__**==\n[size=150]{extra.spool.dry}[/size] Grüße',
    fontFamily, fontSizeMm: 8, fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000',
    wrap: true, fitToWidth: true, minFontSizeMm: 1, z: 0 }]
  const outputs = [true, false].map(dry => {
    const prepared = prepareSvgApiInput({ spool: { id: 1, filament: {}, custom_fields: { dry },
      custom_field_definitions: { dry: { label: 'Dry', field_type: 'checkbox' } } },
      preset: value.preset, fieldDefinitions: { spool: {}, filament: {} }, assets: {},
      pixelWidth: 400, pixelHeight: 300, thermal: false }, 'https://fila.test', {})
    const output = render(prepared)
    expect(output.text[0].text).toContain(dry ? '✓' : '✗')
    expect(output.text[0].lines.length).toBeGreaterThan(1)
    expect(output.text[0].size).toBeLessThan(8)
    expect(output.mono.some((byte: number) => byte !== 0)).toBe(true)
    return output
  })
  expect(outputs[0].png).not.toEqual(outputs[1].png)
})

it.each(['rectangle', 'square', 'circle'] as const)('keeps a small %s visible when its stroke consumes its interior', shape => {
  const value = input()
  value.pixelWidth = 400
  value.pixelHeight = 300
  value.preset.design.label = { widthMm: 40, heightMm: 30, marginMm: 0, border: false }
  for (const strokeWidthMm of [1, 2, 3]) {
    value.preset.design.elements = [{ id: 'shape', type: 'shape', shape, x: 5, y: 5,
      w: 2, h: 2, fill: '', radiusMm: 0, stroke: '#000000', strokeWidthMm, z: 0 }]
    const output = render(value)
    const pixel = (x: number, y: number) => [...output.pixels.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 4)]
    expect(pixel(60, 60)).toEqual([0, 0, 0, 255])
    expect(pixel(48, 60)).toEqual([255, 255, 255, 255])
    expect(pixel(71, 60)).toEqual([255, 255, 255, 255])
  }
})

it('retains line thickness and rejects invalid shape strokes', () => {
  const value = input()
  value.preset.design.elements = [{ id: 'line', type: 'shape', shape: 'line', x: 5, y: 5,
    w: 10, h: 1, fill: '', radiusMm: 0, stroke: '#000000', strokeWidthMm: 3, z: 0 }]
  expect(render(value).svg).toContain('stroke-width="3"')
  for (const strokeWidthMm of [-1, NaN, Infinity]) {
    value.preset.design.elements[0] = { ...value.preset.design.elements[0], strokeWidthMm } as typeof value.preset.design.elements[0]
    expect(() => render(value)).toThrow(/Invalid shape stroke/)
  }
})

it('reuses font measurements while fitting a long word without losing characters', () => {
  const font = runtime.fonts['Space Grotesk:400']
  const shaping = vi.spyOn(font, 'layout')
  try {
    const result = layoutText('W'.repeat(250), { w: 98, h: 98, fontSizeMm: 8, minFontSizeMm: 0.265, wrap: true, fitToWidth: true }, font)
    expect(result.lines.join('')).toBe('W'.repeat(250))
    expect(result.size).toBeLessThan(8)
    expect(result.height).toBeLessThanOrEqual(98)
    expect(shaping.mock.calls.length).toBeLessThan(100)
  } finally { shaping.mockRestore() }
})

it.each([[-5, 5], [30, 5], [5, -5], [5, 20]])('rejects a thermal QR clipped at %s,%s', (x, y) => {
  const value = input()
  value.thermal = true
  value.preset.design.elements = [{ id: 'qr', type: 'qr', x, y, w: 18, h: 18, z: 0, mode: 'simple' }] as SvgInput['preset']['design']['elements']
  expect(() => render(value)).toThrow(/fit inside the label/i)
})

it('produces identical PNG bytes without reading back unused RGBA pixels', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="7"><circle cx="4" cy="3" r="2" fill="#02e57f"/></svg>'
  const expected = rasterize(svg).png
  const renderer = new Resvg(svg), image = renderer.render()
  const pixels = vi.spyOn(Object.getPrototypeOf(image), 'pixels', 'get').mockImplementation(() => {
    throw new Error('PNG-only rendering must not allocate an RGBA copy')
  })
  try { expect(rasterizePng(svg)).toEqual(expected) }
  finally { pixels.mockRestore(); image.free(); renderer.free() }
})

it('uses the same fixed-point luminance rounding as Pillow at threshold boundaries', () => {
  const output = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="1"><rect width="9" height="1" fill="#02e57f"/></svg>', 150)
  // Pillow RGB(2, 229, 127) -> L=150; equality is white, not black.
  expect([...output.mono]).toEqual([0, 0])
})

it('keeps multiple QR hit boxes and opaque clearance above non-QR artwork', () => {
  const value = input()
  value.thermal = true
  value.preset.design.elements = [
    { id: 'qr-a', type: 'qr', x: 1, y: 1, w: 18, h: 18, z: 0, mode: 'simple' },
    { id: 'qr-b', type: 'qr', x: 21, y: 1, w: 18, h: 18, z: 1, mode: 'logo' },
    { id: 'background', type: 'shape', shape: 'rectangle', x: 0, y: 0, w: 40, h: 30, z: 99, fill: '#000' },
  ] as SvgInput['preset']['design']['elements']
  const result = render(value)
  expect(result.qrs.map((qr: { id: string }) => qr.id)).toEqual(['qr-a', 'qr-b'])
  expect(result.boxes).toHaveLength(3)
  for (const qr of result.qrs) {
    const index = (qr.y! * result.width + qr.x!) * 4
    expect(Array.from(result.pixels.slice(index, index + 4))).toEqual([255, 255, 255, 255])
    expect(qr.dots).toBeGreaterThanOrEqual(3)
  }
})

it('honors explicit output dimensions and threshold endpoints without mutating the design', () => {
  const value = input(), before = structuredClone(value)
  const result = render(value, 0)
  expect([result.width, result.height]).toEqual([641, 481])
  expect(result.mono).toHaveLength(81 * 481)
  expect(result.mono.every((byte: number) => byte === 0)).toBe(true)
  expect(render(value, 255).mono.some((byte: number) => byte !== 0)).toBe(true)
  expect(value).toEqual(before)
  expect(() => render({ ...value, pixelWidth: 0 })).toThrow(/dimension|pixel/i)
  expect(() => render({ ...value, pixelWidth: 8001, pixelHeight: 1000 })).toThrow(/pixel/i)
})

it('returns collapsed geometry for editor hit targets, including hidden rows', () => {
  const value = input()
  value.preset.design.elements = [
    { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 38, h: 4, collapseWhenEmpty: true },
    { id: 'title', type: 'text', x: 1, y: 5.5, w: 38, h: 3, template: '[if={missing}]gone[/if]', fontSizeMm: 3, legacyTextRole: 'title' },
    { id: 'info', type: 'text', x: 1, y: 9, w: 18, h: 19, template: 'Ü', fontSizeMm: 2, legacyTextRole: 'info' },
  ] as SvgInput['preset']['design']['elements']
  const result = render(value)
  expect(result.boxes.find((box: { id: string }) => box.id === 'logo').hidden).toBe(true)
  expect(result.boxes.find((box: { id: string }) => box.id === 'title').hidden).toBe(true)
  expect(result.boxes.find((box: { id: string }) => box.id === 'info')).toMatchObject({ y: 1.5, hidden: false })
})
