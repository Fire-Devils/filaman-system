import { api } from './api'
import { isValidPluginSlug, PLUGIN_PAGE_PREFIX } from './plugin-nav'

type FilamentPluginForm = {
  readPluginDraft(): Record<string, unknown>
  stagePluginDraft(units: unknown, draft: Record<string, unknown>): { staged: string[]; skipped: string[] }
}

type Hook =
  | { mode: 'create' | 'edit'; filamentId: number | null; form: FilamentPluginForm }
  | { mode: 'selection'; selectedIds: ReadonlySet<number> }

type PluginHook = { name: string; page_url: string }

export function mountFilamentPluginHooks(host: HTMLElement, hook: Hook) {
  const actions = host.querySelector<HTMLElement>('[data-plugin-hook-actions]')!
  const dialog = host.querySelector<HTMLDialogElement>('dialog')!
  const heading = dialog.querySelector('h2')!
  const content = dialog.querySelector<HTMLElement>('[data-plugin-hook-content]')!
  const origin = window.location.origin
  let frame: HTMLIFrameElement | undefined
  let path = ''
  let selection: number[] = []
  let draft: Record<string, unknown> | undefined

  function close() {
    if (dialog.open) dialog.close()
    content.replaceChildren()
    frame = undefined
    selection = []
    draft = undefined
  }

  dialog.querySelector('button')!.addEventListener('click', close)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  window.addEventListener('pagehide', close)

  window.addEventListener('message', event => {
    const sender = frame?.contentWindow
    if (!dialog.open || !sender || event.source !== sender || event.origin !== origin) return
    try {
      if (sender.location.pathname !== path) return
    } catch {
      // The frame has left the installed plugin page.
      return
    }
    const message = event.data
    if (!message || typeof message.request_id !== 'string' || !message.request_id || message.request_id.length > 128) return
    const { type, request_id } = message
    if (type === 'filaman:filament-context') {
      const context = hook.mode === 'selection'
        ? { mode: hook.mode, filament_ids: selection }
        : { mode: hook.mode, filament_id: hook.filamentId, fields: draft = hook.form.readPluginDraft() }
      sender.postMessage({ type, request_id, ...context }, origin)
    }
    if (type === 'filaman:filament-stage' && hook.mode !== 'selection' && draft) {
      sender.postMessage({ type, request_id, ...hook.form.stagePluginDraft(message.units, draft) }, origin)
    }
  })

  void api.get<PluginHook[]>(`/filament-plugin-hooks?surface=${hook.mode}`).then(plugins => {
    if (!Array.isArray(plugins)) return
    for (const plugin of plugins) {
      if (typeof plugin?.name !== 'string' || typeof plugin.page_url !== 'string' ||
          !plugin.page_url.startsWith(PLUGIN_PAGE_PREFIX) || !isValidPluginSlug(plugin.page_url.slice(PLUGIN_PAGE_PREFIX.length))) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fm-btn fm-btn-outline'
      button.textContent = plugin.name
      button.setAttribute('aria-haspopup', 'dialog')
      actions.append(button)
      button.addEventListener('click', () => {
        if (dialog.open) return
        selection = hook.mode === 'selection' ? [...hook.selectedIds] : []
        if (hook.mode === 'selection' && !selection.length) return
        path = plugin.page_url
        heading.textContent = plugin.name
        frame = document.createElement('iframe')
        frame.title = plugin.name
        frame.sandbox.add('allow-same-origin', 'allow-scripts', 'allow-forms', 'allow-popups')
        frame.src = path + '?filament_host=' + (hook.mode === 'selection' ? 'selection' : 'editor')
        content.replaceChildren(frame)
        dialog.showModal()
      })
    }
  }).catch(() => { /* Optional extension point. */ })

  return close
}
