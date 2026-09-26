// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultLabelDesign } from './defaults'
import { createFreeformEditorController } from './editor-state'
import { bindFreeformEditorDom } from './editor-dom'
import { renderSelectableTemplate, restoreTemplateSelection } from './template-selection'
import { parseTemplate, type SpoolData } from '../label-template'

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

async function editor(source: string) {
  const design = createDefaultLabelDesign('spool')
  const text = design.elements.find(element => element.type === 'text')!
  text.template = source
  design.elements = [text]
  document.body.innerHTML = `<div id="freeform-designer-workspace">
    <button data-designer-add="text">Add text</button>
    <div id="freeform-canvas-host"><div class="label-preview"></div></div>
    <div id="freeform-text-toolbar"><button data-text-modifier="bold">Bold</button></div>
    <textarea id="freeform-template" data-element-prop="template"></textarea>
    <button data-designer-action="undo">Undo</button><button data-designer-action="redo">Redo</button>
    <button data-field-token="{filament.color}">Color</button>
  </div>`
  const preview = document.querySelector<HTMLElement>('.label-preview')!
  const controller = createFreeformEditorController({ initialDesign: design, render: () => {
    const selected = controller.getSelectedElement()
    if (selected?.type !== 'text') return
    const node = document.createElement('div')
    node.dataset.labelElementId = selected.id
    node.dataset.labelElementType = 'text'
    node.append(renderSelectableTemplate(selected.template, { id: '42', 'filament.color': 'Blue' } as SpoolData))
    preview.replaceChildren(node)
  } })
  const binding = bindFreeformEditorDom({ controller })
  cleanups.push(() => { binding.destroy(); controller.destroy() })
  await binding.ready
  const node = () => preview.firstElementChild as HTMLElement
  node().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const select = (start: number, end = start) => {
    restoreTemplateSelection(node(), { start, end })
    document.dispatchEvent(new Event('selectionchange'))
  }
  const bold = () => document.querySelector<HTMLButtonElement>('[data-text-modifier="bold"]')!.click()
  return { controller, binding, node, select, bold }
}

it('undoes and redoes a component added while the toolbar retains focus', async () => {
  const e = await editor('Original')
  const add = document.querySelector<HTMLButtonElement>('[data-designer-add="text"]')!
  add.focus()
  add.click()
  await vi.waitFor(() => expect(e.controller.getDesign().elements).toHaveLength(2))

  add.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(e.controller.getDesign().elements).toHaveLength(1))

  add.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(e.controller.getDesign().elements).toHaveLength(2))
})

it.each(['keyboard', 'toolbar', 'beforeinput'] as const)('restores the same characters through %s undo and redo', async method => {
  const e = await editor('[i]ab cd[/i]')
  e.select(3, 5)
  e.bold()
  await vi.waitFor(() => expect(e.node().querySelector('strong')?.textContent).toBe('ab'))
  const history = async (redo = false) => {
    if (method === 'toolbar') {
      const button = document.querySelector<HTMLButtonElement>(`[data-designer-action="${redo ? 'redo' : 'undo'}"]`)!
      await vi.waitFor(() => expect(button.disabled).toBe(false))
      button.click()
    }
    else if (method === 'keyboard') e.node().dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: redo, bubbles: true, cancelable: true }))
    else e.node().dispatchEvent(new InputEvent('beforeinput', { inputType: redo ? 'historyRedo' : 'historyUndo', bubbles: true, cancelable: true }))
  }
  for (let turn = 0; turn < 2; turn++) {
    await history()
    await vi.waitFor(() => {
      expect(e.node().querySelector('strong')).toBeNull()
      expect(document.getSelection()?.toString()).toBe('ab')
    })
    await history(true)
    await vi.waitFor(() => {
      expect(e.node().querySelector('strong')?.textContent).toBe('ab')
      expect(document.getSelection()?.toString()).toBe('ab')
    })
  }
  await history()
  await vi.waitFor(() => expect(e.node().querySelector('strong')).toBeNull())
  e.bold()
  await vi.waitFor(() => expect(e.node().querySelector('strong')?.textContent).toBe('ab'))
  expect(e.controller.canRedo()).toBe(false)
})

