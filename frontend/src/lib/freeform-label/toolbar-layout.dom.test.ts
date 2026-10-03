// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bindCanvasTextEditor } from './canvas-text-editor'
import { createDefaultLabelDesign } from './defaults'

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

it('keeps direct text controls above the canvas without floating coordinates', () => {
  document.body.innerHTML = '<div class="freeform-canvas-stage"><div id="freeform-text-toolbar"></div><div id="freeform-canvas-host"><div data-label-element-id="text"></div></div></div>'
  const toolbar = document.getElementById('freeform-text-toolbar')!
  const selected = createDefaultLabelDesign('spool').elements.find(element => element.type === 'text')!
  selected.id = 'text'
  const binding = bindCanvasTextEditor({
    root: document, getSelected: () => selected, getTemplateRange: () => ({ start: 0, end: 0 }),
    resetTemplateRange() {}, isEditable: () => true, select() {}, updateTemplate() {},
    undo() {}, redo() {},
    refresh: async () => {}, refreshInteractions: async () => {},
  })
  try {
    binding.sync()
    expect(toolbar.hidden).toBe(false)
    expect(toolbar.style.left).toBe('')
    expect(toolbar.style.top).toBe('')
    binding.setGestureActive(true)
    expect(toolbar.hidden).toBe(true)
    binding.setGestureActive(false)
    expect(toolbar.hidden).toBe(false)
  } finally { binding.destroy() }
  expect(toolbar.hidden).toBe(true)
})
