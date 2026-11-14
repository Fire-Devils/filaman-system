import { api } from './api'
import { isAbortError } from './abort'
import { createPluginIcon } from './plugin-icon'
import { isValidPluginSlug, PLUGIN_PAGE_PREFIX } from './plugin-nav'

type FilamentPluginForm = {
  readPluginDraft(): Record<string, unknown>
  stagePluginDraft(units: unknown, draft: Record<string, unknown>): { staged: string[]; skipped: string[] }
}

export type SelectedFilament = {
  id: number
  manufacturer_id: number
  designation: string
  material_type: string
  record_token?: string
}

type Hook =
  | { mode: 'create' | 'edit'; filamentId: number | null; getRecordToken?: () => string | undefined; form: FilamentPluginForm }
  | { mode: 'selection'; selectedIds: ReadonlySet<number>; expectedFilaments?: ReadonlyMap<number, SelectedFilament> }

type PluginHook = {
  plugin_key: string
  name: string
  page_url: string
  icon_url?: string | null
  editor_launcher?: { style?: 'text' | 'icon'; allow_auto_open?: boolean }
}

export function mountFilamentPluginHooks(host: HTMLElement, hook: Hook) {
  const actions = host.querySelector<HTMLElement>('[data-plugin-hook-actions]')!
  const dialog = host.querySelector<HTMLDialogElement>('dialog')!
  const heading = dialog.querySelector('h2')!
  const content = dialog.querySelector<HTMLElement>('[data-plugin-hook-content]')!
  const origin = window.location.origin
  let frame: HTMLIFrameElement | undefined
  let path = ''
  let selection: number[] = []
  let expectedSelection: SelectedFilament[] | undefined
  let draft: Record<string, unknown> | undefined
  let editEntry = 0
  let discovery = 0
  let discovering = false
  let resumeDiscovery = false
  if (hook.mode === 'edit') {
    for (const event of ['pointerdown', 'keydown', 'input', 'submit']) {
      document.addEventListener(event, cancelAutoOpen, { capture: true })
    }
  }

  function cancelAutoOpen() {
    editEntry++
  }

  function close() {
    if (dialog.open) dialog.close()
    content.replaceChildren()
    frame = undefined
    selection = []
    expectedSelection = undefined
    draft = undefined
  }

  dialog.querySelector('button')!.addEventListener('click', close)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  window.addEventListener('pagehide', event => {
    const interrupted = event.persisted && discovering
    closeEntry()
    resumeDiscovery = interrupted
  })
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !resumeDiscovery) return
    resumeDiscovery = false
    void discover()
  })

  function closeEntry() {
    cancelAutoOpen()
    discovery++
    discovering = false
    resumeDiscovery = false
    close()
  }

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
        ? { mode: hook.mode, filament_ids: selection, expected_filaments: expectedSelection }
        : { mode: hook.mode, filament_id: hook.filamentId, record_token: hook.getRecordToken?.(), fields: draft = hook.form.readPluginDraft() }
      sender.postMessage({ type, request_id, ...context }, origin)
    }
    if (type === 'filaman:filament-stage' && hook.mode !== 'selection' && draft) {
      sender.postMessage({ type, request_id, ...hook.form.stagePluginDraft(message.units, draft) }, origin)
    }
  })

  const query = hook.mode === 'edit' ? 'edit&include_launcher=true' : hook.mode
  async function discover() {
    const request = ++discovery
    discovering = true
    actions.replaceChildren()
    const plugins = await api.get<PluginHook[]>(`/filament-plugin-hooks?surface=${query}`).catch(error => isAbortError(error) ? null : [])
    if (request !== discovery || plugins === null) return []
    discovering = false
    if (!Array.isArray(plugins)) return []
    const launchers: { key: string; button: HTMLButtonElement; open: () => void }[] = []
    for (const plugin of plugins) {
      if (typeof plugin?.name !== 'string' || typeof plugin.page_url !== 'string' ||
          !plugin.page_url.startsWith(PLUGIN_PAGE_PREFIX) || !isValidPluginSlug(plugin.page_url.slice(PLUGIN_PAGE_PREFIX.length))) continue
      const button = document.createElement('button')
      button.type = 'button'
      const launcher = hook.mode === 'edit' ? plugin.editor_launcher : undefined
      if (launcher?.style === 'icon') {
        button.className = 'detail-icon-button'
        button.setAttribute('aria-label', plugin.name)
        button.title = plugin.name
        button.append(createPluginIcon(plugin.icon_url))
      } else {
        button.className = 'fm-btn fm-btn-outline'
        button.textContent = plugin.name
      }
      button.setAttribute('aria-haspopup', 'dialog')
      actions.append(button)
      const open = () => {
        if (dialog.open) return
        selection = hook.mode === 'selection' ? [...hook.selectedIds] : []
        if (hook.mode === 'selection' && !selection.length) return
        if (hook.mode === 'selection' && hook.expectedFilaments) {
          expectedSelection = selection.flatMap(id => {
            const expected = hook.expectedFilaments?.get(id)
            return expected ? [expected] : []
          })
        }
        path = plugin.page_url
        heading.textContent = plugin.name
        frame = document.createElement('iframe')
        frame.title = plugin.name
        frame.sandbox.add('allow-same-origin', 'allow-scripts', 'allow-forms', 'allow-popups')
        frame.src = path + '?filament_host=' + (hook.mode === 'selection' ? 'selection' : 'editor')
        content.replaceChildren(frame)
        dialog.showModal()
      }
      button.addEventListener('click', () => {
        cancelAutoOpen()
        open()
      })
      if (launcher?.allow_auto_open === true) launchers.push({ key: plugin.plugin_key, button, open })
    }
    return launchers
  }

  if (hook.mode !== 'edit') void discover()

  return {
    close: closeEntry,
    async enterEdit() {
      if (hook.mode !== 'edit') return
      const entry = ++editEntry
      const launchers = await discover()
      if (entry !== editEntry) return
      for (const { key, button, open } of launchers) {
        try {
          if (localStorage.getItem(`filaman:plugin:${key}:open-on-edit`) !== 'true') continue
        } catch {
          return // Auto-open is optional when browser storage is unavailable.
        }
        if (!document.querySelector('dialog[open]')) {
          button.focus({ preventScroll: true })
          open()
        }
        break
      }
    },
  }
}
