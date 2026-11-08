// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-wasm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderDesignerLabel, buildSpoolDataFromFlatLabel } from '../label-designer'
import { renderSvgElementOutput, redrawSvgGesture, bindSvgClone, prepareSvgPrintImages, clearSvgDesignerLabel } from './browser'
import type { LabelDesignV2 } from '../freeform-label/types'
import { renderStandardLabel, API_DEFAULT_LABEL_SETTINGS } from '../label-standard'
import { getTemplateSelectionRange } from '../freeform-label/template-selection'
import { LabelOutputAssetError } from '../label-output-readiness'

const readRasterizer = vi.hoisted(() => vi.fn<() => Promise<Uint8Array>>())
vi.mock('./runtime.mjs', async importOriginal => {
  const module = await importOriginal<typeof import('./runtime.mjs')>()
  return { createSvgRuntime: (_readAsset: unknown, raster: boolean) => module.createSvgRuntime((path: string) =>
    path.endsWith('.wasm') ? readRasterizer() : readFile(`node_modules/${path}`), raster) }
})
readRasterizer.mockImplementation(() => readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm'))
let previewId = 0
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:label-preview-${++previewId}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  document.querySelectorAll<HTMLElement>('[data-label-svg]').forEach(clearSvgDesignerLabel)
  vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren()
})
const data = buildSpoolDataFromFlatLabel({ id: 295, designation: 'Ä Ö Ü ß' })
function design(): LabelDesignV2 {
  return { version: 2, label: { widthMm: 40, heightMm: 30, marginMm: 1, border: false }, elements: [
    { id: 'logo', type: 'manufacturerLogo', x: 1, y: 1, w: 38, h: 4, z: 0, objectFit: 'contain', collapseWhenEmpty: true },
    { id: 'title', type: 'text', x: 1, y: 5.5, w: 38, h: 3, z: 1, template: '[if={missing}]gone[/if]', fontSizeMm: 3, legacyTextRole: 'title' },
    { id: 'info', type: 'text', x: 1, y: 9, w: 18, h: 19, z: 2, template: '{filament.name}', fontSizeMm: 2, legacyTextRole: 'info' },
    { id: 'qr', type: 'qr', x: 21, y: 10, w: 18, h: 18, z: 3, mode: 'simple', legacyVAlign: 'bottom' },
  ] as LabelDesignV2['elements'] }
}
function root() { const node = document.createElement('div'); document.body.append(node); return node }

it('keeps a rasterizer load failure out of preview and makes the whole output retryable', async () => {
  const element = root(), value = design()
  readRasterizer.mockRejectedValueOnce(new Error('Network unavailable'))
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  expect(readRasterizer).not.toHaveBeenCalled()
  expect(element.querySelector('[data-label-svg-raster]')).not.toBeNull()
  await expect(renderSvgElementOutput(element, 480, 360, false)).rejects.toBeInstanceOf(LabelOutputAssetError)
  expect(element.hasAttribute('data-label-output-error')).toBe(false)
  await expect(renderSvgElementOutput(element, 480, 360, false)).resolves.toMatchObject({ width: 480, height: 360 })
  expect(readRasterizer).toHaveBeenCalledTimes(2)
})

it.each([[40, 30], [300, 200]])('uses vector artwork for a %s × %s mm interactive preview without encoding a PNG', async (widthMm, heightMm) => {
  const element = root(), value = design()
  Object.assign(value.label, { widthMm, heightMm })
  const render = vi.spyOn(Resvg.prototype, 'render').mockImplementation(() => { throw new Error('Preview must not rasterize') })
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  expect(element.dataset.labelOutputError).toBeUndefined()
  expect(element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).toMatch(/^blob:/)
  const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
  expect(blob.type).toBe('image/svg+xml')
  expect(await blob.text()).toContain('<svg')
  expect(render).not.toHaveBeenCalled()
})

it('defers batch rasterization until final output and keeps the sheet copy printable', async () => {
  const element = root(), value = design()
  const logo = await readFile('public/logo-qr.png')
  Object.assign(value.elements.find(e => e.id === 'qr')!, { mode: 'colorLogo' })
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(logo), { headers: { 'Content-Type': 'image/png' } }))
  vi.stubGlobal('createImageBitmap', async () => ({ width: logo.readUInt32BE(16), height: logo.readUInt32BE(20), close() {} }))
  const raster = vi.spyOn(Resvg.prototype, 'render')
  await renderDesignerLabel({ element, design: value, data, vectorPreview: true })
  expect(element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).toMatch(/^blob:/)
  expect(element.querySelector('[data-label-editor-chrome]')).toBeNull()
  expect(raster).not.toHaveBeenCalled()
  const clone = element.cloneNode(true) as HTMLElement
  bindSvgClone(element, clone)
  await prepareSvgPrintImages([clone], 600)
  expect(clone.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).toMatch(/^data:image\/png;/)
  expect(raster).toHaveBeenCalledOnce()
})

