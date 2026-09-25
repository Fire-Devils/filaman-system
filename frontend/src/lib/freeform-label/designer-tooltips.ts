export function bindDesignerTooltips(workspace: HTMLElement): () => void {
  const tooltip = document.createElement('div')
  tooltip.className = 'freeform-designer-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  document.body.append(tooltip)
  let active: HTMLElement | null = null
  let savedTitle: string | null = null
  let timer: number | undefined

  const hide = () => {
    window.clearTimeout(timer)
    timer = undefined
    if (active && savedTitle !== null) active.title = savedTitle
    active = null
    savedTitle = null
    tooltip.hidden = true
  }
  const targetFor = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return null
    if (target.closest('[data-label-element-id]')) return null
    const control = target.closest<HTMLElement>('button, [role="button"], .freeform-qr-center-option, [data-designer-tooltip]')
    return control && workspace.contains(control) && !control.hasAttribute('data-no-designer-tooltip') ? control : null
  }
  const reveal = () => {
    if (!active) return
    tooltip.hidden = false
    const controlRect = active.getBoundingClientRect()
    const tipRect = tooltip.getBoundingClientRect()
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, controlRect.left + (controlRect.width - tipRect.width) / 2))}px`
    tooltip.style.top = `${controlRect.top >= tipRect.height + 12 ? controlRect.top - tipRect.height - 6 : controlRect.bottom + 6}px`
  }
  const show = (event: Event) => {
    const control = targetFor(event)
    if (!control) return
    if (control === active) {
      if (event.type === 'focusin' && tooltip.hidden) {
        window.clearTimeout(timer)
        reveal()
      }
      return
    }
    hide()
    const label = control.title || control.getAttribute('aria-label') || control.textContent?.trim()
    if (!label) return
    active = control
    savedTitle = control.hasAttribute('title') ? control.title : null
    if (savedTitle !== null) control.removeAttribute('title')
    tooltip.textContent = label
    if (event.type === 'focusin') reveal()
    else timer = window.setTimeout(reveal, 300)
  }
  const leave = (event: MouseEvent | FocusEvent) => {
    if (!active || targetFor(event) !== active) return
    const next = event.relatedTarget
    if (next instanceof Node && active.contains(next)) return
    hide()
  }

  workspace.addEventListener('mouseover', show)
  workspace.addEventListener('focusin', show)
  workspace.addEventListener('mouseout', leave)
  workspace.addEventListener('focusout', leave)
  return () => {
    workspace.removeEventListener('mouseover', show)
    workspace.removeEventListener('focusin', show)
    workspace.removeEventListener('mouseout', leave)
    workspace.removeEventListener('focusout', leave)
    hide()
    tooltip.remove()
  }
}
