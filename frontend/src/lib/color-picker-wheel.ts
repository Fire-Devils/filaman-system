import { COLOR_NEUTRAL_PRESETS, neutralWheelPalette, sampleNeutralWheelColor, type ColorWheelSample, colorWheelPoint, createColorWheel, parseColorSample, syncColorWheelMarkers } from './color-wheel'
import { normalizeHexCode, toColorSwatchBackground } from './colors'
import { t } from './i18n'

export function hsvHex(hue: number, saturation: number, value: number): string {
  const chroma = value / 100 * saturation / 100
  const h = ((hue % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs(h % 2 - 1))
  const channels = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x]
    : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x]
  return '#' + channels.map(channel => Math.round((channel + value / 100 - chroma) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

export function bindColorPickerWheel(details: HTMLElement, hex: HTMLInputElement, signal: AbortSignal | undefined, onSync?: () => void) {
  const { wheel, wheelWrap, markers } = createColorWheel(`${hex.id}-picker-wheel`, 0)
  let sample = parseColorSample(hex.value)!
  function initialNeutral(color: ColorWheelSample): keyof typeof COLOR_NEUTRAL_PRESETS | null {
    if (color.saturation > 0 && color.value > 0) return null
    for (const mode of ['black', 'grey', 'white'] as const) {
      const range = COLOR_NEUTRAL_PRESETS[mode]
      if (color.value >= range.valueFrom && color.value <= range.valueTo) return mode
    }
    return null
  }
  let neutralMode = initialNeutral(sample)
  let choosing = false
  let neutralPoint: { rgb: string; x: number; y: number } | undefined
  let lastColor = sample.saturation > 0 && sample.value > 0 ? sample.hex.slice(0, 7) : '#FF0000'
  const body = document.createElement('div')
  body.className = 'fm-picker-wheel-body'
  const sliders = document.createElement('div')
  sliders.className = 'fm-picker-wheel-sliders'
  const controls = (['hue', 'saturation', 'brightness'] as const).map((key, index) => {
    const label = document.createElement('label')
    label.textContent = t(`colors.cleanup.${key}`)
    const input = document.createElement('input')
    input.type = 'range'; input.min = '0'; input.max = index === 0 ? '360' : '100'; input.step = 'any'
    input.setAttribute(`data-wheel-${key}`, '')
    if (key === 'brightness') {
      const track = document.createElement('span')
      track.className = 'fm-header-color-dual-range fm-picker-brightness-range'
      track.appendChild(input); label.appendChild(track)
    } else label.appendChild(input)
    sliders.appendChild(label)
    return input
  })
  const [hue, saturation, brightness] = controls
  const brightnessTrack = brightness.parentElement!
  const brightnessCaption = sliders.children[2].firstChild!
  let editingHex = false
  const selected = document.createElement('label')
  selected.className = 'fm-picker-selected-color'
  const selectedSwatch = document.createElement('span')
  selectedSwatch.className = 'filament-color-dot'
  selectedSwatch.setAttribute('aria-hidden', 'true')
  const selectedHex = document.createElement('input')
  selectedHex.type = 'text'
  selectedHex.className = 'fm-input'
  selectedHex.spellcheck = false
  selectedHex.setAttribute('autocomplete', 'off')
  selectedHex.setAttribute('aria-label', t('colors.cleanup.selectedColor'))
  selectedHex.setAttribute('data-wheel-hex', '')
  selectedHex.addEventListener('input', event => {
    event.stopPropagation()
    const normalized = normalizeHexCode(selectedHex.value)
    selectedHex.setAttribute('aria-invalid', String(!normalized))
    editingHex = true
    try {
      hex.value = normalized || selectedHex.value
      hex.dispatchEvent(new Event('input', { bubbles: true }))
    } finally { editingHex = false }
  }, { signal })
  selectedHex.addEventListener('blur', () => {
    const normalized = normalizeHexCode(selectedHex.value)
    if (normalized) selectedHex.value = normalized
  }, { signal })
  selectedHex.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const normalized = normalizeHexCode(selectedHex.value)
      if (normalized) selectedHex.value = normalized
    }
  }, { signal })
  selected.append(`${t('colors.cleanup.selectedColor')}: `, selectedSwatch, selectedHex)
  const neutrals = document.createElement('div')
  neutrals.className = 'fm-header-color-neutrals'
  const colorMode = document.createElement('button')
  colorMode.type = 'button'
  colorMode.className = 'fm-header-color-default'
  colorMode.setAttribute('data-wheel-color', '')
  const colorIcon = document.createElement('span')
  colorIcon.className = 'fm-color-library-icon'
  colorIcon.setAttribute('aria-hidden', 'true')
  colorMode.append(colorIcon, t('filaments.color'))
  colorMode.addEventListener('click', () => { neutralMode = null; choose(lastColor) }, { signal })
  neutrals.appendChild(colorMode)
  for (const [neutral, value] of [['black', '#000000'], ['grey', '#808080'], ['white', '#FFFFFF']] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.colorNeutral = neutral
    button.value = value
    const dot = document.createElement('span')
    dot.className = `fm-header-color-neutral-swatch ${neutral}`
    dot.setAttribute('aria-hidden', 'true')
    button.append(dot, t(`filters.soft${neutral.charAt(0).toUpperCase()}${neutral.slice(1)}`))
    button.addEventListener('click', () => { neutralMode = neutral; sample.saturation = 0; choose(value) }, { signal })
    neutrals.appendChild(button)
  }

  const preview = document.createElement('p')
  preview.className = 'fm-picker-complement-row'
  const swatch = document.createElement('span')
  swatch.className = 'filament-color-dot'
  swatch.setAttribute('aria-hidden', 'true')
  const complement = document.createElement('code')
  complement.setAttribute('data-wheel-complement', '')
  const selectComplement = document.createElement('button')
  selectComplement.type = 'button'
  selectComplement.className = 'fm-picker-complement'
  selectComplement.setAttribute('data-select-complement', '')
  selectComplement.append(swatch, complement)
  selectComplement.addEventListener('click', () => choose(complement.textContent!.slice(0, 7)), { signal })
  preview.append(`${t('colors.cleanup.complement')}: `, selectComplement)
  const adjustments = document.createElement('details')
  adjustments.className = 'fm-picker-adjustments'
  adjustments.open = !matchMedia('(max-width: 480px), (pointer: coarse)').matches
  const summary = document.createElement('summary')
  const band = document.createElement('span')
  summary.append(t('colors.cleanup.adjustments'), band)
  adjustments.append(summary, sliders)
  body.append(wheelWrap, preview, adjustments); details.append(selected, neutrals, body)
  // Safari must keep a wheel drag separate from the popup's scrolling gesture.
  wheelWrap.addEventListener('touchmove', event => event.preventDefault(), { passive: false, signal })

  function choose(value: string, position?: { x: number; y: number }) {
    neutralPoint = position ? { rgb: value, ...position } : undefined
    const normalized = normalizeHexCode(hex.value) || sample.hex
    hex.value = value + (normalized.length === 9 ? normalized.slice(7) : '')
    choosing = true
    try { hex.dispatchEvent(new Event('input', { bubbles: true })) } finally { choosing = false }
  }

  function sync(event?: Event) {
    const next = parseColorSample(hex.value)
    if (!next) {
      if (!editingHex) selectedHex.value = hex.value
      selectedHex.setAttribute('aria-invalid', 'true')
      return
    }
    const chromatic = next.saturation > 0 && next.value > 0
    if (!choosing && (event?.target === hex || event?.target instanceof HTMLInputElement && event.target.type === 'color')) {
      neutralPoint = undefined
      neutralMode = initialNeutral(next)
    }
    const neutral = neutralMode !== null
    const neutralSaturation = neutralMode ? COLOR_NEUTRAL_PRESETS[neutralMode].saturationTo : 0
    const range = neutralMode ? COLOR_NEUTRAL_PRESETS[neutralMode] : { valueFrom: 0, valueTo: 100 }
    brightnessTrack.style.setProperty('--color-range-low', `${range.valueFrom}%`)
    brightnessTrack.style.setProperty('--color-range-high', `${range.valueTo}%`)
    brightness.setAttribute('aria-valuemin', String(range.valueFrom))
    brightness.setAttribute('aria-valuemax', String(range.valueTo))
    brightnessCaption.textContent = t('colors.cleanup.brightness') + (neutral ? ` (${range.valueFrom}–${range.valueTo}%)` : '')
    band.textContent = neutral ? ` · ${brightnessCaption.textContent}` : ''
    if (neutralMode) {
      const size = parseFloat(getComputedStyle(wheel).width) || 180
      const border = parseFloat(getComputedStyle(wheel).borderLeftWidth) || 0
      const palette = neutralWheelPalette(neutralMode, size - border * 2)
      wheel.style.setProperty('--picker-neutral-palette', palette.background)
    }
    wheel.classList.toggle('is-neutral', neutral)
    if (neutralMode) wheel.dataset.neutralMode = neutralMode
    else delete wheel.dataset.neutralMode
    if (chromatic && !neutral) lastColor = next.hex.slice(0, 7)
    colorMode.classList.toggle('active', !neutral)
    colorMode.setAttribute('aria-pressed', String(!neutral))
    if (next.value === 0) next.saturation = sample.saturation
    if (next.saturation === 0 || next.value === 0) next.hue = sample.hue
    sample = next
    if (!editingHex) {
      selectedHex.value = sample.hex
      selectedHex.setAttribute('aria-invalid', 'false')
    }
    selectedSwatch.style.background = toColorSwatchBackground(sample.hex)
    neutrals.querySelectorAll<HTMLButtonElement>('[data-color-neutral]').forEach(button => {
      const active = neutral && wheel.dataset.neutralMode === button.dataset.colorNeutral
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', String(active))
    })
    hue.value = String(sample.hue); saturation.value = String(sample.saturation); brightness.value = String(sample.value)
    const alpha = sample.hex.length === 9 ? sample.hex.slice(7) : ''
    const opposite = hsvHex(sample.hue + 180, sample.saturation, sample.value) + alpha
    complement.textContent = opposite
    selectComplement.setAttribute('aria-label', `${t('colors.cleanup.complement')}: ${opposite}`)
    swatch.style.background = toColorSwatchBackground(opposite)
    wheel.style.setProperty('--color-neutral-saturation', String(neutralSaturation / 100))
    wheel.style.setProperty('--color-wheel-darkness', String(1 - sample.value / 100))
    const points = [sample, parseColorSample(opposite)!].map(point => colorWheelPoint(point))
    syncColorWheelMarkers(markers, new Map(points.map(point => [point.hex, point])), () => 0, { active: true, neutral, neutralSaturation: 100, referenceHex: sample.hex, referenceRing: true })
    if (neutral) {
      markers.querySelectorAll<SVGCircleElement>('[data-color-marker]').forEach(marker => {
        const selected = marker.dataset.colorMarker === sample.hex && neutralPoint?.rgb === sample.hex.slice(0, 7)
        marker.parentElement!.style.display = selected ? '' : 'none'
        if (selected && neutralPoint) for (const node of marker.parentElement!.children) {
          node.setAttribute('cx', String(neutralPoint.x))
          node.setAttribute('cy', String(neutralPoint.y))
        }
      })
    }

    onSync?.()
  }

  function apply(event: Event) {
    if (event.target !== brightness && Number(saturation.value) > 0 && Number(brightness.value) > 0) neutralMode = null
    if (neutralMode) {
      const range = COLOR_NEUTRAL_PRESETS[neutralMode]
      const channel = Math.max(Math.ceil(range.valueFrom * 255 / 100), Math.min(Math.floor(range.valueTo * 255 / 100), Math.round(Number(brightness.value) * 255 / 100)))
      brightness.value = String(channel / 255 * 100)
    }
    sample = { ...sample, hue: Number(hue.value), saturation: Number(saturation.value), value: Number(brightness.value) }
    choose(hsvHex(sample.hue, sample.saturation, sample.value))
  }
  controls.forEach(input => input.addEventListener('input', apply, { signal }))
  // The sliders provide keyboard access to the same two-dimensional selection.
  function point(event: PointerEvent) {
    const bounds = wheel.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const border = parseFloat(getComputedStyle(wheel).borderLeftWidth) || 0
    const diameter = bounds.width - border * 2
    const x = (event.clientX - bounds.left - border) / diameter * 2 - 1
    const y = 1 - (event.clientY - bounds.top - border) / diameter * 2
    if (neutralMode) {
      const limit = Math.max(1, Math.hypot(x, y))
      const range = COLOR_NEUTRAL_PRESETS[neutralMode]
      const color = sampleNeutralWheelColor(x, y, neutralMode, diameter)
      const value = parseColorSample(color)!.value
      if (value < range.valueFrom || value > range.valueTo) return
      choose(color, {
        x: 50 + x / limit * diameter / bounds.width * 50,
        y: 50 - y / limit * diameter / bounds.height * 50,
      })
      return
    } else {
      hue.value = String((Math.atan2(y, x) * 180 / Math.PI + 360) % 360)
      saturation.value = String(Math.min(100, Math.hypot(x, y) * 100))
    }
    apply(event)
  }
  let dragging = false
  wheel.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault(); dragging = true; wheel.setPointerCapture?.(event.pointerId); point(event)
  }, { signal })
  wheel.addEventListener('pointermove', event => { if (dragging) point(event) }, { signal })
  wheel.addEventListener('pointerup', event => { if (dragging) point(event); dragging = false }, { signal })
  wheel.addEventListener('pointercancel', () => { dragging = false }, { signal })
  details.addEventListener('toggle', sync, { signal })
  const form = hex.closest('form')!
  form.addEventListener('input', sync, { signal })
  form.addEventListener('change', sync, { signal })
  sync()
  const snapshot = () => ({ hex: hex.value, sample: { ...sample }, neutralMode, lastColor, neutralPoint })
  return { sync, snapshot, restore(state: ReturnType<typeof snapshot>) {
    sample = { ...state.sample }
    neutralMode = state.neutralMode
    lastColor = state.lastColor
    neutralPoint = state.neutralPoint
    choosing = true
    try {
      hex.value = sample.hex
      hex.dispatchEvent(new Event('input', { bubbles: true }))
      if (state.hex !== hex.value) {
        hex.value = state.hex
        hex.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } finally { choosing = false }
  }, reset() {
    sample = parseColorSample(hex.value)!
    neutralMode = initialNeutral(sample)
    neutralPoint = undefined
    lastColor = sample.saturation > 0 && sample.value > 0 ? sample.hex.slice(0, 7) : '#FF0000'
    sync()
  } }
}


