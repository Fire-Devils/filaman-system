// Small hand-drawn SVG charts for the dashboard (no chart library).
// Colors come from theme variables so light and dark themes both work.
import { escapeHtml } from './extra-fields'

export interface ChartPoint {
  /** Short axis label, e.g. "Mar". */
  label: string
  /** null = nothing recorded for this point: a gap, no mark. */
  value: number | null
  /** Exact value text for the tooltip. */
  tip: string
}

export interface ChartOptions {
  kind: 'columns' | 'area'
  width: number
  color: string
  formatAxis: (value: number) => string
  /** Only whole-number ticks (counts). */
  integer?: boolean
  ariaLabel: string
  height?: number
}

/** Round axis maximum and evenly spaced ticks from 0 to it. */
export function niceScale(max: number, integer = false): { top: number; ticks: number[] } {
  const safe = Number.isFinite(max) && max > 0 ? max : 1
  const raw = safe / 3
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / magnitude
  let step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude
  if (integer) step = Math.max(1, Math.ceil(step))
  const count = Math.max(1, Math.ceil(safe / step))
  return { top: step * count, ticks: Array.from({ length: count + 1 }, (_, i) => step * i) }
}

export function hasChartData(points: readonly ChartPoint[]): boolean {
  return points.some(point => point.value !== null && point.value > 0)
}

const num = (value: number) => Number(value.toFixed(1))

