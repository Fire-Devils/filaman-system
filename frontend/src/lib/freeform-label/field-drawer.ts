/** Drawer visibility is selection-local; the overlay never changes canvas geometry. */
export function bindFieldDrawer(root: ParentNode) {
  const dock = root.querySelector<HTMLElement>('#freeform-field-dock')
  const toggle = root.querySelector<HTMLButtonElement>('#freeform-field-dock-toggle')
  const body = root.querySelector<HTMLElement>('#freeform-field-dock-body')
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
      toggle?.removeEventListener('click', onToggle)
    },
  }
}
