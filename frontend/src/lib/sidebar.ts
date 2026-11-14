import { t } from './i18n'
import { navHrefFor } from './plugin-nav'
import { createPluginIcon } from './plugin-icon'
import type { AppDialogs } from './form-dialog'
import { api, ApiError } from './api'
import { getAbortSignal, isAbortError } from './abort'
import {
  arrangeSidebarItems, colorModeId, defaultSidebarPreferences, expandedStorageKey, legacyColorKey, mergeSidebarOrder,
  readLegacySidebarPreferences, sidebarStorageKey, sidebarSyncKey,
  type AccountSidebarPreferences, type ColorMode, type SidebarPreferences,
} from './sidebar-preferences'

interface SidebarLink {
  id: string
  name: string
  element: HTMLElement
  icon?: Element | null
  iconUrl?: string | null
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

export function setupSidebar() {
  const nav = document.getElementById('sidebar-nav')!
  const group = document.getElementById('plugin-nav')!
  const admin = document.getElementById('admin-nav')!
  const heading = document.querySelector<HTMLButtonElement>('#sidebar-plugin-heading')!
  const title = document.getElementById('sidebar-plugin-label')!
  const count = document.getElementById('sidebar-plugin-count')!
  const pinned = document.getElementById('sidebar-pinned-plugins')!
  const extra = document.getElementById('sidebar-plugin-preview')!
  const form = document.querySelector<HTMLFormElement>('#sidebar-settings-form')
  const settingsLink = document.getElementById('sidebar-plugin-settings-link')!
  const mouse = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 600px)')
  let previewing = false
  let plugins: SidebarLink[] = []
  let adminAllowed = false
  const items: SidebarLink[] = Array.from(nav.children).map(element => {
    const link = element === group ? null : element.matches('a') ? element : element.querySelector('a')
    return {
      id: link?.getAttribute('href') ?? element.id,
      name: element.id === colorModeId ? t('theme.colorMode') : link?.textContent?.trim() || t('nav.plugins'),
      element: element as HTMLElement,
      icon: (link ?? element).querySelector('.fm-nav-icon'),
    }
  })
  const isSection = (item: SidebarLink) => item.element === group || item.element === admin

  const themeButtons = document.querySelectorAll<HTMLButtonElement>('.fm-theme-toggle button[data-theme]')
  let accountId: number | undefined
  let account: AccountSidebarPreferences = { sidebar: null, theme: null, expanded: null }
  let preferences = defaultSidebarPreferences()
  let savedSidebar: SidebarPreferences | null = null
  let changingTheme = false
  let accountLoaded = false
  let expanded = false
  let draftExpansion: boolean | undefined
  let refreshGeneration = 0
  let pendingWrites = 0
  let writes: Promise<unknown> = Promise.resolve()
  const dirty = () => form?.matches('[data-dirty]')
  const preferenceUrl = () => `/me/preferences/sidebar?account_id=${accountId}`
  const readAccount = () => api.get<AccountSidebarPreferences>(preferenceUrl(), {
    cache: 'no-store', signal: AbortSignal.any([getAbortSignal(), AbortSignal.timeout(5000)]),
  })

