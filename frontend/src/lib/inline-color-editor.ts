import { bindAlphaColorControls, normalizeHexCode } from './colors'

export interface CreatedColor {
  id: number
  name: string
  hex_code: string
}

interface InlineColorEditorOptions {
  getAbortSignal: () => AbortSignal
  getCsrfToken: () => string
  isAbortError: (error: unknown) => boolean
  onCreated: (color: CreatedColor) => void
  onOpenChange?: (open: boolean) => void
  translate: (key: string) => string
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing inline color editor element #${id}`)
  return element as T
}

export function bindInlineColorEditor(options: InlineColorEditorOptions) {
  const disclosure = requiredElement<HTMLDetailsElement>('new-color-disclosure')
  const form = requiredElement<HTMLDivElement>('new-color-form')
  const saveButton = requiredElement<HTMLButtonElement>('btn-save-new-color')
  const picker = requiredElement<HTMLInputElement>('new-color-picker')
  const hexInput = requiredElement<HTMLInputElement>('new-color-hex')
  const nameInput = requiredElement<HTMLInputElement>('new-color-name')
  const editorInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input'))
  let reportedOpen = disclosure.open

  const colorControls = bindAlphaColorControls({
    picker,
    hexInput,
    alphaEnabled: requiredElement<HTMLInputElement>('new-color-alpha-enabled'),
    alphaOptions: requiredElement<HTMLDivElement>('new-color-alpha-options'),
    alphaPreview: requiredElement<HTMLSpanElement>('new-color-alpha-preview'),
    alphaInput: requiredElement<HTMLInputElement>('new-color-alpha'),
    alphaValueInput: requiredElement<HTMLInputElement>('new-color-alpha-value'),
    alphaHexInput: requiredElement<HTMLInputElement>('new-color-alpha-hex'),
  })

  function close(): void {
    disclosure.open = false
    nameInput.value = ''
    colorControls.reset()
    editorInputs.forEach((input) => {
      input.disabled = true
    })
  }

  disclosure.addEventListener('toggle', () => {
    if (reportedOpen !== disclosure.open) {
      reportedOpen = disclosure.open
      options.onOpenChange?.(disclosure.open)
    }
    if (!disclosure.open) {
      close()
      return
    }
    editorInputs.forEach((input) => {
      input.disabled = false
    })
    colorControls.syncFromHex()
    nameInput.focus()
  })

  saveButton.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    const hex = normalizeHexCode(hexInput.value)
    if (!name) {
      nameInput.reportValidity()
      return
    }
    if (!hex) {
      hexInput.focus()
      return
    }

    saveButton.disabled = true
    try {
      const response = await fetch('/api/v1/colors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': options.getCsrfToken(),
        },
        credentials: 'include',
        body: JSON.stringify({ name, hex_code: hex }),
        signal: options.getAbortSignal(),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(
          error.detail?.message ||
            options.translate('filaments.failedCreateColor')
        )
      }

      options.onCreated(await response.json())
      close()
    } catch (error: unknown) {
      if (options.isAbortError(error)) return
      const message =
        error instanceof Error ? error.message : String(error)
      const dialog = (
        window as typeof window & {
          __fmAlert?: (value: string) => Promise<void>
        }
      ).__fmAlert
      if (dialog) void dialog(message)
      else window.alert(message)
    } finally {
      saveButton.disabled = false
    }
  })
}