it('uses the manual caret for field insertion after canvas editing', async () => {
  const e = await editor('Hello world')
  e.select(0, 5)
  const template = document.querySelector<HTMLTextAreaElement>('#freeform-template')!
  template.focus()
  template.setSelectionRange(6, 6)
  template.dispatchEvent(new Event('select'))
  document.querySelector<HTMLButtonElement>('[data-field-token]')!.click()
  await vi.waitFor(() => expect(e.controller.getSelectedElement()).toMatchObject({ template: 'Hello {filament.color}world' }))
  expect(e.node().textContent).toBe('Hello Blueworld')
})

it.each(['canvas', 'manual'])('retains the original condition through %s insertion, Undo and Redo', async mode => {
  const source = '[b]{Color: {filament.color}!}[/b]'
  const e = await editor(source)
  const position = source.indexOf('Color:') + 6
  if (mode === 'canvas') e.select(position)
  else {
    const manual = document.querySelector<HTMLTextAreaElement>('#freeform-template')!
    manual.focus()
    manual.setSelectionRange(position, position)
    manual.dispatchEvent(new Event('select'))
  }
  const field = document.querySelector<HTMLButtonElement>('[data-field-token]')!
  field.dataset.fieldToken = '{id}'
  field.click()
  await vi.waitFor(() => expect(e.node().textContent).toBe('Color:42 Blue!'))
  const saved = JSON.parse(JSON.stringify(e.controller.getSelectedElement()))
  expect(parseTemplate(saved.template, { id: '42' } as SpoolData).textContent).toBe('')
  expect([...e.node().querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('Color:42 Blue!')
  const undo = document.querySelector<HTMLButtonElement>('[data-designer-action="undo"]')!
  await vi.waitFor(() => expect(undo.disabled).toBe(false))
  undo.click()
  await vi.waitFor(() => expect(e.controller.getSelectedElement()).toMatchObject({ template: source }))
  const redo = document.querySelector<HTMLButtonElement>('[data-designer-action="redo"]')!
  await vi.waitFor(() => expect(redo.disabled).toBe(false))
  redo.click()
  await vi.waitFor(() => expect(e.controller.getSelectedElement()).toMatchObject({ template: saved.template }))
})

it('rejects insertion that would truncate a retained condition at the storage limit', async () => {
  const source = `{${'x'.repeat(7979)}{filament.color}}`
  const e = await editor(source)
  e.controller.setTemplateSelection(2)
  e.controller.insertField('{id}')
  expect(e.controller.getSelectedElement()).toMatchObject({ template: source })
  expect(e.controller.canUndo()).toBe(false)
})

it('restores character selection when undo returns to a different text element', async () => {
  const e = await editor('[i]ab cd[/i]')
  const original = e.controller.getSelectedId()
  e.select(3, 5)
  e.bold()
  await vi.waitFor(() => expect(e.node().querySelector('strong')?.textContent).toBe('ab'))
  e.controller.addElement('text')
  await e.binding.refresh()
  e.node().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  e.select(0, 2)
  e.bold()
  await vi.waitFor(() => expect(e.node().querySelector('strong')?.textContent).toBe('Te'))
  const undo = document.querySelector<HTMLButtonElement>('[data-designer-action="undo"]')!
  await vi.waitFor(() => expect(undo.disabled).toBe(false))
  undo.click()
  await vi.waitFor(() => expect(e.node().querySelector('strong')).toBeNull())
  undo.click()
  await vi.waitFor(() => {
    expect(e.controller.getSelectedId()).toBe(original)
    expect(e.node().contentEditable).toBe('true')
    expect(document.getSelection()?.toString()).toBe('ab')
  })
  e.node().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'XY', bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(e.node().textContent).toBe('XY cd'))
})