  function applyTheme(theme: ColorMode) {
    document.documentElement.dataset.theme = theme
    themeButtons.forEach(button => {
      const selected = button.dataset.theme === theme
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
  }

  function patchAccount(data: Partial<AccountSidebarPreferences> & {
    expected_sidebar?: SidebarPreferences | null
    import_legacy?: boolean
  }) {
    pendingWrites++
    ++refreshGeneration
    const write = writes.then(async () => {
      const result = await api.patch<AccountSidebarPreferences>(preferenceUrl(), data, {
        signal: AbortSignal.timeout(15000), keepalive: !data.sidebar,
      })
      try {
        localStorage.setItem(sidebarSyncKey, `${accountId}:${Date.now()}:${Math.random()}`)
      } catch { /* Other tabs refresh when brought to the foreground. */ }
      return result
    }).finally(() => pendingWrites--)
    writes = write.catch(() => {})
    return write
  }

  function reportSaveError(error: unknown) {
    if (isAbortError(error)) return
    const message = t('settings.sidebarSaveError')
    if (settings) settings.setStatus(message)
    else void (window as typeof window & AppDialogs).__fmAlert(message)
  }

  for (const button of themeButtons) {
    button.disabled = true
    button.addEventListener('click', async () => {
      const theme = button.dataset.theme as ColorMode
      changingTheme = true
      applyTheme(theme)
      themeButtons.forEach(button => { button.disabled = true })
      try {
        const result = await patchAccount({ theme })
        applyAccount(result)
      } catch (error) {
        reportSaveError(error)
      } finally {
        changingTheme = false
        applyTheme(account.theme ?? 'brand')
        themeButtons.forEach(button => { button.disabled = false })
      }
    })
  }

  function closePreview() {
    if (!previewing) return
    if (extra.contains(document.activeElement)) heading.focus({ preventScroll: true })
    extra.hidePopover()
    extra.removeAttribute('popover')
    extra.hidden = !expanded
    previewing = false
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
  }

  heading.addEventListener('pointerenter', openPreview)
  for (const element of [heading, extra]) {
    element.addEventListener('pointerleave', event => {
      const next = event.relatedTarget
      if (!(next instanceof Node && (extra.contains(next) || heading.contains(next)))) closePreview()
    })
  }
  heading.addEventListener('click', () => {
    expanded = !expanded
    renderDisclosure()
    if (dirty()) draftExpansion = expanded
    else if (preferences.remember) {
      const requested = expanded
      void patchAccount({ expanded: requested }).then(result => {
        if (expanded === requested) applyAccount(result)
      }).catch(reportSaveError)
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
  }

  function arrangedNavigation(entries: SidebarLink[]) {
    const hasColorMode = preferences.navigation.some(row => row.id === colorModeId)
    const arranged = arrangeSidebarItems(entries, preferences.navigation)
    if (!hasColorMode) {
      const picker = arranged.find(item => item.id === colorModeId)
      if (picker) picker.shown = preferences.showColorMode
    }
    return arranged
  }

  function renderNav() {
    closePreview()
    const focused = document.activeElement as HTMLElement | null
    const wasFocused = focused && nav.contains(focused)
    nav.classList.toggle('sidebar-nav-compact', preferences.compact)
    for (const item of arrangedNavigation(items)) {
      nav.append(item.element)
      if (!isSection(item)) item.element.hidden = !item.shown
      if (item.element === admin) admin.hidden = !item.shown || !adminAllowed
      if (item.element === group) group.hidden = !item.shown
    }
    pinned.replaceChildren()
    extra.replaceChildren()
    for (const plugin of arrangeSidebarItems(plugins, preferences.plugins)) {
      if (plugin.shown) (plugin.pinned ? pinned : extra).append(plugin.element)
    }
    const extraCount = extra.childElementCount
    group.hidden ||= !pinned.childElementCount && !extraCount
    heading.hidden = !extraCount
    title.hidden = Boolean(extraCount)
    count.textContent = String(extraCount)
    renderDisclosure()
    if (extraCount) extra.append(settingsLink)
    if (wasFocused && document.activeElement !== focused) {
      const next = focused.getClientRects().length ? focused
        : [heading, ...nav.querySelectorAll<HTMLElement>('a[href]')].find(item => item.getClientRects().length)
          ?? document.getElementById('sidebar-toggle')
      next?.focus({ preventScroll: true })
    }
  }

  const settings = form && setupSettings(form)
  renderNav()

  function applyAccount(result: AccountSidebarPreferences) {
    account = result
    if (!changingTheme) applyTheme(result.theme ?? 'brand')
    if (!dirty() && JSON.stringify(savedSidebar) !== JSON.stringify(result.sidebar)) {
      savedSidebar = result.sidebar
      preferences = savedSidebar ?? defaultSidebarPreferences()
      if (preferences.remember && result.expanded !== null) expanded = result.expanded
      renderNav()
      settings?.render()
    } else if (preferences.remember && draftExpansion === undefined && result.expanded !== null && expanded !== result.expanded) {
      expanded = result.expanded
      renderDisclosure()
    }
  }

  async function refreshAccount() {
    if (!accountLoaded) return
    await writes
    if (pendingWrites) return
    const generation = ++refreshGeneration
    try {
      const result = await readAccount()
      if (generation === refreshGeneration) applyAccount(result)
    } catch { /* Keep the current settings during a transient read failure. */ }
  }
  window.addEventListener('storage', event => {
    if (event.key === sidebarSyncKey && event.newValue?.startsWith(`${accountId}:`)) void refreshAccount()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) void refreshAccount() })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAccount() })

  function setupSettings(settingsForm: HTMLFormElement) {
    const navigation = document.querySelector<HTMLUListElement>('#sidebar-navigation-order')!
    const pluginList = document.querySelector<HTMLUListElement>('#sidebar-plugins-order')!
    const lists = settingsForm.querySelector<HTMLElement>('.sidebar-settings-lists')!
    const reset = document.querySelector<HTMLButtonElement>('#sidebar-reset')!
    const rowTemplate = document.querySelector<HTMLTemplateElement>('#sidebar-settings-row')!
    const colorPreview = document.querySelector<HTMLTemplateElement>('#sidebar-color-mode-preview')!
    const status = document.getElementById('sidebar-settings-status')!
    const save = settingsForm.querySelector<HTMLButtonElement>('[type="submit"]')!
    const hover = settingsForm.querySelector<HTMLInputElement>('[name="hover"]')!
    const remember = settingsForm.querySelector<HTMLInputElement>('[name="remember"]')!
    const compact = settingsForm.querySelector<HTMLInputElement>('[value="compact"]')!
    const comfortable = settingsForm.querySelector<HTMLInputElement>('[value="comfortable"]')!
    let dropTarget: HTMLElement | null = null
    let drag: { handle: HTMLButtonElement; y: number; pointerId: number; moved: boolean } | null = null
    let submitting = false
    save.disabled = true

    function updateRow(row: HTMLElement, item: { shown: boolean; pinned?: boolean }) {
      row.querySelector<HTMLInputElement>('.sidebar-show input')!.checked = item.shown
      const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')
      if (pin) {
        pin.checked = item.pinned !== false
        pin.disabled = !item.shown
      }
    }

    function makeRow(item: SidebarLink & { shown: boolean; pinned?: boolean }, isPlugin: boolean) {
      const row = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement
      row.dataset.id = item.id
      const label = row.querySelector('.sidebar-item-label')!
      if (isPlugin) label.append(sidebarPluginIcon(item.iconUrl))
      else if (item.icon) label.append(item.icon.cloneNode(true))
      label.append(item.name)
      if (!isPlugin && item.id === colorModeId) {
        const preview = colorPreview.content.cloneNode(true) as DocumentFragment
        for (const text of preview.querySelectorAll<HTMLElement>('[data-i18n]')) text.textContent = t(text.dataset.i18n!)
        label.append(preview)
      }
      const handle = row.querySelector<HTMLButtonElement>('.sidebar-reorder')!
      handle.setAttribute('aria-label', t('settings.sidebarReorder').replace('{name}', () => item.name))
      for (const button of row.querySelectorAll<HTMLButtonElement>('[data-step]')) {
        const label = t(button.dataset.i18nAriaLabel!)
        button.setAttribute('aria-label', label)
        button.title = label
      }
      const show = row.querySelector<HTMLInputElement>('.sidebar-show input')!
      show.setAttribute('aria-label', t('settings.sidebarShowItem').replace('{name}', () => item.name))
      const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')!
      if (isPlugin) {
        pin.setAttribute('aria-label', t('settings.sidebarPinItem').replace('{name}', () => item.name))
      } else {
        pin.closest('label')!.remove()
      }
      updateRow(row, item)
      return row
    }

    function renderRows(list: HTMLUListElement, items: SidebarLink[], isPlugin: boolean) {
      const focused = document.activeElement as HTMLElement | null
      const focusedRow = list.contains(focused) ? focused?.closest<HTMLElement>('li') : null
      const controls = 'button, input'
      const controlIndex = focusedRow ? Array.from(focusedRow.querySelectorAll(controls)).indexOf(focused!) : -1
      const existing = new Map(Array.from(list.querySelectorAll<HTMLElement>('li'), row => [row.dataset.id, row]))
      const arranged = isPlugin ? arrangeSidebarItems(items, preferences.plugins) : arrangedNavigation(items)
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
      renderRows(pluginList, plugins, true)
    }

    function render() {
      renderRows(navigation, items.filter(item => item.element !== admin || adminAllowed), false)
      renderPlugins()
      hover.checked = preferences.hover
      remember.checked = preferences.remember
      compact.checked = preferences.compact
      comfortable.checked = !preferences.compact
    }

    function readRows(list: HTMLUListElement) {
      return Array.from(list.querySelectorAll<HTMLElement>('li')).map(row => {
        const shown = row.querySelector<HTMLInputElement>('.sidebar-show input')!.checked
        const pin = row.querySelector<HTMLInputElement>('.sidebar-pin input')
        if (pin) pin.disabled = !shown
        return { id: row.dataset.id!, shown, ...(pin && { pinned: pin.checked }) }
      })
    }

    function applyDraft() {
      const navigationRows = readRows(navigation)
      const pluginRows = readRows(pluginList)
      preferences = {
        navigation: mergeSidebarOrder(preferences.navigation, navigationRows),
        plugins: mergeSidebarOrder(preferences.plugins, pluginRows),
        compact: compact.checked, hover: hover.checked, remember: remember.checked,
        showColorMode: navigationRows.find(row => row.id === colorModeId)!.shown,
      }
      settingsForm.setAttribute('data-dirty', '')
      save.disabled = false
      status.textContent = ''
      renderNav()
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

    settingsForm.addEventListener('change', applyDraft)
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

    // On wide layouts the two sections are independently visible.
    new ResizeObserver(() => {
      const tabbed = tablist.offsetWidth > 0
      for (const tab of tabs) {
        const panel = document.getElementById(tab.getAttribute('aria-controls')!)!
        const title = panel.querySelector('h2')!
        panel.setAttribute('aria-labelledby', tabbed ? tab.id : title.id)
        if (tabbed) panel.setAttribute('role', 'tabpanel')
        else panel.removeAttribute('role')
      }
    }).observe(tablist)

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
      drag = { handle, y: event.clientY, pointerId: event.pointerId, moved: false }
      handle.setPointerCapture(event.pointerId)
    })

    settingsForm.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return
      drag.moved ||= Math.abs(event.clientY - drag.y) > 6
      if (!drag.moved) return
      dropTarget?.removeAttribute('data-drop-target')
      dropTarget = rowAtPointer(event, drag.handle.closest('li')!)
      dropTarget?.setAttribute('data-drop-target', '')
      if (event.clientY < 64) window.scrollBy(0, -16)
      if (event.clientY > innerHeight - 64) window.scrollBy(0, 16)
    })

    function rowAtPointer(event: PointerEvent, row: HTMLElement) {
      if (!row.isConnected) return null
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('li.sidebar-settings-item')
      return target && target !== row && target.parentElement === row.parentElement ? target : null
    }

    function endDrag(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return
      const row = drag.handle.closest('li')!
      const target = event.type === 'pointerup' && drag.moved ? rowAtPointer(event, row) : null
      if (target) {
        const bounds = target.getBoundingClientRect()
        move(row, target, event.clientY > bounds.top + bounds.height / 2)
      }
      dropTarget?.removeAttribute('data-drop-target')
      dropTarget = drag = null
    }
    settingsForm.addEventListener('pointerup', endDrag)
    settingsForm.addEventListener('pointercancel', endDrag)
    document.addEventListener('lostpointercapture', endDrag)

    reset.addEventListener('click', () => {
      preferences = defaultSidebarPreferences()
      expanded = false
      draftExpansion = false
      render()
      applyDraft()
    })
    settingsForm.addEventListener('submit', async event => {
      event.preventDefault()
      if (submitting || !dirty()) return
      submitting = true
      save.disabled = true
      lists.inert = true
      reset.disabled = true
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
          const confirmed = await (window as typeof window & AppDialogs).__fmConfirm(t('settings.sidebarConflictMessage'), {
            title: t('settings.sidebarConflictTitle'), okLabel: t('settings.sidebarOverwrite'),
          })
          if (!confirmed) return
          result = await persist(latest.sidebar)
        }
        draftExpansion = undefined
        settingsForm.removeAttribute('data-dirty')
        applyAccount(result)
        status.textContent = t('common.saved')
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) status.textContent = t('settings.sidebarChangedAgain')
        else reportSaveError(error)
      } finally {
        submitting = false
        lists.inert = false
        reset.disabled = false
        save.disabled = !dirty()
      }
    })
    render()
    return { render, renderPlugins, setStatus(message: string) { status.textContent = message } }
  }

  function setPluginsStatus(key: string) {
    const status = document.getElementById('sidebar-plugins-empty')
    if (!status) return
    status.hidden = Boolean(plugins.length)
    status.dataset.i18n = key
    status.textContent = t(key)
  }

  return {
    async loadAccount(userId: number) {
      accountId = userId
      try {
        let result = await readAccount()
        applyAccount(result)
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
          applyAccount(result)
        }
        for (const key of [sidebarStorageKey, legacyColorKey, expandedStorageKey, 'theme']) localStorage.removeItem(key)
      } catch {
        if (!account.sidebar && !account.theme) settings?.setStatus(t('settings.sidebarLoadError'))
      } finally {
        accountLoaded = true
        applyTheme(account.theme ?? 'brand')
        themeButtons.forEach(button => { button.disabled = false })
      }
    },
    setAdmin(allowed: boolean) {
      adminAllowed = allowed
      renderNav()
      settings?.render()
    },
    setPlugins(entries: PluginLink[]) {
      const existing = new Map(plugins.map(plugin => [plugin.id, plugin]))
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
      renderNav()
      settings?.renderPlugins()
    },
    setPluginsUnavailable() {
      setPluginsStatus('settings.sidebarPluginsUnavailable')
    },
  }
}
