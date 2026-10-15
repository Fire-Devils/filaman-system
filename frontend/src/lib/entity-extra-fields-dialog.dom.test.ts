// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEntityExtraFieldsDialog } from './entity-extra-fields-dialog'
import { setLang } from './i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shared extra fields dialog', () => {
  it('saves only extra fields and leaves them unchanged on cancel', async () => {
    setLang('en')
    const save = vi.fn(async () => {})
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const dialog = createEntityExtraFieldsDialog({
      targetType: 'filament',
      systemFields: {
        storage_note: { id: 1, key: 'storage_note', label: 'Storage note', field_type: 'text' },
      },
      onSave: save,
    })

    dialog.open({ customFields: { storage_note: 'Keep dry' } }, trigger)
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    expect(overlay.tagName).toBe('DIALOG')
    expect(overlay.open).toBe(true)
    const input = overlay.querySelector<HTMLInputElement>('.system-field-input')!
    expect(input.value).toBe('Keep dry')
    input.value = 'Below 25% RH'
    overlay.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({
      customFields: { storage_note: 'Below 25% RH' },
      customFieldDefinitions: null,
    }))
    expect(overlay.open).toBe(false)

    dialog.open({ customFields: { storage_note: 'Keep dry' } }, trigger)
    overlay.querySelector<HTMLButtonElement>('[data-extra-fields-cancel]')!.click()
    expect(overlay.open).toBe(false)
    dialog.open({ customFields: { storage_note: 'Keep dry' } }, trigger)
    overlay.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(overlay.open).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
