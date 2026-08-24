export interface FixedPreviewToolbarBinding {
  sync(): void
  restore(): void
  destroy(): void
}

export interface FixedPreviewToolbarOptions {
  previewRoot: HTMLElement
  isActive?: () => boolean
}

interface FixedPreviewToolbarState {
  binding: FixedPreviewToolbarBinding
  setIsActive(isActive: () => boolean): void
}

const fixedPreviewToolbars = new WeakMap<HTMLElement, FixedPreviewToolbarState>()
const pendingToolbarSyncs = new WeakSet<HTMLElement>()

function getPreviewToolbar(previewRoot: HTMLElement) {
  const toolbar = previewRoot.querySelector('.preview-zoom-bar')
  return toolbar instanceof HTMLElement ? toolbar : null
}

export function stripElementIds(root: Element): void {
  root.removeAttribute('id')
  root.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
}

export function resetPreviewSurface(element: HTMLElement): void {
  element.style.zoom = '1'
  element.style.transform = 'none'
  element.style.transformOrigin = 'unset'
  element.style.boxShadow = 'none'
  element.style.border = 'none'
  element.style.borderRadius = '0'
}

export function bindFixedPreviewToolbar(
  options: FixedPreviewToolbarOptions,
): FixedPreviewToolbarBinding {
  const existing = fixedPreviewToolbars.get(options.previewRoot)
  if (existing) {
    existing.setIsActive(options.isActive ?? (() => true))
    existing.binding.sync()
    return existing.binding
  }

  let isActive = options.isActive ?? (() => true)
  let frameId: number | null = null
  let destroyed = false
  const sync = () => {
    if (!isActive()) return
    const toolbar = getPreviewToolbar(options.previewRoot)
    if (!toolbar) return
    const rect = options.previewRoot.getBoundingClientRect()
    toolbar.style.position = 'fixed'
    toolbar.style.top = `${rect.top}px`
    toolbar.style.left = `${rect.left + rect.width / 2}px`
    toolbar.style.transform = 'translateX(-50%)'
  }
  const restore = () => {
    const toolbar = getPreviewToolbar(options.previewRoot)
    if (!toolbar) return
    toolbar.style.removeProperty('position')
    toolbar.style.removeProperty('top')
    toolbar.style.removeProperty('left')
    toolbar.style.removeProperty('transform')
  }
  const scheduleSync = () => {
    if (destroyed || pendingToolbarSyncs.has(options.previewRoot)) return
    pendingToolbarSyncs.add(options.previewRoot)
    frameId = window.requestAnimationFrame(() => {
      frameId = null
      pendingToolbarSyncs.delete(options.previewRoot)
      sync()
    })
  }
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    options.previewRoot.removeEventListener('scroll', scheduleSync)
    window.removeEventListener('resize', scheduleSync)
    window.removeEventListener('pagehide', destroy)
    if (frameId !== null) window.cancelAnimationFrame(frameId)
    frameId = null
    pendingToolbarSyncs.delete(options.previewRoot)
    restore()
    if (fixedPreviewToolbars.get(options.previewRoot)?.binding === binding) {
      fixedPreviewToolbars.delete(options.previewRoot)
    }
  }
  const binding = { sync, restore, destroy }

  fixedPreviewToolbars.set(options.previewRoot, {
    binding,
    setIsActive: nextIsActive => {
      isActive = nextIsActive
    },
  })
  options.previewRoot.addEventListener('scroll', scheduleSync, { passive: true })
  window.addEventListener('resize', scheduleSync, { passive: true })
  window.addEventListener('pagehide', destroy, { once: true })
  sync()

  return binding
}
