export function bindShapeMenu(root: ParentNode) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-shape-menu-trigger]')
  const menu = root.querySelector<HTMLElement>('[data-shape-menu]')
  if (!trigger || !menu) return { destroy() {} }
  const choices = [...menu.querySelectorAll<HTMLButtonElement>('[data-designer-shape]')]
  const ownerDocument = trigger.ownerDocument
  const view = ownerDocument.defaultView
  const listeners: Array<() => void> = []
  function listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture)
    listeners.push(() => target.removeEventListener(type, listener, capture))
  }
  function close(restoreFocus = false) {
    menu!.hidden = true
    trigger!.setAttribute('aria-expanded', 'false')
    if (restoreFocus) trigger!.focus({ preventScroll: true })
  }
  function open(last = false) {
    if (trigger!.disabled || trigger!.closest('[inert]')) return
    menu!.hidden = false
    trigger!.setAttribute('aria-expanded', 'true')
    const anchor = trigger!.getBoundingClientRect()
    const bounds = menu!.getBoundingClientRect()
    const width = view?.innerWidth ?? ownerDocument.documentElement.clientWidth
    const height = view?.innerHeight ?? ownerDocument.documentElement.clientHeight
    menu!.style.left = `${Math.max(8, Math.min(anchor.left, width - bounds.width - 8))}px`
    menu!.style.top = `${Math.max(8, anchor.bottom + bounds.height + 4 <= height - 8 ? anchor.bottom + 4 : anchor.top - bounds.height - 4)}px`
    choices[last ? choices.length - 1 : 0]?.focus({ preventScroll: true })
  }
  listen(trigger, 'click', () => { if (menu.hidden) open(); else close(true) })
  listen(trigger, 'keydown', event => {
    if (!(event instanceof KeyboardEvent) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    open(event.key === 'ArrowUp')
  })
  listen(menu, 'click', event => {
    if (event.target instanceof Element && event.target.closest('[data-designer-shape]')) close()
  })
  listen(ownerDocument, 'pointerdown', event => {
    if (event.target instanceof Node && !trigger.contains(event.target) && !menu.contains(event.target)) close()
  })
  listen(ownerDocument, 'keydown', event => {
    if (menu.hidden || !(event instanceof KeyboardEvent)) return
    if (event.key === 'Escape') { event.preventDefault(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    if (!menu.contains(event.target instanceof Node ? event.target : null)) return
    const index = choices.findIndex(choice => choice === ownerDocument.activeElement)
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % choices.length
    else if (event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = choices.length - 1
    else return
    event.preventDefault()
    choices[next]?.focus({ preventScroll: true })
  })
  listen(ownerDocument, 'scroll', () => close(), true)
  if (view) listen(view, 'resize', () => close())
  return { destroy() { close(); listeners.forEach(remove => remove()) } }
}
