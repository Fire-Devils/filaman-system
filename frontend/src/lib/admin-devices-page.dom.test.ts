// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import { bindFormDialog } from './form-dialog'
import { bindFormState } from './form-state'
import { tableAction } from './table-actions'
import { escapeHtml } from './extra-fields'
import { setLang, t, translatePage } from './i18n'
import { copyText } from './clipboard'

async function boot(language: 'en' | 'de' | 'fr' = 'en') {
  setLang(language)
  const device = { id: 9, name: 'Scale "A" <printer>', is_active: true, is_online: true, registration_pending: false, ip_address: '::1', auto_assign_enabled: false, auto_assign_timeout: 60, last_used_at: null }
  const api = {
    put: vi.fn(async (_path: string, data: unknown) => Object.assign(device, data)),
    post: vi.fn(async () => ({ device_code: 'test-one-time-code' })),
    delete: vi.fn(async () => ({})),
  }
  const fetchAllPages = vi.fn(async () => ({ items: [device, { ...device, id: 10, name: 'Other reader' }] }))
  Object.assign(window, { __fmConfirm: vi.fn(async () => true), __fmAlert: vi.fn(async () => true) })
  const dependencies = { t, translatePage, initI18n: async () => {}, isAbortError: () => false, copyText, escapeHtml, api, fetchAllPages, bindFormDialog, bindFormState, tableAction }
  await bootAstroPage('admin/devices', dependencies)
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  return { ...api, fetchAllPages }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function expectActionsDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLButtonElement>('#devices-table .btn-edit, #devices-table .btn-delete, #btn-new').forEach(button => expect(button.disabled).toBe(disabled))
}
function change(id: string, value: string | boolean) {
  const input = document.getElementById(id) as HTMLInputElement
  if (typeof value === 'boolean') input.checked = value
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('edits a device inline with change-aware Save, retained failed drafts and the existing request shape', async () => {
  const api = await boot()
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector('#device-editor-row')).not.toBeNull()
  expect(document.querySelector<HTMLInputElement>('#edit-device-name')!.value).toBe('Scale "A" <printer>')
  const save = document.querySelector<HTMLButtonElement>('#edit-submit')!
  expect(save.disabled).toBe(true)
  change('edit-device-name', 'Renamed')
  expect(save.disabled).toBe(false)
  change('edit-device-name', 'Scale "A" <printer>')
  expect(save.disabled).toBe(true)
  change('edit-auto-assign', true)
  expect(document.querySelector<HTMLElement>('#edit-timeout-group')!.hidden).toBe(false)
  change('edit-auto-timeout', '120')
  let rejectWrite!: (error: Error) => void
  api.put.mockImplementationOnce(() => new Promise<never>((_resolve, reject) => { rejectWrite = reject }))
  document.querySelector('#edit-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(save.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#edit-cancel')!.disabled).toBe(true)
  document.querySelector('#edit-form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('#device-editor-row')).not.toBeNull()
  rejectWrite(new Error('Device unavailable'))
  await vi.waitFor(() => expect(document.querySelector('#edit-error')!.textContent).toBe('Device unavailable'))
  expect(document.querySelector<HTMLInputElement>('#edit-auto-timeout')!.value).toBe('120')
  expect(save.disabled).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('#edit-cancel')!.disabled).toBe(false)
  document.querySelector('#edit-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(document.querySelector('#device-editor-row')).toBeNull())
  expect(api.put).toHaveBeenLastCalledWith('/admin/devices/9', { name: 'Scale "A" <printer>', auto_assign_enabled: true, auto_assign_timeout: 120 })
  expect(document.querySelector('tbody img')).toBeNull()
})

it('locks competing edits through delete confirmation, write and refresh, then permits editing again', async () => {
  const api = await boot()
  const loaded = await api.fetchAllPages.mock.results[0].value
  const confirmation = deferred<boolean>()
  const deletion = deferred<object>()
  const refresh = deferred<typeof loaded>()
  Object.assign(window, { __fmConfirm: () => confirmation.promise })
  api.delete.mockImplementationOnce(() => deletion.promise)
  api.fetchAllPages.mockImplementationOnce(() => refresh.promise)
  document.querySelector<HTMLButtonElement>('.btn-delete[data-id="9"]')!.click()
  expectActionsDisabled(true)
  confirmation.resolve(true)
  await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/devices/9'))
  expectActionsDisabled(true)
  deletion.resolve({})
  await vi.waitFor(() => expect(api.fetchAllPages).toHaveBeenCalledTimes(2))
  expectActionsDisabled(true)
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector('#device-editor-row')).toBeNull()
  refresh.resolve({ items: [loaded.items[1]] })
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.disabled).toBe(false))
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  change('edit-device-name', 'Retained draft')
  expect(document.querySelector<HTMLInputElement>('#edit-device-name')!.value).toBe('Retained draft')
  document.querySelector<HTMLButtonElement>('#edit-cancel')!.click()
  expectActionsDisabled(false)
})