it.each([false, true])('budgets only distinct artwork in batch previews (distinct: %s)', async distinct => {
  const element = root(), value = design()
  const logo = await readFile('public/logo-qr.png')
  const other = await readFile('public/logo.png')
  const source = 'data:image/png;base64,' + logo.toString('base64')
  value.elements = [1, 15].map((x, z) => ({
    id: `image-${z}`, type: 'image', assetId: distinct && z === 1 ? 'other' : 'shared', x, y: 1, w: 12, h: 12, z, objectFit: 'contain',
  }))
  vi.stubGlobal('createImageBitmap', async () => ({ width: logo.readUInt32BE(16), height: logo.readUInt32BE(20), close() {} }))
  await renderDesignerLabel({ element, design: value, data, vectorPreview: true,
    resolveAssetUrl: id => id === 'other' ? 'data:image/png;base64,' + other.toString('base64') : source })
  const preview = element.querySelector<HTMLImageElement>('[data-label-svg-raster]')?.src
  expect(preview?.slice(0, 15)).toMatch(distinct ? /^data:image\/png;/ : /^blob:/)

  const clone = element.cloneNode(true) as HTMLElement
  bindSvgClone(element, clone)
  await prepareSvgPrintImages([clone], 600)
  const png = Buffer.from(clone.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src.split(',')[1], 'base64')
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([945, 709])
})

it('releases replaced SVG URLs and replaces sheet copies with print-grade PNGs', async () => {
  const element = root(), value = design()
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  const previous = element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src
  value.elements.find(e => e.id === 'info')!.x = 2
  redrawSvgGesture(element, value)
  await new Promise(requestAnimationFrame)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(previous)
  const current = element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src
  const clone = element.cloneNode(true) as HTMLElement
  bindSvgClone(element, clone)
  await prepareSvgPrintImages([clone], 600)
  expect(clone.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).toMatch(/^data:image\/png;/)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(current)
  clearSvgDesignerLabel(element)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(current)
})

it('marks conflicting QR boxes locally and blocks output until separated', async () => {
  const element = root(), value = design()
  value.label.widthMm = 50
  value.elements = [
    { id: 'a', type: 'qr', x: 1, y: 2, w: 18, h: 18, z: 0, mode: 'simple', linkMode: 'spool', urlTemplate: '' },
    { id: 'b', type: 'qr', x: 21, y: 2, w: 18, h: 18, z: 1, mode: 'simple', linkMode: 'spool', urlTemplate: '' },
  ]
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  expect(element.hasAttribute('data-label-output-error')).toBe(false)
  expect(element.querySelectorAll('[data-label-element-id][data-label-output-error]')).toHaveLength(2)
  expect(element.textContent).toContain('Move QR codes farther apart')
  await expect(renderSvgElementOutput(element, 500, 300, true)).rejects.toThrow(/farther apart/)
  const warning = element.querySelector('[data-label-fit-warning]')
  value.elements[1].y = 3
  redrawSvgGesture(element, value)
  await new Promise(requestAnimationFrame)
  expect(element.querySelector('[data-label-fit-warning]')).toBe(warning)
  value.elements[1].x = 28
  redrawSvgGesture(element, value)
  await new Promise(requestAnimationFrame)
  expect(element.querySelector('[data-label-element-id][data-label-output-error]')).toBeNull()
  await expect(renderSvgElementOutput(element, 500, 300, true)).resolves.toBeTruthy()
})

