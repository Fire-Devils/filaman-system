import './plugin-drawer.css'

/** Keep the host form usable until there is no room for both panes. */
export function mountPluginDrawer(dialog: HTMLDialogElement, workspace: HTMLElement, close: () => void, signal?: AbortSignal) {
  const minimumPage = 600, minimumDrawer = 384, preferredDrawer = 560, gap = 16
  const modalWorkspace = workspace instanceof HTMLDialogElement
  const lifecycle = new AbortController()
  let active = false
  let opener: HTMLElement | null = null
  let frameKeys: AbortController | undefined

  function release() {
    delete workspace.dataset.pluginDocked
    workspace.style.removeProperty('--plugin-drawer-width')
    workspace.style.removeProperty('--plugin-workspace-width')
    delete dialog.dataset.docked
  }
  function layout() {
    if (!active || !workspace.isConnected || modalWorkspace && !workspace.open) return
    // Do not raise the drawer above a confirmation awaiting a human response.
    if ([...document.querySelectorAll('dialog:modal')].some(modal => modal !== dialog && !modal.contains(dialog))) return
    const inset = modalWorkspace ? 0 : parseFloat(getComputedStyle(workspace).paddingInlineStart) || 0
    const available = modalWorkspace ? innerWidth - 34 : workspace.getBoundingClientRect().width - inset
    const docked = available >= minimumPage + minimumDrawer + gap
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const wasOpen = dialog.open
    const changeMode = wasOpen && dialog.matches(':modal') === docked
    if (changeMode) dialog.close()
    if (docked) {
      const width = Math.min(preferredDrawer, available - minimumPage - gap)
      workspace.dataset.pluginDocked = ''
      workspace.style.setProperty('--plugin-drawer-width', `${width}px`)
      if (modalWorkspace) workspace.style.setProperty('--plugin-workspace-width', `${minimumPage + width + gap + 2}px`)
      const bounds = workspace.getBoundingClientRect()
      dialog.dataset.docked = ''
      dialog.style.setProperty('--plugin-left', `${bounds.right - width - (modalWorkspace ? 1 : 0)}px`)
      dialog.style.setProperty('--plugin-top', `${modalWorkspace ? bounds.top + 1 : bounds.top}px`)
      dialog.style.setProperty('--plugin-height', `${modalWorkspace ? bounds.height - 2 : innerHeight - bounds.top}px`)
      dialog.style.setProperty('--plugin-width', `${width}px`)
      if (!dialog.open) dialog.show()
    } else {
      release()
      if (!dialog.open) dialog.showModal()
    }
    if (wasOpen && focused?.isConnected) focused.focus({ preventScroll: true })
  }
  document.addEventListener('close', layout, {capture: true, signal: lifecycle.signal})
  const observer = new ResizeObserver(layout)
  observer.observe(workspace, { box: 'border-box' })
  window.addEventListener('resize', layout, { signal: lifecycle.signal })
  function escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !dialog.hasAttribute('data-docked')) return
    const target = event.target as Node | null
    const modal = target?.ownerDocument?.querySelector('dialog:modal')
    if (modal && !modal.contains(dialog)) return
    event.preventDefault()
    close()
  }
  dialog.addEventListener('keydown', escape, { signal: lifecycle.signal })
  function watchFrame() {
    frameKeys?.abort()
    frameKeys = new AbortController()
    const frame = dialog.querySelector('iframe')
    if (!frame) return
    const bind = () => {
      try { frame.contentDocument?.addEventListener('keydown', escape, { signal: frameKeys!.signal }) }
      catch { /* A plugin that navigated away cannot handle the host draft. */ }
    }
    frame.addEventListener('load', bind, { signal: frameKeys.signal })
    bind()
  }
  const controller = {
    open() {
      if (active) return
      active = true
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      layout()
      watchFrame()
    },
    close() {
      active = false
      frameKeys?.abort()
      if (dialog.open) dialog.close()
      release()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
      opener = null
    },
  }
  signal?.addEventListener('abort', () => { controller.close(); lifecycle.abort(); observer.disconnect() }, { once: true })
  return controller
}