it('locks competing edits until a successful edit refresh finishes', async () => {
  const api = await boot()
  const loaded = await api.fetchAllPages.mock.results[0].value
  const refresh = deferred<typeof loaded>()
  api.fetchAllPages.mockImplementationOnce(() => refresh.promise)
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="9"]')!.click()
  change('edit-device-name', 'Saved name')
  document.querySelector('#edit-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(api.fetchAllPages).toHaveBeenCalledTimes(2))
  expectActionsDisabled(true)
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector('#device-editor-row')).toBeNull()
  refresh.resolve(loaded)
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.disabled).toBe(false))
  expect(document.activeElement).toBe(document.querySelector('.btn-edit[data-id="9"]'))
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector<HTMLInputElement>('#edit-device-name')!.value).toBe('Other reader')
})

it.each(['cancel', 'failure'] as const)('restores device actions after delete %s', async outcome => {
  const api = await boot()
  Object.assign(window, { __fmConfirm: async () => outcome !== 'cancel' })
  api.delete.mockRejectedValueOnce(new Error('Device unavailable'))
  document.querySelector<HTMLButtonElement>('.btn-delete[data-id="9"]')!.click()
  expectActionsDisabled(true)
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#btn-new')!.disabled).toBe(false))
  expectActionsDisabled(false)
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector<HTMLInputElement>('#edit-device-name')!.value).toBe('Other reader')
})

it('restores Create after a failed refresh following a successful edit', async () => {
  const api = await boot()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.fetchAllPages.mockRejectedValueOnce(new Error('Refresh unavailable'))
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="9"]')!.click()
  change('edit-device-name', 'Saved name')
  document.querySelector('#edit-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(document.querySelector('#devices-table [role="alert"]')).not.toBeNull())
  expect(document.querySelector('#device-editor-row')).toBeNull()
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#btn-new')!.disabled).toBe(false))
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true)
})

it('keeps row actions locked after acknowledging a new token until its refresh finishes', async () => {
  const api = await boot()
  const loaded = await api.fetchAllPages.mock.results[0].value
  const refresh = deferred<typeof loaded>()
  api.fetchAllPages.mockImplementationOnce(() => refresh.promise)
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('device-name', 'New reader')
  document.querySelector('#modal-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#token-modal')!.open).toBe(true))
  document.querySelector<HTMLButtonElement>('#token-close')!.click()
  expectActionsDisabled(true)
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector('#device-editor-row')).toBeNull()
  refresh.resolve(loaded)
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.disabled).toBe(false))
  document.querySelector<HTMLButtonElement>('.btn-edit[data-id="10"]')!.click()
  expect(document.querySelector('#device-editor-row')).not.toBeNull()
})

it('keeps one-time device codes in the guarded native dialog and clears them on acknowledgement', async () => {
  const api = await boot()
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('device-name', 'New reader')
  document.querySelector('#modal-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  const token = document.querySelector<HTMLDialogElement>('#token-modal')!
  await vi.waitFor(() => expect(token.open).toBe(true))
  expect(api.post).toHaveBeenCalledWith('/admin/devices', { name: 'New reader' })
  expect(document.querySelector<HTMLInputElement>('#token-display')!.value).toBe('test-one-time-code')
  token.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(token.open).toBe(true)
  document.querySelector<HTMLButtonElement>('#token-close')!.click()
  expect(token.open).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#token-display')!.value).toBe('')
  expect(document.querySelector('#devices-table')!.textContent).not.toContain('test-one-time-code')
})

it('copies the device code from inside the modal when the Clipboard API is unavailable', async () => {
  await boot()
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('device-name', 'New reader')
  document.querySelector('#modal-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  const modal = document.querySelector<HTMLDialogElement>('#token-modal')!
  await vi.waitFor(() => expect(modal.open).toBe(true))
  const copyButton = modal.querySelector<HTMLButtonElement>('#token-copy')!
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: () => {
      // A native modal makes fields outside it inert, even if the copy command returns true.
      const field = modal.querySelector('textarea')
      if (field) copied = field.value.slice(field.selectionStart, field.selectionEnd)
      return true
    },
  })
  try {
    copyButton.click()
    await vi.waitFor(() => expect(copyButton.textContent).toBe(t('admin.copied')))
    expect(copied).toBe('test-one-time-code')
    expect(modal.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(copyButton)
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(document, 'execCommand')
  }
})

it.each(['de', 'fr'] as const)('translates dynamically inserted device controls in %s', async language => {
  await boot(language)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector('#device-editor-row label[for="edit-device-name"]')!.textContent).toBe(t('common.name'))
  expect(document.querySelector('#edit-submit')!.textContent).toBe(t('common.save'))
  expect(document.querySelector('#edit-cancel')!.textContent).toBe(t('common.cancel'))
  expect(document.querySelector('#device-editor-row [data-i18n="admin.autoAssignEnabled"]')!.textContent).toBe(t('admin.autoAssignEnabled'))
})
