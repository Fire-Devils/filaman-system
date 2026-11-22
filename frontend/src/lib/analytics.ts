export type AnalyticsRange = '3m' | '6m' | '12m' | 'year' | 'all'

export interface AnalyticsSummary {
  date_from: string
  date_to: string
  consumption_by_month: { month: string; weight_g: number; cost: number }[]
  consumption_by_material: { material_type: string; weight_g: number; cost: number }[]
  consumption_by_manufacturer: { manufacturer: string; weight_g: number; cost: number }[]
  purchases: {
    total: number
    by_month: { month: string; total: number; by_material: Record<string, number> }[]
    by_material: Record<string, number>
  }
  print_jobs: {
    count: number
    completed: number
    failed: number
    cancelled: number
    success_rate: number | null
    total_weight_g: number
    total_cost: number
    avg_cost_per_job: number | null
    total_print_time_s: number
  }
  top_projects: { project_id: number; name: string; job_count: number; weight_g: number; cost: number }[]
  totals: { weight_g: number; cost: number; cost_unknown_weight_g: number }
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** from/to query values (local dates) for a range choice. */
export function rangeToParams(range: AnalyticsRange, today = new Date()): { from: string; to: string } {
  const to = isoDate(today)
  if (range === 'all') return { from: '1970-01-01', to }
  if (range === 'year') return { from: `${today.getFullYear()}-01-01`, to }
  const months = range === '3m' ? 3 : range === '6m' ? 6 : 12
  const start = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1)
  return { from: isoDate(start), to }
}

/** Bar widths in percent (0-100) relative to the largest value; non-zero values get at least minPct. */
export function barPercents(values: number[], minPct = 2): number[] {
  const max = Math.max(0, ...values)
  if (max <= 0) return values.map(() => 0)
  return values.map(v => (v <= 0 ? 0 : Math.max(minPct, (v / max) * 100)))
}

/** "2026-05" to a short localized label such as "May 26". */
export function formatMonthLabel(month: string, lang: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return month
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
  const locale = lang === 'de' ? 'de-DE' : lang === 'fr' ? 'fr-FR' : 'en-US'
  return new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(date)
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? '–' : `${Math.round(value * 100)} %`
}

export function formatDurationHours(seconds: number): string {
  const hours = seconds / 3600
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} h`
}

export function hasAnyData(summary: AnalyticsSummary): boolean {
  return summary.totals.weight_g > 0 || summary.print_jobs.count > 0 || summary.purchases.total > 0
}