it('keeps the label visible and marks only overflowing text boxes with repair advice', async () => {
  const element = root(), value = design()
  value.elements = value.elements.filter(e => e.id !== 'logo' && e.id !== 'title')
  const info = value.elements.find(e => e.id === 'info')!
  Object.assign(info, { template: '220-260\n60-80', h: 2, legacyTextRole: undefined })
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  expect(element.querySelector('[data-label-svg-raster]')).not.toBeNull()
  expect(element.hasAttribute('data-label-output-error')).toBe(false)
  const failed = element.querySelector<HTMLElement>('[data-label-element-id="info"]')!
  expect(failed.dataset.labelOutputError).toMatch(/enlarge|Scale font to fit/i)
  expect(failed.title).toContain('Text does not fit')
  expect(failed.querySelector('[role="alert"]')).toBeNull()
  expect(element.querySelector('[data-label-element-id="qr"]')?.hasAttribute('data-label-output-error')).toBe(false)
  await expect(renderSvgElementOutput(element, 480, 360, false)).rejects.toThrow(/fit/i)
  Object.assign(info, { h: 12 })
  redrawSvgGesture(element, value)
  await new Promise(requestAnimationFrame)
  expect(element.querySelector('[data-label-element-id="info"]')).toBe(failed)
  expect(failed.hasAttribute('data-label-output-error')).toBe(false)
  expect(failed.querySelector('[role="alert"]')).toBeNull()
  await expect(renderSvgElementOutput(element, 480, 360, false)).resolves.toBeTruthy()
})

it('keeps field selection on the editing overlay and omits it from printable output', async () => {
  const element = root(), value = design()
  value.elements = [{ ...value.elements.find(e => e.id === 'info')!, template: '**{filament.name}**' } as LabelDesignV2['elements'][number]]
  await renderDesignerLabel({ element, design: value, data: { ...data, 'filament.name': 'Galaxy PLA' }, interactive: true })
  const token = element.querySelector('[data-template-atomic]')!
  expect(token.textContent).toBe('Galaxy PLA')
  const range = document.createRange()
  range.setStart(token.firstChild!, 1)
  range.setEnd(token.firstChild!, 4)
  expect(getTemplateSelectionRange(element, range)).toEqual({ start: 2, end: 17 })
  const svg = await (vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob).text()
  await renderDesignerLabel({ element, design: value, data: { ...data, 'filament.name': 'Galaxy PLA' }, interactive: false })
  expect(element.querySelector('[data-label-editor-chrome], [data-template-start]')).toBeNull()
  expect(element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).toMatch(/^data:image\/png;/)
  const output = await renderSvgElementOutput(element, 472, 354, false)
  expect(output.svg.slice(output.svg.indexOf('>'))).toBe(svg.slice(svg.indexOf('>')))
})

it('shows selectable missing data markers without changing rendered output', async () => {
  const element = root(), value = design()
  const text = value.elements.find(e => e.type === 'text' && e.id === 'info')!
  if (text.type !== 'text') throw new Error('Expected text fixture')
  text.template = 'A**{filament.bed_temp_range_c|unit}**{extra.zero}{lot_number}[if={extra.empty}]{extra.hidden}[/if]Z'
  value.elements = [text, { id: 'cover', type: 'shape', shape: 'rectangle', x: 1, y: 9, w: 18, h: 4, z: 3,
    fill: '#123456', stroke: '#000000', strokeWidthMm: 0, radiusMm: 0 }]
  const previewData = { ...data, extra: { zero: '0', empty: '' } }
  await renderDesignerLabel({ element, design: value, data: previewData, interactive: true })
  const marker = element.querySelector<HTMLElement>('[data-template-missing]')!
  expect(marker?.textContent).toBe('?')
  expect(marker.hasAttribute('data-template-atomic')).toBe(true)
  expect(marker.title).toBe('No data in token {filament.bed_temp_range_c|unit}')
  const overlay = element.querySelector<HTMLElement>('[data-label-element-id="info"]')!
  expect((overlay.firstElementChild as HTMLElement).style.visibility).toBe('hidden')
  expect(overlay.firstElementChild?.textContent).toBe('A?0?Z')
  expect(overlay.querySelectorAll('[data-template-missing][data-preview-badge]')).toHaveLength(2)
  const previewSvg = await (vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob).text()
  expect(previewSvg.match(/fill="#facc15"/g)).toHaveLength(2)
  expect(previewSvg.lastIndexOf('<path')).toBeLessThan(previewSvg.indexOf('fill="#123456"'))
  expect(previewSvg.lastIndexOf('fill="#facc15"')).toBeLessThan(previewSvg.indexOf('fill="#123456"'))
  expect(element.querySelector('[data-label-output-error]')).toBeNull()
  const output = await renderSvgElementOutput(element, 480, 360, false)
  text.template = 'A0Z'
  await renderDesignerLabel({ element, design: value, data: previewData, interactive: true })
  expect(element.querySelector('[data-template-missing]')).toBeNull()
  const clean = await renderSvgElementOutput(element, 480, 360, false)
  expect(output.svg).toBe(clean.svg)
  expect(output.png).toEqual(clean.png)
})

