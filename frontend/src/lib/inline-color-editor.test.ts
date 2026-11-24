// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { abortAllRequests, getAbortSignal } from './abort'
import { bindInlineColorEditor } from './inline-color-editor'

function renderEditor(onOpenChange = vi.fn()): HTMLFormElement {
  document.body.innerHTML = `
    <form id="filament-form">
      <input id="designation" required value="PLA" />
      <details id="new-color-disclosure">
        <summary>Add color to library</summary>
        <div id="new-color-form">
          <input id="new-color-name" required disabled />
          <input id="new-color-picker" type="color" value="#FF0000" disabled />
          <input id="new-color-hex" required value="#FF0000" disabled />
          <input id="new-color-alpha-enabled" type="checkbox" disabled />
          <div id="new-color-alpha-options" class="hidden"></div>
          <span id="new-color-alpha-preview"></span>
          <input id="new-color-alpha" type="range" value="100" disabled />
          <input id="new-color-alpha-value" type="number" value="100" disabled />
          <input id="new-color-alpha-hex" value="FF" disabled />
          <button type="button" id="new-color-wheel-trigger" disabled>Color wheel</button>
          <div id="new-color-picker-popup" popover data-color-picker-popup><section data-color-picker-wheel></section></div>
          <button type="button" id="btn-save-new-color">Save Color</button>
        </div>
      </details>
    </form>
  `

  bindInlineColorEditor({
    getAbortSignal,
    getCsrfToken: () => 'csrf',
    isAbortError: () => false,
    onCreated: vi.fn(),
    onOpenChange,
    translate: (key) => key,
  })

  return document.getElementById('filament-form') as HTMLFormElement
}

describe('bindInlineColorEditor parent form behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shares the popup wheel without adding controls to the parent form', () => {
    const form = renderEditor()
    const popup = document.getElementById('new-color-picker-popup')!
    expect(popup.closest('form')).toBeNull()
    const hide = vi.fn()
    popup.hidePopover = hide
    const trigger = document.getElementById('new-color-wheel-trigger') as HTMLButtonElement
    const disclosure = document.getElementById('new-color-disclosure') as HTMLDetailsElement
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    expect(trigger.disabled).toBe(false)
    abortAllRequests()
    const hue = popup.querySelector<HTMLInputElement>('[data-wheel-hue]')!
    hue.value = '120'
    hue.dispatchEvent(new Event('input'))
    expect(form.querySelector<HTMLInputElement>('#new-color-hex')!.value).toBe('#00FF00')
    disclosure.open = false
    disclosure.dispatchEvent(new Event('toggle'))
    expect(hide).toHaveBeenCalled()
    expect(trigger.disabled).toBe(true)
  })

  it('enables required fields only while the disclosure is open', () => {
    const form = renderEditor()
    const disclosure = document.getElementById('new-color-disclosure') as HTMLDetailsElement
    let submitCount = 0
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitCount += 1
    })

    form.requestSubmit()
    expect(submitCount).toBe(1)

    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    expect(
      (document.getElementById('new-color-name') as HTMLInputElement).disabled
    ).toBe(false)
    form.requestSubmit()
    expect(submitCount).toBe(1)

    disclosure.open = false
    disclosure.dispatchEvent(new Event('toggle'))
    expect(
      (document.getElementById('new-color-name') as HTMLInputElement).disabled
    ).toBe(true)
    form.requestSubmit()
    expect(submitCount).toBe(2)
  })

  it('reports the required color name when saving it blank', () => {
    renderEditor()
    const disclosure = document.getElementById('new-color-disclosure') as HTMLDetailsElement
    const nameInput = document.getElementById('new-color-name') as HTMLInputElement
    let invalidCount = 0
    nameInput.addEventListener('invalid', () => invalidCount++)

    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    document.getElementById('btn-save-new-color')!.click()

    expect(invalidCount).toBe(1)
  })

  it('reports whether the add-color editor is open', () => {
    const onOpenChange = vi.fn()
    renderEditor(onOpenChange)
    const disclosure = document.getElementById('new-color-disclosure') as HTMLDetailsElement

    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    disclosure.open = false
    disclosure.dispatchEvent(new Event('toggle'))

    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })
})
