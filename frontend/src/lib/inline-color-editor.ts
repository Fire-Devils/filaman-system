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
  translate: (key: string) => string
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing inline color editor element #${id}`)
  return element as T
}

export function bindInlineColorEditor(options: InlineColorEditorOptions) {
  const form = requiredElement<HTMLDivElement>('new-color-form')
  const toggle = requiredElement<HTMLDivElement>('new-color-toggle')
  const addButton = requiredElement<HTMLButtonElement>('btn-add-new-color')
  const saveButton = requiredElement<HTMLButtonElement>('btn-save-new-color')
  const cancelButton = requiredElement<HTMLButtonElement>('btn-cancel-new-color')
  const picker = requiredElement<HTMLInputElement>('new-color-picker')
  const hexInput = requiredElement<HTMLInputElement>('new-color-hex')
  const nameInput = requiredElement<HTMLInputElement>('new-color-name')

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
    form.classList.add('hidden')
    toggle.classList.remove('hidden')
    nameInput.value = ''
    colorControls.reset()
  }

  addButton.addEventListener('click', () => {
    form.classList.remove('hidden')
    toggle.classList.add('hidden')
    colorControls.syncFromHex()
    nameInput.focus()
  })

  cancelButton.addEventListener('click', close)

  saveButton.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    const hex = normalizeHexCode(hexInput.value)
    if (!name) {
      nameInput.focus()
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
