// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { migrateV1PresetData } from './migrate-v1'
import { renderFreeformLabel } from './render'
import { createDefaultLabelDesign } from './defaults'
import { waitForLabelOutputAssets } from '../label-output-readiness'
import type { SpoolData } from '../label-template'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'fonts')
  document.body.replaceChildren()
})

it('fits migrated long titles after fonts load, including detached output roots', async () => {
  const original = migrateV1PresetData({ settings: {
    label: { width: 40, height: 20 },
    logo: { show: false }, qr: { show: false }, info: { show: false }, info2: { show: false },
    title: { template: 'Long legacy title', fitToWidth: true, sizeMm: 4 }, title2: { show: false },
  } }, 'spool').design
  // happy-dom has no layout engine. Simulate measurable text only while attached,
  // with a title that needs to shrink from 4 mm to at most 2 mm to fit its box.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.isConnected ? 100 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.isConnected ? Number.parseFloat(this.style.fontSize || this.parentElement?.style.fontSize || '0') * 50 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 100, Number.parseFloat(this.parentElement?.style.fontSize || '0') * (96 / 25.4))
  })
  let fontsReady!: () => void
  Object.defineProperty(document, 'fonts', { configurable: true, value: {
    ready: new Promise<void>(resolve => { fontsReady = resolve }),
  } })
  const output = document.createElement('div')
  const rendering = renderFreeformLabel({ element: output, design: original, data: {} as SpoolData })
  await Promise.resolve()
  expect(output.children).toHaveLength(0)
  fontsReady()
  await rendering
  const title = output.querySelector<HTMLElement>('[data-label-element-type="text"]')!
  expect(title.textContent).toBe('Long legacy title')
  expect(Number.parseFloat(title.style.fontSize)).toBeGreaterThan(1.9)
  expect(Number.parseFloat(title.style.fontSize)).toBeLessThanOrEqual(2)
  const divider = output.querySelector<HTMLElement>('[data-label-element-type="shape"]')!
  const shrink = 4 - Number.parseFloat(title.style.fontSize)
  expect(Number.parseFloat(title.style.height)).toBeCloseTo(4 - shrink)
  expect(Number.parseFloat(divider.style.top)).toBeCloseTo(original.elements.find(element => element.type === 'shape')!.y - shrink)
  expect(document.body.children).toHaveLength(0)
  expect(original.elements.find(element => element.type === 'text')?.fontSizeMm).toBe(4)
})

it.each(['top', 'middle', 'bottom'] as const)('shrinks wrapped text to its box height with %s alignment without changing the chosen size', async verticalAlign => {
  const design = migrateV1PresetData({ settings: {
    label: { width: 40, height: 20 },
    logo: { show: false }, qr: { show: false }, info: { show: false }, info2: { show: false },
    title: { template: 'A title that wraps onto several lines', fitToWidth: true, sizeMm: 4 }, title2: { show: false },
  } }, 'spool').design
  const text = design.elements.find(element => element.type === 'text')!
  Object.assign(text, { wrap: true, verticalAlign })
  // Model wrapped content whose height fits at 2 mm, even when parent overflow
  // metrics miss content overflowing above a middle/bottom-aligned box.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.parentElement?.dataset.labelElementType !== 'text') return 40
    const size = Number.parseFloat(this.parentElement.style.fontSize)
    return (size > 2 ? 3 : 2) * size * (96 / 25.4) * 1.15
  })
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const size = Number.parseFloat(this.startContainer.parentElement!.parentElement!.style.fontSize)
    return Array.from({ length: size > 2 ? 3 : 2 }, (_, line) => new DOMRect(0, line * 20, 100, 19)) as unknown as DOMRectList
  })
  const output = document.createElement('div')
  await renderFreeformLabel({ element: output, design, data: {} as SpoolData })
  const title = output.querySelector<HTMLElement>('[data-label-element-type="text"]')!
  expect(title.style.whiteSpace).toBe('normal')
  expect(Number.parseFloat(title.style.fontSize)).toBeGreaterThan(1.9)
  expect(Number.parseFloat(title.style.fontSize)).toBeLessThanOrEqual(2)
  expect(text.fontSizeMm).toBe(4)
  expect(title.style.height).toBe(`${text.h}mm`)
})

it('does not count explicit line breaks as extra wrapped overflow', async () => {
  const design = createDefaultLabelDesign('filament')
  const text = design.elements.find(element => element.type === 'text')!
  Object.assign(text, {
    template: 'Line one\nLine two\nLine three\nLine four',
    fontSizeMm: 3,
    minFontSizeMm: 2,
    fitToWidth: true,
    wrap: true,
  })
  design.elements = [text]
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80)
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    [0, 20, 40, 60].map(top => new DOMRect(0, top, 100, 19)) as unknown as DOMRectList,
  )

  const output = document.createElement('div')
  await renderFreeformLabel({ element: output, design, data: {} as SpoolData })
  const rendered = output.querySelector<HTMLElement>('[data-label-element-type="text"]')!

  expect(rendered.dataset.labelOutputError).toBeUndefined()
  expect(rendered.style.fontSize).toBe('3mm')
})

it('keeps the minimum font size and blocks output when wrapped text cannot fit in two lines', async () => {
  const design = migrateV1PresetData({ settings: {
    label: { width: 40, height: 20 },
    logo: { show: false }, qr: { show: false }, info: { show: false }, info2: { show: false },
    title: { template: 'Too much text for this box', fitToWidth: true, sizeMm: 4 }, title2: { show: false },
  } }, 'spool').design
  Object.assign(design.elements.find(element => element.type === 'text')!, { wrap: true, minFontSizeMm: 2 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100)
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    [0, 20, 40].map(top => new DOMRect(0, top, 100, 19)) as unknown as DOMRectList,
  )
  const output = document.createElement('div')
  await renderFreeformLabel({ element: output, design, data: {} as SpoolData })
  expect(output.querySelector<HTMLElement>('[data-label-element-type="text"]')!.style.fontSize).toBe('2mm')
  await expect(waitForLabelOutputAssets([output])).rejects.toThrow('Text cannot fit')
})
