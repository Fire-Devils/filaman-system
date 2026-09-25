// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindCanvasTextEditor } from './canvas-text-editor'
import { createDefaultLabelDesign } from './defaults'
import { renderSelectableTemplate } from './template-selection'
import { prepareLabelOutputClone } from '../label-preview-dom'
import type { SpoolData } from '../label-template'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); document.body.replaceChildren() })

function editor(source: string, delayed = false) {
  const selected = createDefaultLabelDesign('spool').elements.find(element => element.type === 'text')!
  selected.template = source
  document.body.innerHTML = '<div id="freeform-canvas-host"><div data-label-element-id="text" data-label-element-type="text"></div></div><div id="freeform-text-toolbar"><select data-element-prop="fontFamily"><option>Space Grotesk</option></select><button data-text-modifier="bold">B</button><button data-text-modifier="underline">U</button></div>'
  selected.id = 'text'
  const node = document.querySelector<HTMLElement>('[data-label-element-id]')!
  const render = () => { node.replaceChildren(renderSelectableTemplate(selected.template, { 'filament.color': 'Ocean Blue', 'filament.name': 'PLA Galaxy Black' } as SpoolData)) }
  render()
  let range = { start: 0, end: 0 }
  const refreshes: Array<() => void> = []
  const binding = bindCanvasTextEditor({
    root: document, getSelected: () => selected, getTemplateRange: () => range,
    resetTemplateRange: () => { range = { start: 0, end: 0 } }, isEditable: () => true,
    select: () => {}, updateTemplate: (value, nextRange) => { selected.template = value; range = nextRange },
    undo: () => {}, redo: () => {},
    refresh: () => delayed ? new Promise<void>(resolve => { refreshes.push(() => { render(); resolve() }) }) : Promise.resolve(render()), refreshInteractions: async () => {},
  })
  cleanups.push(binding.destroy)
  binding.sync()
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  function select(start: Node, startOffset: number, end = start, endOffset = startOffset) {
    const range = document.createRange()
    range.setStart(start, startOffset); range.setEnd(end, endOffset)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  }
  function input(inputType: string, data: string | null = null) {
    node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }))
  }
  function clipboard(type: string, contents: Record<string, string> = {}) {
    const transfer = new DataTransfer()
    Object.entries(contents).forEach(([key, value]) => transfer.setData(key, value))
    const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: transfer })
    node.dispatchEvent(event)
    return transfer
  }
  return { selected, node, select, input, clipboard, binding, flush: (reverse = false) => {
    const pending = refreshes.splice(0)
    ;(reverse ? pending.reverse() : pending).forEach(refresh => refresh())
  } }
}

