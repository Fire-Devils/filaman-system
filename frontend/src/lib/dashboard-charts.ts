// Small hand-drawn SVG charts for the dashboard (no chart library).
// Colors come from theme variables so light and dark themes both work.
import { escapeHtml } from './extra-fields'

export interface ChartPoint {
  /** Short axis label, e.g. "Mar". */
  label: string
  value: number
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
  return points.some(point => point.value > 0)
}

const num = (value: number) => Number(value.toFixed(1))

export function renderChartSvg(points: readonly ChartPoint[], options: ChartOptions): string {
  const { width, height = 190, color, kind } = options
  const { top, ticks } = niceScale(Math.max(0, ...points.map(p => p.value)), options.integer)
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
      const barH = Math.max(point.value > 0 ? 1.5 : 0, plotH - (y(point.value) - pad.top))
      return `<g><title>${escapeHtml(point.tip)}</title>
        <rect x="${num(pad.left + band * i)}" y="${pad.top}" width="${num(band)}" height="${plotH}" fill="transparent"/>
        <rect x="${num(cx(i) - barW / 2)}" y="${num(pad.top + plotH - barH)}" width="${num(barW)}" height="${num(barH)}" rx="2" fill="${color}" opacity="0.85"/></g>`
    }).join('')
  } else {
    const coords = points.map((point, i) => `${num(cx(i))},${num(y(point.value))}`)
    const baseline = num(pad.top + plotH)
    const area = `M${num(cx(0))},${baseline} L${coords.join(' L')} L${num(cx(points.length - 1))},${baseline} Z`
    const dots = points.map((point, i) => `<g><title>${escapeHtml(point.tip)}</title>
        <circle cx="${num(cx(i))}" cy="${num(y(point.value))}" r="9" fill="transparent"/>
        <circle cx="${num(cx(i))}" cy="${num(y(point.value))}" r="${points.length > 18 ? 2 : 3}" fill="var(--bg-elevated)" stroke="${color}" stroke-width="1.75"/></g>`).join('')
    marks = `<path d="${area}" fill="${color}" opacity="0.14"/>
      <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
  }

  return `<svg class="dashboard-chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(options.ariaLabel)}">${grid}${marks}${labels}</svg>`
}