it.each(['spools', 'filaments'] as const)('renders cached embedded batch logos for %s through preview and export', async entityPath => {
  const element = root()
  const logoUrl = 'data:image/png;base64,' + (await readFile('public/logo-qr.png')).toString('base64')
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 100, height: 100, close }))
  await renderDesignerLabel({ element, design: design(), data, entityPath, logoUrl, interactive: true })
  expect(element.dataset.labelOutputError).toBeUndefined()
  expect(element.querySelector('[data-label-element-id="logo"]')).not.toBeNull()
  const output = await renderSvgElementOutput(element, 320, 240, false)
  expect(output.svg).toContain(logoUrl)
  expect(close).toHaveBeenCalledOnce()
})

it.each(['https://other.example/logo.png', 'data:image/svg+xml,<svg/>', 'data:text/html,<img>'])('rejects unsafe logo sources: %s', async logoUrl => {
  const element = root()
  await renderDesignerLabel({ element, design: design(), data, logoUrl })
  expect(element.hasAttribute('data-label-output-error')).toBe(true)
  expect(element.querySelector('[data-label-svg-raster]')).toBeNull()
  await expect(renderSvgElementOutput(element, 320, 240, false)).rejects.toThrow()
})

it('rejects oversized embedded images before decoding and retains the pixel budget', async () => {
  const element = root(), bitmap = vi.fn()
  vi.stubGlobal('createImageBitmap', bitmap)
  await renderDesignerLabel({ element, design: design(), data, logoUrl: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024) })
  expect(element.dataset.labelOutputError).toBe('Unsupported label image')
  expect(bitmap).not.toHaveBeenCalled()
  const close = vi.fn()
  bitmap.mockResolvedValue({ width: 4001, height: 3000, close })
  await renderDesignerLabel({ element, design: design(), data,
    logoUrl: 'data:image/png;base64,' + (await readFile('public/logo-qr.png')).toString('base64') })
  expect(element.dataset.labelOutputError).toBe('Label image exceeds pixel budget')
  expect(close).toHaveBeenCalledOnce()
})

it('keeps preview, gesture and PNG export pixels without allocating unused raw output', async () => {
  const element = root(), value = design()
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  const previous = element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src
  const previousSvg = await (vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob).text()
  const renderer = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), image = renderer.render()
  const pixels = vi.spyOn(Object.getPrototypeOf(image), 'pixels', 'get').mockImplementation(() => { throw new Error('Unused pixel readback') })
  try {
    await renderDesignerLabel({ element, design: value, data, interactive: true })
    expect(element.dataset.labelOutputError).toBeUndefined()
    expect(await (vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob).text()).toBe(previousSvg)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previous)
    value.elements.find(e => e.id === 'info')!.x = 2
    redrawSvgGesture(element, value)
    await new Promise(requestAnimationFrame)
    expect(element.dataset.labelOutputError).toBeUndefined()
    expect(element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).not.toBe(previous)
    const output = await renderSvgElementOutput(element, 480, 360, false)
    expect(Array.from(output.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  } finally { pixels.mockRestore(); image.free(); renderer.free() }
})

it('mounts shared pixels with authoritative collapsed geometry and topmost QR targets', async () => {
  const element = root()
  await renderDesignerLabel({ element, design: design(), data, interactive: true })
  expect(element.querySelector('[data-label-svg-raster]')).not.toBeNull()
  expect(element.querySelector<HTMLElement>('[data-label-element-id="info"]')?.style.top).toBe('1.5mm')
  expect(element.querySelector('[data-label-element-id="logo"]')).toBeNull()
  expect(element.querySelector('[data-label-element-id="qr"]')?.getAttribute('data-qr-module-count')).toBeTruthy()
  const output = await renderSvgElementOutput(element, 320, 240, true)
  expect([output.width, output.height]).toEqual([320, 240])
  expect(output.qrs.every((qr: { dots: number }) => qr.dots >= 3)).toBe(true)
})

