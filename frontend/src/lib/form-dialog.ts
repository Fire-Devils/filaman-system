/** Native modality keeps closed sibling dialogs out of the keyboard focus order. */
export function bindFormDialog(dialog: HTMLDialogElement, options: {
  canClose?: () => boolean
  onClose?: () => void
} = {}) {
  let opener: HTMLElement | null = null
  let active = false
  function finish() {
    if (!active) return
    active = false
    options.onClose?.()
    if (opener?.isConnected) opener.focus()
    opener = null
  }
  function close() {
    if (!dialog.open || options.canClose?.() === false) return
    dialog.close()
    finish()
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('close', () => { if (!dialog.open) finish() })
  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', close))
  return {
    close,
    open() {
      if (dialog.open) return
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      active = true
      dialog.showModal()
    },
  }
}
