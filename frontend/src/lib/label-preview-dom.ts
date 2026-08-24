export interface FixedPreviewToolbarBinding {
  sync(): void
  restore(): void
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
    if (pendingToolbarSyncs.has(options.previewRoot)) return
    pendingToolbarSyncs.add(options.previewRoot)
    window.requestAnimationFrame(() => {
      pendingToolbarSyncs.delete(options.previewRoot)
      sync()
    })
  }
  const binding = { sync, restore }

  fixedPreviewToolbars.set(options.previewRoot, {
    binding,
    setIsActive: nextIsActive => {
      isActive = nextIsActive
    },
  })
  options.previewRoot.addEventListener('scroll', scheduleSync, { passive: true })
  window.addEventListener('resize', scheduleSync, { passive: true })
  sync()

  return binding
}
