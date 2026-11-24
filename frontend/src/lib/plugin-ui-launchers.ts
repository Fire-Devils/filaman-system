import { api } from './api'
import { getAbortSignal, isAbortError } from './abort'
import { createPluginIcon } from './plugin-icon'
import { isValidPluginSlug, PLUGIN_PAGE_PREFIX } from './plugin-nav'
import { syncPluginTheme } from './plugin-theme'
import { mountPluginDrawer } from './plugin-drawer'
import { t } from './i18n'
import type { AppDialogs } from './form-dialog'

export type LauncherSurface = `${'filaments' | 'colors'}.${'editor' | 'library' | 'selection'}`
export type PluginUiLauncher = {
  plugin_key: string; plugin_name: string; launcher_id: string; surface: LauncherSurface
  label: string; page_url: string; icon_url?: string | null; legacy: boolean
  editor_launcher?: { style?: 'icon' | 'text'; allow_auto_open?: boolean } | null
}
export type PluginMessage = { type: string; request_id: string; [key: string]: unknown }
export type PluginSession = {
  frame: HTMLIFrameElement; signal: AbortSignal; isCurrent(): boolean
  revalidate(): Promise<boolean>
  reply(message: PluginMessage, data: object): void
}
export type PluginUiSurfaceAdapter = {
  surface: LauncherSurface; mode?: 'create' | 'edit'; workspace: HTMLElement
  isEligible(): { enabled: boolean; reason?: string }
  query?: Record<string, string>
  contextType?: string
  context?(): object
  onOpen?(): void
  onClose?(): void
  onMessage?(message: PluginMessage, session: PluginSession): void | Promise<void>
}
type WorkspaceOwner = { close(): void }
const owners = new WeakMap<HTMLElement, WorkspaceOwner>()
const revisions = new WeakMap<HTMLElement, number>()