describe('canvas text editing', () => {
  it('applies an inline font to highlighted visible text', async () => {
    const e = editor('Hello world')
    const text = e.node.querySelector('[data-template-leaf]')!.firstChild!
    e.select(text, 6, text, 11)
    expect(e.binding.formatFont('Fraunces')).toBe(true)
    await Promise.resolve()
    expect(e.selected.template).toBe('Hello [font=Fraunces]world[/font]')
    expect(e.node.querySelector('[style*="font-family"]')?.textContent).toBe('world')
  })

  it('lets native form controls receive pointer input while formatting buttons preserve the text range', () => {
    editor('Text')
    const selectPress = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    document.querySelector('select')!.dispatchEvent(selectPress)
    expect(selectPress.defaultPrevented).toBe(false)

    const buttonPress = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    document.querySelector('button')!.dispatchEvent(buttonPress)
    expect(buttonPress.defaultPrevented).toBe(true)
  })

  it('edits visible literal text while keeping resolved tokens indivisible', async () => {
    const e = editor('Hi {filament.color}')
    expect(e.node.contentEditable).toBe('true')
    const chip = e.node.querySelector<HTMLElement>('[data-template-token-chip]')!
    expect(chip.title).toBe('{filament.color}')
    expect(e.node.querySelector<HTMLElement>('[data-template-atomic]')!.contentEditable).toBe('false')
    e.select(e.node.firstChild!.firstChild!, 1)
    e.input('insertText', 'ey')
    await Promise.resolve()
    expect(e.selected.template).toBe('Heyi {filament.color}')
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(document.getSelection()!.anchorOffset).toBe(3)
  })

  it('shows one attached caption and a selected chip only after clicking a token', () => {
    const e = editor('{filament.color} {filament.name}')
    const chips = [...e.node.querySelectorAll<HTMLElement>('[data-template-token-chip]')]
    const canvas = document.querySelector<HTMLElement>('#freeform-canvas-host')!
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === canvas) return DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 100 })
      if (this === e.node) return DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 20 })
      if (this === chips[0]) return DOMRect.fromRect({ x: 5, y: 0, width: 45, height: 18 })
      if (this === chips[1]) return DOMRect.fromRect({ x: 55, y: 0, width: 35, height: 18 })
      if (this.hasAttribute('data-template-token-caption')) return DOMRect.fromRect({ width: 80, height: 12 })
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    e.binding.sync()
    expect(canvas.querySelector('[data-template-token-caption]')).toBeNull()
    expect(chips.every(chip => !chip.hasAttribute('data-template-token-active'))).toBe(true)
    chips[0].click()
    let captions = [...canvas.querySelectorAll<HTMLElement>('[data-template-token-caption]')]
    expect(captions.map(caption => caption.textContent)).toEqual(['filament.color'])
    expect(captions[0].hasAttribute('data-label-editor-chrome')).toBe(true)
    expect(chips[0].hasAttribute('data-template-token-active')).toBe(true)
    expect(chips[1].hasAttribute('data-template-token-active')).toBe(false)
    expect(document.getSelection()?.isCollapsed).toBe(true)
    chips[1].click()
    captions = [...canvas.querySelectorAll<HTMLElement>('[data-template-token-caption]')]
    expect(captions.map(caption => caption.textContent)).toEqual(['filament.name'])
    expect(chips[0].hasAttribute('data-template-token-active')).toBe(false)
    expect(chips[1].hasAttribute('data-template-token-active')).toBe(true)
    const output = canvas.cloneNode(true) as HTMLElement
    prepareLabelOutputClone(output)
    expect(output.querySelector('[data-template-token-caption]')).toBeNull()
    expect(output.querySelector('[data-template-token-active]')).toBeNull()
  })

  it('prevents native text selection before a token click can highlight its chip', () => {
    const e = editor('Hi {filament.color}')
    const chip = e.node.querySelector<HTMLElement>('[data-template-token-chip]')!
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    chip.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    chip.click()
    expect(chip.hasAttribute('data-template-token-active')).toBe(true)
    expect(document.getSelection()?.isCollapsed).toBe(true)
  })

  it.each([
    ['ArrowLeft', 'AX{filament.color}B'],
    ['ArrowRight', 'A{filament.color}XB'],
  ] as const)('keeps the caret at the token boundary after browser focus settles on %s', async (key, expected) => {
    const e = editor('A{filament.color}B')
    e.node.querySelector<HTMLElement>('[data-template-token-chip]')!.click()
    vi.spyOn(e.node, 'focus').mockImplementation(() => {
      queueMicrotask(() => e.select(e.node.firstChild!.firstChild!, 0))
    })
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

    expect(e.binding.handleKeydown(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    await Promise.resolve()
    e.input('insertText', 'X')
    await Promise.resolve()

    expect(e.selected.template).toBe(expected)
  })

  it.each([
    ['ArrowLeft', 2, 0, 'AX{filament.color}B'],
    ['ArrowRight', 0, 1, 'A{filament.color}XB'],
  ] as const)('keeps an adjacent token selected through browser selection repair on %s', async (key, leafIndex, offset, expected) => {
    const e = editor('A{filament.color}B')
    const leaves = e.node.querySelectorAll<HTMLElement>('[data-template-leaf]')
    const token = e.node.querySelector<HTMLElement>('[data-template-token-chip]')!
    e.select(leaves[leafIndex].firstChild!, offset)
    const enter = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

    expect(e.binding.handleKeydown(enter)).toBe(true)
    expect(enter.defaultPrevented).toBe(true)
    expect(token.hasAttribute('data-template-token-active')).toBe(true)
    e.select(leaves[0].firstChild!, 0)
    document.dispatchEvent(new Event('selectionchange'))
    expect(token.hasAttribute('data-template-token-active')).toBe(true)

    e.binding.handleKeydown(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    e.input('insertText', 'X')
    await Promise.resolve()
    expect(e.selected.template).toBe(expected)
  })

  it.each([
    ['ArrowLeft', 0, 1],
    ['ArrowRight', 1, 2],
  ] as const)('selects the next visible token across formatted whitespace on %s', (key, gapOffset, tokenIndex) => {
    const e = editor('**{filament.color} {filament.name}**  {filament.color}')
    const gap = [...e.node.querySelectorAll<HTMLElement>('[data-template-leaf]')]
      .find(leaf => leaf.textContent === '  ')!
    const tokens = e.node.querySelectorAll<HTMLElement>('[data-template-token-chip]')
    e.select(gap.firstChild!, gapOffset)
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

    expect(e.binding.handleKeydown(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(tokens[tokenIndex].hasAttribute('data-template-token-active')).toBe(true)
  })

  it('prevents native selection when entering a text box through a token', () => {
    const e = editor('Hi {filament.color}')
    e.binding.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const token = e.node.querySelector<HTMLElement>('[data-template-atomic]')!
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    token.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(e.node.contentEditable).toBe('true')
    token.click()
    expect(token.hasAttribute('data-template-token-active')).toBe(true)
    expect(document.getSelection()?.isCollapsed).toBe(true)
  })

  it('moves the selected token caption aside when the next line has text', () => {
    const e = editor('{filament.color} {filament.name}')
    const chips = [...e.node.querySelectorAll<HTMLElement>('[data-template-token-chip]')]
    const canvas = document.querySelector<HTMLElement>('#freeform-canvas-host')!
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === canvas) return DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 100 })
      if (this === e.node) return DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 35 })
      if (this === chips[0]) return DOMRect.fromRect({ x: 5, y: 0, width: 45, height: 18 })
      if (this === chips[1]) return DOMRect.fromRect({ x: 0, y: 18, width: 90, height: 12 })
      if (this.hasAttribute('data-template-token-caption')) return DOMRect.fromRect({ width: 40, height: 10 })
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    chips[0].click()
    const caption = canvas.querySelector<HTMLElement>('[data-template-token-caption]')!
    expect(caption.style.left).toBe('50px')
    expect(caption.style.top).toBe('0px')
  })

  it('places a crowded caption below the text box instead of covering its next line', () => {
    const e = editor('{filament.color} {filament.name}')
    const chips = [...e.node.querySelectorAll<HTMLElement>('[data-template-token-chip]')]
    const canvas = document.querySelector<HTMLElement>('#freeform-canvas-host')!
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === canvas || this === e.node) return DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 30 })
      if (this === chips[0]) return DOMRect.fromRect({ x: 5, y: 0, width: 45, height: 18 })
      if (this === chips[1]) return DOMRect.fromRect({ x: 0, y: 18, width: 100, height: 12 })
      if (this.hasAttribute('data-template-token-caption')) return DOMRect.fromRect({ width: 80, height: 12 })
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    chips[0].click()
    expect(canvas.querySelector<HTMLElement>('[data-template-token-caption]')?.style.top).toBe('30px')
  })

  it('replaces a partial token highlight as a complete token', () => {
    const e = editor('Hi {filament.color}!')
    const token = e.node.querySelector('[data-template-atomic]')!
    e.select(token.firstChild!, 2, token.firstChild!, 5)
    e.input('insertText', 'blue')
    expect(e.selected.template).toBe('Hi blue!')
  })

  it('backspaces an entire token beside a caret', () => {
    const e = editor('Hi {filament.color}!')
    const tail = e.node.lastChild!.firstChild!
    e.select(tail, 0)
    e.input('deleteContentBackward')
    expect(e.selected.template).toBe('Hi !')
  })

  it.each([
    ['deleteWordBackward', 'Hello world', 11, 6, 11, 'Hello '],
    ['deleteWordForward', 'Hello world', 0, 0, 5, ' world'],
    ['deleteSoftLineBackward', 'Hello world', 11, 0, 11, ''],
    ['deleteHardLineForward', 'Hello world', 0, 0, 11, ''],
    ['deleteSoftLineBackward', 'Hello ', 6, 0, 5, ''],
  ] as const)('honors the browser deletion range for %s in %j', (inputType, source, caret, start, end, expected) => {
    const e = editor(source)
    const text = e.node.firstChild!.firstChild!
    e.select(text, caret)
    const target = document.createRange()
    target.setStart(text, start)
    target.setEnd(text, end)
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })
    Object.defineProperty(event, 'getTargetRanges', { value: () => [target] })
    e.node.dispatchEvent(event)
    expect(e.selected.template).toBe(expected)
  })

  it('copies source tokens with enclosing formatting and pastes them without HTML', async () => {
    const e = editor('**Hi {filament.color}**!')
    const token = e.node.querySelector('[data-template-atomic]')!
    e.select(token.firstChild!, 2, token.firstChild!, 5)
    const copied = e.clipboard('copy')
    expect(copied.getData('text/plain')).toBe('**{filament.color}**')
    e.select(e.node.lastChild!.firstChild!, 1)
    e.clipboard('paste', { 'text/plain': copied.getData('text/plain'), 'text/html': '<img src=x onerror="alert(1)">' })
    await Promise.resolve()
    expect(e.selected.template).toBe('[b]Hi {filament.color}[/b]![b]{filament.color}[/b]')
    expect([...e.node.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['Hi Ocean Blue', 'Ocean Blue'])
    expect(e.node.querySelector('img')).toBeNull()
  })

  it('deletes across formatting boundaries without leaving markup or removing unselected letters', () => {
    const e = editor('**Hello** world')
    const leaves = e.node.querySelectorAll('[data-template-leaf]')
    e.select(leaves[0].firstChild!, 2, leaves[1].firstChild!, 3)
    e.input('deleteContentForward')
    expect(e.selected.template).toBe('**He**rld')
  })

  it('commits composed input once and keeps tokens intact', async () => {
    const e = editor('Hi {filament.color}')
    e.select(e.node.firstChild!.firstChild!, 3)
    e.node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    e.input('insertCompositionText', 'n')
    e.input('insertCompositionText', 'ñ')
    expect(e.selected.template).toBe('Hi {filament.color}')
    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: 'ñ' }) // happy-dom does not implement CompositionEvent.data.
    e.node.dispatchEvent(end)
    await Promise.resolve()
    expect(e.selected.template).toBe('Hi ñ{filament.color}')
  })

  it('targets a whole token for formatting without native text highlighting', async () => {
    const e = editor('Hi {filament.color}')
    e.node.querySelector('[data-template-atomic]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.getSelection()!.toString()).toBe('')
    expect(e.binding.format('bold')).toBe(true)
    await Promise.resolve()
    expect(e.selected.template).toBe('Hi [b]{filament.color}[/b]')
    expect(document.getSelection()!.toString()).toBe('')
  })

  it('keeps a rapid run of edits and restores its latest caret', async () => {
    const e = editor('Hi ')
    e.select(e.node.firstChild!.firstChild!, 3)
    e.input('insertText', 'a'); e.input('insertText', 'b'); e.input('insertText', 'c')
    await Promise.resolve()
    expect(e.selected.template).toBe('Hi abc')
    expect(document.getSelection()!.anchorOffset).toBe(6)
  })

  it('restores the active caret after an undo rerenders the text', async () => {
    const e = editor('Hi ')
    e.select(e.node.firstChild!.firstChild!, 3)
    e.input('insertText', 'a')
    await Promise.resolve()
    e.selected.template = 'Hi '
    e.node.replaceChildren(renderSelectableTemplate('Hi ', {} as SpoolData))
    e.binding.sync()
    expect(document.getSelection()!.anchorNode).toBe(e.node.firstChild!.firstChild)
    expect(document.getSelection()!.anchorOffset).toBe(3)
  })

  it('keeps uppercase-expanded literal characters editable without token chips', () => {
    const e = editor('^^Straße^^ {filament.color}')
    const expanded = [...e.node.querySelectorAll<HTMLElement>('[data-template-atomic]')].find(node => node.textContent === 'SS')!
    expect(expanded.contentEditable).not.toBe('false')
    expect(expanded.hasAttribute('data-template-token-chip')).toBe(false)
  })

  it('deletes the latest typed character when rendering has not caught up', async () => {
    const e = editor('Hi {filament.color}', true)
    e.select(e.node, e.node.childNodes.length)
    e.input('insertText', 'abc')
    e.input('deleteContentBackward')
    expect(e.selected.template).toBe('Hi {filament.color}ab')
    e.flush()
    await Promise.resolve()
    expect(document.getSelection()!.anchorOffset).toBe(2)
  })

  it.each([
    ['deleteWordBackward', 'Hi ', 'world', 'Hi '],
    ['deleteSoftLineBackward', 'Hi ', 'world', ''],
    ['deleteWordBackward', 'Hi {filament.color}', ' ', 'Hi '],
  ])('keeps %s working while a render is pending for %j', async (inputType, source, inserted, expected) => {
    const e = editor(source, true)
    e.select(e.node, e.node.childNodes.length)
    e.input('insertText', inserted)
    e.input(inputType)
    expect(e.selected.template).toBe(expected)
    e.flush()
    await Promise.resolve()
  })

  it('inserts a dock token at the visible caret', async () => {
    const e = editor('Hi there')
    e.select(e.node.firstChild!.firstChild!, 3)
    expect(e.binding.insertField('{filament.color}')).toBe(true)
    await Promise.resolve()
    expect(e.selected.template).toBe('Hi {filament.color}there')
  })

  it('preserves copied bold text when pasted inside existing bold text', async () => {
    const e = editor('**Hello**')
    e.select(e.node.querySelector('[data-template-leaf]')!.firstChild!, 2)
    e.clipboard('paste', { 'text/plain': '**X**' })
    await Promise.resolve()
    expect(e.node.textContent).toBe('HeXllo')
    expect([...e.node.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('HeXllo')
  })

  it('removes empty markup after deleting the last styled character', async () => {
    const e = editor('**X**')
    e.select(e.node.querySelector('[data-template-leaf]')!.firstChild!, 1)
    e.input('deleteContentBackward')
    await Promise.resolve()
    expect(e.selected.template).toBe('')
    expect(e.node.textContent).toBe('')
  })

  it('keeps the latest edit caret when an older formatting refresh finishes later', async () => {
    const e = editor('Hello', true)
    e.select(e.node.firstChild!.firstChild!, 0, e.node.firstChild!.firstChild!, 5)
    e.binding.format('bold')
    e.input('insertText', 'X')
    e.flush(true)
    await Promise.resolve()
    expect(e.selected.template).toBe('[b]X[/b]')
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(document.getSelection()!.anchorOffset).toBe(1)
  })

  it('rejects oversized paste without truncating tokens or existing source', () => {
    const e = editor('Hi {filament.color}')
    e.select(e.node, e.node.childNodes.length)
    e.clipboard('paste', { 'text/plain': 'X'.repeat(8001) })
    expect(e.selected.template).toBe('Hi {filament.color}')
  })
})

it('tracks the selected nested style and toggles it with toolbar clicks', async () => {
  const e = editor('**__{filament.color}__** plain')
  const bold = document.querySelector<HTMLButtonElement>('[data-text-modifier="bold"]')!
  e.node.querySelector('[data-template-atomic]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  document.dispatchEvent(new Event('selectionchange'))
  expect(bold.getAttribute('aria-pressed')).toBe('true')
  for (let i = 0; i < 4; i++) {
    bold.click()
    await Promise.resolve()
    expect(bold.getAttribute('aria-pressed')).toBe(String(i % 2 !== 0))
    expect(e.node.textContent).toBe('Ocean Blue plain')
  }
  const tail = e.node.lastChild!.firstChild!
  e.select(tail, 1, tail, 4)
  document.dispatchEvent(new Event('selectionchange'))
  expect(bold.getAttribute('aria-pressed')).toBe('false')
})
