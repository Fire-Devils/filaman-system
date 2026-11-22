import { navigate as navigatePanel, type TransitionBeforePreparationEvent } from 'astro:transitions/client'
import { t } from './i18n'
import { navHrefFor } from './plugin-nav'
import { createPluginIcon } from './plugin-icon'
import type { AppDialogs } from './form-dialog'
import { api, ApiError } from './api'
import { isAbortError } from './abort'
import {
  arrangeSidebarItems, colorModeId, defaultSidebarPreferences, expandedStorageKey, legacyColorKey, mergeSidebarOrder,
  readLegacySidebarPreferences, sidebarNavigationLimit, sidebarPluginLimit, sidebarStorageKey, sidebarSyncKey,
  type AccountSidebarPreferences, type ColorMode, type SidebarPreferences,
} from './sidebar-preferences'

interface SidebarLink {
  id: string
  name: string
  element: HTMLElement
  icon?: Element | null
  iconUrl?: string | null
  pluginKey?: string
}

interface PluginLink {
  plugin_key: string
  name: string
  page_url: string
  icon_url?: string | null
}

function sidebarPluginIcon(url?: string | null) {
  const icon = createPluginIcon(url)
  icon.classList.add('fm-nav-icon')
  return icon
}

export function setupSidebar(highlightActiveNav: () => void) {
  const nav = document.getElementById('sidebar-nav')!
  const sidebarContent = document.getElementById('sidebar-content')!
  const group = document.getElementById('plugin-nav')!
  const admin = document.getElementById('admin-nav')!
  const profile = document.getElementById('sidebar-profile')!
  const colorMode = document.getElementById(colorModeId)!
  const footer = profile.parentElement!
  const adminHeaders = admin.querySelectorAll<HTMLElement>('[data-sidebar-header]')
  const pluginDivider = group.querySelector<HTMLElement>('[data-sidebar-header]')!
  const heading = document.querySelector<HTMLButtonElement>('#sidebar-plugin-heading')!
  const title = document.getElementById('sidebar-plugin-label')!
  const count = document.getElementById('sidebar-plugin-count')!
  const pinned = document.getElementById('sidebar-pinned-plugins')!
  const extra = document.getElementById('sidebar-plugin-preview')!
  let form = document.querySelector<HTMLFormElement>('#sidebar-settings-form')
  const settingsLink = document.getElementById('sidebar-plugin-settings-link')!
  const mouse = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 600px)')
  let previewing = false
  let plugins: SidebarLink[] = []
  let pluginStatus = 'common.loading'
  let adminAllowed = false
  const items: SidebarLink[] = [...nav.children, profile].map(element => {
    const link = element === group || element === profile ? null : element.matches('a') ? element : element.querySelector('a')
    return {
      id: link?.getAttribute('href') ?? element.id,
      name: element === profile ? t('settings.profile')
        : element.id === colorModeId ? t('theme.colorMode') : link?.textContent?.trim() || t('nav.plugins'),
      element: element as HTMLElement,
      icon: (link ?? element).querySelector('.fm-nav-icon'),
    }
  })
  const isSection = (item: SidebarLink) => item.element === group || item.element === admin

  const themeButtons = () => document.querySelectorAll<HTMLButtonElement>('.fm-sidebar .fm-theme-toggle button[data-theme], .settings-appearance .fm-theme-toggle button[data-theme]')
  let accountId: number | undefined
  let account: AccountSidebarPreferences | null = null
  let preferences = defaultSidebarPreferences()
  let savedSidebar: SidebarPreferences | null = null
  let changingTheme = false
  let loadingAccount = false
  let refreshAfterLoad = false
  let expanded = false
  let draftExpansion: boolean | undefined
  let expansionWrite = 0
  let savingExpansion = false
  let refreshGeneration = 0
  let pendingWrites = 0
  let failedWrites = 0
  let writes: Promise<unknown> = Promise.resolve()
  let sidebarSave: Promise<void> | undefined
  let navigationRequest: symbol | undefined
  let committingPanel: AbortSignal | undefined
  const isLeaving = () => navigationRequest || (committingPanel && !committingPanel.aborted)
  const hasPendingWrite = () => Boolean(sidebarSave || pendingWrites)
  const dirty = () => form?.matches('[data-dirty]')
  const preferenceUrl = () => `/me/preferences/sidebar?account_id=${accountId}`
  const readAccount = () => api.get<AccountSidebarPreferences>(preferenceUrl(), {
    cache: 'no-store', signal: AbortSignal.timeout(5000),
  })

  function applyTheme(theme: ColorMode) {
    document.documentElement.dataset.theme = theme
    // Presentation cache only; account preferences remain authoritative.
    if (window.parent === window) {
      try { localStorage.setItem('filaman-theme-cache', theme) } catch { /* Storage may be blocked. */ }
    }
    themeButtons().forEach(button => {
      const selected = button.dataset.theme === theme
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
    settings?.renderPreviews()
  }

  function patchAccount(data: Partial<AccountSidebarPreferences> & {
    expected_sidebar?: SidebarPreferences | null
    import_legacy?: boolean
  }) {
    pendingWrites++
    ++refreshGeneration
    const signal = AbortSignal.timeout(15000)
    const write = writes.then(async () => {
      const result = await api.patch<AccountSidebarPreferences>(preferenceUrl(), data, {
        signal, keepalive: !data.sidebar,
      })
      account = result
      try {
        localStorage.setItem(sidebarSyncKey, `${accountId}:${Date.now()}:${Math.random()}`)
      } catch { /* Other tabs refresh when brought to the foreground. */ }
      return result
    }).finally(() => pendingWrites--)
    writes = write.catch(() => {
      // The form handles conflicts and reports its final outcome separately.
      if (!('expected_sidebar' in data)) failedWrites++
    })
    return write
  }

  async function waitForWrites() {
    const failures = failedWrites
    while (hasPendingWrite()) await (sidebarSave ?? writes)
    return failedWrites === failures
  }

  async function navigate(action: () => void | Promise<void>) {
    const request = navigationRequest = Symbol()
    try {
      const saved = await waitForWrites()
      if (saved && request === navigationRequest) await action()
    } finally {
      if (request === navigationRequest) navigationRequest = undefined
    }
  }

  // Observe clicks before Astro's document listener, after controls can prevent navigation.
  document.body.addEventListener('click', event => {
    if (!hasPendingWrite() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return
    const target = new URL(link.href)
    if (target.origin !== location.origin || (target.href.includes('#') && target.pathname === location.pathname && target.search === location.search)) return
    event.preventDefault()
    void navigate(() => {
      if (document.querySelector('main[data-panel]') && !link.hasAttribute('data-astro-reload')) {
        void navigatePanel(target.href, { sourceElement: link, history: link.dataset.astroHistory === 'replace' ? 'replace' : 'auto' })
      } else location.assign(target.href)
    })
  })

  let panelHistoryIndex: number | undefined = history.state?.index
  let restoreHistoryIndex: number | undefined
  const canceledNavigation = Symbol()
  function guardPanelNavigation(event: TransitionBeforePreparationEvent, prepare: () => Promise<void>) {
    const traversing = event.navigationType === 'traverse'
    const from = panelHistoryIndex
    const to = history.state?.index
    if (traversing) navigationRequest = undefined
    const restoring = traversing && restoreHistoryIndex !== undefined && to === restoreHistoryIndex
    if (traversing) restoreHistoryIndex = undefined
    const failures = failedWrites
    return async () => {
      if (event.info === canceledNavigation || restoring ||
        (traversing && hasPendingWrite() && typeof from === 'number' && from === to)) {
        event.newDocument = document
        return
      }
      if (!hasPendingWrite() || await waitForWrites()) {
        if (event.signal.aborted) return
        await prepare()
        if (event.signal.aborted || (!event.defaultPrevented && event.newDocument === document)) return
        // Save can begin while the outgoing editor is still visible during preparation.
        if (hasPendingWrite()) await waitForWrites()
        if (event.signal.aborted) return
        if (failures === failedWrites) {
          if (!event.defaultPrevented) committingPanel = event.signal
          return
        }
      }
      if (event.signal.aborted) return
      if (traversing && typeof from === 'number' && typeof to === 'number' && from !== to) {
        // Restore the URL and history index without replacing the editor.
        restoreHistoryIndex = from
        const canceled = new Promise<void>(resolve => event.signal.addEventListener('abort', () => resolve(), { once: true }))
        history.go(from - to)
        await canceled
        return
      }
      if (event.defaultPrevented) {
        // Supersede Astro's full-page fallback before it can replace the editor.
        void navigatePanel(event.from.href, { history: 'replace', info: canceledNavigation })
        return
      }
      event.to = event.from
      event.newDocument = document
    }
  }

  window.addEventListener('beforeunload', event => {
    if (!hasPendingWrite()) return
    event.preventDefault()
    event.returnValue = ''
  })

  function reportSaveError(error: unknown) {
    if (isAbortError(error)) return
    const message = t('settings.sidebarSaveError')
    if (settings) settings.setStatus(message)
    else void (window as typeof window & AppDialogs).__fmAlert(message)
  }

  themeButtons().forEach(button => { button.disabled = true })
  document.addEventListener('click', async event => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('.fm-theme-toggle button[data-theme]')
    if (!button || button.disabled || button.closest('[inert]')) return
    if (changingTheme || isLeaving()) return
    const theme = button.dataset.theme as ColorMode
    changingTheme = true
    applyTheme(theme)
    themeButtons().forEach(button => { button.setAttribute('aria-disabled', 'true') })
    try {
      const result = await patchAccount({ theme })
      applyAccount(result)
    } catch (error) {
      reportSaveError(error)
    } finally {
      changingTheme = false
      applyTheme(account?.theme ?? 'brand')
      themeButtons().forEach(button => { button.removeAttribute('aria-disabled') })
    }
  })

  function closePreview() {
    if (!previewing) return
    if (extra.contains(document.activeElement)) heading.focus({ preventScroll: true })
    extra.hidePopover()
    extra.removeAttribute('popover')
    extra.hidden = !expanded
    previewing = false
    highlightActiveNav()
  }

  function openPreview(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || typeof extra.showPopover !== 'function' || !mouse.matches || !preferences.hover || expanded || previewing || !extra.childElementCount) return
    const anchor = heading.getBoundingClientRect()
    extra.setAttribute('popover', 'manual')
    extra.hidden = false
    extra.style.insetInlineStart = anchor.right + 'px'
    extra.style.top = anchor.top + 'px'
    extra.showPopover()
    extra.style.top = Math.max(8, Math.min(anchor.top, innerHeight - extra.offsetHeight - 8)) + 'px'
    previewing = true
    highlightActiveNav()
  }

  heading.addEventListener('pointerenter', openPreview)
  for (const element of [heading, extra]) {
    element.addEventListener('pointerleave', event => {
      const next = event.relatedTarget
      if (!(next instanceof Node && (extra.contains(next) || heading.contains(next)))) closePreview()
    })
  }
  heading.addEventListener('click', () => {
    if (heading.getAttribute('aria-disabled') === 'true' || isLeaving()) return
    expanded = !expanded
    renderDisclosure()
    if (dirty()) {
      draftExpansion = expanded
      settings?.updateDraftState()
    } else if (preferences.remember) {
      const write = ++expansionWrite
      savingExpansion = true
      void patchAccount({ expanded }).then(result => {
        if (write === expansionWrite) applyAccount(result)
      }).catch(error => {
        if (write !== expansionWrite) return
        if (draftExpansion === undefined) {
          expanded = account?.expanded ?? false
          renderDisclosure()
        }
        reportSaveError(error)
        void refreshAccount()
      }).finally(() => {
        if (write !== expansionWrite) return
        savingExpansion = false
        if (dirty() && draftExpansion !== undefined && !sidebarSave) settings?.updateDraftState()
      })
    }
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePreview()
  })
  window.addEventListener('resize', closePreview)
  nav.closest('.fm-sidebar-content')?.addEventListener('scroll', closePreview, { passive: true })

  function renderDisclosure() {
    closePreview()
    heading.setAttribute('aria-expanded', String(expanded && !heading.hidden))
    if (!expanded && !heading.hidden && extra.contains(document.activeElement)) heading.focus({ preventScroll: true })
    extra.hidden = !expanded || heading.hidden
    highlightActiveNav()
    updateDensity()
    settings?.renderPreviews()
  }

  function updateDensity() {
    nav.classList.toggle('sidebar-nav-compact', preferences.compact === true)
    if (preferences.compact === null && sidebarContent.scrollHeight > sidebarContent.clientHeight) {
      nav.classList.add('sidebar-nav-compact')
    }
  }

  const densityObserver = new ResizeObserver(() => {
    if (preferences.compact === null) updateDensity()
  })
  densityObserver.observe(sidebarContent)
  densityObserver.observe(nav)

  const promotionId = (key: string) => 'plugin/' + key
  const isPromoted = (key: string, layout = preferences) => layout.navigation.some(row => row.id === promotionId(key))
  const headerShown = (id: string, layout = preferences) => layout.navigation.find(row => row.id === id)?.shown !== false
  const adminHeaderId = 'sidebar-admin-header'
  const pluginsHeaderId = 'sidebar-plugins-header'
  const canPin = () => plugins.length > 1 && headerShown(pluginsHeaderId)

  function arrangedNavigation(allowAdmin: boolean, layout = preferences) {
    const promoted = plugins.filter(plugin => isPromoted(plugin.id, layout)).map(plugin => ({
      ...plugin, id: promotionId(plugin.id), pluginKey: plugin.id, icon: plugin.element.querySelector('.fm-nav-icon'),
    }))
    const entries = [...items.filter(item => allowAdmin || item.element !== admin), ...promoted]
    const arranged = arrangeSidebarItems(entries, layout.navigation)
    const pluginPreferences = new Map(layout.plugins.map(row => [row.id, row]))
    const hasColorMode = layout.navigation.some(row => row.id === colorModeId)
    for (const item of arranged) {
      if (item.id === colorModeId && !hasColorMode) item.shown = layout.showColorMode
      if (item.element === profile) item.shown = true
      if (item.pluginKey) item.shown = pluginPreferences.get(item.pluginKey)?.shown !== false
    }
    return arranged
  }

  function renderNav(removed: SidebarLink[] = []) {
    closePreview()
    const focused = document.activeElement as HTMLElement | null
    const wasFocused = focused && (nav.contains(focused) || profile.contains(focused))
    for (const item of removed) item.element.remove()
    const ordered = arrangedNavigation(true)
    for (const item of ordered) {
      if (item.element === profile && item === ordered.at(-1)) {
        if (profile.parentElement !== footer) footer.prepend(profile)
        continue
      }
      nav.append(item.element)
      if (!isSection(item)) item.element.hidden = !item.shown
      if (item.element === admin) admin.hidden = !item.shown || !adminAllowed
      if (item.element === group) group.hidden = !item.shown
    }
    adminHeaders.forEach(element => { element.hidden = !headerShown(adminHeaderId) })
    const showPluginsHeader = headerShown(pluginsHeaderId)
    pluginDivider.hidden = !showPluginsHeader
    pinned.replaceChildren()
    extra.replaceChildren()
    for (const plugin of arrangeSidebarItems(plugins, preferences.plugins)) {
      if (isPromoted(plugin.id)) continue
      plugin.element.hidden = false
      if (plugin.shown) (plugin.pinned || !canPin() ? pinned : extra).append(plugin.element)
      else plugin.element.remove()
    }
    const extraCount = extra.childElementCount
    group.hidden ||= !pinned.childElementCount && !extraCount
    heading.hidden = !extraCount
    title.hidden = !showPluginsHeader || Boolean(extraCount)
    count.textContent = String(extraCount)
    if (extraCount) extra.append(settingsLink)
    renderDisclosure()
    if (wasFocused && document.activeElement !== focused) {
      const next = focused.getClientRects().length ? focused
        : [heading, ...nav.querySelectorAll<HTMLElement>('a[href]')].find(item => item.getClientRects().length)
          ?? document.getElementById('sidebar-toggle')
      next?.focus({ preventScroll: true })
    }
  }

  let settings = form && setupSettings(form)
  renderNav()

  document.addEventListener('astro:before-swap', event => {
    if (committingPanel === event.signal) committingPanel = undefined
  })
  document.addEventListener('astro:after-swap', () => {
    panelHistoryIndex = history.state?.index
    const nextForm = document.querySelector<HTMLFormElement>('#sidebar-settings-form')
    if (nextForm !== form) {
      const discardDraft = dirty()
      settings?.dispose()
      if (discardDraft) restoreSavedLayout()
      form = nextForm
      settings = form && setupSettings(form)
      if (account) settings?.enable()
      else if (settings) void refreshAccount()
      if (discardDraft || settings) renderNav()
    }
    themeButtons().forEach(button => { button.disabled = !account })
    if (account) applyTheme(account.theme ?? 'brand')
  })

  function restoreSavedLayout() {
    savedSidebar = account?.sidebar ?? null
    preferences = savedSidebar ?? defaultSidebarPreferences()
    if (draftExpansion !== undefined || preferences.remember) expanded = account?.expanded ?? false
    draftExpansion = undefined
  }

  function applyAccount(result: AccountSidebarPreferences) {
    account = result
    if (!changingTheme) applyTheme(result.theme ?? 'brand')
    if (!dirty() && JSON.stringify(savedSidebar) !== JSON.stringify(result.sidebar)) {
      savedSidebar = result.sidebar
      preferences = savedSidebar ?? defaultSidebarPreferences()
      if (!pendingWrites && preferences.remember && result.expanded !== null) expanded = result.expanded
      renderNav()
      settings?.render()
    } else if (!pendingWrites && preferences.remember && draftExpansion === undefined && result.expanded !== null && expanded !== result.expanded) {
      expanded = result.expanded
      renderDisclosure()
    }
  }

  async function refreshAccount() {
    if (accountId === undefined || loadingAccount) return
    if (!account) return loadAccount(accountId)
    await writes
    if (pendingWrites) return
    const generation = ++refreshGeneration
    try {
      const result = await readAccount()
      if (generation === refreshGeneration) applyAccount(result)
    } catch { /* Keep the current settings during a transient read failure. */ }
  }
  window.addEventListener('storage', event => {
    if (event.key !== sidebarSyncKey || !event.newValue?.startsWith(`${accountId}:`)) return
    if (loadingAccount) refreshAfterLoad = true
    else void refreshAccount()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) void refreshAccount() })
  window.addEventListener('focus', () => void refreshAccount())
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAccount() })

  function setupSettings(settingsForm: HTMLFormElement) {
    const listeners = new AbortController()
    const navigation = document.querySelector<HTMLUListElement>('#sidebar-navigation-order')!
    const pluginList = document.querySelector<HTMLUListElement>('#sidebar-plugins-order')!
    const lists = settingsForm.querySelector<HTMLElement>('.sidebar-settings-lists')!
    const toolbar = settingsForm.querySelector<HTMLElement>('.sidebar-settings-toolbar')!
    const toolbarObserver = new IntersectionObserver(([start]) => {
      toolbar.toggleAttribute('data-stuck', start.boundingClientRect.bottom <= 0)
    })
    toolbarObserver.observe(settingsForm.querySelector('.sidebar-settings-start')!)
    const reset = toolbar.querySelector<HTMLButtonElement>('#sidebar-reset')!
    const revert = settingsForm.querySelector<HTMLButtonElement>('#sidebar-revert')!
    const rowTemplate = document.querySelector<HTMLTemplateElement>('#sidebar-settings-row')!
    const optionTemplate = document.querySelector<HTMLTemplateElement>('#sidebar-placement-option')!
    const status = document.getElementById('sidebar-settings-status')!
    const save = settingsForm.querySelector<HTMLButtonElement>('[type="submit"]')!
    const hover = settingsForm.querySelector<HTMLInputElement>('[name="hover"]')!
    const remember = settingsForm.querySelector<HTMLInputElement>('[name="remember"]')!
    const compact = settingsForm.querySelector<HTMLInputElement>('[value="compact"]')!
    const comfortable = settingsForm.querySelector<HTMLInputElement>('[value="comfortable"]')!
    const auto = settingsForm.querySelector<HTMLInputElement>('[value="auto"]')!
    let dropTarget: HTMLElement | null = null
    let drag: { row: HTMLElement; y: number; pointerId: number; moved: boolean } | null = null
    save.disabled = true

    function updateRow(row: HTMLElement, item: SidebarLink & { shown: boolean; pinned?: boolean }) {
      const show = row.querySelector<HTMLInputElement>('.sidebar-show input')
      if (show) {
        show.checked = item.shown
        show.disabled = Boolean(item.pluginKey)
      }
      const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')
      if (pin) {
        const promoted = isPromoted(item.id)
        pin.checked = item.pinned !== false
        pin.disabled = !item.shown || promoted || !canPin()
        row.querySelector<HTMLInputElement>('[data-promote]')!.checked = promoted
      }
      const header = row.querySelector<HTMLInputElement>('[data-header-id]')
      if (header) header.checked = headerShown(header.dataset.headerId!)
    }

    function addOption(parent: HTMLElement, label: string, accessibleLabel: string) {
      const option = optionTemplate.content.firstElementChild!.cloneNode(true) as HTMLLabelElement
      option.querySelector('span')!.textContent = label
      const input = option.querySelector('input')!
      input.setAttribute('aria-label', accessibleLabel)
      parent.append(option)
      return input
    }

    function renderPreviews() {
      for (const source of [group, admin, profile, colorMode]) {
        const id = source === admin ? '/admin' : source.id
        const row = navigation.querySelector(`[data-id="${id}"]`)
        const target = row?.querySelector('.sidebar-block-preview')
        if (!row || !target) continue
        const block = source.cloneNode(true) as HTMLElement
        block.removeAttribute('id')
        block.hidden = false
        block.classList.remove('hide-collapsed', 'invisible')
        block.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
        block.querySelectorAll('.hide-collapsed').forEach(element => element.classList.remove('hide-collapsed'))
        if (source === group) {
          const empty = heading.hidden && !pinned.childElementCount
          row.toggleAttribute('data-empty-plugin-group', empty)
          for (const input of row.querySelectorAll<HTMLInputElement>('.sidebar-row-visibility input')) {
            if (empty && document.activeElement === input) {
              row.querySelector<HTMLButtonElement>('[data-step]:enabled')?.focus({ preventScroll: true })
            }
            input.disabled = empty
          }
          if (empty && title.hidden) block.textContent = t('nav.plugins')
        }
        target.replaceChildren(block)
      }
    }

    function makeRow(item: SidebarLink & { shown: boolean; pinned?: boolean }, isPlugin: boolean) {
      const row = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement
      row.dataset.id = item.id
      const label = row.querySelector('.sidebar-item-label')!
      if (item.element === group || item.element === admin || item.element === profile || item.element === colorMode) {
        const block = document.createElement('div')
        block.className = 'sidebar-block-preview'
        block.inert = true
        block.setAttribute('aria-hidden', 'true')
        label.append(block)
        row.setAttribute('aria-label', item.name)
        if (item.element === group || item.element === admin) {
          const show = row.querySelector('.sidebar-show')!
          const visibility = document.createElement('div')
          visibility.className = 'sidebar-row-visibility'
          show.replaceWith(visibility)
          const header = addOption(visibility, t('settings.sidebarShowHeader'),
            t('settings.sidebarShowNamedHeader').replace('{name}', () => item.element === admin ? t('nav.admin') : t('nav.plugins')))
          header.dataset.headerId = item.element === admin ? adminHeaderId : pluginsHeaderId
          visibility.append(show)
        }
      } else {
        if (isPlugin) label.append(sidebarPluginIcon(item.iconUrl))
        else if (item.icon) label.append(item.icon.cloneNode(true))
        label.append(item.name)
      }
      const handle = row.querySelector<HTMLButtonElement>('.sidebar-reorder')!
      handle.setAttribute('aria-label', t('settings.sidebarReorder').replace('{name}', () => item.name))
      for (const button of row.querySelectorAll<HTMLButtonElement>('[data-step]')) {
        const label = t(button.dataset.i18nAriaLabel!)
        button.setAttribute('aria-label', label)
        button.title = label
      }
      const show = row.querySelector<HTMLInputElement>('.sidebar-show input')!
      if (item.element === profile) show.closest('label')!.remove()
      else show.setAttribute('aria-label', t('settings.sidebarShowItem').replace('{name}', () => item.name))
      const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')!
      if (isPlugin) {
        pin.setAttribute('aria-label', t('settings.sidebarPinItem').replace('{name}', () => item.name))
        const pinLabel = pin.closest('label')!
        const promotionLabel = pinLabel.cloneNode(true) as HTMLLabelElement
        promotionLabel.className = 'sidebar-promote'
        const promotion = promotionLabel.querySelector('input')!
        promotion.setAttribute('aria-label', t('settings.sidebarPromoteItem').replace('{name}', () => item.name))
        promotion.dataset.promote = item.id
        pinLabel.before(promotionLabel)
      } else {
        pin.closest('label')!.remove()
      }
      updateRow(row, item)
      return row
    }

    function renderRows(
      list: HTMLUListElement, arranged: (SidebarLink & { shown: boolean; pinned?: boolean })[], isPlugin: boolean,
    ) {
      const focused = document.activeElement as HTMLElement | null
      const focusedRow = list.contains(focused) ? focused?.closest<HTMLElement>('li') : null
      const controls = 'button, input'
      const controlIndex = focusedRow ? Array.from(focusedRow.querySelectorAll(controls)).indexOf(focused!) : -1
      const existing = new Map(Array.from(list.querySelectorAll<HTMLElement>('li'), row => [row.dataset.id, row]))
      const rows = arranged.map(item => {
        const row = existing.get(item.id)
        const identity = JSON.stringify([item.name, item.iconUrl])
        if (row?.dataset.identity === identity) {
          existing.delete(item.id)
          updateRow(row, item)
          return row
        }
        const replacement = makeRow(item, isPlugin)
        replacement.dataset.identity = identity
        return replacement
      })
      for (const row of existing.values()) row.remove()
      rows.forEach((row, index) => {
        const current = list.children.item(index)
        if (row !== current) list.insertBefore(row, current)
      })
      updateMoveButtons()
      if (focusedRow && (document.activeElement !== focused || focused?.matches(':disabled'))) {
        const row = rows.find(row => row.dataset.id === focusedRow.dataset.id)
        const replacement = row?.querySelectorAll<HTMLElement>(controls)[controlIndex]
        const fallback = list.closest('section')!.querySelector<HTMLElement>('h2')!
        const next = replacement && !replacement.matches(':disabled') ? replacement : fallback
        next.focus({ preventScroll: true })
      }
    }

    function renderPlugins() {
      renderRows(pluginList, arrangeSidebarItems(plugins, preferences.plugins), true)
    }

    function renderNavigation() {
      renderRows(navigation, arrangedNavigation(adminAllowed), false)
      renderPreviews()
    }

    function render() {
      renderNavigation()
      renderPlugins()
      hover.checked = preferences.hover
      remember.checked = preferences.remember
      compact.checked = preferences.compact === true
      comfortable.checked = preferences.compact === false
      auto.checked = preferences.compact === null
    }

    function readRows(list: HTMLUListElement) {
      return Array.from(list.querySelectorAll<HTMLElement>('li')).map(row => {
        const shown = row.querySelector<HTMLInputElement>('.sidebar-show input')?.checked ?? true
        const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')
        if (pin) pin.disabled = !shown || isPromoted(row.dataset.id!) || !canPin()
        return { id: row.dataset.id!, shown, ...(pin && { pinned: pin.checked }) }
      })
    }

    function layoutSnapshot(layout: SidebarPreferences) {
      const navigationRows = arrangedNavigation(adminAllowed, layout).map(({ id, shown }) => ({ id, shown }))
      for (const id of adminAllowed ? [pluginsHeaderId, adminHeaderId] : [pluginsHeaderId]) {
        navigationRows.push({ id, shown: headerShown(id, layout) })
      }
      const pluginRows = arrangeSidebarItems(plugins, layout.plugins).map(({ id, shown, pinned }) => ({ id, shown, pinned }))
      return JSON.stringify([
        layout.compact, layout.hover, layout.remember,
        mergeSidebarOrder(layout.navigation, navigationRows, sidebarNavigationLimit).map(({ id, shown }) => [id, shown]),
        mergeSidebarOrder(layout.plugins, pluginRows, sidebarPluginLimit).map(({ id, shown, pinned }) => [id, shown, pinned !== false]),
      ])
    }

    function updateDraftState() {
      const expansionChanged = preferences.remember && draftExpansion !== undefined
        && (savingExpansion || draftExpansion !== (account?.expanded ?? false))
      const changed = expansionChanged || layoutSnapshot(preferences) !== layoutSnapshot(savedSidebar ?? defaultSidebarPreferences())
      settingsForm.toggleAttribute('data-dirty', changed)
      save.disabled = revert.disabled = !changed
      status.textContent = changed ? t('settings.sidebarUnsaved') : ''
      if (!changed) {
        const currentExpansion = expanded
        restoreSavedLayout()
        if (savingExpansion || !preferences.remember) expanded = currentExpansion
        renderNav()
        render()
      }
      return changed
    }

    function applyDraft() {
      const navigationRows = readRows(navigation)
      navigation.querySelectorAll<HTMLInputElement>('[data-header-id]').forEach(input => {
        navigationRows.push({ id: input.dataset.headerId!, shown: input.checked })
      })
      const pluginRows = readRows(pluginList)
      preferences = {
        navigation: mergeSidebarOrder(preferences.navigation, navigationRows, sidebarNavigationLimit),
        plugins: mergeSidebarOrder(preferences.plugins, pluginRows, sidebarPluginLimit),
        compact: auto.checked ? null : compact.checked, hover: hover.checked, remember: remember.checked,
        showColorMode: navigationRows.find(row => row.id === colorModeId)!.shown,
      }
      if (updateDraftState()) {
        renderNav()
        renderPlugins()
      }
    }

    function updateMoveButtons() {
      for (const row of settingsForm.querySelectorAll('.sidebar-settings-item')) {
        row.querySelector<HTMLButtonElement>('[data-step="-1"]')!.disabled = !row.previousElementSibling
        row.querySelector<HTMLButtonElement>('[data-step="1"]')!.disabled = !row.nextElementSibling
      }
    }

    function move(row: Element, target: Element, after: boolean) {
      if (after) target.after(row)
      else target.before(row)
      applyDraft()
      updateMoveButtons()
    }

    settingsForm.addEventListener('change', event => {
      const input = event.target as HTMLInputElement
      if (input.dataset.promote) {
        const id = promotionId(input.dataset.promote)
        const order = mergeSidebarOrder(preferences.navigation, readRows(navigation)).filter(row => row.id !== id)
        if (input.checked) {
          const profileIndex = order.findIndex(item => item.id === profile.id)
          const index = profile.parentElement === footer && profileIndex !== -1 ? profileIndex : order.length
          order.splice(index, 0, { id, shown: true })
        }
        preferences = { ...preferences, navigation: order }
        renderNavigation()
        renderPlugins()
      }
      applyDraft()
      if (input.matches('#sidebar-plugins-order .sidebar-show input') && isPromoted(input.closest('li')!.dataset.id!)) {
        renderNavigation()
      }
    })
    settingsForm.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button')
      if (!button) return
      if (button.dataset.step) {
        const row = button.closest('li')!
        const after = button.dataset.step === '1'
        const target = after ? row.nextElementSibling : row.previousElementSibling
        if (target) {
          move(row, target, after)
          const focus = button.disabled ? row.querySelector<HTMLButtonElement>('[data-step]:not(:disabled)') : button
          focus?.focus({ preventScroll: true })
        }
      } else if (button.matches('[role="tab"]')) {
        selectSectionTab(button)
      }
    })

    const tablist = settingsForm.querySelector<HTMLElement>('[role="tablist"]')!
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

    function selectSectionTab(selected: HTMLButtonElement) {
      for (const tab of tabs) {
        tab.setAttribute('aria-selected', String(tab === selected))
        tab.tabIndex = tab === selected ? 0 : -1
      }
    }

    settingsLink.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      closePreview()
      selectSectionTab(tabs[1])
      if (settingsForm.closest('main')?.inert) document.getElementById('sidebar-toggle')?.click()
      document.getElementById('sidebar-plugins-title')?.focus()
    }, { signal: listeners.signal })

    // On wide layouts the two sections are independently visible.
    const sectionObserver = new ResizeObserver(() => {
      const tabbed = tablist.offsetWidth > 0
      for (const tab of tabs) {
        const panel = document.getElementById(tab.getAttribute('aria-controls')!)!
        const title = panel.querySelector('h2')!
        panel.setAttribute('aria-labelledby', tabbed ? tab.id : title.id)
        if (tabbed) panel.setAttribute('role', 'tabpanel')
        else panel.removeAttribute('role')
      }
    })
    sectionObserver.observe(tablist)

    tablist.addEventListener('keydown', event => {
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[1 - index]
      selectSectionTab(next)
      next.focus()
    })

    settingsForm.addEventListener('pointerdown', event => {
      const handle = (event.target as Element).closest<HTMLButtonElement>('.sidebar-reorder')
      if (!handle || event.button !== 0) return
      drag = { row: handle.closest('li')!, y: event.clientY, pointerId: event.pointerId, moved: false }
      handle.setPointerCapture(event.pointerId)
    })

    settingsForm.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return
      drag.moved ||= Math.abs(event.clientY - drag.y) > 6
      if (!drag.moved) return
      drag.row.setAttribute('data-dragging', '')
      dropTarget?.removeAttribute('data-drop-target')
      dropTarget = rowAtPointer(event, drag.row)
      if (dropTarget) dropTarget.dataset.dropTarget = isBelowMidpoint(event, dropTarget) ? 'after' : 'before'
      if (event.clientY < toolbar.getBoundingClientRect().bottom + 24) window.scrollBy(0, -16)
      if (event.clientY > innerHeight - 64) window.scrollBy(0, 16)
    })

    function rowAtPointer(event: PointerEvent, row: HTMLElement) {
      if (!row.isConnected) return null
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('li.sidebar-settings-item')
      return target && target !== row && target.parentElement === row.parentElement ? target : null
    }

    function isBelowMidpoint(event: PointerEvent, row: HTMLElement) {
      const { top, height } = row.getBoundingClientRect()
      return event.clientY > top + height / 2
    }

    function endDrag(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return
      const { row, moved } = drag
      const target = event.type === 'pointerup' && moved ? rowAtPointer(event, row) : null
      row.removeAttribute('data-dragging')
      dropTarget?.removeAttribute('data-drop-target')
      dropTarget = drag = null
      if (target) move(row, target, isBelowMidpoint(event, target))
    }
    settingsForm.addEventListener('pointerup', endDrag)
    settingsForm.addEventListener('pointercancel', endDrag)
    document.addEventListener('lostpointercapture', endDrag, { signal: listeners.signal })

    reset.addEventListener('click', () => {
      preferences = defaultSidebarPreferences()
      expanded = false
      draftExpansion = false
      render()
      applyDraft()
    })
    revert.addEventListener('click', () => {
      restoreSavedLayout()
      settingsForm.removeAttribute('data-dirty')
      save.disabled = true
      revert.disabled = true
      status.textContent = ''
      render()
      renderNav()
      void refreshAccount()
    })
    settingsForm.addEventListener('submit', event => {
      event.preventDefault()
      if (sidebarSave || isLeaving() || !dirty()) return
      sidebarSave = saveDraft().then(saved => {
        if (!saved) failedWrites++
      }).finally(() => { sidebarSave = undefined })
    })

    async function saveDraft() {
      save.disabled = true
      revert.disabled = true
      status.textContent = t('common.saving')
      lists.inert = true
      reset.disabled = true
      heading.setAttribute('aria-disabled', 'true')
      const persist = (expected_sidebar: SidebarPreferences | null) => patchAccount({
        sidebar: preferences, expected_sidebar,
        ...((preferences.remember && (!expected_sidebar?.remember || draftExpansion !== undefined)) && { expanded }),
      })
      try {
        let result: AccountSidebarPreferences
        try {
          result = await persist(savedSidebar)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) throw error
          const latest = await readAccount()
          applyAccount(latest)
          const confirmed = await (window as typeof window & AppDialogs).__fmConfirm(t('settings.sidebarConflictMessage'), {
            title: t('settings.sidebarConflictTitle'), okLabel: t('settings.sidebarOverwrite'),
          })
          if (!confirmed) {
            status.textContent = t('settings.sidebarUnsaved')
            return false
          }
          result = await persist(latest.sidebar)
        }
        draftExpansion = undefined
        settingsForm.removeAttribute('data-dirty')
        applyAccount(result)
        status.textContent = t('common.saved')
        return true
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) status.textContent = t('settings.sidebarChangedAgain')
        else reportSaveError(error)
        return false
      } finally {
        lists.inert = false
        reset.disabled = false
        heading.removeAttribute('aria-disabled')
        save.disabled = !dirty()
        revert.disabled = save.disabled
      }
    }
    render()
    setPluginsStatus(pluginStatus)
    return {
      render, renderNavigation, renderPlugins, renderPreviews, updateDraftState,
      dispose() {
        sectionObserver.disconnect()
        toolbarObserver.disconnect()
        listeners.abort()
      },
      setStatus(message: string) { status.textContent = message },
      enable() {
        lists.inert = false
        reset.disabled = false
      },
    }
  }

  function setPluginsStatus(key: string) {
    pluginStatus = key
    const status = document.getElementById('sidebar-plugins-empty')
    if (!status) return
    status.hidden = Boolean(plugins.length)
    status.dataset.i18n = key
    status.textContent = t(key)
  }

  async function loadAccount(userId: number, initialTheme?: string | null) {
    accountId = userId
    loadingAccount = true
    if (initialTheme === 'brand' || initialTheme === 'light' || initialTheme === 'dark') applyTheme(initialTheme)
    settings?.setStatus(t('common.loading'))
    try {
      let result = await readAccount()
      const legacySidebar = readLegacySidebarPreferences(localStorage)
      const legacyTheme = localStorage.getItem('theme')
      const theme = legacyTheme === 'light' || legacyTheme === 'dark' || legacyTheme === 'brand' ? legacyTheme : undefined
      if ((!result.sidebar && legacySidebar) || (!result.theme && theme)) {
        if (legacySidebar && !localStorage.getItem(sidebarStorageKey)) {
          legacySidebar.navigation = items.map(item => ({ id: item.id, shown: item.id !== '/filaments/colors' }))
        }
        result = await patchAccount({
          import_legacy: true, sidebar: legacySidebar, theme,
          expanded: localStorage.getItem(expandedStorageKey) === 'true',
        })
      }
      applyAccount(result)
      for (const key of [sidebarStorageKey, legacyColorKey, expandedStorageKey, 'theme']) localStorage.removeItem(key)
      settings?.setStatus('')
    } catch {
      settings?.setStatus(t('settings.sidebarLoadError'))
    } finally {
      loadingAccount = false
      if (account) {
        settings?.enable()
        themeButtons().forEach(button => { button.disabled = false })
      }
      if (refreshAfterLoad) {
        refreshAfterLoad = false
        void refreshAccount()
      }
    }
  }

  return {
    navigate,
    isLeaving,
    guardPanelNavigation,
    loadAccount,
    setAdmin(allowed: boolean) {
      if (adminAllowed === allowed) {
        settings?.renderPreviews()
        return
      }
      adminAllowed = allowed
      renderNav()
      settings?.render()
    },
    setPlugins(entries: PluginLink[]) {
      const existing = new Map(plugins.map(plugin => [plugin.id, plugin]))
      const nextKeys = new Set(entries.map(plugin => plugin.plugin_key))
      const removed = plugins.filter(plugin => !nextKeys.has(plugin.id))
      plugins = entries.map(plugin => {
        const href = navHrefFor(plugin.page_url)
        const previous = existing.get(plugin.plugin_key)
        const link = previous?.element as HTMLAnchorElement | undefined ?? document.createElement('a')
        if (link.getAttribute('href') !== href) link.href = href
        if (!previous || previous.name !== plugin.name || previous.iconUrl !== plugin.icon_url) {
          link.classList.add('fm-nav-item')
          const icon = sidebarPluginIcon(plugin.icon_url)
          const name = document.createElement('span')
          name.textContent = plugin.name
          link.replaceChildren(icon, name)
        }
        return { id: plugin.plugin_key, name: plugin.name, element: link, iconUrl: plugin.icon_url }
      })
      setPluginsStatus('settings.sidebarNoPlugins')
      renderNav(removed)
      settings?.renderNavigation()
      settings?.renderPlugins()
    },
    setPluginsUnavailable() {
      setPluginsStatus('settings.sidebarPluginsUnavailable')
    },
  }
}
