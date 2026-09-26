// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultLabelDesign } from './defaults'
import {
  createFreeformEditorController,
  initFreeformLabelDesignerEditor,
  persistFreeformLabelDesign,
  type FreeformEditorState,
  type LabelAssetMetadata,
} from './editor-controller'
import type { InteractFactory } from './interaction-adapter'

vi.mock('./assets', () => ({
  createLabelAssetClient: () => ({ list: async () => [], upload: vi.fn(), delete: vi.fn() }),
}))

function initialDesign() {
  const design = createDefaultLabelDesign('spool')
  design.elements = [{
    id: 'box', type: 'shape', shape: 'rectangle', x: 1, y: 2, w: 10, h: 8, z: 0,
    fill: '', stroke: '#000000', strokeWidthMm: 0.3, radiusMm: 0,
  }]
  return design
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('controller gesture commits', () => {
  it('commits geometry without replacing unrelated artwork', async () => {
    document.body.innerHTML = '<div id="freeform-canvas-host"><div class="label-preview"></div></div>'
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    const design = initialDesign()
    design.elements.push({
      id: 'other', type: 'shape', shape: 'circle', x: 20, y: 2, w: 8, h: 8, z: 1,
      fill: '', stroke: '#000000', strokeWidthMm: 0.3, radiusMm: 0,
    })
    persistFreeformLabelDesign('gesture-working', design)
    type DragOptions = Parameters<ReturnType<InteractFactory>['draggable']>[0]
    type ResizeOptions = Parameters<ReturnType<InteractFactory>['resizable']>[0]
    const resizes = new Map<HTMLElement, ResizeOptions>()
    const editor = await initFreeformLabelDesignerEditor({
      settingsKey: 'gesture-working', presetsKey: 'gesture-presets',
      onChange: async () => {
        const preview = document.querySelector<HTMLElement>('.label-preview')!
        preview.replaceChildren(...design.elements.map(element => {
          const node = document.createElement('div')
          node.dataset.labelElementId = element.id
          return node
        }))
      },
      loadInteract: async () => node => {
        const binding = {
          draggable(_options: DragOptions) { return binding },
          resizable(options: ResizeOptions) { resizes.set(node, options); return binding },
          unset() {},
        }
        return binding
      },
    })
    try {
      const unrelated = document.querySelector<HTMLElement>('[data-label-element-id="other"]')!
      const frame = document.querySelector<HTMLElement>('[data-label-selection-for="box"]')!
      const { listeners } = resizes.get(frame)!
      listeners.start({})
      listeners.move({ rect: { width: 50, height: 40 }, edges: { right: true, bottom: true }, altKey: true })
      listeners.end({})
      expect(document.querySelector('[data-label-element-id="other"]')).toBe(unrelated)
      expect(JSON.parse(localStorage.getItem('gesture-working')!).design.elements[0].w).toBe(editor.getDesign().elements[0].w)
    } finally {
      editor.destroy()
    }
  })

  it('keeps a sub-thousandth cropped image overlapping in identical live and committed geometry', () => {
    const design = initialDesign()
    design.elements = [{
      id: 'thin', type: 'image', assetId: 'asset', objectFit: 'contain',
      x: 10, y: 39.9996, w: 20, h: 0.0004, z: 0,
      crop: { x: 0, y: 0, w: 1, h: 0.01 },
    }]
    const changes: FreeformEditorState[] = []
    const controller = createFreeformEditorController({ initialDesign: design, onChange: state => changes.push(state) })

    controller.beginGesture()
    controller.updateGesture('thin', { x: 100, y: 100 })
    const live = controller.getDesign().elements[0]
    controller.endGesture()

    expect(live).toMatchObject({ x: 59.9, w: 20, h: 0.0004 })
    expect(live.y).toBeCloseTo(39.9996, 8)
    expect(changes).toHaveLength(1)
    expect(changes[0].design.elements[0]).toEqual(live)
  })

  it('duplicates a partially overflowing element without snapping it fully onto the label', () => {
    const controller = createFreeformEditorController({ initialDesign: initialDesign(), createId: () => 'copy' })
    controller.updateSelected({ x: 59.9, y: 39.9 })

    const copy = controller.duplicateSelected()

    expect(copy).toMatchObject({ x: 59.9, y: 39.9 })
  })

  it('keeps design, label, and selected-element snapshots mutation-safe during live movement', () => {
    const controller = createFreeformEditorController({ initialDesign: initialDesign() })
    controller.beginGesture()
    controller.updateGesture('box', { x: 5 })
    controller.getState().design.elements[0].x = 99
    controller.getDesign().elements[0].y = 99
    controller.getLabel().widthMm = 99
    controller.getElement('box')!.w = 99
    controller.getSelectedElement()!.h = 99
    expect(controller.getDesign()).toMatchObject({
      label: initialDesign().label,
      elements: [{ id: 'box', x: 5, y: 2, w: 10, h: 8 }],
    })
    controller.endGesture()
    expect(controller.undo().elements[0].x).toBe(1)
  })

  it('keeps several moves live while publishing one committed history step', () => {
    const changes: FreeformEditorState[] = []
    const controller = createFreeformEditorController({ initialDesign: initialDesign(), onChange: state => changes.push(state) })
    const before = controller.getState().design
    controller.beginGesture()
    controller.updateGesture('box', { x: 3 })
    controller.updateGesture('box', { x: 4 })
    controller.updateGesture('box', { x: 5, y: 6 })
    const after = controller.getState().design
    expect(after.elements[0]).toMatchObject({ x: 5, y: 6 })
    expect(changes).toHaveLength(0)
    controller.endGesture()
    expect(changes.map(state => state.design)).toEqual([after])
    expect(controller.undo()).toEqual(before)
    expect(controller.canUndo()).toBe(false)
    expect(controller.redo()).toEqual(after)
    controller.endGesture()
    expect(controller.getState().design).toEqual(after)
    expect(changes).toHaveLength(3)
  })

  it('does not publish intermediate geometry when async asset and render work finishes', async () => {
    let finishAssets!: (assets: LabelAssetMetadata[]) => void
    let finishRender!: () => void
    const changes: FreeformEditorState[] = []
    const controller = createFreeformEditorController({
      initialDesign: initialDesign(),
      onChange: state => changes.push(state),
      assets: { list: () => new Promise(resolve => { finishAssets = resolve }), upload: vi.fn(), delete: vi.fn() },
      render: () => new Promise<void>(resolve => { finishRender = resolve }),
    })
    const assets = controller.loadAssets()
    const render = controller.requestRender()
    changes.length = 0
    controller.beginGesture()
    controller.updateGesture('box', { x: 5 })
    finishAssets([])
    finishRender()
    await Promise.all([assets, render])
    expect(changes).toHaveLength(0)
    expect(controller.getState().assetsLoading).toBe(false)
    controller.endGesture()
    expect(changes).toHaveLength(1)
    expect(changes[0].design.elements[0].x).toBe(5)
  })

  it('commits a live movement before an ordinary edit, preserving separate undo steps', () => {
    const controller = createFreeformEditorController({ initialDesign: initialDesign() })
    controller.beginGesture()
    controller.updateGesture('box', { x: 5 })
    controller.updateSelected({ fill: '#FFFFFF' })
    expect(controller.undo().elements[0]).toMatchObject({ x: 5, fill: '' })
    expect(controller.undo().elements[0]).toMatchObject({ x: 1, fill: '' })
    controller.endGesture()
    expect(controller.redo().elements[0]).toMatchObject({ x: 5, fill: '' })
    expect(controller.redo().elements[0]).toMatchObject({ x: 5, fill: '#FFFFFF' })
  })

  it('preserves a movement for redo when undo interrupts the gesture', () => {
    const controller = createFreeformEditorController({ initialDesign: initialDesign() })
    controller.beginGesture()
    controller.updateGesture('box', { x: 5 })
    expect(controller.undo().elements[0].x).toBe(1)
    controller.endGesture()
    expect(controller.redo().elements[0].x).toBe(5)
  })

  it('flushes live movement when destroyed and ignores unknown element IDs', () => {
    const changes: FreeformEditorState[] = []
    const controller = createFreeformEditorController({ initialDesign: initialDesign(), onChange: state => changes.push(state) })
    controller.beginGesture()
    controller.updateGesture('missing', { x: 4 })
    controller.endGesture()
    expect(changes).toHaveLength(0)
    controller.beginGesture()
    controller.updateGesture('box', { x: 5 })
    controller.destroy()
    expect(changes).toHaveLength(1)
    expect(changes[0].design.elements[0].x).toBe(5)
  })

  it.each(['end', 'destroy', 'read-only', 'rerender'] as const)('persists final geometry once when the real page handles %s', async finish => {
    document.body.innerHTML = '<div id="freeform-canvas-host"><div class="label-preview"><div data-label-element-id="box"></div></div></div>'
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
    persistFreeformLabelDesign('gesture-working', initialDesign())
    type DragOptions = Parameters<ReturnType<InteractFactory>['draggable']>[0]
    const drags = new Map<HTMLElement, DragOptions>()
    const loadInteract = async (): Promise<InteractFactory> => node => {
      const binding = {
        draggable(options: DragOptions) { drags.set(node, options); return binding },
        resizable() { return binding },
        unset() {},
      }
      return binding
    }
    const editor = await initFreeformLabelDesignerEditor({
      settingsKey: 'gesture-working', presetsKey: 'gesture-presets', onChange: async () => {}, loadInteract,
    })
    try {
      const writes = vi.spyOn(localStorage, 'setItem')
      const node = document.querySelector<HTMLElement>('[data-label-element-id="box"]')!
      const listeners = drags.get(node)!.listeners
      listeners.start({})
      listeners.move({ dx: 10, dy: 0 })
      listeners.move({ dx: 10, dy: 0 })
      const live = editor.getDesign()
      expect(live.elements[0].x).toBeGreaterThan(1)
      expect(writes).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem('gesture-working')!).design.elements[0].x).toBe(1)
      if (finish === 'end') listeners.end({})
      else if (finish === 'destroy') editor.destroy()
      else if (finish === 'rerender') {
        node.replaceWith(node.cloneNode())
        await editor.refreshInteractions()
      }
      else {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
        window.dispatchEvent(new Event('resize'))
        await Promise.resolve()
      }
      expect(writes).toHaveBeenCalledTimes(1)
      expect(JSON.parse(localStorage.getItem('gesture-working')!).design).toEqual(live)
      listeners.end({})
      expect(writes).toHaveBeenCalledTimes(1)
    } finally {
      editor.destroy()
    }
  })
})
