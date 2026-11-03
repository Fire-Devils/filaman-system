// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { bindFormDialog } from './form-dialog'

afterEach(() => { document.body.replaceChildren() })

it('uses a native modal and restores the opener through Cancel and Escape', () => {
  document.body.innerHTML = '<button id="opener">Add</button><dialog><button data-dialog-close>Cancel</button><input></dialog><dialog id="rfid"><button>Confirm</button></dialog>'
  const opener = document.querySelector<HTMLButtonElement>('#opener')!
  const element = document.querySelector('dialog')!
  const cleanup = vi.fn()
  const dialog = bindFormDialog(element, { onClose: cleanup })
  opener.focus()
  dialog.open()
  expect(element.open).toBe(true)
  expect(document.querySelector<HTMLDialogElement>('#rfid')!.open).toBe(false)
  element.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()
  expect(element.open).toBe(false)
  expect(document.activeElement).toBe(opener)
  expect(cleanup).toHaveBeenCalledTimes(1)
  dialog.open()
  element.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(element.open).toBe(false)
  expect(cleanup).toHaveBeenCalledTimes(2)
})

it('prevents closing a pending save and runs cleanup once on close', () => {
  document.body.innerHTML = '<dialog><button data-dialog-close>Cancel</button></dialog>'
  const element = document.querySelector('dialog')!
  let busy = true
  const cleanup = vi.fn()
  const dialog = bindFormDialog(element, { canClose: () => !busy, onClose: cleanup })
  dialog.open()
  element.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(element.open).toBe(true)
  busy = false
  dialog.close()
  element.dispatchEvent(new Event('close'))
  expect(cleanup).toHaveBeenCalledTimes(1)
})