/** Add the shared wheel without changing the original native color input. */
export function bindColorPickerPopup(popup: HTMLElement, hex: HTMLInputElement, signal: AbortSignal | undefined, onSync?: () => void) {
  const form = hex.closest('form')!
  // Keep the popup inside its modal's interactive subtree, outside the color form when possible.
  const dialog = hex.closest('dialog')
  ;(dialog || form.parentElement)!.appendChild(popup)
  const wheel = bindColorPickerWheel(popup.querySelector<HTMLElement>('[data-color-picker-wheel]')!, hex, signal, onSync)
  function syncViewport() {
    const viewport = window.visualViewport
    if (!viewport) return
    for (const [key, value] of Object.entries({ width: viewport.width, height: viewport.height, left: viewport.offsetLeft, top: viewport.offsetTop })) {
      popup.style.setProperty(`--picker-viewport-${key}`, `${value}px`)
    }
  }
  window.visualViewport?.addEventListener('resize', syncViewport, { signal })
  window.visualViewport?.addEventListener('scroll', syncViewport, { signal })
  let openingState: ReturnType<typeof wheel.snapshot> | undefined
  popup.querySelector('[data-wheel-cancel]')?.addEventListener('click', () => {
    if (openingState) wheel.restore(openingState)
    popup.hidePopover?.()
  }, { signal })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !popup.matches(':popover-open')) return
    event.preventDefault()
    event.stopPropagation()
    popup.hidePopover?.()
  }, { signal, capture: true })
  form.addEventListener('submit', () => popup.hidePopover?.(), { signal, capture: true })
  popup.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState === 'open') {
      syncViewport()
      wheel.sync()
      openingState = wheel.snapshot()
    }
  }, { signal })
  popup.addEventListener('toggle', event => {
    wheel.sync()
    if ((event as ToggleEvent).newState === 'open') {
      const target = matchMedia('(max-width: 480px), (pointer: coarse)').matches ? '[data-wheel-close]' : 'input:not(:disabled)'
      popup.querySelector<HTMLElement>(target)?.focus({ preventScroll: true })
    }
  }, { signal })
  dialog?.addEventListener('close', () => popup.hidePopover?.(), { signal })
  signal?.addEventListener('abort', () => popup.hidePopover?.(), { once: true })
  return { sync: wheel.sync, close() { popup.hidePopover?.() }, reset() { popup.hidePopover?.(); wheel.reset() } }
}
