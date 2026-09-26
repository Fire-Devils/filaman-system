import type { LabelDesignElement } from './types'

const ELEMENT_MIME = 'application/x-filaman-label-element+json'

/** Native clipboard events support keyboard and browser-menu commands without permissions. */
export function bindElementClipboard(options: {
  canvas: HTMLElement | null
  isEditable(): boolean
  getSelected(): LabelDesignElement | null
  paste(element: Record<string, unknown>): boolean
}) {
  const eligible = (event: ClipboardEvent) => options.isEditable() && !event.defaultPrevented
    && event.clipboardData && !(event.target instanceof Element && event.target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-label-text-editing]',
    ))
  const copy = (event: ClipboardEvent) => {
    if (!eligible(event)) return
    const element = options.getSelected()
    if (!element) return
    const source = JSON.stringify({ kind: 'filaman-label-element', version: 1, element })
    event.clipboardData!.setData(ELEMENT_MIME, source)
    event.clipboardData!.setData('text/plain', source)
    event.preventDefault()
  }
  const paste = (event: ClipboardEvent) => {
    if (!eligible(event)) return
    const source = event.clipboardData!.getData(ELEMENT_MIME) || event.clipboardData!.getData('text/plain')
    if (!source || source.length > 100_000) return
    try {
      const value: unknown = JSON.parse(source)
      if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'filaman-label-element'
        || !('version' in value) || value.version !== 1 || !('element' in value)
        || !value.element || typeof value.element !== 'object' || Array.isArray(value.element)) return
      if (options.paste(value.element as Record<string, unknown>)) event.preventDefault()
    } catch { /* Unrelated clipboard content belongs to the browser. */ }
  }
  options.canvas?.addEventListener('copy', copy)
  options.canvas?.addEventListener('paste', paste)
  return () => {
    options.canvas?.removeEventListener('copy', copy)
    options.canvas?.removeEventListener('paste', paste)
  }
}
