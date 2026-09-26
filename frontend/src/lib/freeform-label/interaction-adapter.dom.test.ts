// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bindLabelInteractions, type InteractFactory } from './interaction-adapter'
import { prepareLabelOutputClone } from '../label-preview-dom'
import type { LabelDesignElement, LabelDesignV2 } from './types'

type Listener = (event: Record<string, unknown>) => void
type InteractionOptions = { listeners: Record<string, Listener>; edges?: Record<string, boolean | HTMLElement | string>; margin?: number; ignoreFrom?: string }

function createInteractMock() {
  const bindings = new Map<string, {
    drag?: InteractionOptions
    resize?: InteractionOptions
    unset: ReturnType<typeof vi.fn>
  }>()
  const factory = vi.fn((target: HTMLElement) => {
    const binding = { unset: vi.fn() } as {
      drag?: InteractionOptions
      resize?: InteractionOptions
      unset: ReturnType<typeof vi.fn>
    }
    bindings.set(target.dataset.labelSelectionFor ? `frame:${target.dataset.labelSelectionFor}` : target.dataset.labelElementId!, binding)
    const interactable = {
      draggable(options: InteractionOptions) {
        binding.drag = options
        return interactable
      },
      resizable(options: InteractionOptions) {
        binding.resize = options
        return interactable
      },
      unset: binding.unset,
    }
    return interactable
  }) as unknown as InteractFactory
  return { factory, bindings }
}

const elements: LabelDesignElement[] = [
  { id: 'text', type: 'text', x: 2, y: 3, w: 20, h: 6, z: 0, template: 'Text', fontFamily: 'Space Grotesk', fontSizeMm: 3, fontWeight: 400, italic: false, underline: false, align: 'left', color: '#000000', wrap: false },
  { id: 'qr', type: 'qr', x: 40, y: 20, w: 15, h: 15, z: 1, mode: 'simple', linkMode: 'spool', urlTemplate: '' },
  { id: 'shape', type: 'shape', x: 10, y: 15, w: 20, h: 5, z: 2, shape: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidthMm: 0.2, radiusMm: 0 },
]

