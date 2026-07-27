// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createExtraFieldDefinitionDialog,
  type ExtraFieldDefinitionDialogDraft,
  type ExtraFieldDefinitionDialogResult,
} from './extra-field-definition-dialog'
import { setLang } from './i18n'

function draft(
  overrides: Partial<ExtraFieldDefinitionDialogDraft> = {},
): ExtraFieldDefinitionDialogDraft {
  return {
    targetType: 'filament',
    key: 'inspection',
    label: 'Inspection',
    fieldType: 'text',
    options: [],
    unit: '',
    decimalPlaces: '',
    minBound: '',
    maxBound: '',
    maxLength: '',
    defaultValue: null,
    ...overrides,
  }
}

async function submitDialog(): Promise<void> {
  document
    .querySelector<HTMLFormElement>('.extra-field-dialog-form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => {
    expect(
      document.querySelector<HTMLButtonElement>('.extra-field-dialog-submit')?.disabled,
    ).toBe(false)
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  setLang('en')
})

describe('shared Extra Field definition dialog', () => {
  it('preserves an unchanged timezone-bearing datetime default', async () => {
    const submission: { value?: ExtraFieldDefinitionDialogResult } = {}
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Edit Field',
      draft: draft({
        fieldType: 'datetime',
        defaultValue: '2026-07-25T14:30:45.123Z',
      }),
      lockIdentity: true,
      lockType: true,
      onSubmit(result) {
        submission.value = result
      },
    })

    const input = document.querySelector<HTMLInputElement>('[data-default-scalar]')!
    expect(input.type).toBe('datetime-local')
    expect(input.dataset.originalRaw).toBe('2026-07-25T14:30:45.123Z')
    document.querySelector<HTMLInputElement>('.extra-field-dialog-label')!.value =
      'Updated inspection'

    await submitDialog()

    expect(submission.value?.defaultValue).toBe('2026-07-25T14:30:45.123Z')
  })

  it('keeps an existing legacy field type visible and unchanged', async () => {
    const submission: { value?: ExtraFieldDefinitionDialogResult } = {}
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Edit Field',
      draft: draft({
        fieldType: 'float',
        unit: 'mm',
        decimalPlaces: '2',
      }),
      lockIdentity: true,
      lockType: true,
      onSubmit(result) {
        submission.value = result
      },
    })

    const select = document.querySelector<HTMLSelectElement>('.extra-field-dialog-type')!
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('float')
    expect(select.selectedOptions[0]?.textContent).toContain('float')

    await submitDialog()

    expect(submission.value?.fieldType).toBe('float')
    expect(submission.value?.unit).toBe('mm')
    expect(submission.value?.decimalPlaces).toBe('2')
  })

  it('shows the display label beside a checkbox default control', () => {
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Add Field',
      draft: draft({
        label: 'Filament humidity',
        fieldType: 'checkbox',
        defaultValue: 'true',
      }),
      onSubmit() {},
    })

    const checkbox = document.querySelector<HTMLInputElement>('[data-default-checkbox]')!
    expect(checkbox.checked).toBe(true)
    expect(checkbox.closest('label')?.textContent).toContain('Filament humidity')
    expect(document.querySelector('.extra-field-dialog-default')?.textContent)
      .toContain('checked or unchecked')
    expect(document.querySelector('.extra-field-dialog-default-row')?.textContent)
      .not.toContain('This value will be pre-filled')
    expect(
      document.querySelector<HTMLElement>('.extra-field-dialog-default-hint')?.style.display,
    ).toBe('none')
  })

  it('shows an explicit empty dropdown default', () => {
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Add Field',
      draft: draft({
        fieldType: 'dropdown',
        options: ['PLA', 'PETG'],
      }),
      onSubmit() {},
    })

    expect(
      document.querySelector<HTMLSelectElement>('[data-default-scalar]')
        ?.selectedOptions[0]?.textContent,
    ).toContain('No default selected')
    expect(document.querySelector('.extra-field-dialog-default-hint')?.textContent)
      .toContain('selected option will be the default')
    expect(document.querySelector('.extra-field-dialog-default-row')?.textContent)
      .not.toContain('This value will be pre-filled')
  })

  it('shows only the selection-specific hint for a multi-select default', () => {
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Add Field',
      draft: draft({
        fieldType: 'multiselect',
        options: ['PLA', 'PETG'],
      }),
      onSubmit() {},
    })

    expect(document.querySelector('.extra-field-dialog-default')?.textContent)
      .toContain('Selected options will be selected by default')
    expect(document.querySelector('.extra-field-dialog-default-row')?.textContent)
      .not.toContain('This value will be pre-filled')
    expect(
      document.querySelector<HTMLElement>('.extra-field-dialog-default-hint')?.style.display,
    ).toBe('none')
  })

  it('renders the shared dialog text in German', () => {
    setLang('de')
    const dialog = createExtraFieldDefinitionDialog({ mode: 'system' })
    dialog.open({
      title: 'Feld hinzufügen',
      draft: draft({
        label: 'Prüfung',
        fieldType: 'checkbox',
      }),
      onSubmit() {},
    })

    expect(document.querySelector('.extra-field-dialog-default')?.textContent)
      .toContain('aktiviert oder deaktiviert')
    expect(document.querySelector('.extra-field-dialog-default-row')?.textContent)
      .not.toContain('vorausgefüllt')
    expect(
      document.querySelector<HTMLButtonElement>('.extra-field-dialog-submit')
        ?.textContent,
    ).toContain('Speichern')
  })
})
