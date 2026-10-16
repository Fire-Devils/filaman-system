import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error fontkit has no bundled declarations.
import { create } from 'fontkit'
import { initWasm, layoutText, renderLabel, rasterize } from '../../../tests/label-rendering/render.mjs'
import { fixtures, data } from '../../../tests/label-rendering/fixtures.mjs'
import { LABEL_FONT_FAMILIES, LABEL_FONT_WEIGHTS } from '../freeform-label/types'

const font = create(readFileSync('node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2'))
const box = { w: 22, h: 35, fontSizeMm: 3, minFontSizeMm: 1.5, wrap: true, fitToWidth: false }
const fonts = Object.fromEntries(LABEL_FONT_FAMILIES.flatMap(family => (family === 'Space Mono' ? [400, 700] : LABEL_FONT_WEIGHTS).map(weight => {
  const slug = family.toLowerCase().replaceAll(' ', '-')
  return [`${family}:${weight}`, create(readFileSync(`node_modules/@fontsource/${slug}/files/${slug}-latin-${weight}-normal.woff2`))]
})))
beforeAll(() => initWasm(readFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm')))

describe('shared SVG text layout', () => {
  it('wraps with real glyph widths without dropping accented words', () => {
    const text = 'Hinzugefügt für größere Spulen: weiß, crème'
    const result = layoutText(text, box, font)
    expect(result.lines.length).toBeGreaterThan(1)
    expect(result.lines.join(' ')).toBe(text)
    for (const line of result.lines) {
      expect(font.layout(line).advanceWidth * result.size / font.unitsPerEm).toBeLessThanOrEqual(box.w)
    }
  })
  it('preserves explicit newlines and blank lines when wrapping is disabled', () => {
    expect(layoutText('PLA\n\nArtikel 11101', { ...box, w: 35, wrap: false }, font).lines)
      .toEqual(['PLA', '', 'Artikel 11101'])
  })
  it('fits only when enabled and refuses content that still cannot fit', () => {
    const text = 'Hinzugefügt am Donnerstag 8. Oktober 2026'
    expect(() => layoutText(text, { ...box, h: 9 }, font)).toThrow(/fit/i)
    const result = layoutText(text, { ...box, h: 9, fitToWidth: true }, font)
    expect(result.size).toBeLessThan(3)
    expect(result.size).toBeGreaterThanOrEqual(1.5)
    expect(result.lines.join(' ')).toBe(text)
    expect(() => layoutText(text, { ...box, h: 1, fitToWidth: true }, font)).toThrow(/fit/i)
    expect(() => layoutText('ÄÖÜ\näöü', { ...box, w: 20, h: 3, minFontSizeMm: undefined, fitToWidth: true }, font)).toThrow(/minimum/i)
  })
})

describe('V2 raster semantics', () => {
  it('keeps native inverse text inline instead of introducing a full-width legacy band', () => {
    const preset = { version: 2, design: { version: 2, label: { widthMm: 40, heightMm: 30 }, elements: [
      { id: 'title', type: 'text', x: 1, y: 1, w: 38, h: 6, template: '==PLA==', fontSizeMm: 3, fontWeight: 700, align: 'center' },
    ] } }
    const output = rasterize(renderLabel(preset, data, {}, fonts, 203).svg)
    expect(Array.from(output.pixels.slice((16 * 320 + 10) * 4, (16 * 320 + 10) * 4 + 4))).toEqual([255, 255, 255, 255])
    expect(output.mono.some(value => value !== 0)).toBe(true)
  })
  it('whitens the entire QR slot and refuses less than three dots per module', () => {
    const preset = structuredClone(fixtures[2].preset)
    const result = renderLabel(preset, data, {}, fonts, 203)
    const output = rasterize(result.svg)
    expect(result.qrs[0].dots).toBe(4)
    expect(Array.from(output.pixels.slice((81 * 320 + 161) * 4, (81 * 320 + 161) * 4 + 4))).toEqual([255, 255, 255, 255])
    const q = result.qrs[0]
    if (q.x === undefined || q.y === undefined) throw new Error('Expected thermal QR pixel geometry')
    // Independently check the standard 7×7 finder, not the QR library's own matrix.
    for (let row = -4; row < 7; row++) for (let col = -4; col < 7; col++) {
      const black = row >= 0 && col >= 0 && (row === 0 || col === 0 || row === 6 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4))
      for (let dy = 0; dy < q.dots; dy++) for (let dx = 0; dx < q.dots; dx++) {
        const x = q.x + (col + 4) * q.dots + dx, y = q.y + (row + 4) * q.dots + dy
        expect(output.pixels[(y * 320 + x) * 4]).toBe(black ? 0 : 255)
      }
    }
    const qr = preset.design.elements.find((e: { type: string }) => e.type === 'qr')!
    qr.w = qr.h = 14
    expect(renderLabel(preset, data, {}, fonts, 203).qrs[0].dots).toBe(3)
    qr.w = qr.h = 6
    expect(() => renderLabel(preset, data, {}, fonts, 203)).toThrow(/dots per module/)
  })
  it('preserves field markup as literal text and rejects unsupported styling', () => {
    const preset = structuredClone(fixtures[0].preset)
    const values = { ...data, 'filament.name': '==PLA==' }
    const result = renderLabel(preset, values, {}, fonts, 203)
    expect(result.text[0].text).toBe('==PLA==')
    preset.design.elements[0].fontFamily = 'Unknown font'
    expect(() => renderLabel(preset, values, {}, fonts, 203)).toThrow(/font/i)
  })
  it('uses every selectable font and weight for umlauts without falling back to one face', () => {
    const outputs = new Map<string, string>()
    for (const fontFamily of LABEL_FONT_FAMILIES) for (const fontWeight of LABEL_FONT_WEIGHTS) {
      const preset = structuredClone(fixtures[0].preset)
      preset.design.elements = [{ ...preset.design.elements[0], fontFamily, fontWeight, template: 'ÄÖÜ äöü ß', fontSizeMm: 3 }]
      const result = renderLabel(preset, data, {}, fonts, 203)
      expect(result.text[0].text).toBe('ÄÖÜ äöü ß')
      expect(rasterize(result.svg).mono.some(value => value !== 0)).toBe(true)
      outputs.set(`${fontFamily}:${fontWeight}`, result.svg)
    }
    expect(new Set(outputs.values()).size).toBe(14)
    expect(outputs.get('Space Mono:500')).toBe(outputs.get('Space Mono:400'))
    expect(outputs.get('Space Mono:600')).toBe(outputs.get('Space Mono:700'))
  })
  it('wraps and shrinks mixed-font runs together while keeping field markup literal', () => {
    const preset = structuredClone(fixtures[0].preset)
    preset.design.elements = [{ ...preset.design.elements[1], x: 1, y: 1, w: 22, h: 10,
      fontSizeMm: 3, minFontSizeMm: 1, template: 'Grüße [font=Fraunces]Ü[b]größer[/b][/font] [font=Space Mono]{filament.name}[/font]' }]
    const result = renderLabel(preset, { ...data, 'filament.name': 'ä **ß**' }, {}, fonts, 203)
    expect(result.text[0].text).toBe('Grüße Ügrößer ä **ß**')
    expect(result.text[0].lines.join('').replace(/\s/g, '')).toBe('GrüßeÜgrößerä**ß**')
    expect(result.text[0].size).toBeLessThan(3)
    expect(result.text[0].size).toBeGreaterThanOrEqual(1)
    expect(result.svg).toContain(fonts['Fraunces:400'].glyphForCodePoint('Ü'.codePointAt(0)).path.toSVG())
    expect(result.svg).toContain(fonts['Space Mono:400'].glyphForCodePoint('ß'.codePointAt(0)).path.toSVG())
    preset.design.elements[0].h = 1
    expect(() => renderLabel(preset, data, {}, fonts, 203)).toThrow(/fit/i)
  })
  it('draws circles, horizontal lines and inset square/rectangle strokes inside their boxes', () => {
    const preset = { version: 2, design: { version: 2, label: { widthMm: 40, heightMm: 30 }, elements: [
      { id: 'circle', type: 'shape', shape: 'circle', x: 2, y: 2, w: 10, h: 10, fill: '#000', strokeWidthMm: 0 },
      { id: 'line', type: 'shape', shape: 'line', x: 15, y: 2, w: 10, h: 10, stroke: '#000', strokeWidthMm: 1 },
      { id: 'square', type: 'shape', shape: 'square', x: 2, y: 16, w: 10, h: 10, fill: '', stroke: '#000', strokeWidthMm: 1 },
      { id: 'rect', type: 'shape', shape: 'rectangle', x: 16, y: 16, w: 20, h: 8, fill: '#000', strokeWidthMm: 0 },
    ] } }
    const output = rasterize(renderLabel(preset, data, {}, fonts, 203).svg)
    const shade = (x: number, y: number) => output.pixels[(Math.floor(y * 8) * 320 + Math.floor(x * 8)) * 4]
    expect(shade(2.5, 2.5)).toBe(255)
    expect(shade(7, 7)).toBe(0)
    expect(shade(20, 7)).toBe(0)
    expect(shade(20, 3)).toBe(255)
    expect(shade(1.75, 20)).toBe(255)
    expect(shade(2.5, 20)).toBe(0)
    expect(shade(7, 20)).toBe(255)
    expect(shade(30, 20)).toBe(0)
    expect(shade(30, 25)).toBe(255)
  })
  it('uses the separator font when wrapping at an inline font boundary', () => {
    const preset = structuredClone(fixtures[0].preset)
    preset.design.elements = [{ ...preset.design.elements[1], x: 1, y: 1, w: 5, h: 20,
      fontSizeMm: 3, fitToWidth: false, template: 'A[font=Space Mono] B[/font]' }]
    // A + Space Mono space + B is 5.562 mm, not 4.497 mm with the wrong space.
    expect(renderLabel(preset, data, {}, fonts, 203).text[0].lines).toEqual(['A', 'B'])
  })
  it('does not charge line height for an empty conditional text box', () => {
    const preset = structuredClone(fixtures[0].preset)
    preset.design.elements = [{ ...preset.design.elements[1], x: 1, y: 1, w: 5, h: 0.5,
      fontSizeMm: 3, fitToWidth: false, template: '[if={missing}]ÄÖÜ[/if]' }]
    const result = renderLabel(preset, data, {}, fonts, 203)
    expect(result.text[0].lines).toEqual([])
    expect(rasterize(result.svg).mono.every(value => value === 0)).toBe(true)
  })
  it('renders nested italic, underline, inline size and inverse without printing markup', () => {
    const preset = structuredClone(fixtures[0].preset)
    preset.design.elements = [{ ...preset.design.elements[1], x: 1, y: 1, w: 38, h: 28,
      template: '[i]Äöü[/i] __ß__ [size=150][b]Groß[/b][/size]\n==[font=Fraunces]Weiß[/font]== @@Farbe@@' }]
    const result = renderLabel(preset, { ...data, 'filament.color_hexes': '#FF0000,#0000FF' }, {}, fonts, 203)
    expect(result.text[0].text).toBe('Äöü ß Groß\nWeiß Farbe')
    const raster = rasterize(result.svg)
    expect(raster.pixels.some((v, i) => i % 4 === 0 && v > 180 && raster.pixels[i + 1] < 80)).toBe(true)
    const plain = structuredClone(preset)
    plain.design.elements[0].template = 'Äöü ß Groß\nWeiß Farbe'
    expect(result.svg).not.toBe(renderLabel(plain, data, {}, fonts, 203).svg)
  })
  it('fits inline size by its actual height and supports inline swatches', () => {
    const preset = structuredClone(fixtures[0].preset)
    preset.design.elements = [{ ...preset.design.elements[1], x: 1, y: 1, w: 38, h: 10,
      template: '[size=300]Ü[/size]\n{color_swatch[5]} Artikel 11101', fontSizeMm: 3, minFontSizeMm: 1 }]
    const result = renderLabel(preset, data, {}, fonts, 203)
    expect(result.text[0].size).toBeLessThan(3)
    expect(result.text[0].text).toContain('Artikel 11101')
    expect(rasterize(result.svg).mono.some(value => value)).toBe(true)
    preset.design.elements[0] = { ...preset.design.elements[0], template: '[size=300]Ü[/size]\nlast', legacyTextRole: 'info', h: 9 }
    const legacy = renderLabel(preset, data, {}, fonts, 203).text[0]
    expect(legacy.size).toBeLessThan(3)
    expect(legacy.lines).toEqual(['Ü', 'last'])
  })
  it('renders standalone swatch bands, border and manually aligned logos', () => {
    const preset = { version: 2, design: { version: 2, label: { widthMm: 40, heightMm: 30, marginMm: 1, border: true }, elements: [
      { id: 'swatch', type: 'swatch', x: 2, y: 2, w: 20, h: 5, radiusMm: 0 },
      { id: 'logo', type: 'manufacturerLogo', x: 2, y: 10, w: 30, h: 10, align: 'right', manualSizeMm: 4 },
    ] } }
    const png = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="black"/></svg>').png
    const assets = { logo: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, width: 10, height: 10 } }
    const result = renderLabel(preset, { ...data, 'filament.color_hexes': '#FF0000,#0000FF' }, assets, fonts, 203)
    const raster = rasterize(result.svg)
    const rgb = (x: number, y: number) => Array.from(raster.pixels.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 3))
    expect(rgb(30, 30)).toEqual([255, 0, 0])
    expect(rgb(130, 30)).toEqual([0, 0, 255])
    expect(rgb(235, 120)).toEqual([0, 0, 0])
    expect(rgb(40, 120)).toEqual([255, 255, 255])
    expect(rgb(8, 100)).toEqual([0, 0, 0])
  })
  it('keeps pixels outside an image crop out of its contain letterbox', () => {
    const preset = structuredClone(fixtures[1].preset)
    preset.design.elements = [{ id: 'crop', type: 'image', x: 1, y: 1, w: 12, h: 12, assetId: 'photo', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }]
    const png = rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="black"/></svg>').png
    const assets = { photo: { dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, width: 120, height: 80 } }
    const raster = rasterize(renderLabel(preset, data, assets, fonts, 203).svg)
    for (const x of [12, 100]) expect(raster.pixels[(48 * 320 + x) * 4]).toBe(255)
    expect(raster.pixels[(48 * 320 + 48) * 4]).toBe(0)
  })
  it('collapses migrated logo/title rows while retaining bottom QR placement', () => {
    const preset = { version: 2, design: { version: 2, label: { widthMm: 40, heightMm: 30 }, elements: [
      { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 38, h: 4, collapseWhenEmpty: true },
      { id: 'title', type: 'text', x: 1, y: 5.5, w: 38, h: 3, template: '[if={missing}]gone[/if]', fontSizeMm: 3, legacyTextRole: 'title' },
      { id: 'info', type: 'text', x: 1, y: 9, w: 18, h: 19, template: 'Ü', fontSizeMm: 2, legacyTextRole: 'info' },
      { id: 'qr', type: 'qr', x: 20, y: 10, w: 19, h: 19, mode: 'simple', legacyVAlign: 'bottom' },
    ] } }
    const result = renderLabel(preset, data, {}, fonts, 203)
    expect(result.text.map((item: { id: string }) => item.id)).toEqual(['info'])
    expect(result.text[0].y).toBe(1.5)
    expect(result.qrs[0].y).toBe(82)
    expect(preset.design.elements[2].y).toBe(9)
  })
  it('keeps normal QR decoration separate from thermal and resolves filament links', () => {
    const preset = structuredClone(fixtures[2].preset)
    const values = { ...data, 'filament.id': '41' }
    const thermal = renderLabel(preset, values, {}, fonts, 203)
    const normal = renderLabel(preset, values, {}, fonts, 203, 'https://fila.test', { thermal: false, entityPath: 'filaments' })
    expect(thermal.qrs[0].level).toBe('M')
    expect(thermal.qrs[0].decorated).toBe(false)
    expect(normal.qrs[0].level).toBe('H')
    expect(normal.qrs[0].decorated).toBe(true)
    expect(normal.qrs[0].url).toBe('https://fila.test/filaments/41')
    expect(rasterize(normal.svg).mono.some(value => value)).toBe(true)
  })
})
