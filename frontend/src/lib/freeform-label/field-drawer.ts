import { t } from '../i18n'

/** Drawer visibility is selection-local; the overlay never changes canvas geometry. */
export function bindFieldDrawer(root: ParentNode) {
  const dock = root.querySelector<HTMLElement>('#freeform-field-dock')
  const toggle = root.querySelector<HTMLButtonElement>('#freeform-field-dock-toggle')
  const body = root.querySelector<HTMLElement>('#freeform-field-dock-body')
  const search = root.querySelector<HTMLInputElement>('#freeform-field-search')
  const noResults = root.querySelector<HTMLElement>('#freeform-field-no-results')
  const tabs = [...(dock?.querySelectorAll<HTMLButtonElement>('[data-field-group-tab]') ?? [])].filter(tab => !tab.hidden)
  const panels = [...(dock?.querySelectorAll<HTMLElement>('[data-field-group]') ?? [])]
  let selectedTab = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') ?? tabs[0]
  const openStates = new Map<HTMLDetailsElement, boolean>()
  const filter = () => {
    const query = search?.value.trim().toLowerCase() ?? ''
    dock?.toggleAttribute('data-searching', Boolean(query))
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', String(!query && tab === selectedTab))
      tab.tabIndex = tab === selectedTab ? 0 : -1
    }
    let hasResults = false
    for (const panel of panels) {
      const tab = tabs.find(candidate => candidate.getAttribute('aria-controls') === panel.id)
      if (!tab) {
        panel.hidden = true
        continue
      }
      let panelMatches = false
      for (const group of panel.querySelectorAll<HTMLDetailsElement>('details')) {
        if (query && !openStates.has(group)) openStates.set(group, group.open)
        let matches = false
        for (const chip of group.querySelectorAll<HTMLElement>('[data-field-token]')) {
          const searchKey = chip.dataset.fieldSearchKey
          const alias = query && searchKey ? t(searchKey) : ''
          chip.hidden = Boolean(query) && !`${chip.textContent} ${chip.dataset.fieldToken} ${alias}`.toLowerCase().includes(query)
          matches ||= !chip.hidden
        }
        group.hidden = Boolean(query) && !matches
        if (query) group.open = matches
        else if (openStates.has(group)) group.open = openStates.get(group)!
        panelMatches ||= matches
      }
      const heading = panel.querySelector<HTMLElement>('[data-field-result-heading]')
      if (heading) heading.hidden = !query
      panel.setAttribute('role', query ? 'region' : 'tabpanel')
      panel.setAttribute('aria-labelledby', query && heading ? heading.id : tab.id)
      panel.hidden = query ? !panelMatches : tab !== selectedTab
      hasResults ||= panelMatches
    }
    if (noResults) noResults.hidden = !query || hasResults
    if (!query) openStates.clear()
  }
  const onTabClick = (event: Event) => {
    selectedTab = event.currentTarget as HTMLButtonElement
    if (search) search.value = ''
    filter()
  }
  const onTabKey = (event: KeyboardEvent) => {
    const current = tabs.indexOf(event.currentTarget as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
      : -1
    if (next < 0) return
    event.preventDefault()
    tabs[next].click()
    tabs[next].focus()
  }
  for (const tab of tabs) {
    tab.addEventListener('click', onTabClick)
    tab.addEventListener('keydown', onTabKey)
  }
  search?.addEventListener('input', filter)
  filter()
  const observer = new MutationObserver(filter)
  if (dock) observer.observe(dock, { childList: true, subtree: true })
  let selectedTextId: string | undefined
  let editable = false
  let collapsed = false
  const sync = () => {
    if (!dock || !toggle || !body) return
    const available = editable && Boolean(selectedTextId)
    const open = available && !collapsed
    dock.dataset.open = String(open)
    dock.dataset.available = String(available)
    toggle.disabled = !available
    toggle.setAttribute('aria-expanded', String(open))
    if (!open && body.contains(body.ownerDocument.activeElement)) toggle.focus({ preventScroll: true })
    body.toggleAttribute('inert', !open)
    body.setAttribute('aria-hidden', String(!open))
  }
  const onToggle = () => { collapsed = !collapsed; sync() }
  toggle?.addEventListener('click', onToggle)

  return {
    update(textId: string | undefined, canEdit: boolean) {
      if (textId !== selectedTextId) collapsed = false
      selectedTextId = textId
      editable = canEdit
      sync()
    },
    destroy() {
      search?.removeEventListener('input', filter)
      for (const tab of tabs) {
        tab.removeEventListener('click', onTabClick)
        tab.removeEventListener('keydown', onTabKey)
      }
      observer.disconnect()
      toggle?.removeEventListener('click', onToggle)
    },
  }
}