function makeDesign(): LabelDesignV2 {
  return {
    version: 2,
    label: { widthMm: 60, heightMm: 40, marginMm: 1, border: false },
    elements: structuredClone(elements),
  }
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="root">
      <div data-label-element-id="text"></div>
      <div data-label-element-id="qr"></div>
      <div data-label-element-id="shape"></div>
    </div>`
  const root = document.querySelector<HTMLElement>('#root')!
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 600, height: 400, x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400 }),
  })
})

describe('freeform label interaction adapter', () => {
  it('does not place a selection frame over artwork for a collapsed legacy element', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    root.querySelector<HTMLElement>('[data-label-element-id="text"]')!.style.display = 'none'
    const mock = createInteractMock()
    const binding = await bindLabelInteractions({ root, getDesign: makeDesign, getSelectedId: () => 'text', editable: true,
      onSelect: () => undefined, onGeometryChange: () => undefined, loadInteract: async () => mock.factory })
    expect(root.querySelector('[data-label-selection-for]')).toBeNull()
    expect(mock.bindings.has('text')).toBe(false)
    binding.destroy()
  })

  it('frames rendered legacy geometry while committing movement to stored geometry', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const text = root.querySelector<HTMLElement>('[data-label-element-id="text"]')!
    Object.assign(text.style, { left: '2mm', top: '1mm', width: '20mm', height: '4mm' })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root, getDesign: makeDesign, getSelectedId: () => 'text', editable: true,
      onSelect: () => undefined, onGeometryChange, loadInteract: async () => factory,
    })

    const frame = root.querySelector<HTMLElement>('[data-label-selection-for="text"]')!
    expect({ top: frame.style.top, height: frame.style.height }).toEqual({ top: '1mm', height: '4mm' })

    bindings.get('frame:text')!.drag!.listeners.start({})
    bindings.get('frame:text')!.drag!.listeners.move({ dx: 10, dy: 10 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 3, y: 4, w: 20, h: 6 })
    expect({ left: text.style.left, top: text.style.top }).toEqual({ left: '3mm', top: '2mm' })
    expect({ left: frame.style.left, top: frame.style.top }).toEqual({ left: '3mm', top: '2mm' })
    controller.destroy()
  })

  it('keeps framing rendered legacy geometry while inline text editing is active', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const text = root.querySelector<HTMLElement>('[data-label-element-id="text"]')!
    Object.assign(text.style, { left: '2mm', top: '1mm', width: '20mm', height: '4mm' })
    const { factory } = createInteractMock()
    const controller = await bindLabelInteractions({
      root, getDesign: makeDesign, getSelectedId: () => 'text', editable: true,
      onSelect: () => undefined, onGeometryChange: () => undefined, loadInteract: async () => factory,
    })

    text.setAttribute('data-label-text-editing', '')
    controller.refresh()

    const frame = root.querySelector<HTMLElement>('[data-label-selection-for="text"]')!
    expect({ top: frame.style.top, height: frame.style.height }).toEqual({ top: '1mm', height: '4mm' })
    controller.destroy()
  })

  it('snaps migrated elements by their visible bounds', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const text = root.querySelector<HTMLElement>('[data-label-element-id="text"]')!
    Object.assign(text.style, { left: '2mm', top: '1.4mm', width: '20mm', height: '4mm' })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root, getDesign: makeDesign, getSelectedId: () => 'text', editable: true,
      onSelect: () => undefined, onGeometryChange, loadInteract: async () => factory,
    })

    bindings.get('frame:text')!.drag!.listeners.move({ dx: 0, dy: 0 })

    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 2, y: 2.6, w: 20, h: 6 })
    expect(text.style.top).toBe('1mm')
    expect(root.querySelector<HTMLElement>('[data-label-snap-guide="y"]')!.style.top).toBe('1mm')
    controller.destroy()
  })

  it('clamps migrated elements by their visible bounds', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const text = root.querySelector<HTMLElement>('[data-label-element-id="text"]')!
    Object.assign(text.style, { left: '2mm', top: '1mm', width: '20mm', height: '4mm' })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root, getDesign: makeDesign, getSelectedId: () => 'text', editable: true,
      onSelect: () => undefined, onGeometryChange, loadInteract: async () => factory,
    })

    bindings.get('frame:text')!.drag!.listeners.start({})
    bindings.get('frame:text')!.drag!.listeners.move({ dx: 0, dy: -1000, altKey: true })

    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 2, y: -1.9, w: 20, h: 6 })
    expect(text.style.top).toBe('-3.9mm')
    controller.destroy()
  })
  it('keeps proportional geometry finite when resize measurements are invalid', async () => {
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!, getDesign: makeDesign,
      getSelectedId: () => 'qr', editable: true, onSelect: () => {}, onGeometryChange,
      loadInteract: async () => factory,
    })
    bindings.get('frame:qr')!.resize!.listeners.move({
      rect: { width: NaN, height: Infinity }, edges: { left: true, top: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('qr', { x: 40, y: 20, w: 15, h: 15 })
    controller.destroy()
  })

  it('reads layout once per move and uses narrow model reads while positioning the selection frame', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const { factory, bindings } = createInteractMock()
    const design = makeDesign()
    const getDesign = vi.fn(() => design)
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root, getDesign, getSelectedId: () => 'text', getLabel: () => ({ ...design.label }),
      getElement: id => structuredClone(design.elements.find(element => element.id === id) ?? null),
      getMaxZ: () => 2, editable: true, onSelect: () => {}, onGeometryChange,
      loadInteract: async () => factory,
    })
    const measure = vi.spyOn(root, 'getBoundingClientRect')
    getDesign.mockClear()
    bindings.get('frame:text')!.drag!.listeners.move({ dx: 20, dy: 10 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 4, y: 4, w: 20, h: 6 })
    expect(root.querySelector<HTMLElement>('[data-label-selection-for="text"]')!.style.left).toBe('4mm')
    expect(measure).toHaveBeenCalledTimes(1)
    expect(getDesign).not.toHaveBeenCalled()
    controller.destroy()
  })

  it('suspends drag/resize for native text selection and restores them afterward', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const text = root.querySelector<HTMLElement>('[data-label-element-id="text"]')!
    text.setAttribute('data-label-text-editing', '')
    const mock = createInteractMock()
    const binding = await bindLabelInteractions({ root, getDesign: makeDesign, editable: true,
      onSelect: () => undefined, onGeometryChange: () => undefined, loadInteract: async () => mock.factory })
    expect(mock.bindings.has('text')).toBe(false)
    expect(mock.bindings.has('qr')).toBe(true)
    text.removeAttribute('data-label-text-editing')
    binding.refresh()
    expect(mock.bindings.get('text')?.drag).toBeDefined()
    expect(text.style.cursor).toBe('move')
    binding.destroy()
  })
  it('does not load or bind interact.js in read-only mode', async () => {
    const loadInteract = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: makeDesign,
      editable: false,
      onSelect: vi.fn(),
      onGeometryChange: vi.fn(),
      loadInteract,
    })

    expect(loadInteract).not.toHaveBeenCalled()
    expect(document.querySelector('[data-label-interaction-bound]')).toBeNull()
    controller.destroy()
  })

  it('selects elements and converts drag pixels to clamped millimetres', async () => {
    const { factory, bindings } = createInteractMock()
    const onSelect = vi.fn()
    const onGeometryChange = vi.fn()
    const onGestureStart = vi.fn()
    const onGestureEnd = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: makeDesign,
      editable: true,
      onSelect,
      onGeometryChange,
      onGestureStart,
      onGestureEnd,
      loadInteract: async () => factory,
    })

    document.querySelector<HTMLElement>('[data-label-element-id="text"]')!.click()
    bindings.get('text')!.drag!.listeners.start({})
    bindings.get('text')!.drag!.listeners.move({ dx: 25, dy: 10 })
    bindings.get('text')!.drag!.listeners.move({ dx: 1000, dy: 1000 })
    bindings.get('text')!.drag!.listeners.end({})

    expect(onSelect).toHaveBeenCalledWith('text')
    expect(onGestureStart).toHaveBeenCalledWith('text')
    expect(onGeometryChange).toHaveBeenNthCalledWith(1, 'text', { x: 4.5, y: 4, w: 20, h: 6 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 59.9, y: 39.9, w: 20, h: 6 })
    expect(onGestureEnd).toHaveBeenCalledWith('text')
    controller.destroy()
  })

  it('snaps moves to label guides without trapping incremental drag and supports immediate bypass cleanup', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root,
      getDesign: makeDesign,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })
    const drag = bindings.get('text')!.drag!.listeners

    drag.start({})
    drag.move({ dx: -9, dy: 0 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1, y: 3, w: 20, h: 6 })
    const guide = root.querySelector<HTMLElement>('[data-label-snap-guide="x"]')!
    expect(guide.dataset.labelEditorChrome).toBe('')
    expect(guide.style.left).toBe('1mm')
    expect(guide.style.width).toBe('0.1mm')

    drag.move({ dx: 4, dy: 0 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1, y: 3, w: 20, h: 6 })
    drag.move({ dx: 2, dy: 0 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1.7, y: 3, w: 20, h: 6 })
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()

    drag.move({ dx: -6, dy: 0 })
    expect(root.querySelector('[data-label-snap-guide]')).not.toBeNull()
    drag.move({ dx: 0, dy: 0, altKey: true })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1.1, y: 3, w: 20, h: 6 })
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()

    drag.move({ dx: 0, dy: 0 })
    expect(root.querySelector('[data-label-snap-guide]')).not.toBeNull()
    controller.refresh()
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()
    drag.move({ dx: 0, dy: 0 })
    expect(root.querySelector('[data-label-snap-guide]')).not.toBeNull()
    drag.end({})
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()
    drag.start({})
    drag.move({ dx: 0, dy: 0 })
    expect(root.querySelector('[data-label-snap-guide]')).not.toBeNull()
    controller.destroy()
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()
  })

  it('uses a six-screen-pixel snap distance at different zoom levels', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    Object.defineProperty(root, 'getBoundingClientRect', { value: () => ({ width: 1200 }) })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root,
      getDesign: makeDesign,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    bindings.get('text')!.drag!.listeners.move({ dx: -15, dy: 0 })

    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1, y: 3, w: 20, h: 6 })
    expect(root.querySelector<HTMLElement>('[data-label-snap-guide="x"]')!.style.width).toBe('0.05mm')
    controller.destroy()
  })

  it('does not retain drag overshoot beyond the overlap hard stop', async () => {
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: makeDesign,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })
    const drag = bindings.get('text')!.drag!.listeners

    drag.start({})
    drag.move({ dx: 1000, dy: 0, altKey: true })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 59.9, y: 3, w: 20, h: 6 })
    drag.move({ dx: -20, dy: 0, altKey: true })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 57.9, y: 3, w: 20, h: 6 })
    controller.destroy()
  })

  it('resizes text in both dimensions, QR uniformly, and rectangles freely through the selected frame', async () => {
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    let selectedId = 'text'
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: makeDesign,
      getSelectedId: () => selectedId,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    expect(bindings.get('text')!.resize).toBeUndefined()
    expect(bindings.get('qr')!.resize).toBeUndefined()
    expect(bindings.get('shape')!.resize).toBeUndefined()

    bindings.get('frame:text')!.resize!.listeners.move({
      rect: { width: 210, height: 80 },
      deltaRect: { left: -10, top: -20 },
      edges: { left: true, top: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 1, y: 1, w: 21, h: 8 })

    selectedId = 'qr'
    controller.syncSelection()
    bindings.get('frame:qr')!.resize!.listeners.move({
      rect: { width: 300, height: 250 },
      deltaRect: { left: -150, top: -100 },
      edges: { left: true, top: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('qr', { x: 25, y: 5, w: 30, h: 30 })

    selectedId = 'shape'
    controller.syncSelection()
    bindings.get('frame:shape')!.resize!.listeners.move({
      rect: { width: 350, height: 120 },
      deltaRect: { left: 0, top: 0 },
      edges: { right: true, bottom: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 35, h: 12 })
    controller.destroy()
  })

  it('keeps the opposite resize anchor for an overflowing box until overlap requires a shift', async () => {
    const design = makeDesign()
    const shape = design.elements.find(element => element.id === 'shape')!
    shape.x = -10
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: () => design,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })
    const resize = bindings.get('frame:shape')!.resize!.listeners

    resize.move({
      rect: { width: 250, height: 50 },
      deltaRect: { left: -50, top: 0 },
      edges: { left: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: -15, y: 15, w: 25, h: 5 })

    resize.move({
      rect: { width: 30, height: 50 },
      deltaRect: { left: 0, top: 0 },
      edges: { right: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: -2.9, y: 15, w: 3, h: 5 })
    controller.destroy()
  })

  it('snaps resize edges without feedback drift and releases after enough raw movement', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root,
      getDesign: makeDesign,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })
    const resize = bindings.get('frame:shape')!.resize!.listeners

    resize.start({})
    resize.move({ rect: { width: 499, height: 50 }, edges: { right: true } })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 50, h: 5 })
    expect(root.querySelector<HTMLElement>('[data-label-snap-guide="x"]')!.style.left).toBe('60mm')
    resize.move({ rect: { width: 503, height: 50 }, edges: { right: true } })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 50, h: 5 })
    resize.move({ rect: { width: 507, height: 50 }, edges: { right: true } })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 50.7, h: 5 })
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()
    resize.end({})
    controller.destroy()
  })

  it('does not show a snap guide when overlap clamping moves the committed edge away', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const design = makeDesign()
    const shape = design.elements.find(element => element.id === 'shape')!
    Object.assign(shape, { x: 59.9, w: 10 })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root,
      getDesign: () => design,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    bindings.get('frame:shape')!.resize!.listeners.move({
      rect: { width: 99, height: 50 },
      edges: { left: true },
    })

    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 59.9, y: 15, w: 9.9, h: 5 })
    expect(root.querySelector('[data-label-snap-guide]')).toBeNull()
    controller.destroy()
  })

  it('does not retain an external resize anchor after overlap clamping moves it', async () => {
    const design = makeDesign()
    const shape = design.elements.find(element => element.id === 'shape')!
    Object.assign(shape, { x: 59.9, w: 20 })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: () => design,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })
    const resize = bindings.get('frame:shape')!.resize!.listeners

    resize.start({})
    resize.move({ rect: { width: 30, height: 50 }, edges: { left: true }, altKey: true })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 59.9, y: 15, w: 3, h: 5 })
    resize.move({ rect: { width: 40, height: 50 }, edges: { left: true }, altKey: true })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 58.9, y: 15, w: 4, h: 5 })
    controller.destroy()
  })

  it('chooses the nearest achievable guide for a proportional corner resize', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const design = makeDesign()
    const qr = design.elements.find(element => element.id === 'qr')!
    Object.assign(qr, { x: 10, y: 12, w: 15, h: 15 })
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root,
      getDesign: () => design,
      getSelectedId: () => 'qr',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    bindings.get('frame:qr')!.resize!.listeners.move({
      rect: { width: 242, height: 242 },
      edges: { left: true, top: true },
    })

    expect(onGeometryChange).toHaveBeenLastCalledWith('qr', { x: 1, y: 3, w: 24, h: 24 })
    expect(root.querySelector<HTMLElement>('[data-label-snap-guide="x"]')!.style.left).toBe('1mm')
    expect(root.querySelector('[data-label-snap-guide="y"]')).toBeNull()
    controller.destroy()
  })

  it('keeps short elements resizable at every corner without filling their interior with handles', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    let rootWidth = 60
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ width: rootWidth, height: 40, x: 0, y: 0, top: 0, left: 0, right: rootWidth, bottom: 40 }),
    })
    const design = makeDesign()
    const text = design.elements.find(element => element.id === 'text')!
    const shape = design.elements.find(element => element.id === 'shape')!
    text.h = 0.3
    shape.w = 13
    shape.h = 7
    const { factory, bindings } = createInteractMock()
    const controller = await bindLabelInteractions({
      root,
      getDesign: () => design,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange: vi.fn(),
      loadInteract: async () => factory,
    })

    expect(bindings.get('text')!.resize).toBeUndefined()
    expect(bindings.get('shape')!.drag).toBeDefined()
    expect(bindings.get('shape')!.resize).toBeUndefined()
    const frame = root.querySelector<HTMLElement>('[data-label-selection-for="shape"]')!
    expect(frame).not.toBeNull()
    expect(bindings.get('frame:shape')!.resize).toBeDefined()
    const corner = frame.querySelector<HTMLElement>('[data-label-selection-corner="top-left"]')!
    expect(parseFloat(corner.style.width)).toBeCloseTo(14)
    expect(parseFloat(corner.style.left) + parseFloat(corner.style.width)).toBeCloseTo(2.5)
    expect(document.querySelector<HTMLElement>('[data-label-element-id="shape"]')!.style.cursor).toBe('move')

    rootWidth = 120
    controller.refresh()
    expect(bindings.get('frame:shape')!.resize).toBeDefined()
    expect(parseFloat(root.querySelector<HTMLElement>('[data-label-selection-corner="top-left"]')!.style.width)).toBeCloseTo(7)

    controller.destroy()
    expect(document.querySelector<HTMLElement>('[data-label-element-id="shape"]')!.style.cursor).toBe('')
  })

  it.each(['circle', 'square'] as const)('resizes %s uniformly while retaining label overlap', async shapeKind => {
    const design = makeDesign()
    const shape = design.elements.find(element => element.type === 'shape')!
    shape.shape = shapeKind
    shape.h = 20
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: () => design,
      getSelectedId: () => 'shape',
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    bindings.get('frame:shape')!.resize!.listeners.move({
      rect: { width: 400, height: 200 },
      edges: { right: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 40, h: 40 })

    bindings.get('frame:shape')!.resize!.listeners.move({
      rect: { width: 800, height: 900 },
      edges: { left: true, top: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 40, h: 40 })

    bindings.get('frame:shape')!.resize!.listeners.move({
      rect: { width: 0.2, height: 0.2 },
      edges: { right: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 10, y: 15, w: 0.1, h: 0.1 })
    controller.destroy()
  })

  it('resizes a thin line by its ends without changing its thickness or vertical position', async () => {
    const design = makeDesign()
    const shape = design.elements.find(element => element.type === 'shape')!
    shape.shape = 'line'
    shape.h = 0.1
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: () => design,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange,
      loadInteract: async () => factory,
    })

    const resize = bindings.get('shape')!.resize
    expect(resize).toBeDefined()
    const line = document.querySelector<HTMLElement>('[data-label-element-id="shape"]')!
    expect(resize!.edges).toEqual({ left: line.querySelector('[data-label-line-end="left"]'), right: line.querySelector('[data-label-line-end="right"]'), top: false, bottom: false })
    expect(resize!.margin).toBe(3)
    resize!.listeners.move({
      rect: { width: 250, height: 100 },
      deltaRect: { left: -10, top: -20 },
      edges: { left: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 5, y: 15, w: 25, h: 0.1 })

    resize!.listeners.move({
      rect: { width: 1000, height: 500 },
      edges: { right: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 5, y: 15, w: 60, h: 0.1 })

    resize!.listeners.move({
      rect: { width: 0, height: 0 },
      deltaRect: { left: 1000, top: 1000 },
      edges: { left: true },
    })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 59.9, y: 15, w: 0.1, h: 0.1 })
    controller.destroy()
  })

  it('gives line endpoints zoom-independent hit targets while preserving the middle for moving', async () => {
    const design = makeDesign()
    const shape = design.elements.find(element => element.type === 'shape')!
    shape.shape = 'line'
    shape.w = 2
    shape.h = 0.1
    const root = document.querySelector<HTMLElement>('#root')!
    const line = root.querySelector<HTMLElement>('[data-label-element-id="shape"]')!
    let rootWidth = 600
    Object.defineProperty(root, 'getBoundingClientRect', { configurable: true, value: () => ({ width: rootWidth }) })
    const { factory, bindings } = createInteractMock()
    const controller = await bindLabelInteractions({ root, getDesign: () => design, editable: true,
      onSelect: vi.fn(), onGeometryChange: vi.fn(), loadInteract: async () => factory })

    const left = line.querySelector<HTMLElement>('[data-label-line-end="left"]')!
    const right = line.querySelector<HTMLElement>('[data-label-line-end="right"]')!
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    expect(parseFloat(left.style.width) * 10).toBeCloseTo(14)
    expect(parseFloat(left.style.height) * 10).toBeCloseTo(14)
    const leftInnerEdge = parseFloat(left.style.left) + parseFloat(left.style.width)
    const rightInnerEdge = shape.w - parseFloat(right.style.right) - parseFloat(right.style.width)
    expect((rightInnerEdge - leftInnerEdge) * 10).toBeCloseTo(8)
    expect(left.matches(bindings.get('shape')!.drag!.ignoreFrom!)).toBe(true)
    expect(line.matches(bindings.get('shape')!.drag!.ignoreFrom!)).toBe(false)
    expect(bindings.get('shape')!.resize!.edges?.left).toBe(left)

    const clone = root.cloneNode(true) as HTMLElement
    prepareLabelOutputClone(clone)
    expect(clone.querySelector('[data-label-line-end]')).toBeNull()
    expect(line.querySelectorAll('[data-label-line-end]')).toHaveLength(2)

    rootWidth = 1200
    controller.refresh()
    const refreshed = line.querySelector<HTMLElement>('[data-label-line-end="left"]')!
    expect(left.isConnected).toBe(false)
    expect(line.querySelectorAll('[data-label-line-end]')).toHaveLength(2)
    expect(parseFloat(refreshed.style.width) * 20).toBeCloseTo(14)
    controller.destroy()
    expect(line.querySelector('[data-label-line-end]')).toBeNull()
  })

  it('tears down old bindings on refresh and all bindings on destroy', async () => {
    const { factory, bindings } = createInteractMock()
    const controller = await bindLabelInteractions({
      root: document.querySelector<HTMLElement>('#root')!,
      getDesign: makeDesign,
      editable: true,
      onSelect: vi.fn(),
      onGeometryChange: vi.fn(),
      loadInteract: async () => factory,
    })
    const firstUnsets = [...bindings.values()].map(binding => binding.unset)

    controller.refresh()
    expect(firstUnsets.every(unset => unset.mock.calls.length === 1)).toBe(true)
    const refreshedUnsets = [...bindings.values()].map(binding => binding.unset)
    controller.destroy()
    expect(refreshedUnsets.every(unset => unset.mock.calls.length === 1)).toBe(true)
    expect(document.querySelector('[data-label-interaction-bound]')).toBeNull()
  })

  it.each([
    { corner: 'top-left', edges: { top: true, left: true }, deltaRect: { left: -20, top: -20 }, want: { x: 8, y: 13, w: 22, h: 7 } },
    { corner: 'top-right', edges: { top: true, right: true }, deltaRect: { left: 0, top: -20 }, want: { x: 10, y: 13, w: 22, h: 7 } },
    { corner: 'bottom-left', edges: { bottom: true, left: true }, deltaRect: { left: -20, top: 0 }, want: { x: 8, y: 15, w: 22, h: 7 } },
    { corner: 'bottom-right', edges: { bottom: true, right: true }, deltaRect: { left: 0, top: 0 }, want: { x: 10, y: 15, w: 22, h: 7 } },
  ])('resizes an overlapping lower layer from $corner without moving its opposite corner', async ({ corner, edges, deltaRect, want }) => {
    const root = document.querySelector<HTMLElement>('#root')!
    const design = makeDesign()
    const shape = root.querySelector<HTMLElement>('[data-label-element-id="shape"]')!
    shape.style.zIndex = '0'
    root.querySelector<HTMLElement>('[data-label-element-id="text"]')!.style.zIndex = '12'
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({ root, getDesign: () => design, getSelectedId: () => 'shape', editable: true,
      onSelect: () => controller?.syncSelection(), onGeometryChange, loadInteract: async () => factory })
    const frame = root.querySelector<HTMLElement>('[data-label-selection-for="shape"]')!
    expect(frame?.parentElement).toBe(root)
    expect(Number(frame.style.zIndex)).toBeGreaterThan(12)
    expect(shape.style.zIndex).toBe('0')
    const handle = frame.querySelector<HTMLElement>(`[data-label-selection-corner="${corner}"]`)!
    const resize = bindings.get('frame:shape')!.resize!
    for (const side of Object.keys(edges)) expect(handle.matches(String(resize.edges![side]))).toBe(true)
    expect(handle.matches(bindings.get('frame:shape')!.drag!.ignoreFrom!)).toBe(true)
    expect(frame.matches(bindings.get('frame:shape')!.drag!.ignoreFrom!)).toBe(false)
    resize.listeners.start({})
    resize.listeners.move({ rect: { width: 220, height: 70 }, deltaRect, edges })
    controller.syncSelection()
    expect(root.querySelector('[data-label-selection-for]')).toBe(frame)
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', want)
    expect(shape.style.left).toBe(`${want.x}mm`)
    expect(frame.style.left).toBe(`${want.x}mm`)
    expect(frame.style.height).toBe(`${want.h}mm`)
    resize.listeners.end({})
    controller.destroy()
  })

  it('moves the selected layer from the overlay interior and removes editor chrome from output and lifecycle changes', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    let selectedId: string | null = 'shape'
    const controller = await bindLabelInteractions({ root, getDesign: makeDesign, getSelectedId: () => selectedId, editable: true,
      onSelect: vi.fn(), onGeometryChange, loadInteract: async () => factory })
    const frame = root.querySelector<HTMLElement>('[data-label-selection-for]')!
    bindings.get('frame:shape')!.drag!.listeners.move({ dx: 30, dy: -10 })
    expect(onGeometryChange).toHaveBeenLastCalledWith('shape', { x: 13, y: 14, w: 20, h: 5 })
    expect(frame.style.left).toBe('13mm')
    const clone = root.cloneNode(true) as HTMLElement
    prepareLabelOutputClone(clone)
    expect(clone.querySelector('[data-label-selection-for]')).toBeNull()
    expect(root.querySelector('[data-label-selection-for]')).toBe(frame)
    selectedId = 'text'
    controller.syncSelection()
    expect(frame.isConnected).toBe(false)
    expect(root.querySelectorAll('[data-label-selection-for]')).toHaveLength(1)
    expect(root.querySelector('[data-label-element-id="shape"]')!.hasAttribute('data-label-selection-framed')).toBe(false)
    root.querySelector('[data-label-element-id="text"]')!.setAttribute('data-label-text-editing', '')
    controller.syncSelection()
    expect(root.querySelector('[data-label-selection-for="text"] [data-label-selection-move]')).toBeNull()
    expect(root.querySelectorAll('[data-label-selection-for="text"] [data-label-selection-edge]')).toHaveLength(4)
    root.querySelector('[data-label-element-id="text"]')!.removeAttribute('data-label-text-editing')
    controller.syncSelection()
    expect(root.querySelector('[data-label-selection-for="text"]')).not.toBeNull()
    selectedId = null
    controller.syncSelection()
    expect(root.querySelector('[data-label-selection-for]')).toBeNull()
    selectedId = 'qr'
    controller.syncSelection()
    controller.destroy()
    expect(root.querySelector('[data-label-selection-for]')).toBeNull()
    expect(root.querySelector('[data-label-selection-framed]')).toBeNull()
  })

  it('anchors the opposite text corner when resize reaches the label boundary or minimum box size', async () => {
    const { factory, bindings } = createInteractMock()
    const onGeometryChange = vi.fn()
    const controller = await bindLabelInteractions({ root: document.querySelector<HTMLElement>('#root')!, getDesign: makeDesign,
      getSelectedId: () => 'text', editable: true, onSelect: vi.fn(), onGeometryChange, loadInteract: async () => factory })
    const resize = bindings.get('frame:text')!.resize!
    resize.listeners.move({ rect: { width: 400, height: 400 }, deltaRect: { left: -200, top: -340 }, edges: { left: true, top: true } })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: -18, y: -31, w: 40, h: 40 })
    resize.listeners.move({ rect: { width: 1, height: 1 }, deltaRect: { left: 219, top: 89 }, edges: { left: true, top: true } })
    expect(onGeometryChange).toHaveBeenLastCalledWith('text', { x: 19, y: 6, w: 3, h: 3 })
    controller.destroy()
  })

  it('uses corners only for resizing and leaves a move target on tiny text boxes', async () => {
    const root = document.querySelector<HTMLElement>('#root')!
    const design = makeDesign()
    design.elements[0] = { ...design.elements[0], w: 0.5, h: 0.5 }
    const { factory, bindings } = createInteractMock()
    const controller = await bindLabelInteractions({ root, getDesign: () => design,
      getSelectedId: () => 'text', editable: true, onSelect: vi.fn(), onGeometryChange: vi.fn(), loadInteract: async () => factory })
    const frame = root.querySelector<HTMLElement>('[data-label-selection-for="text"]')!
    const drag = bindings.get('frame:text')!.drag!
    const resize = bindings.get('frame:text')!.resize!
    expect(frame.querySelector('[data-label-selection-move]')).toBeNull()
    expect(frame.querySelectorAll('[data-label-selection-edge]')).toHaveLength(4)
    for (const edge of frame.querySelectorAll<HTMLElement>('[data-label-selection-edge]')) {
      expect(edge.matches(drag.ignoreFrom!)).toBe(false)
      expect(edge.matches(String(resize.edges!.left))).toBe(false)
      expect(edge.matches(String(resize.edges!.right))).toBe(false)
      expect(edge.matches(String(resize.edges!.top))).toBe(false)
      expect(edge.matches(String(resize.edges!.bottom))).toBe(false)
    }
    expect(frame.style.getPropertyValue('--selection-inset-x')).toBe('0mm')
    expect(frame.style.getPropertyValue('--selection-inset-y')).toBe('0mm')
    expect(frame.querySelector<HTMLElement>('[data-label-selection-edge="top"]')!.style.top).toBe('-0.8mm')
    controller.destroy()
  })
})
