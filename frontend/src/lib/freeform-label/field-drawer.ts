/** Drawer visibility is selection-local; the overlay never changes canvas geometry. */
export function bindFieldDrawer(root: ParentNode) {
  const dock = root.querySelector<HTMLElement>('#freeform-field-dock')
  const toggle = root.querySelector<HTMLButtonElement>('#freeform-field-dock-toggle')
  const body = root.querySelector<HTMLElement>('#freeform-field-dock-body')
  const search = root.querySelector<HTMLInputElement>('#freeform-field-search')
  const openStates = new Map<HTMLDetailsElement, boolean>()
  const filter = () => {
    const query = search?.value.trim().toLowerCase() ?? ''
    for (const group of dock?.querySelectorAll<HTMLDetailsElement>('details') ?? []) {
      if (query && !openStates.has(group)) openStates.set(group, group.open)
      let matches = false
      for (const chip of group.querySelectorAll<HTMLElement>('[data-field-token]')) {
        chip.hidden = Boolean(query) && !`${chip.textContent} ${chip.dataset.fieldToken}`.toLowerCase().includes(query)
        matches ||= !chip.hidden
      }
      group.hidden = Boolean(query) && !matches
      if (query) group.open = matches
      else if (openStates.has(group)) group.open = openStates.get(group)!
    }
    if (!query) openStates.clear()
  }
  search?.addEventListener('input', filter)
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
      observer.disconnect()
      toggle?.removeEventListener('click', onToggle)
    },
  }
}
