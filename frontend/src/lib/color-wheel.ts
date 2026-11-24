import { normalizeHexCode } from './colors'

export const COLOR_NEUTRAL_PRESETS = {
  black: { saturationTo: 20, valueFrom: 0, valueTo: 20 },
  white: { saturationTo: 10, valueFrom: 80, valueTo: 100 },
  grey: { saturationTo: 10, valueFrom: 35, valueTo: 65 },
} as const

type NeutralContexts = [CanvasRenderingContext2D, CanvasRenderingContext2D]

function neutralContexts(size: number): NeutralContexts {
  const context = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    return canvas.getContext('2d', { willReadFrequently: true })!
  }
  return [context(), context()]
}

function paintNeutralWheel([base, tint]: NeutralContexts, cx: number, cy: number, radius: number, saturation: number) {
  const size = base.canvas.width
  base.globalAlpha = 1
  base.globalCompositeOperation = 'source-over'
  const grayscale = base.createRadialGradient(cx, cy, 0, cx, cy, radius)
  grayscale.addColorStop(0, '#000'); grayscale.addColorStop(1, '#fff')
  base.fillStyle = grayscale; base.fillRect(0, 0, size, size)
  const rainbow = tint.createConicGradient(0, cx, cy)
  ;['#f00', '#f0f', '#00f', '#0ff', '#0f0', '#ff0', '#f00'].forEach((color, index) => rainbow.addColorStop(index / 6, color))
  tint.fillStyle = rainbow; tint.fillRect(0, 0, size, size)
  const center = tint.createRadialGradient(cx, cy, 0, cx, cy, radius * .78)
  center.addColorStop(0, '#fff'); center.addColorStop(1, 'rgb(255 255 255 / 0%)')
  tint.fillStyle = center; tint.fillRect(0, 0, size, size)
  base.globalCompositeOperation = 'color'
  base.globalAlpha = saturation / 100
  base.drawImage(tint.canvas, 0, 0)
}

/** Sample the same pixels displayed by the neutral picker. */
export function sampleNeutralWheelColor(x: number, y: number, mode: keyof typeof COLOR_NEUTRAL_PRESETS, diameter: number): string {
  const { pixels, size } = neutralWheelPalette(mode, diameter)
  const px = Math.max(0, Math.min(size - 1, Math.floor((x + 1) * size / 2)))
  const py = Math.max(0, Math.min(size - 1, Math.floor((1 - y) * size / 2)))
  const offset = (py * size + px) * 4
  return '#' + [...pixels.slice(offset, offset + 3)].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()
}

const neutralPalettes = new Map<string, { background: string; pixels: Uint8ClampedArray; size: number }>()

/** Spread each neutral brightness band across the full shared wheel palette. */
export function neutralWheelPalette(mode: keyof typeof COLOR_NEUTRAL_PRESETS, diameter: number) {
  const size = Math.round(diameter), key = `${mode}:${size}`
  const cached = neutralPalettes.get(key)
  if (cached) return cached
  const range = COLOR_NEUTRAL_PRESETS[mode], contexts = neutralContexts(size)
  const [base] = contexts
  paintNeutralWheel(contexts, size / 2, size / 2, size / 2, range.saturationTo)
  const image = base.getImageData(0, 0, size, size), pixels = image.data
  const min = Math.ceil(range.valueFrom * 255 / 100), max = Math.floor(range.valueTo * 255 / 100)
  for (let i = 0; i < pixels.length; i += 4) {
    const value = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
    const brightness = Math.round(min + (max - min) * value / 255)
    for (let channel = i; channel < i + 3; channel++) {
      const tint = value ? Math.min((value - pixels[channel]) / value, range.saturationTo / 100) : 0
      pixels[channel] = Math.max(Math.ceil(brightness * (100 - range.saturationTo) / 100), Math.round(brightness * (1 - tint)))
    }
  }
  base.putImageData(image, 0, 0)
  const palette = { pixels, size, background: `url("${base.canvas.toDataURL()}")` }
  neutralPalettes.set(key, palette)
  return palette
}

export type ColorWheelSample = NonNullable<ReturnType<typeof parseColorSample>>
export type ColorWheelPoint = ColorWheelSample & { x: number; y: number }

