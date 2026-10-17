import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDefaultLabelDesign } from '../freeform-label/defaults'
import { fontFiles } from './core.mjs'

const input = () => ({ payload: { spool: { id: 295, filament: { designation: 'Grüße ÄÖÜ ß', type: 'PLA' } },
  preset: { version: 2, design: createDefaultLabelDesign('spool') }, fieldDefinitions: { spool: {}, filament: {} },
  assets: {}, pixelWidth: 480, pixelHeight: 320, thermal: false }, origin: 'https://fila.test', assets: {} })
const run = (value: unknown, entry = 'dist/label-svg/render.mjs') => {
  const result = spawnSync(process.env.LABEL_NODE_EXECUTABLE || process.execPath, [entry],
    { input: typeof value === 'string' ? value : JSON.stringify(value), encoding: 'utf8', timeout: 30000 })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}
it('runs the built renderer without Vite and returns an exact-size PNG', () => {
  const png = Buffer.from(run(input()).png, 'base64')
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([480, 320])
  expect(run({ ...input(), payload: { ...input().payload, preset: null } }).png).toBeTruthy()
})

it('loads only used faces, including nested bold fonts and the QR brand, without changing pixels', () => {
  const value = input()
  value.payload.preset.design.label = { widthMm: 40, heightMm: 30, marginMm: 1, border: false }
  value.payload.preset.design.elements = [
    { id: 'mixed', type: 'text', x: 1, y: 1, w: 38, h: 9, z: 0,
      template: 'Grüße [font=Fraunces][b]ÄÖÜ ß[/b][/font] {filament.name}[if={missing}][font=Roboto Condensed]hidden[/font][/if]',
      fontFamily: 'Space Mono', fontWeight: 500, fontSizeMm: 3, wrap: true, fitToWidth: true, minFontSizeMm: 1,
      italic: false, underline: false, align: 'left', color: '#000000' },
    { id: 'qr', type: 'qr', x: 1, y: 11, w: 18, h: 18, z: 1, mode: 'logo', linkMode: 'url', urlTemplate: 'https://fila.test' },
  ]
  value.payload.spool.filament.designation = '[font=Roboto Condensed]literal[/font]'
  const expected = run(value).png
  expect(expected).toBeTruthy()
  const directory = mkdtempSync(join(tmpdir(), 'label-fonts-'))
  try {
    cpSync('dist/label-svg', directory, { recursive: true })
    const needed = ['Space Mono:400', 'Fraunces:700', 'Space Grotesk:700']
    for (const { key, file } of fontFiles) if (!needed.includes(key)) rmSync(join(directory, 'resources', file))
    const entry = join(directory, 'render.mjs')
    const actual = run(value, entry)
    expect(actual.error).toBeUndefined()
    const hash = (png: string) => createHash('sha256').update(png).digest('hex')
    expect(hash(actual.png)).toBe(hash(expected))
    // A missing required face must still be an internal runtime failure, not a layout error.
    rmSync(join(directory, 'resources/@fontsource/fraunces/files/fraunces-latin-700-normal.woff2'))
    expect(run(value, entry).error).toEqual({ kind: 'internal', message: 'Shared label runtime unavailable' })
    value.payload.preset.design.elements = [
      { id: 'shape', type: 'shape', shape: 'circle', x: 1, y: 1, w: 10, h: 10, z: 0, fill: '#000000', stroke: '', strokeWidthMm: 0, radiusMm: 0 },
    ]
    rmSync(join(directory, 'resources/@fontsource'), { recursive: true })
    expect(hash(run(value, entry).png)).toBe(hash(run(value).png))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it('reports malformed JSON, missing images and overflow explicitly', () => {
  expect(run('{').error.kind).toBe('layout')
  const value = input()
  value.payload.preset.design.elements = [{ id: 'photo', type: 'image', assetId: 'missing', x: 1, y: 1, w: 10, h: 10, z: 0, objectFit: 'contain' }]
  expect(run(value).error).toMatchObject({ kind: 'layout', message: expect.stringMatching(/image/i) })
  value.payload.preset.design.elements = [{ id: 'tiny', type: 'text', template: 'Too much text', x: 1, y: 1, w: 1, h: 1, z: 0, fontSizeMm: 3, fontFamily: 'Space Grotesk', fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000', wrap: true }]
  expect(run(value).error).toMatchObject({ kind: 'layout', message: expect.stringMatching(/fit/i) })
})
