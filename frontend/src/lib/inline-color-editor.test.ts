// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bindInlineColorEditor } from './inline-color-editor'

function renderEditor(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="filament-form">
      <input id="designation" required value="PLA" />
      <div id="new-color-toggle">
        <button type="button" id="btn-add-new-color">Add</button>
      </div>
      <div id="new-color-form" class="hidden">
        <input id="new-color-name" required disabled />
        <input id="new-color-picker" type="color" value="#FF0000" disabled />
        <input id="new-color-hex" required value="#FF0000" disabled />
        <input id="new-color-alpha-enabled" type="checkbox" disabled />
        <div id="new-color-alpha-options" class="hidden"></div>
        <span id="new-color-alpha-preview"></span>
        <input id="new-color-alpha" type="range" value="100" disabled />
        <input id="new-color-alpha-value" type="number" value="100" disabled />
        <input id="new-color-alpha-hex" value="FF" disabled />
        <button type="button" id="btn-save-new-color">Save</button>
        <button type="button" id="btn-cancel-new-color">Cancel</button>
      </div>
    </form>
  `

  bindInlineColorEditor({
    getAbortSignal: () => new AbortController().signal,
    getCsrfToken: () => 'csrf',
    isAbortError: () => false,
    onCreated: vi.fn(),
    translate: (key) => key,
  })

  return document.getElementById('filament-form') as HTMLFormElement
}

describe('bindInlineColorEditor parent form behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps hidden fields out of validation and restores that state on cancel', () => {
    const form = renderEditor()
    let submitCount = 0
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitCount += 1
    })

    form.requestSubmit()
    expect(submitCount).toBe(1)

    document.getElementById('btn-add-new-color')!.click()
    expect(
      (document.getElementById('new-color-name') as HTMLInputElement).disabled
    ).toBe(false)
    form.requestSubmit()
    expect(submitCount).toBe(1)

    document.getElementById('btn-cancel-new-color')!.click()
    expect(
      (document.getElementById('new-color-name') as HTMLInputElement).disabled
    ).toBe(true)
    form.requestSubmit()
    expect(submitCount).toBe(2)
  })
})