export function colorWheelPoint(sample: ColorWheelSample): ColorWheelPoint {
  const angle = sample.hue * Math.PI / 180
  return { ...sample, x: 50 + Math.cos(angle) * sample.saturation / 2, y: 50 - Math.sin(angle) * sample.saturation / 2 }
}

export const COLOR_HARMONY_OFFSETS = {
  single: [0],
  complementary: [0, 180],
  triadic: [0, 120, 240],
  analogous: [0, 30, 330],
  'split-complementary': [0, 150, 210],
} as const

export function parseColorSample(raw: string) {
  const hex = normalizeHexCode(raw)
  if (!hex) return null
  return { hex, ...hexToHsv(hex), transparent: hex.length === 9 && hex.slice(-2) !== 'FF' }
}

function hexToHsv(hex: string): { hue: number; saturation: number; value: number } {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  return {
    hue,
    saturation: max === 0 ? 0 : delta / max * 100,
    value: max * 100,
  }
}

export function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360
  return Math.min(delta, 360 - delta)
}

export function createColorWheel(id: string, windowCount: number) {
  const wheel = document.createElement('div')
  wheel.className = 'fm-header-color-wheel'
  const surface = document.createElement('span')
  surface.className = 'fm-header-color-wheel-surface'
  surface.setAttribute('aria-hidden', 'true')
  wheel.appendChild(surface)
  for (let group = 0; group < windowCount; group++) {
    const selection = document.createElement('span')
    selection.className = 'fm-header-color-wheel-selection'
    selection.dataset.colorWindow = String(group)
    selection.setAttribute('aria-hidden', 'true')
    wheel.appendChild(selection)
  }
  const wheelWrap = document.createElement('div')
  wheelWrap.className = 'fm-header-color-wheel-wrap'
  wheelWrap.appendChild(wheel)
  const markers = document.createElementNS(SVG, 'svg')
  markers.classList.add('fm-header-color-markers')
  markers.setAttribute('viewBox', '0 0 100 100')
  markers.setAttribute('aria-hidden', 'true')
  // Match the wheel's 4px crosshatch pitch in this 100-unit / 180px viewBox.
  const hatchPitch = 4 * Math.SQRT2 / 1.8
  const alphaCell = 4 / 1.8
  markers.innerHTML = `
    <defs>
      <pattern id="${id}-marker-hatch" width="${hatchPitch}" height="${hatchPitch}" patternUnits="userSpaceOnUse">
        <path d="M0 0L${hatchPitch} ${hatchPitch}" stroke="white" stroke-opacity="0.13" stroke-width="${1 / 1.8}"/>
        <path d="M0 ${hatchPitch}L${hatchPitch} 0" stroke="black" stroke-opacity="0.09" stroke-width="${1 / 1.8}"/>
      </pattern>
      <pattern id="${id}-marker-alpha" width="${2 * alphaCell}" height="${2 * alphaCell}" patternUnits="userSpaceOnUse">
        <rect width="100%" height="100%" fill="#FFFFFF"/>
        <rect x="${alphaCell}" width="${alphaCell}" height="${alphaCell}" fill="#D1D5DB"/>
        <rect y="${alphaCell}" width="${alphaCell}" height="${alphaCell}" fill="#D1D5DB"/>
      </pattern>
    </defs>
    <g data-color-marker-layer="excluded"></g><g data-color-marker-layer="matching"></g>`
  wheelWrap.appendChild(markers)
  markerStates.set(markers, { id })
  return { wheel, wheelWrap, markers }
}

const SVG = 'http://www.w3.org/2000/svg'
const markerStates = new WeakMap<SVGSVGElement, {
  id: string
  samples?: ReadonlyMap<string, ColorWheelPoint>
  markers?: SVGCircleElement[]
  neutral?: boolean
}>()

