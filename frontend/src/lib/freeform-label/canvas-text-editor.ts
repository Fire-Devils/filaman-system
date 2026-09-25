import type { LabelDesignElement, LabelFontFamily } from './types'
import {
  formatTemplateRange,
  formatTemplateFontRange,
  getTemplateFontForRange,
  isTemplateModifierActive,
  getTemplateSelectionRange,
  getTemplateCaretRange,
  copyTemplateRange,
  replaceTemplateRange,
  adjacentTemplateRange,
  restoreTemplateSelection,
  type TemplateSourceRange,
  type TemplateTextModifier,
} from './template-selection'

interface CanvasTextEditorOptions {
  root: ParentNode
  getSelected(): LabelDesignElement | null
  getTemplateRange(): TemplateSourceRange
  setTemplateRange?(range: TemplateSourceRange): void
  resetTemplateRange(): void
  isEditable(): boolean
  select(id: string): void
  updateTemplate(template: string, range: TemplateSourceRange): void
  undo(): void
  redo(): void
  refresh(): Promise<void>
  refreshInteractions(): Promise<void>
}

/** Native visible-text editing; template source stays authoritative. */
export function bindCanvasTextEditor(options: CanvasTextEditorOptions) {
  const canvas = options.root.querySelector<HTMLElement>('#freeform-canvas-host')
  const toolbar = options.root.querySelector<HTMLElement>('#freeform-text-toolbar')
  const template = options.root.querySelector<HTMLTextAreaElement>('#freeform-template')
  let editingId: string | null = null
  let selectedId: string | null = null
  let canvasRange: TemplateSourceRange | null = null
  let destroyed = false
  let gestureActive = false
  let pendingEdit = 0
  let editRevision = 0
  let compositionRange: TemplateSourceRange | null = null
  let captionTokens: Array<{ token: HTMLElement; caption: HTMLElement }> = []
  let activeTokenIndex: number | null = null
  const cleanups: Array<() => void> = []
  const listen = <E extends Event = Event>(target: EventTarget | null, event: string, handler: (event: E) => void) => {
    target?.addEventListener(event, handler as EventListener)
    cleanups.push(() => target?.removeEventListener(event, handler as EventListener))
  }
  const selectedNode = (id = options.getSelected()?.id) => {
    return Array.from(canvas?.querySelectorAll<HTMLElement>('[data-label-element-id]') ?? [])
      .find(node => node.dataset.labelElementId === id) ?? null
  }
  const adjacentRenderedToken = (node: HTMLElement, selection: Selection | null, backward: boolean) => {
    if (!selection?.rangeCount || !selection.isCollapsed || !node.contains(selection.anchorNode)) return null
    const anchor = selection.anchorNode!
    const leaf = (anchor instanceof Element ? anchor : anchor.parentElement)
      ?.closest<HTMLElement>('[data-template-start][data-template-end]')
    if (!leaf || leaf.hasAttribute('data-template-atomic') || anchor !== leaf.firstChild || anchor.nodeType !== Node.TEXT_NODE) return null
    const text = leaf.textContent ?? ''
    const offset = selection.anchorOffset
    const atVisibleEdge = /^\s*$/.test(text)
      ? backward ? offset < text.length : offset > 0
      : backward ? offset === 0 : offset === text.length
    if (!atVisibleEdge) return null
    const leaves = [...node.querySelectorAll<HTMLElement>('[data-template-start][data-template-end]')]
      .filter(candidate => candidate.textContent)
    const adjacent = leaves[leaves.indexOf(leaf) + (backward ? -1 : 1)]
    return adjacent?.hasAttribute('data-template-atomic') ? adjacent : null
  }

  const positionCaptions = () => {
    if (!canvas || !captionTokens.length) return
    const host = canvas.getBoundingClientRect()
    for (const { token, caption } of captionTokens) {
      if (!token.isConnected || !caption.isConnected) continue
      const tokenRect = token.getBoundingClientRect()
      const { width, height } = caption.getBoundingClientRect()
      const textBox = selectedNode()
      const occupied = [...(textBox?.querySelectorAll<HTMLElement>('[data-template-start][data-template-end]') ?? [])]
        .filter(leaf => leaf !== token)
        .flatMap(leaf => [...leaf.getClientRects()])
      const right = tokenRect.right - host.left
      const left = tokenRect.left - host.left
      const top = tokenRect.top - host.top
      const bottom = tokenRect.bottom - host.top
      const choices = [
        { x: right - width, y: bottom },
        { x: left, y: bottom },
        { x: right - width, y: top - height },
        { x: right, y: top },
        { x: left - width, y: top },
        { x: right - width, y: (textBox?.getBoundingClientRect().bottom ?? tokenRect.bottom) - host.top },
      ]
      const fits = ({ x, y }: { x: number; y: number }) => x >= 0 && y >= 0 && x + width <= host.width && y + height <= host.height
        && occupied.every(rect => x + host.left >= rect.right - 1 || x + width + host.left <= rect.left + 1 || y + host.top >= rect.bottom - 1 || y + height + host.top <= rect.top + 1)
      const choice = choices.find(fits) ?? choices.at(-1)!
      caption.style.left = `${Math.max(0, Math.min(choice.x, host.width - width))}px`
      caption.style.top = `${choice.y}px`
    }
  }
  const clearActiveToken = () => {
    activeTokenIndex = null
    canvas?.querySelectorAll('[data-template-token-active], [data-template-token-caption]').forEach(node => {
      if (node.hasAttribute('data-template-token-caption')) node.remove()
      else node.removeAttribute('data-template-token-active')
    })
    captionTokens = []
  }
  const activateToken = (token: HTMLElement) => {
    const node = selectedNode()
    if (!node?.contains(token)) return false
    canvasRange = { start: Number(token.dataset.templateStart), end: Number(token.dataset.templateEnd) }
    options.setTemplateRange?.(canvasRange)
    activeTokenIndex = [...node.querySelectorAll('[data-template-atomic]')].indexOf(token)
    document.getSelection()?.removeAllRanges()
    sync()
    syncModifierState()
    return true
  }
  const zoomObserver = typeof MutationObserver === 'undefined' || !canvas ? null : new MutationObserver(records => {
    if (records.some(record => record.target instanceof Element && record.target.matches('.label-preview, .label-wrapper'))) positionCaptions()
  })
  zoomObserver?.observe(canvas!, { attributes: true, attributeFilter: ['style'], subtree: true })
  if (zoomObserver) cleanups.push(() => zoomObserver.disconnect())
  listen(window, 'resize', positionCaptions)

  const sync = () => {
    if (destroyed) return
    const selected = options.getSelected()
    const text = options.isEditable() && selected?.type === 'text' ? selected : null
    const leavingTextSelection = editingId !== null && selectedId !== text?.id
    if (selectedId !== text?.id) {
      editingId = null
      canvasRange = null
      compositionRange = null
      pendingEdit = 0
      editRevision++
      selectedId = text?.id ?? null
      activeTokenIndex = null
    }
    if (!text) editingId = null
    canvas?.querySelectorAll('[data-template-token-caption]').forEach(caption => caption.remove())
    captionTokens = []
    for (const node of canvas?.querySelectorAll<HTMLElement>('[data-label-element-id]') ?? []) {
      const editing = node.dataset.labelElementId === editingId
      node.toggleAttribute('data-label-text-editing', editing)
      if (editing) node.contentEditable = 'true'
      else node.removeAttribute('contenteditable')
      for (const [index, token] of [...node.querySelectorAll<HTMLElement>('[data-template-atomic]')].entries()) {
        const source = text?.template.slice(Number(token.dataset.templateStart), Number(token.dataset.templateEnd)) ?? ''
        const chip = editing && /^\{[^{}]*\}$/.test(source)
        token.toggleAttribute('data-template-token-chip', chip)
        const active = chip && index === activeTokenIndex
        token.toggleAttribute('data-template-token-active', active)
        if (chip) {
          token.contentEditable = 'false'; token.draggable = false; token.title = source
          if (active) {
            const caption = document.createElement('span')
            caption.dataset.templateTokenCaption = ''
            caption.dataset.labelEditorChrome = ''
            caption.setAttribute('aria-hidden', 'true')
            caption.textContent = source.slice(1, -1)
            canvas?.append(caption)
            captionTokens.push({ token, caption })
          }
        }
        else { token.removeAttribute('contenteditable'); token.removeAttribute('draggable'); token.removeAttribute('title') }
      }
      if (editing && canvasRange && activeTokenIndex === null && !pendingEdit && !compositionRange && !node.contains(document.getSelection()?.anchorNode ?? null)) {
        restoreTemplateSelection(node, canvasRange)
      }
    }
    if (leavingTextSelection) void options.refreshInteractions()
    syncModifierState()
    positionToolbar()
    positionCaptions()
  }

  const positionToolbar = () => {
    if (destroyed || !toolbar) return
    const selected = options.getSelected()
    const node = selectedNode(selected?.id)
    toolbar.hidden = gestureActive || !options.isEditable() || !selected || !node
    toolbar.style.left = ''
    toolbar.style.top = ''
  }

  const syncModifierState = () => {
    const selected = options.getSelected()
    const source = canvasRange ?? options.getTemplateRange()
    const range = source.end > source.start ? source : { start: 0, end: selected?.type === 'text' ? selected.template.length : 0 }
    toolbar?.querySelectorAll<HTMLButtonElement>('[data-text-modifier]').forEach(button => {
      button.setAttribute('aria-pressed', String(selected?.type === 'text' && isTemplateModifierActive(
        selected.template, range.start, range.end, button.dataset.textModifier as TemplateTextModifier,
      )))
    })
    if (selected?.type === 'text') {
      const family = (source.end > source.start
        ? getTemplateFontForRange(selected.template, source.start, source.end) : null) ?? selected.fontFamily
      const current = toolbar?.querySelector<HTMLElement>('[data-font-current]')
      if (current) {
        current.textContent = family
        current.style.fontFamily = family
      }
      toolbar?.querySelectorAll<HTMLButtonElement>('[data-font-choice]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.fontChoice === family))
      })
    }
  }

  const rememberCanvasRange = () => {
    if (!editingId || pendingEdit || compositionRange) return
    const node = selectedNode()
    const selection = document.getSelection()
    if (!node || !selection || !node.contains(selection.anchorNode)) return
    if (activeTokenIndex !== null) {
      if (selection.isCollapsed) return
      clearActiveToken()
    }
    canvasRange = getTemplateSelectionRange(node, selection) ?? getTemplateCaretRange(node, selection)
    if (canvasRange) options.setTemplateRange?.(canvasRange)
    syncModifierState()
    if (canvasRange && !selection.isCollapsed) {
      const range = selection.getRangeAt(0)
      const atomicBoundary = [range.startContainer, range.endContainer].some(node =>
        (node instanceof Element ? node : node.parentElement)?.closest('[data-template-atomic]'))
      if (atomicBoundary) restoreTemplateSelection(node, canvasRange)
    }
  }

  const startSelecting = (id: string) => {
    if (!options.isEditable()) return
    options.select(id)
    sync()
    if (options.getSelected()?.type !== 'text') return
    editingId = id
    activeTokenIndex = null
    canvasRange = null
    options.resetTemplateRange()
    sync()
    void options.refreshInteractions()
    selectedNode()?.focus({ preventScroll: true })
    rememberCanvasRange()
  }

  const stopSelecting = (resetRange = true) => {
    editingId = null
    clearActiveToken()
    canvasRange = null
    compositionRange = null
    pendingEdit = 0
    editRevision++
    if (resetRange) {
      options.resetTemplateRange()
      document.getSelection()?.removeAllRanges()
    }
    sync()
    void options.refreshInteractions()
  }

  const commitFormatting = (selected: Extract<LabelDesignElement, { type: 'text' }>, result: ReturnType<typeof formatTemplateRange>, highlighted: TemplateSourceRange | null, fromCanvas: boolean) => {
    if (result.template.length > 8000) return true
    options.updateTemplate(result.template, result)
    if (fromCanvas) canvasRange = { start: result.start, end: result.end }
    syncModifierState()
    const revision = ++editRevision
    pendingEdit = revision
    void options.refresh().then(() => {
      if (destroyed || options.getSelected()?.id !== selected.id || revision !== editRevision) return
      pendingEdit = 0
      sync()
      if (activeTokenIndex !== null) document.getSelection()?.removeAllRanges()
      else if (fromCanvas && editingId && selectedNode()) {
        restoreTemplateSelection(selectedNode()!, result)
      } else if (template && highlighted) {
        template.focus({ preventScroll: true })
        template.setSelectionRange(result.start, result.end)
      }
    })
    return true
  }

  const highlightedRange = () => {
    rememberCanvasRange()
    const source = options.getTemplateRange()
    return canvasRange && canvasRange.end > canvasRange.start ? canvasRange : source.end > source.start ? source : null
  }

  const format = (modifier: TemplateTextModifier, wholeIfEmpty = true): boolean => {
    const selected = options.getSelected()
    if (!options.isEditable() || selected?.type !== 'text') return false
    const highlighted = highlightedRange()
    if (!highlighted && !wholeIfEmpty) return false
    const range = highlighted ?? { start: 0, end: selected.template.length }
    return commitFormatting(selected, formatTemplateRange(selected.template, range.start, range.end, modifier), highlighted, canvasRange !== null || editingId !== null)
  }

  const formatFont = (family: LabelFontFamily): boolean => {
    const selected = options.getSelected()
    if (!options.isEditable() || selected?.type !== 'text') return false
    const highlighted = highlightedRange()
    if (!highlighted) return false
    return commitFormatting(selected, formatTemplateFontRange(selected.template, highlighted.start, highlighted.end, family), highlighted, canvasRange !== null || editingId !== null)
  }

  const edit = (replacement: string, range?: TemplateSourceRange) => {
    const selected = options.getSelected()
    if (!editingId || selected?.type !== 'text' || replacement.length > 8000) return
    rememberCanvasRange()
    const source = range ?? canvasRange ?? { start: selected.template.length, end: selected.template.length }
    clearActiveToken()
    const result = replaceTemplateRange(selected.template, source.start, source.end, replacement)
    // Match the stored template limit without letting normalization cut a token.
    if (result.template.length > 8000) return
    canvasRange = result
    options.updateTemplate(result.template, result)
    const revision = ++editRevision
    pendingEdit = revision
    void options.refresh().then(() => {
      if (destroyed || revision !== pendingEdit || selected.id !== editingId) return
      pendingEdit = 0
      sync()
      const node = selectedNode()
      if (node) { node.focus({ preventScroll: true }); restoreTemplateSelection(node, result) }
    })
  }

  listen<InputEvent>(canvas, 'beforeinput', event => {
    if (!editingId || !options.isEditable()) return
    if (compositionRange && event.isComposing) return
    if (event.inputType === 'insertCompositionText') return
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault()
      if (event.inputType === 'historyUndo') options.undo()
      else options.redo()
      return
    }
    event.preventDefault()
    rememberCanvasRange()
    const selected = options.getSelected()
    if (selected?.type !== 'text') return
    if (event.inputType.startsWith('delete')) {
      let source = canvasRange ?? { start: selected.template.length, end: selected.template.length }
      // Native ranges capture word/visual-line boundaries and platform shortcuts.
      // During a pending render, only the latest source caret is authoritative.
      const target = !pendingEdit && event.getTargetRanges?.()[0]
      const node = selectedNode()
      if (target && node?.contains(target.startContainer) && node.contains(target.endContainer)) {
        const range = document.createRange()
        range.setStart(target.startContainer, target.startOffset)
        range.setEnd(target.endContainer, target.endOffset)
        const mapped = getTemplateSelectionRange(node, range)
        // Include collapsed whitespace between the visible boundary and caret.
        if (mapped) source = { start: Math.min(source.start, mapped.start), end: Math.max(source.end, mapped.end) }
      }
      if (source.start === source.end) {
        const backward = event.inputType.endsWith('Backward')
        const unit = event.inputType.includes('Word') ? 'word' : event.inputType.includes('Line') ? 'line' : 'grapheme'
        const adjacent = adjacentTemplateRange(selected.template, source.start, backward, unit)
        if (adjacent) edit('', adjacent)
      } else edit('', source)
    } else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') edit('\n')
    else if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') edit(event.data ?? '')
    else if (event.inputType === 'formatBold') format('bold')
    else if (event.inputType === 'formatItalic') format('italic')
    else if (event.inputType === 'formatUnderline') format('underline')
  })
  listen<CompositionEvent>(canvas, 'compositionstart', () => {
    if (!editingId) return
    rememberCanvasRange()
    const selected = options.getSelected()
    if (selected?.type === 'text') compositionRange = canvasRange ?? { start: selected.template.length, end: selected.template.length }
  })
  listen<CompositionEvent>(canvas, 'compositionend', event => {
    const range = compositionRange
    compositionRange = null
    if (range) edit(event.data, range)
  })
  listen<MouseEvent>(canvas, 'click', event => {
    if (!editingId || event.shiftKey) return
    const token = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-template-token-chip]') : null
    if (!token || !activateToken(token)) clearActiveToken()
  })
  const copy = (event: ClipboardEvent) => {
    if (!editingId || !event.clipboardData) return
    rememberCanvasRange()
    const selected = options.getSelected()
    if (selected?.type !== 'text' || !canvasRange || canvasRange.start === canvasRange.end) return
    const text = copyTemplateRange(selected.template, canvasRange.start, canvasRange.end)
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData('application/x-filaman-template-text', text)
    if (event.type === 'cut') edit('')
  }
  listen<ClipboardEvent>(canvas, 'copy', copy)
  listen<ClipboardEvent>(canvas, 'cut', copy)
  listen<ClipboardEvent>(canvas, 'paste', event => {
    if (!editingId || !event.clipboardData) return
    event.preventDefault()
    const text = event.clipboardData.getData('application/x-filaman-template-text') || event.clipboardData.getData('text/plain')
    if (text) edit(text.replace(/\r\n?/g, '\n'))
  })
  listen<DragEvent>(canvas, 'drop', event => { if (editingId) event.preventDefault() })

  const directTextPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const node = event.target.closest<HTMLElement>('[data-label-element-type="text"]')
    if (node && event.target.closest('[data-template-atomic]')) event.preventDefault()
    if (node?.dataset.labelElementId && editingId !== node.dataset.labelElementId) {
      startSelecting(node.dataset.labelElementId)
      event.stopPropagation()
    }
  }
  canvas?.addEventListener('pointerdown', directTextPointerDown, true)
  cleanups.push(() => canvas?.removeEventListener('pointerdown', directTextPointerDown, true))
  listen<KeyboardEvent>(canvas, 'keydown', event => {
    if (event.key !== 'Enter' || editingId || !(event.target instanceof Element)) return
    const node = event.target.closest<HTMLElement>('[data-label-element-type="text"]')
    if (!node?.dataset.labelElementId) return
    event.preventDefault()
    startSelecting(node.dataset.labelElementId)
  })
  listen(canvas, 'dblclick', event => {
    const node = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-label-element-type="text"], [data-label-selection-for]') : null
    const id = node?.dataset.labelElementId ?? node?.dataset.labelSelectionFor
    if (id && (node?.dataset.labelElementType === 'text' || options.getSelected()?.type === 'text')) startSelecting(id)
  })
  listen(document, 'selectionchange', rememberCanvasRange)
  listen(template, 'focus', () => stopSelecting(false))
  listen(template, 'select', () => { canvasRange = null; clearActiveToken(); syncModifierState() })
  listen(toolbar, 'pointerdown', event => {
    if (!(event.target instanceof Element) || !event.target.closest('button')) return
    rememberCanvasRange()
    // Keep the highlighted range when the user presses a formatting button.
    event.preventDefault()
  })
  listen(toolbar, 'click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
    if (!button) return
    if (button.dataset.textModifier) format(button.dataset.textModifier as TemplateTextModifier)
  })
  return {
    sync,
    restoreHistorySelection() {
      clearActiveToken()
      compositionRange = null
      const selected = options.getSelected()
      selectedId = selected?.type === 'text' ? selected.id : null
      editingId = editingId ? selectedId : null
      const range = options.getTemplateRange()
      canvasRange = editingId ? range : null
      const revision = ++editRevision
      pendingEdit = revision
      // The current DOM still has offsets from the previous history entry.
      if (editingId) document.getSelection()?.removeAllRanges()
      void options.refresh().then(() => {
        if (destroyed || revision !== editRevision) return
        pendingEdit = 0
        sync()
        const node = selectedNode()
        if (editingId && node) {
          node.focus({ preventScroll: true })
          restoreTemplateSelection(node, range)
        } else template?.setSelectionRange(range.start, range.end)
      })
    },
    positionToolbar,
    setGestureActive(active: boolean) {
      gestureActive = active
      positionToolbar()
    },
    format,
    formatFont,
    insertField(token: string): boolean {
      if (!editingId || !options.isEditable()) return false
      edit(token)
      return true
    },
    handleKeydown(event: KeyboardEvent): boolean {
      if (!editingId) return false
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) return false
      const horizontalArrow = ['ArrowLeft', 'ArrowRight'].includes(event.key)
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      if (activeTokenIndex !== null && horizontalArrow) {
        event.preventDefault()
        const boundary = event.key === 'ArrowLeft' ? canvasRange?.start : canvasRange?.end
        const node = selectedNode()
        if (boundary !== undefined && node) {
          clearActiveToken()
          canvasRange = { start: boundary, end: boundary }
          options.setTemplateRange?.(canvasRange)
          restoreTemplateSelection(node, canvasRange)
          syncModifierState()
        }
      } else if (horizontalArrow) {
        const node = selectedNode()
        const selection = document.getSelection()
        const caret = node ? getTemplateCaretRange(node, selection) : null
        const stored = canvasRange
        const position = caret?.start ?? (stored && stored.start === stored.end ? stored.start : null)
        const backward = event.key === 'ArrowLeft'
        const token = (position === null ? null : [...(node?.querySelectorAll<HTMLElement>('[data-template-atomic]') ?? [])].find(candidate =>
          Number(candidate.dataset[backward ? 'templateEnd' : 'templateStart']) === position))
          ?? (node ? adjacentRenderedToken(node, selection, backward) : null)
        if (token) {
          event.preventDefault()
          activateToken(token)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        stopSelecting()
      } else if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        format(({ b: 'bold', i: 'italic', u: 'underline' } as const)[event.key.toLowerCase() as 'b' | 'i' | 'u'])
      }
      // Selection-mode arrows/Delete belong to text selection, not element mutations.
      return true
    },
    destroy() {
      destroyed = true
      cleanups.forEach(cleanup => cleanup())
      canvas?.querySelectorAll('[data-template-token-caption]').forEach(caption => caption.remove())
      captionTokens = []
      canvas?.querySelectorAll('[data-label-text-editing]').forEach(node => {
        node.removeAttribute('data-label-text-editing'); node.removeAttribute('contenteditable')
        node.querySelectorAll('[data-template-atomic]').forEach(token => { token.removeAttribute('contenteditable'); token.removeAttribute('draggable'); token.removeAttribute('data-template-token-chip'); token.removeAttribute('data-template-token-active'); token.removeAttribute('title') })
      })
      if (toolbar) toolbar.hidden = true
    },
  }
}
