// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { bindFreeformEditorDom } from './editor-dom'
import { createFreeformEditorController } from './editor-state'
import type { LabelDesignV2 } from './types'

const design: LabelDesignV2 = {
  version: 2, label: { widthMm: 60, heightMm: 40, marginMm: 2, border: false },
  elements: [{ id: 'image', type: 'image', x: 4, y: 5, w: 12, h: 8, z: 0,
    assetId: 'asset-1', objectFit: 'contain', crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }],
}
let dispose = () => {}
afterEach(() => { dispose(); document.body.replaceChildren() })

function setup(editable = true) {
  document.body.innerHTML = '<div id="freeform-canvas-host" tabindex="0"><div data-label-element-id="image" data-label-element-type="image"></div><textarea></textarea><div contenteditable="true">Words</div></div>'
  let id = 0
  const controller = createFreeformEditorController({ initialDesign: design, createId: () => `pasted-${++id}` })
  const binding = bindFreeformEditorDom({ controller, editable })
  dispose = () => { binding.destroy(); controller.destroy() }
  const canvas = document.getElementById('freeform-canvas-host')!
  const clipboard = new DataTransfer()
  const fire = (type: 'copy' | 'paste', target: Element = canvas, data = clipboard) => {
    const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  return { controller, binding, canvas, clipboard, fire }
}

describe('element clipboard', () => {
  it('pastes the copied snapshot with crop intact, a fresh id, and one undo step', () => {
    const { controller, fire } = setup()
    expect(fire('copy').defaultPrevented).toBe(true)
    expect(controller.canUndo()).toBe(false)
    controller.updateSelected({ x: 20 })
    controller.clearSelection()
    expect(fire('paste').defaultPrevented).toBe(true)
    expect(controller.getSelectedElement()).toMatchObject({
      id: 'pasted-1', type: 'image', x: 6, y: 7, z: 1, assetId: 'asset-1',
      crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
    })
    controller.undo()
    expect(controller.getDesign().elements).toHaveLength(1)
    expect(controller.getDesign().elements[0].x).toBe(20)
    controller.redo()
    expect(controller.getDesign().elements).toHaveLength(2)
  })

  it('preserves text templates and formatting when pasted into another designer', () => {
    const { controller, fire, clipboard, binding } = setup()
    controller.addElement('text')
    controller.updateSelected({ template: '**{filament.material}** sample', align: 'right', italic: true })
    fire('copy')
    binding.destroy()
    const other = createFreeformEditorController({ initialDesign: { ...design, elements: [] }, createId: () => 'new-text' })
    const otherBinding = bindFreeformEditorDom({ controller: other })
    dispose = () => { otherBinding.destroy(); controller.destroy(); other.destroy() }
    fire('paste', undefined, clipboard)
    expect(other.getSelectedElement()).toMatchObject({ id: 'new-text', template: '**{filament.material}** sample', align: 'right', italic: true })
  })

  it.each(['textarea', '[contenteditable]', '[data-label-text-editing]'])('leaves native text clipboard alone for %s', selector => {
    const { controller, canvas, fire } = setup()
    fire('copy')
    canvas.firstElementChild!.setAttribute('data-label-text-editing', '')
    const target = canvas.querySelector(selector)!
    expect(fire('copy', target).defaultPrevented).toBe(false)
    expect(fire('paste', target).defaultPrevented).toBe(false)
    expect(controller.getDesign().elements).toHaveLength(1)
  })

  it('ignores unrelated or malformed clipboard data and never falls back to a stale copied element', () => {
    const { controller, fire, clipboard } = setup()
    fire('copy')
    for (const value of ['ordinary text', '{', '{"kind":"filaman-label-element","version":1,"element":{"type":"script"}}']) {
      clipboard.clearData()
      clipboard.setData('text/plain', value)
      expect(fire('paste').defaultPrevented).toBe(false)
    }
    expect(controller.getDesign().elements).toHaveLength(1)
  })

  it('does not intercept clipboard events while read-only or after destruction', () => {
    const { fire, binding } = setup(false)
    expect(fire('copy').defaultPrevented).toBe(false)
    expect(fire('paste').defaultPrevented).toBe(false)
    binding.destroy()
    expect(fire('copy').defaultPrevented).toBe(false)
  })
})