export function syncColorWheelMarkers(
  layer: SVGSVGElement,
  samples: ReadonlyMap<string, ColorWheelPoint>,
  matchGroup: (hex: string) => number | undefined,
  { active, neutral = false, neutralSaturation = 100, tone, referenceHex, referenceRing }: {
    active: boolean; neutral?: boolean; neutralSaturation?: number; tone?: string; referenceHex?: string; referenceRing?: boolean
  },
) {
  const excluded = layer.querySelector<SVGGElement>('[data-color-marker-layer="excluded"]')!
  const matching = layer.querySelector<SVGGElement>('[data-color-marker-layer="matching"]')!
  const cache = markerStates.get(layer)!
  if (cache.samples !== samples || !cache.markers) {
    cache.samples = samples
    cache.neutral = undefined
    cache.markers = [...samples.values()].map(sample => {
      const circle = document.createElementNS(SVG, 'circle')
      circle.dataset.colorMarker = sample.hex
      circle.setAttribute('fill', sample.hex)
      circle.setAttribute('r', '2.6')
      const hatch = document.createElementNS(SVG, 'circle')
      hatch.classList.add('fm-header-color-marker-hatch')
      hatch.setAttribute('r', '2.6')
      hatch.setAttribute('fill', `url(#${cache.id}-marker-hatch)`)
      const group = document.createElementNS(SVG, 'g')
      // Keep excluded hatches from bleeding through matching alpha samples.
      if (sample.transparent) {
        const backing = document.createElementNS(SVG, 'circle')
        backing.classList.add('fm-header-color-marker-backing')
        backing.setAttribute('r', '2.6')
        backing.setAttribute('fill', `url(#${cache.id}-marker-alpha)`)
        group.appendChild(backing)
      }
      group.append(circle, hatch)
      return circle
    })
    excluded.replaceChildren()
    matching.replaceChildren(...cache.markers.map(circle => circle.parentElement!))
  }
  let referenceGroup: Element | undefined
  for (const circle of cache.markers) {
    const sample = samples.get(circle.dataset.colorMarker!)!
    if (cache.neutral !== neutral) {
      const x = String(neutral ? 50 + sample.value / 2 : sample.x)
      const y = String(neutral ? 50 : sample.y)
      for (const node of circle.parentElement!.children) {
        node.setAttribute('cx', x)
        node.setAttribute('cy', y)
      }
    }
    const display = neutral && sample.saturation > neutralSaturation ? 'none' : ''
    if (circle.style.display !== display) circle.style.display = display
    const groupIndex = matchGroup(sample.hex)
    const reference = sample.hex === referenceHex
    const matches = !active || groupIndex !== undefined || reference
    if (referenceHex !== undefined) {
      circle.classList.toggle('is-reference', reference)
      circle.classList.toggle('is-reference-ring', reference && !!referenceRing)
    }
    circle.classList.toggle('is-matching', active && groupIndex !== undefined)
    if (active && groupIndex !== undefined && groupIndex > 0 && tone) circle.dataset.colorHarmonyTone = tone
    else delete circle.dataset.colorHarmonyTone
    const hatch = circle.nextElementSibling as SVGCircleElement
    const hatchDisplay = matches || display === 'none' ? 'none' : ''
    if (hatch.style.display !== hatchDisplay) hatch.style.display = hatchDisplay
    const backing = circle.previousElementSibling as SVGCircleElement | null
    if (backing) {
      const backingDisplay = matches && display !== 'none' && !(reference && referenceRing) ? '' : 'none'
      if (backing.style.display !== backingDisplay) backing.style.display = backingDisplay
    }
    const destination = matches ? matching : excluded
    const group = circle.parentElement!
    if (reference) referenceGroup = group
    else if (group.parentNode !== destination) destination.appendChild(group)
  }
  if (referenceGroup && matching.lastElementChild !== referenceGroup) matching.appendChild(referenceGroup)
  cache.neutral = neutral
}

export function colorWheelHueMask(hueTo: number, span: number, offsets: readonly number[]): string {
  if (span === 360) return 'conic-gradient(transparent, transparent)'
  const intervals: [number, number][] = []
  for (const offset of offsets) {
    const start = ((90 - hueTo - offset) % 360 + 360) % 360
    intervals.push([start, Math.min(360, start + span)])
    if (start + span > 360) intervals.push([0, start + span - 360])
  }
  intervals.sort((a, b) => a[0] - b[0])
  const stops: string[] = []
  let end = 0
  for (const [from, to] of intervals) {
    if (from > end) stops.push(`#000 ${end}deg ${from}deg`)
    if (to > end) stops.push(`transparent ${Math.max(end, from)}deg ${to}deg`)
    end = Math.max(end, to)
  }
  if (end < 360) stops.push(`#000 ${end}deg 360deg`)
  return `conic-gradient(${stops.join(', ')})`
}