export function renderChartSvg(points: readonly ChartPoint[], options: ChartOptions): string {
  const { width, height = 190, color, kind } = options
  const { top, ticks } = niceScale(Math.max(0, ...points.map(p => p.value ?? 0)), options.integer)
  const axisLabels = ticks.map(options.formatAxis)
  const padLeft = Math.ceil(Math.max(...axisLabels.map(l => l.length)) * 6.2) + 12
  const pad = { top: 10, right: 10, bottom: 24, left: padLeft }
  const plotW = Math.max(40, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const band = plotW / points.length
  const y = (value: number) => pad.top + plotH - (Math.min(value, top) / top) * plotH
  const cx = (i: number) => pad.left + band * (i + 0.5)

  const grid = ticks.map((tick, i) => `
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${num(y(tick))}" y2="${num(y(tick))}" stroke="var(--border)" stroke-width="1"${i === 0 ? '' : ' stroke-dasharray="3 4"'}/>
    <text x="${pad.left - 6}" y="${num(y(tick) + 3.5)}" text-anchor="end" font-size="10.5" fill="var(--text-muted)">${escapeHtml(axisLabels[i])}</text>`).join('')

  const step = Math.max(1, Math.ceil(34 / band))
  const labels = points.map((point, i) => (points.length - 1 - i) % step === 0
    ? `<text x="${num(cx(i))}" y="${height - 7}" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">${escapeHtml(point.label)}</text>`
    : '').join('')

  let marks: string
  if (kind === 'columns') {
    const barW = Math.min(36, band * 0.62)
    marks = points.map((point, i) => {
      if (point.value === null) return ''
      const barH = Math.max(point.value > 0 ? 1.5 : 0, plotH - (y(point.value) - pad.top))
      return `<g><title>${escapeHtml(point.tip)}</title>
        <rect x="${num(pad.left + band * i)}" y="${pad.top}" width="${num(band)}" height="${plotH}" fill="transparent"/>
        <rect x="${num(cx(i) - barW / 2)}" y="${num(pad.top + plotH - barH)}" width="${num(barW)}" height="${num(barH)}" rx="2" fill="${color}" opacity="0.85"/></g>`
    }).join('')
  } else {
    const baseline = num(pad.top + plotH)
    // Consecutive months with data form one run; a gap ends the line and the area.
    const runs: { i: number; value: number }[][] = []
    points.forEach((point, i) => {
      if (point.value === null) return
      const last = runs[runs.length - 1]
      if (last && last[last.length - 1].i === i - 1) last.push({ i, value: point.value })
      else runs.push([{ i, value: point.value }])
    })
    const lines = runs.map(run => {
      const coords = run.map(p => `${num(cx(p.i))},${num(y(p.value))}`)
      const area = run.length > 1
        ? `<path d="M${num(cx(run[0].i))},${baseline} L${coords.join(' L')} L${num(cx(run[run.length - 1].i))},${baseline} Z" fill="${color}" opacity="0.14"/>`
        : ''
      const line = run.length > 1
        ? `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        : ''
      return area + line
    }).join('')
    const dots = points.map((point, i) => point.value === null ? '' : `<g><title>${escapeHtml(point.tip)}</title>
        <circle cx="${num(cx(i))}" cy="${num(y(point.value))}" r="9" fill="transparent"/>
        <circle cx="${num(cx(i))}" cy="${num(y(point.value))}" r="${points.length > 18 ? 2 : 3}" fill="var(--bg-elevated)" stroke="${color}" stroke-width="1.75"/></g>`).join('')
    marks = `${lines}${dots}`
  }

  return `<svg class="dashboard-chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(options.ariaLabel)}">${grid}${marks}${labels}</svg>`
}

export interface DonutInput {
  name: string
  value: number
  /** Extra tooltip text after the name, e.g. weight and spool count. */
  detail: string
}

export interface DonutSlice extends DonutInput {
  percent: number
  color: string
  /** True for the merged remainder slice. */
  other?: boolean
}

export interface DonutOptions {
  /** Merged slice name. */
  otherLabel: string
  /** Builds the tooltip for the merged slice. */
  otherDetail?: (value: number) => string
  /** Max single slices before the rest is merged. */
  maxSlices?: number
  colors?: readonly string[]
  otherColor?: string
}

export const DONUT_COLORS = [
  'var(--accent)', 'var(--info-text)', 'var(--warning-text)', 'var(--error-text)', 'var(--success-text)', 'var(--accent-2)',
] as const

/** Largest slices first, zero entries dropped, remainder merged into one "other" slice. */
export function buildDonutSlices(items: readonly DonutInput[], options: DonutOptions): DonutSlice[] {
  const { maxSlices = 6, colors = DONUT_COLORS, otherColor = 'var(--text-muted)' } = options
  const sorted = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value)
  const total = sorted.reduce((sum, i) => sum + i.value, 0)
  if (total <= 0) return []
  const head = sorted.slice(0, maxSlices)
  const rest = sorted.slice(maxSlices)
  const slices: DonutSlice[] = head.map((item, i) => ({ ...item, percent: (item.value / total) * 100, color: colors[i % colors.length] }))
  if (rest.length > 0) {
    const value = rest.reduce((sum, i) => sum + i.value, 0)
    slices.push({
      name: options.otherLabel, value, detail: options.otherDetail ? options.otherDetail(value) : '',
      percent: (value / total) * 100, color: otherColor, other: true,
    })
  }
  return slices
}

export interface DonutSvgOptions {
  ariaLabel: string
  centerValue: string
  centerLabel: string
  size?: number
  /** Tooltip text per slice (name, weight, spools, percent). */
  tip: (slice: DonutSlice) => string
}

/** Donut chart as SVG; each slice is a ring segment, a single slice a full ring. */
export function renderDonutSvg(slices: readonly DonutSlice[], options: DonutSvgOptions): string {
  const size = options.size ?? 160
  const c = size / 2
  const outer = c - 2
  const inner = outer * 0.62
  const point = (r: number, a: number) => `${num(c + r * Math.sin(a))} ${num(c - r * Math.cos(a))}`
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  let angle = 0
  const segments = slices.map(slice => {
    const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0
    const attrs = `fill="${slice.color}" stroke="var(--bg-elevated)" stroke-width="1.5"`
    let shape: string
    if (sweep >= Math.PI * 2 - 1e-6) {
      shape = `<path d="M ${point(outer, 0)} A ${outer} ${outer} 0 1 1 ${point(outer, Math.PI)} A ${outer} ${outer} 0 1 1 ${point(outer, 0)} Z M ${point(inner, 0)} A ${inner} ${inner} 0 1 0 ${point(inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${point(inner, 0)} Z" fill-rule="evenodd" ${attrs}>`
    } else {
      const end = angle + sweep
      const large = sweep > Math.PI ? 1 : 0
      shape = `<path d="M ${point(outer, angle)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, angle)} Z" ${attrs}>`
    }
    angle += sweep
    return `${shape}<title>${escapeHtml(options.tip(slice))}</title></path>`
  }).join('')
  return `<svg class="dashboard-chart-svg dashboard-donut-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(options.ariaLabel)}">`
    + segments
    + `<text x="${c}" y="${c + 1}" text-anchor="middle" font-size="${num(size * 0.1)}" font-weight="700" fill="var(--text)">${escapeHtml(options.centerValue)}</text>`
    + `<text x="${c}" y="${num(c + size * 0.1)}" text-anchor="middle" font-size="${num(size * 0.065)}" fill="var(--text-muted)">${escapeHtml(options.centerLabel)}</text>`
    + `</svg>`
}