export function mountPluginUiLaunchers(host: HTMLElement, adapter: PluginUiSurfaceAdapter, signal?: AbortSignal) {
  const lifecycle = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
  const actions = host.querySelector<HTMLElement>('[data-plugin-hook-actions]')!
  const dialog = host.querySelector<HTMLDialogElement>('dialog')!
  const content = dialog.querySelector<HTMLElement>('[data-plugin-hook-content]')!
  const workspace = adapter.workspace
  const ownershipScope = workspace.closest<HTMLElement>('.fm-main') || workspace
  let generation = 0, entry = 0
  let contextEntry: number | undefined
  let draftRevision = 0, contextRevision = 0
  let frame: HTMLIFrameElement | undefined, sessionAbort: AbortController | undefined
  let boundDocument: Document | undefined, path = ''
  let opener: HTMLElement | null = null
  let currentPlugin: PluginUiLauncher | undefined
  let context: object | undefined
  let buttons: {plugin: PluginUiLauncher; button: HTMLButtonElement}[] = []
  let discovery: Promise<typeof buttons> | undefined
  let interrupted = false
  const drawer = adapter.surface.endsWith('.selection') ? null : mountPluginDrawer(dialog, workspace, close, activeSignal)
  const owner: WorkspaceOwner = { close }
  function close() {
    entry++
    sessionAbort?.abort()
    if (drawer) drawer.close()
    else if (dialog.open) dialog.close()
    content.replaceChildren()
    frame = undefined; boundDocument = undefined; currentPlugin = undefined; context = undefined
    if (owners.get(ownershipScope) === owner) owners.delete(ownershipScope)
    if (opener?.isConnected) opener.focus()
    opener = null
    adapter.onClose?.()
  }
  function updateEligibility() {
    const state = adapter.isEligible()
    for (const {plugin, button} of buttons) {
      button.disabled = !state.enabled
      button.title = state.enabled ? label(plugin) : state.reason || t('pluginLaunchers.selectRecords')
    }
  }
  function label(plugin: PluginUiLauncher) {
    return plugin.legacy ? plugin.plugin_name : `${plugin.label} — ${plugin.plugin_name}`
  }
  function samePlacement(left: PluginUiLauncher, right: PluginUiLauncher) {
    return left.plugin_key === right.plugin_key && left.launcher_id === right.launcher_id
      && left.surface === right.surface && left.page_url === right.page_url && left.legacy === right.legacy
  }
  async function open(plugin: PluginUiLauncher, trigger?: HTMLElement) {
    if (activeSignal.aborted || !adapter.isEligible().enabled || !buttons.some(item => item.plugin === plugin)) return
    if (currentPlugin === plugin && frame) return
    const openEntry = entry
    const focusTarget = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const revision = (revisions.get(ownershipScope) || 0) + 1
    revisions.set(ownershipScope, revision)
    const previous = owners.get(ownershipScope)
    if (previous) {
      const confirm = (window as unknown as AppDialogs).__fmConfirm
      if (!await confirm(t('pluginLaunchers.replace'), {okLabel: t('pluginLaunchers.replaceAction'), isDanger: false})) return
      if (activeSignal.aborted || entry !== openEntry) return
      let validation = refresh(true)
      let approved = await validation
      while (discovery && validation !== discovery) {
        if (activeSignal.aborted || entry !== openEntry) return
        validation = discovery
        approved = await validation
      }
      if (!approved.some(item => samePlacement(item.plugin, plugin))) return
    }
    const registered = buttons.find(item => samePlacement(item.plugin, plugin))
    if (activeSignal.aborted || entry !== openEntry || !registered || revisions.get(ownershipScope) !== revision || !adapter.isEligible().enabled) return
    plugin = registered.plugin
    previous?.close()
    owners.set(ownershipScope, owner)
    opener = focusTarget?.isConnected ? focusTarget : registered.button.closest('details')?.querySelector('summary') || registered.button
    adapter.onOpen?.()
    context = adapter.context?.()
    currentPlugin = plugin; path = plugin.page_url
    dialog.querySelector('h2')!.textContent = label(plugin)
    sessionAbort = new AbortController()
    frame = document.createElement('iframe')
    frame.title = label(plugin)
    frame.sandbox.add('allow-same-origin', 'allow-scripts', 'allow-forms', 'allow-popups')
    const url = new URL(path, location.origin)
    for (const [key, value] of Object.entries(adapter.query || {})) url.searchParams.set(key, value)
    if (!plugin.legacy) url.searchParams.set('launcher_id', plugin.launcher_id)
    frame.src = url.pathname + url.search
    frame.addEventListener('load', () => {
      if (boundDocument && !validDocument(false)) close()
    }, {signal: sessionAbort.signal})
    content.replaceChildren(frame)
    syncPluginTheme(frame, sessionAbort.signal)
    if (drawer) drawer.open(); else dialog.showModal()
  }
  function validDocument(bind: boolean): boolean {
    if (!frame || !dialog.open || activeSignal.aborted || sessionAbort?.signal.aborted) return false
    try {
      const sender = frame.contentWindow!
      if (sender.location.origin !== location.origin || sender.location.pathname !== path) return false
      if (boundDocument && sender.document !== boundDocument) { close(); return false }
      if (bind && !boundDocument) boundDocument = sender.document
      return true
    } catch { return false }
  }
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return
    const data = event.data
    if (!data || typeof data.type !== 'string' || typeof data.request_id !== 'string' || !data.request_id || data.request_id.length > 128) return
    const contextRequest = data.type === adapter.contextType || (data.type === 'filaman:launcher-context' && data.version === 1 && !adapter.surface.endsWith('.editor'))
    if (!validDocument(contextRequest) || !boundDocument) return
    if (contextRequest) { contextEntry = entry; contextRevision = draftRevision }
    const currentFrame = frame, currentEntry = entry, currentDocument = boundDocument, currentRevision = draftRevision
    const staging = data.type.endsWith('-stage')
    const deadline = staging ? performance.now() + 2500 : Infinity
    const stageSignal = staging ? AbortSignal.timeout(2500) : undefined
    const isConnected = () => frame === currentFrame && boundDocument === currentDocument && validDocument(false)
    const isCurrent = () => performance.now() < deadline && (data.type === 'filaman:color-open'
      || (contextEntry === currentEntry && contextRevision === currentRevision && draftRevision === currentRevision))
      && entry === currentEntry && isConnected()
    const session: PluginSession = {
      frame: currentFrame, signal: AbortSignal.any([sessionAbort!.signal, ...(stageSignal ? [stageSignal] : [])]), isCurrent,
      async revalidate() {
        const authorized = await refresh(true, stageSignal)
        return isCurrent() && authorized.some(item => item.plugin === currentPlugin)
      },
      reply(message, result) { if (isConnected()) currentFrame.contentWindow?.postMessage({type: message.type, request_id: message.request_id, ...result}, location.origin) },
    }
    if (data.type === 'filaman:launcher-context' && data.version === 1 && !adapter.surface.endsWith('.editor')) {
      session.reply(data, {version: 1, launcher_id: currentPlugin!.launcher_id, surface: adapter.surface, context})
    } else {
      const deliver = async () => {
        if (!contextRequest && isCurrent()) {
          const authorized = await session.revalidate()
          if (!isConnected()) return
          if (!authorized && isCurrent()) {
            session.reply(data, {error: 'integration_unavailable'})
            return
          }
        }
        await adapter.onMessage?.(data, session)
      }
      void deliver().catch(() => {
        if (isCurrent()) session.reply(data, {error: 'integration_unavailable'})
      })
    }
  }, {signal: activeSignal})
  dialog.querySelector('button')!.addEventListener('click', close, {signal: activeSignal})
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() }, {signal: activeSignal})
  // Saving invalidates pending proposals without discarding the conversation.
  workspace.addEventListener('submit', () => { entry++ }, {capture: true, signal: activeSignal})
  for (const event of ['input', 'change']) {
    workspace.addEventListener(event, () => { draftRevision++; contextEntry = undefined }, {capture: true, signal: activeSignal})
  }
  document.addEventListener('astro:before-swap', event => {
    if (event.newDocument !== document) lifecycle.abort()
  }, {signal: activeSignal})
  window.addEventListener('pagehide', event => { interrupted = event.persisted; generation++; close() }, {signal: activeSignal})
  window.addEventListener('pageshow', event => { if (event.persisted && interrupted) { interrupted = false; void refresh() } }, {signal: activeSignal})
  activeSignal.addEventListener('abort', () => { generation++; close() }, {once: true})
  window.addEventListener('storage', event => {
    if (event.key === 'filaman:plugin-nav-changed') { close(); void refresh() }
  }, {signal: activeSignal})
  window.addEventListener('filaman:plugin-nav-changed', () => { close(); void refresh() }, {signal: activeSignal})
  window.addEventListener('filaman:permissions-changed', () => { close(); void refresh() }, {signal: activeSignal})
  window.addEventListener('focus', () => { void refresh(true) }, {signal: activeSignal})
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh(true)
  }, {signal: activeSignal})
  function refresh(preserve = false, requestSignal?: AbortSignal) {
    return discovery = discover(preserve, requestSignal)
  }
  async function discover(preserve: boolean, requestSignal?: AbortSignal) {
    const request = ++generation
    if (!preserve) { close(); actions.replaceChildren(); buttons = [] }
    const query = new URLSearchParams({surface: adapter.surface})
    if (adapter.mode) query.set('mode', adapter.mode)
    try {
      const plugins = await api.get<PluginUiLauncher[]>(`/plugin-ui-launchers?${query}`, {signal: AbortSignal.any([activeSignal, getAbortSignal(), ...(requestSignal ? [requestSignal] : [])])})
      if (request !== generation || activeSignal.aborted) return []
      if (!Array.isArray(plugins)) { close(); actions.replaceChildren(); buttons = []; return [] }
      const available = plugins.filter(plugin => typeof plugin?.plugin_name === 'string' && typeof plugin.label === 'string'
        && typeof plugin.launcher_id === 'string' && plugin.surface === adapter.surface && typeof plugin.page_url === 'string'
        && plugin.page_url.startsWith(PLUGIN_PAGE_PREFIX) && isValidPluginSlug(plugin.page_url.slice(PLUGIN_PAGE_PREFIX.length)))
      if (preserve && buttons.length > 0 && available.length === buttons.length && available.every((plugin, index) => {
        const before = buttons[index].plugin
        return samePlacement(plugin, before) && plugin.plugin_name === before.plugin_name && plugin.label === before.label
          && (plugin.icon_url ?? null) === (before.icon_url ?? null)
          && (plugin.editor_launcher?.style ?? 'text') === (before.editor_launcher?.style ?? 'text')
          && (plugin.editor_launcher?.allow_auto_open ?? false) === (before.editor_launcher?.allow_auto_open ?? false)
      })) { updateEligibility(); return buttons }
      if (preserve && currentPlugin) {
        const retained = available.find(plugin => samePlacement(plugin, currentPlugin!))
        if (!retained) close()
        else currentPlugin = retained
      }
      actions.replaceChildren(); buttons = []
      let overflow: HTMLElement | undefined
      for (const plugin of available) {
        const button = document.createElement('button'); button.type = 'button'
        button.dataset.launcherId = plugin.launcher_id
        const textStyle = plugin.legacy && plugin.editor_launcher?.style !== 'icon'
        button.className = textStyle ? 'fm-btn fm-btn-outline' : 'detail-icon-button'
        button.setAttribute('aria-label', label(plugin)); button.setAttribute('aria-haspopup', 'dialog')
        if (textStyle) button.textContent = plugin.plugin_name
        else button.append(createPluginIcon(plugin.icon_url))
        button.addEventListener('click', () => {
          const menu = button.closest('details')
          const trigger = menu?.querySelector('summary') || button
          if (menu) menu.open = false
          void open(plugin, trigger)
        }, {signal: activeSignal})
        if (buttons.length < 3) actions.append(button)
        else {
          if (!overflow) {
            const details = document.createElement('details'); details.className = 'plugin-launcher-overflow'
            const summary = document.createElement('summary'); summary.textContent = t('pluginLaunchers.more')
            details.addEventListener('keydown', event => {
              if (event.key === 'Escape') { details.open = false; summary.focus(); event.preventDefault() }
            }, {signal: activeSignal})
            overflow = document.createElement('div'); details.append(summary, overflow); actions.append(details)
          }
          button.className = 'fm-btn fm-btn-outline'; button.textContent = label(plugin); overflow.append(button)
        }
        buttons.push({plugin, button})
      }
      if (frame && currentPlugin) {
        const trigger = buttons.find(item => item.plugin === currentPlugin)?.button
        opener = trigger?.closest('details')?.querySelector('summary') || trigger || opener
      }
      updateEligibility()
      return buttons
    } catch (error) {
      if (request !== generation || activeSignal.aborted || isAbortError(error)) return []
      if ([401, 403].includes((error as {status?: number})?.status || 0)) {
        close(); actions.replaceChildren(); buttons = []; return []
      }
      if (preserve) return []
      actions.replaceChildren(); buttons = []
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'fm-btn fm-btn-outline'
      retry.textContent = t('pluginLaunchers.retry'); retry.addEventListener('click', () => { void refresh() }, {signal: activeSignal})
      actions.append(retry)
      return []
    }
  }
  return { refresh, close, updateEligibility, open, signal: activeSignal }
}
