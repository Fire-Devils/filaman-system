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

export function toOpaqueRgbHex(value?: string | null, fallback = '#000000'): string {
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

export function composeHexWithAlpha(value?: string | null, alphaPercent = 100): string {
  const rgb = toOpaqueRgbHex(value, '#000000').replace('#', '').toUpperCase()
  const percent = Math.max(0, Math.min(100, Number(alphaPercent) || 0))

  if (percent >= 100) return `#${rgb}`

  const alpha = Math.round((percent / 100) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()

  return `#${rgb}${alpha}`
}

export function toCssColor(value?: string | null, fallback = 'transparent'): string {
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

export interface AlphaColorControls {
  picker: HTMLInputElement
  hexInput: HTMLInputElement
  alphaInput: HTMLInputElement
  alphaValue: HTMLElement
}

export function bindAlphaColorControls(controls: AlphaColorControls) {
  const { picker, hexInput, alphaInput, alphaValue } = controls

  function syncFromHex(value = hexInput.value): boolean {
    const normalized = normalizeHexCode(value)
    if (!normalized) return false

    hexInput.value = normalized
    picker.value = toOpaqueRgbHex(normalized)
    const alpha = getAlphaPercent(normalized)
    alphaInput.value = String(alpha)
    alphaValue.textContent = `${alpha}%`
    return true
  }

  function syncFromPicker(): void {
    const alpha = Number(alphaInput.value)
    alphaValue.textContent = `${alpha}%`
    hexInput.value = composeHexWithAlpha(picker.value, alpha)
  }

  function reset(value = '#FF0000'): void {
    hexInput.value = value
    syncFromHex(value)
  }

  picker.addEventListener('input', syncFromPicker)
  alphaInput.addEventListener('input', syncFromPicker)
  hexInput.addEventListener('input', () => syncFromHex())

  return { reset, syncFromHex, syncFromPicker }
}
