// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createEntityExtraFieldsDialog } from './entity-extra-fields-dialog'
import { setLang } from './i18n'

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('shared extra fields dialog', () => {
  it.each(['filament', 'spool'] as const)('requires a changed %s draft and resets the baseline on reopen', targetType => {
    const save = vi.fn(async () => {})
    const dialog = createEntityExtraFieldsDialog({
      targetType,
      systemFields: {
        storage_note: { id: 1, key: 'storage_note', label: 'Storage note', field_type: 'text' },
      },
      onSave: save,
    })
    dialog.open({ customFields: { storage_note: 'Keep dry' } })
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!
    const input = overlay.querySelector<HTMLInputElement>('.system-field-input')!
    expect(submit.disabled).toBe(true)
    overlay.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(save).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(true)
    input.value = 'Changed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(false)
    input.value = 'Keep dry'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(true)
    input.value = 'Changed'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(submit.disabled).toBe(false)
    overlay.querySelector<HTMLButtonElement>('[data-extra-fields-cancel]')!.click()
    dialog.open({ customFields: { storage_note: 'Different saved value' } })
    expect(submit.disabled).toBe(true)
    expect(overlay.querySelector<HTMLInputElement>('.system-field-input')!.value).toBe('Different saved value')
    expect(save).not.toHaveBeenCalled()
  })

  it('tracks checkbox, multi-select and range changes without validating while typing', () => {
    const dialog = createEntityExtraFieldsDialog({
      targetType: 'spool',
      systemFields: {
        sealed: { key: 'sealed', label: 'Sealed', field_type: 'checkbox' },
        uses: { key: 'uses', label: 'Uses', field_type: 'multiselect', options: ['Draft', 'Final'] },
        temperature: { key: 'temperature', label: 'Temperature', field_type: 'range' },
      },
      onSave: async () => {},
    })
    dialog.open({ customFields: { sealed: true, uses: ['Draft'], temperature: { min: 10, max: 20 } } })
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!
    for (const selector of ['[data-key="sealed"]', '[data-key="uses"][value="Final"]']) {
      const input = overlay.querySelector<HTMLInputElement>(selector)!
      const original = input.checked
      input.checked = !original
      input.dispatchEvent(new Event('change', { bubbles: true }))
      expect(submit.disabled).toBe(false)
      input.checked = original
      input.dispatchEvent(new Event('change', { bubbles: true }))
      expect(submit.disabled).toBe(true)
    }
    const min = overlay.querySelector<HTMLInputElement>('[data-key="temperature.min"]')!
    min.value = '30'
    min.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(false)
    min.value = '10'
    min.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(true)
  })

  it('tracks committed custom value and definition edits, including reversion', async () => {
    const dialog = createEntityExtraFieldsDialog({ targetType: 'spool', systemFields: {}, onSave: async () => {} })
    dialog.open({ customFields: { note: 'Dry' }, customFieldDefinitions: { note: { label: 'Note', field_type: 'text' } } })
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!

    async function edit(selector: string, value: string): Promise<void> {
      overlay.querySelector<HTMLButtonElement>('.entity-extra-edit')!.click()
      const field = document.querySelector<HTMLInputElement>(selector)!
      field.value = value
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector<HTMLFormElement>('.extra-field-dialog-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('.extra-field-dialog-form')!.closest('dialog')!.open).toBe(false))
    }

    expect(submit.disabled).toBe(true)
    await edit('.extra-field-dialog-label', 'Storage note')
    expect(submit.disabled).toBe(false)
    await edit('.extra-field-dialog-label', 'Note')
    expect(submit.disabled).toBe(true)
    await edit('.extra-field-dialog-value .system-field-input', 'Wet')
    expect(submit.disabled).toBe(false)
    await edit('.extra-field-dialog-value .system-field-input', 'Dry')
    expect(submit.disabled).toBe(true)
    expect(overlay.open).toBe(true)
  })

  it('tracks custom field addition and deletion but ignores a canceled child draft', async () => {
    vi.stubGlobal('__fmConfirm', async () => true)
    const save = vi.fn(async () => {})
    const dialog = createEntityExtraFieldsDialog({ targetType: 'filament', systemFields: {}, onSave: save })
    dialog.open({})
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!
    const add = overlay.querySelector<HTMLButtonElement>('[data-extra-fields-add]')!
    add.focus()
    add.click()
    const child = document.querySelector('.extra-field-dialog-form')!.closest('dialog')!
    document.querySelector<HTMLInputElement>('.extra-field-dialog-key')!.value = 'note'
    child.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(submit.disabled).toBe(true)
    expect(overlay.open).toBe(true)
    expect(document.activeElement).toBe(add)

    add.click()
    document.querySelector<HTMLInputElement>('.extra-field-dialog-key')!.value = 'note'
    document.querySelector<HTMLInputElement>('.extra-field-dialog-label')!.value = 'Note'
    document.querySelector('.extra-field-dialog-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(child.open).toBe(false))
    expect(submit.disabled).toBe(false)
    overlay.querySelector<HTMLButtonElement>('.entity-extra-remove')!.click()
    await vi.waitFor(() => expect(overlay.querySelector('.entity-extra-remove')).toBeNull())
    expect(submit.disabled).toBe(true)

    dialog.open({ customFields: { note: 'Dry' } })
    overlay.querySelector<HTMLButtonElement>('.entity-extra-remove')!.click()
    await vi.waitFor(() => expect(overlay.querySelector('.entity-extra-remove')).toBeNull())
    expect(submit.disabled).toBe(false)
    overlay.querySelector<HTMLButtonElement>('[data-extra-fields-cancel]')!.click()
    expect(save).not.toHaveBeenCalled()
    dialog.open({ customFields: { note: 'Dry' } })
    expect(submit.disabled).toBe(true)
    expect(overlay.querySelector('.entity-extra-edit')).not.toBeNull()
  })

  it('blocks duplicate saves while pending and preserves a failed draft for retry', async () => {
    let rejectSave!: (cause: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject }))
      .mockResolvedValueOnce(undefined)
    const dialog = createEntityExtraFieldsDialog({
      targetType: 'spool',
      systemFields: { note: { key: 'note', label: 'Note', field_type: 'text' } },
      onSave: save,
    })
    dialog.open({ customFields: { note: 'Dry' } })
    const overlay = document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')!
    const form = overlay.querySelector('form')!
    const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!
    const input = overlay.querySelector<HTMLInputElement>('.system-field-input')!
    input.value = 'Wet'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(submit.disabled).toBe(true)
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(submit.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(save).toHaveBeenCalledTimes(1)
    rejectSave(new Error('Save failed'))
    await vi.waitFor(() => expect(submit.disabled).toBe(false))
    expect(overlay.open).toBe(true)
    expect(input.value).toBe('Wet')
    expect(overlay.querySelector<HTMLElement>('.entity-extra-fields-error')!.hidden).toBe(false)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(overlay.open).toBe(false))
    expect(save).toHaveBeenLastCalledWith({ customFields: { note: 'Wet' }, customFieldDefinitions: null })
  })

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
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