it('discards a delayed older asset request and blocks failed/stale output', async () => {
  const element = root()
  let resolve!: (value: string | null) => void
  const imageDesign = design()
  imageDesign.elements = [{ id: 'image', type: 'image', assetId: 'slow', x: 1, y: 1, w: 10, h: 10, z: 0, objectFit: 'contain' }]
  const first = renderDesignerLabel({ element, design: imageDesign, data, interactive: true,
    resolveAssetUrl: () => new Promise(done => { resolve = done }) })
  await renderDesignerLabel({ element, design: design(), data, interactive: true })
  const before = element.innerHTML
  resolve(null)
  await first
  expect(element.innerHTML).toBe(before)
  await renderDesignerLabel({ element, design: imageDesign, data, interactive: true, resolveAssetUrl: () => null })
  expect(element.hasAttribute('data-label-output-error')).toBe(true)
  expect(element.querySelector('[data-label-element-id="image"]')).not.toBeNull()
  await expect(renderSvgElementOutput(element, 320, 240, false)).rejects.toThrow()
})

it('does not replace an active composition surface', async () => {
  const element = root()
  await renderDesignerLabel({ element, design: design(), data, interactive: true })
  const node = element.querySelector('[data-label-element-id="info"]')!
  node.setAttribute('data-label-composing', '')
  await renderDesignerLabel({ element, design: design(), data: { ...data, 'filament.name': 'New' }, interactive: true })
  expect(element.querySelector('[data-label-element-id="info"]')).toBe(node)
  await expect(renderSvgElementOutput(element, 320, 240, false)).rejects.toThrow()
})

it('repaints a gesture without replacing its handles', async () => {
  const element = root(), value = design()
  await renderDesignerLabel({ element, design: value, data, interactive: true })
  const target = element.querySelector('[data-label-element-id="info"]')
  const previous = element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src
  value.elements.find(e => e.id === 'info')!.x = 2
  redrawSvgGesture(element, value)
  await new Promise(requestAnimationFrame)
  expect(element.querySelector('[data-label-element-id="info"]')).toBe(target)
  expect(element.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src).not.toBe(previous)
  expect((await renderSvgElementOutput(element, 320, 240, false)).boxes.find((box: { id: string }) => box.id === 'info').x).toBe(2)
})

it('renders sheet copies at output resolution and rejects stale clone context', async () => {
  const element = root()
  await renderDesignerLabel({ element, design: design(), data, interactive: true })
  const clone = element.cloneNode(true) as HTMLElement
  bindSvgClone(element, clone)
  await prepareSvgPrintImages([clone], 600)
  const png = Buffer.from(clone.querySelector<HTMLImageElement>('[data-label-svg-raster]')!.src.split(',')[1], 'base64')
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([945, 709])
  await renderDesignerLabel({ element, design: design(), data: { ...data, 'filament.name': 'Changed' } })
  await expect(prepareSvgPrintImages([clone], 600)).rejects.toThrow(/changed/i)
})

it.each([false, true])('invalidates completed and pending SVG work when switching to standard (pending=%s)', async pending => {
  const element = root()
  await renderDesignerLabel({ element, design: design(), data })
  const clone = element.cloneNode(true) as HTMLElement
  bindSvgClone(element, clone)
  let release!: (value: null) => void
  const delayedDesign = design()
  delayedDesign.elements = [{ id: 'photo', type: 'image', assetId: 'slow', x: 1, y: 1, w: 10, h: 10, z: 0, objectFit: 'contain' }]
  const rendering = pending ? renderDesignerLabel({ element, design: delayedDesign, data,
    resolveAssetUrl: () => new Promise(resolve => { release = resolve }) }) : Promise.resolve()
  await renderStandardLabel({ element, settings: { ...API_DEFAULT_LABEL_SETTINGS, showQR: false },
    data: { id: '1', designation: 'NEW STANDARD', manufacturer: 'Maker', material: 'PLA',
      colorName: 'Black', hexCode: '#000000', colorHexes: '#000000', multiColorStyle: 'bands', extraFields: [] } })
  if (pending) release(null)
  await rendering
  expect(element.hasAttribute('data-label-svg')).toBe(false)
  expect(element.hasAttribute('data-label-output-error')).toBe(false)
  expect(element.querySelector('.label-designation')?.textContent).toBe('NEW STANDARD PLA')
  await expect(renderSvgElementOutput(element, 320, 240, false)).rejects.toThrow()
  await expect(renderSvgElementOutput(clone, 320, 240, false)).rejects.toThrow()
  await renderDesignerLabel({ element, design: design(), data })
  expect(element.querySelector('[data-label-svg-raster]')).not.toBeNull()
})
