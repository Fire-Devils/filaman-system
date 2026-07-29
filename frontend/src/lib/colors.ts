export function normalizeHexCode(value?: string | null): string {
  if (!value) return ''

  let raw = String(value).trim().replace(/^#/, '')
  if (!raw) return ''

  if (raw.length === 3 || raw.length === 4) {
    raw = raw
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }

  if (!/^[0-9a-fA-F]+$/.test(raw) || (raw.length !== 6 && raw.length !== 8)) {
    return ''
  }

  return `#${raw.toUpperCase()}`
}

export function toOpaqueRgbHex(
  value?: string | null,
  fallback = '#000000'
): string {
  const normalized = normalizeHexCode(value)
  if (!normalized.startsWith('#')) return fallback

  const raw = normalized.slice(1)
  return raw.length === 8 ? `#${raw.slice(0, 6)}` : normalized
}

export function getAlphaPercent(value?: string | null): number {
  const normalized = normalizeHexCode(value)
  if (!normalized.startsWith('#')) return 100

  const raw = normalized.slice(1)
  if (raw.length !== 8) return 100

  return Math.round((parseInt(raw.slice(6, 8), 16) / 255) * 100)
}

export function alphaPercentToHex(alphaPercent = 100): string {
  const percent = Math.max(0, Math.min(100, Number(alphaPercent) || 0))
  return Math.round((percent / 100) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

export function composeHexWithAlphaByte(
  value?: string | null,
  alphaHex = 'FF',
  includeAlpha = true
): string {
  const rgb = toOpaqueRgbHex(value, '#000000').replace('#', '').toUpperCase()
  const normalizedAlpha = /^[0-9a-fA-F]{2}$/.test(alphaHex)
    ? alphaHex.toUpperCase()
    : 'FF'
  return includeAlpha ? `#${rgb}${normalizedAlpha}` : `#${rgb}`
}

export function composeHexWithAlpha(
  value?: string | null,
  alphaPercent = 100,
  includeAlpha = alphaPercent < 100
): string {
  return composeHexWithAlphaByte(
    value,
    alphaPercentToHex(alphaPercent),
    includeAlpha
  )
}

export function toCssColor(
  value?: string | null,
  fallback = 'transparent'
): string {
  const normalized = normalizeHexCode(value)
  if (!normalized.startsWith('#')) return fallback

  const raw = normalized.slice(1)
  if (raw.length === 6) return normalized

  const red = parseInt(raw.slice(0, 2), 16)
  const green = parseInt(raw.slice(2, 4), 16)
  const blue = parseInt(raw.slice(4, 6), 16)
  const alpha = Number((parseInt(raw.slice(6, 8), 16) / 255).toFixed(3))

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

export function toColorSwatchBackground(
  value?: string | null,
  fallback = 'transparent'
): string {
  const color = toCssColor(value, fallback)
  return [
    `linear-gradient(${color}, ${color})`,
    'conic-gradient(#D1D5DB 25%, #FFFFFF 0 50%, #D1D5DB 0 75%, #FFFFFF 0) 0 / 8px 8px',
  ].join(', ')
}

export interface AlphaColorControls {
  picker: HTMLInputElement
  hexInput: HTMLInputElement
  alphaEnabled: HTMLInputElement
  alphaOptions: HTMLElement
  alphaPreview: HTMLElement
  alphaInput: HTMLInputElement
  alphaValueInput: HTMLInputElement
  alphaHexInput: HTMLInputElement
}

export function bindAlphaColorControls(controls: AlphaColorControls) {
  const {
    picker,
    hexInput,
    alphaEnabled,
    alphaOptions,
    alphaPreview,
    alphaInput,
    alphaValueInput,
    alphaHexInput,
  } = controls

  function setAlphaPercent(value: number): number {
    const percent = Math.max(0, Math.min(100, Math.round(value)))
    alphaInput.value = String(percent)
    alphaValueInput.value = String(percent)
    alphaHexInput.value = alphaPercentToHex(percent)
    return percent
  }

  function setAlphaHex(value: string): boolean {
    const alphaHex = value.trim().toUpperCase()
    if (!/^[0-9A-F]{2}$/.test(alphaHex)) return false

    alphaHexInput.value = alphaHex
    const percent = Math.round((parseInt(alphaHex, 16) / 255) * 100)
    alphaInput.value = String(percent)
    alphaValueInput.value = String(percent)
    return true
  }

  function setAlphaEnabled(enabled: boolean): void {
    alphaEnabled.checked = enabled
    alphaOptions.classList.toggle('hidden', !enabled)
  }

  function syncFromHex(value = hexInput.value): boolean {
    const normalized = normalizeHexCode(value)
    if (!normalized) return false

    hexInput.value = normalized
    picker.value = toOpaqueRgbHex(normalized)
    setAlphaEnabled(normalized.length === 9)
    if (normalized.length === 9) {
      setAlphaHex(normalized.slice(7, 9))
    } else {
      setAlphaPercent(100)
    }
    alphaPreview.style.background = toColorSwatchBackground(normalized)
    return true
  }

  function syncFromPicker(): void {
    if (!setAlphaHex(alphaHexInput.value))
      setAlphaPercent(Number(alphaInput.value))
    hexInput.value = composeHexWithAlphaByte(
      picker.value,
      alphaHexInput.value,
      alphaEnabled.checked
    )
    alphaPreview.style.background = toColorSwatchBackground(hexInput.value)
  }

  function syncFromAlphaSlider(): void {
    setAlphaPercent(Number(alphaInput.value))
    syncFromPicker()
  }

  function syncFromAlphaValue(): void {
    if (alphaValueInput.value.trim() === '') return

    setAlphaPercent(Number(alphaValueInput.value))
    syncFromPicker()
  }

  function normalizeAlphaValue(): void {
    if (alphaValueInput.value.trim() !== '') {
      syncFromAlphaValue()
      return
    }

    setAlphaHex(alphaHexInput.value)
    syncFromPicker()
  }

  function syncFromAlphaHex(): boolean {
    if (!setAlphaHex(alphaHexInput.value)) return false
    syncFromPicker()
    return true
  }

  function normalizeAlphaHex(): void {
    if (syncFromAlphaHex()) return

    const normalizedHex = normalizeHexCode(hexInput.value)
    const fallback =
      normalizedHex.length === 9
        ? normalizedHex.slice(7, 9)
        : alphaPercentToHex(Number(alphaInput.value))
    setAlphaHex(fallback)
    syncFromPicker()
  }

  function syncFromAlphaEnabled(): void {
    setAlphaEnabled(alphaEnabled.checked)
    syncFromPicker()
  }

  function reset(value = '#FF0000'): void {
    hexInput.value = value
    syncFromHex(value)
  }

  picker.addEventListener('input', syncFromPicker)
  alphaInput.addEventListener('input', syncFromAlphaSlider)
  alphaValueInput.addEventListener('input', syncFromAlphaValue)
  alphaValueInput.addEventListener('change', normalizeAlphaValue)
  alphaHexInput.addEventListener('input', syncFromAlphaHex)
  alphaHexInput.addEventListener('change', normalizeAlphaHex)
  alphaEnabled.addEventListener('change', syncFromAlphaEnabled)
  hexInput.addEventListener('input', () => syncFromHex())

  return {
    reset,
    syncFromHex,
    syncFromPicker,
    syncFromAlphaEnabled,
    syncFromAlphaValue,
    syncFromAlphaHex,
  }
}
