import { getReadableTextColor, normalizeHexCode } from './colors'

export interface SpoolMetrics {
  remaining_percent: number | null
  remaining_length_m: number | null
  effective_remaining_weight_g?: number | null
}

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function spoolRemainingWeight(spool: { remaining_weight_g?: number | null; metrics?: SpoolMetrics | null }): number | null {
  const weight = spool.metrics?.effective_remaining_weight_g === undefined ? spool.remaining_weight_g : spool.metrics.effective_remaining_weight_g
  return valid(weight) ? weight : null
}

export function formatSpoolMetrics(metrics?: SpoolMetrics | null, locale = 'en') {
  const fraction = valid(metrics?.remaining_percent) ? Math.min(100, metrics.remaining_percent) / 100 : null
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  const fill = fraction === null ? null : rgbaAt(['#E76557', '#F3CB4D', '#4CCB83'], fraction)
  const hex = fill ? `#${fill.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('')}` : ''
  return {
    fraction,
    percentText: fraction === null ? null : `${number.format(fraction * 100)}%`,
    lengthText: valid(metrics?.remaining_length_m) ? number.format(metrics.remaining_length_m) : null,
    pillStyle: hex ? `background:${hex};color:${getReadableTextColor(hex)}` : '',
  }
}

// Schematic winding geometry, not physical hub dimensions or gradient repeat prediction.
const RADIUS = 96, HUB = 43, TURNS = 14
const END = 2 * Math.PI * TURNS
const B = (RADIUS - HUB) / END
const primitive = (r: number) => (r * Math.hypot(r, B) + B * B * Math.asinh(r / B)) / (2 * B)
const TOTAL_LENGTH = primitive(RADIUS) - primitive(HUB)
const traveled = (theta: number) => primitive(RADIUS) - primitive(RADIUS - B * theta)

function rgbaAt(colors: string[], progress: number): number[] {
  const rgba = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    .concat(hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1)
  const position = Math.max(0, Math.min(1, progress)) * (colors.length - 1)
  const index = Math.min(Math.floor(position), colors.length - 1)
  const a = rgba(colors[index]), b = rgba(colors[Math.min(index + 1, colors.length - 1)])
  const t = position - index
  const alpha = a[3] * (1 - t) + b[3] * t
  return a.slice(0, 3).map((value, i) => alpha ? Math.round((value * a[3] * (1 - t) + b[i] * b[3] * t) / alpha) : 0).concat(alpha)
}

export function reelColorAt(colors: string[], progress: number): string {
  const rgba = rgbaAt(colors, progress)
  return `rgba(${rgba.slice(0, 3).join(',')},${rgba[3].toFixed(4)})`
}

function remainingStart(fraction: number): number {
  const target = TOTAL_LENGTH * (1 - Math.min(1, fraction))
  let lo = 0, hi = END
  for (let i = 0; i < 42; i++) {
    const mid = (lo + hi) / 2
    if (traveled(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function point(theta: number, offset: number): [number, number] {
  const radius = RADIUS - B * theta + offset
  return [104 + radius * Math.cos(Math.PI + theta), 104 + radius * Math.sin(Math.PI + theta)]
}

export function buildReelSegments(fraction: number, inputColors: string[], mode: 'striped' | 'gradient', colorSteps = 0) {
  const colors = inputColors.map(normalizeHexCode).filter(Boolean)
  if (!valid(fraction) || fraction === 0) return []
  if (!colors.length) colors.push('#00000000')
  const start = remainingStart(fraction)
  const count = TURNS * 64
  const width = (RADIUS - HUB) / TURNS * .76
  const result = []
  for (let i = Math.floor(start / END * count); i < count; i++) {
    const from = Math.max(start, i / count * END), to = (i + 1) / count * END
    const progress = traveled((from + to) / 2) / TOTAL_LENGTH
    const colorProgress = colorSteps > 1 ? Math.round(progress * (colorSteps - 1)) / (colorSteps - 1) : progress
    const bands = mode === 'striped' ? colors.length : 1
    for (let band = 0; band < bands; band++) {
      const offset = mode === 'striped' ? width * ((band + .5) / bands - .5) : 0
      result.push({ from, to, progress, band, a: point(from, offset), b: point(to, offset),
        width: width / bands, color: reelColorAt(mode === 'striped' ? [colors[band]] : colors, colorProgress) })
    }
  }
  return result
}

let reelSequence = 0

export function renderSpoolReel(fraction: number | null, colors: string[], mode: 'striped' | 'gradient', options: { view?: 'quarter' | 'full' } = {}): string {
  const full = options.view === 'full'
  const patternId = full ? `spool-reel-checker-${++reelSequence}` : 'spool-reel-checker'
  // At gallery size, 128 color/alpha stops avoid one SVG node per winding sample.
  const samples = buildReelSegments(valid(fraction) ? fraction : 1, colors, mode, full ? 128 : 0)
    .filter(s => full || (Math.min(s.a[0], s.b[0]) <= 105 && Math.min(s.a[1], s.b[1]) <= 105))
  const checkerboard = samples.some(s => !s.color.endsWith(',1.0000)'))
    ? `<defs><pattern id="${patternId}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#FFFFFF"/><path d="M0 0h4v4H0zM4 4h4v4H4z" fill="#D1D5DB"/></pattern></defs>` : ''
  // Gallery reels batch identical strokes to avoid thousands of SVG nodes per card.
  const groups = new Map<string, string[]>()
  const path = (geometry: string, attributes: string) => {
    if (!full) return `<path d="${geometry}" ${attributes}/>`
    const group = groups.get(attributes) ?? []
    group.push(geometry)
    groups.set(attributes, group)
    return ''
  }
  const coordinates = (point: number[]) => full ? point.map(value => Number(value.toFixed(2))).join(',') : point.join(',')
  const paths = samples.map(s => {
    const geometry = `M${coordinates(s.a)}L${coordinates(s.b)}`
    const attributes = `stroke-width="${s.width}" stroke-linecap="round"`
    const backing = s.color.endsWith(',1.0000)') ? '' : path(geometry, `${attributes} stroke="url(#${patternId})"`)
    return backing + path(geometry, `${attributes} stroke="${s.color}"`)
  }).join('')
  const highlights = samples.map(s => {
    const alpha = Number(s.color.match(/,([^,]+)\)$/)![1])
    return path(`M${coordinates(s.a)}L${coordinates(s.b)}`, `${full ? 'transform="translate(-.24,-.24)" ' : ''}stroke="white" stroke-opacity="${alpha * .4}" stroke-width="${s.width * .18}" stroke-linecap="round"`)
  }).join('')
  const groupedPaths = [...groups].map(([attributes, geometry]) => `<path d="${geometry.join('')}" ${attributes}/>`).join('')
  return `<span class="${full ? 'spool-reel-full' : 'spool-reel-corner'}" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full ? 208 : 104} ${full ? 208 : 104}" aria-hidden="true" fill="none">
    ${checkerboard}${groupedPaths}${paths}<g transform="translate(-.24,-.24)">${highlights}</g>
    <image href="/reel-flange.webp" x="0" y="0" width="208" height="208" opacity=".42"/>
  </svg></span>`
}
