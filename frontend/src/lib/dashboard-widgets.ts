/** HTML for the data cards of the dashboard (stale spools, printer slots, activity, top consumers, range). */
import { amsSwatchFill, amsSwatchHexes } from './ams-swatch'
import { escapeHtml } from './extra-fields'
import { eventTypeLabel, getEventTypeStyle } from './spool-event-style'

export interface WidgetContext {
  t: (key: string, vars?: Record<string, string | number>) => string
  lang: string
  formatPrice: (value: number) => string
  formatWeight: (grams: number) => string
  /** Reference time for relative dates, injectable for tests. */
  now?: number
}

export interface StaleSpoolsData {
  months: number
  items: {
    spool_id: number; filament_designation: string; material_type: string; color_name: string | null
    colors: string[]; manufacturer_name: string; remaining_weight_g: number; remaining_value: number | null
    last_used_at: string | null
  }[]
  total_count: number; total_weight_g: number; total_value: number; unknown_value_count: number
}

export interface PrinterSlotsData {
  printers: {
    printer_id: number; printer_name: string
    slots: {
      slot_no: number; name: string | null; spool_id: number | null; filament_designation: string | null
      material_type: string | null; color_name: string | null; colors: string[]
      manufacturer_name: string | null; remaining_weight_g: number | null
    }[]
  }[]
}

export interface ActivityEvent {
  id: number; spool_id: number | null; event_type: string; event_at: string
  colors?: { name?: string; hex_code?: string }[] | null
  measured_weight_g: number | null; delta_weight_g: number | null
}

export interface TopConsumersData {
  days: number
  items: {
    filament_id: number; filament_designation: string; material_type: string; color_name: string | null
    colors: string[]; manufacturer_name: string; consumed_g: number; spools_in_stock: number
  }[]
}

export interface StockRangeData {
  days: number
  items: { material_type: string; remaining_g: number; consumed_g: number; days_left: number | null }[]
}

/** Below this many days of stock the range is shown as critical. */
export const CRITICAL_RANGE_DAYS = 28
const MAX_RANGE_DAYS = 365

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

/** Color dot as in the AMS view; only validated hex values reach the style attribute. */
export function colorDot(colors: unknown): string {
  const hexes = amsSwatchHexes(list<string>(colors).map(color => {
    const value = String(color ?? '').trim()
    const hex = value.startsWith('#') ? value : `#${value}`
    return hex.length === 9 ? hex.slice(0, 7) : hex
  }))
  return hexes.length
    ? `<span class="dash-dot" style="background:${amsSwatchFill(hexes, '')}" aria-hidden="true"></span>`
    : '<span class="dash-dot is-empty" aria-hidden="true"></span>'
}

function number(value: number): string {
  return String(Number(value.toFixed(1)))
}

function empty(text: string): string {
  return `<p>${escapeHtml(text)}</p>`
}

/** Short "8 mo. ago" style time in the UI language (keys dashboard.ago*). */
export function formatRelativeTime(iso: string, t: WidgetContext['t'], now = Date.now()): string {
  const seconds = Math.abs(Math.round((new Date(iso).getTime() - now) / 1000))
  const steps: [string, number][] = [
    ['agoYears', 31536000], ['agoMonths', 2592000], ['agoWeeks', 604800], ['agoDays', 86400], ['agoHours', 3600], ['agoMinutes', 60],
  ]
  for (const [key, size] of steps) {
    if (seconds >= size) return t(`dashboard.${key}`, { count: Math.floor(seconds / size) })
  }
  return t('dashboard.agoNow')
}

/** "about 6 weeks", "> 1 year" or "no consumption" for the stock range forecast. */
export function formatRange(daysLeft: number | null, t: WidgetContext['t']): string {
  if (daysLeft === null) return t('dashboard.rangeNone')
  if (daysLeft > MAX_RANGE_DAYS) return t('dashboard.rangeOverYear')
  if (daysLeft < 1) return t('dashboard.rangeUnderDay')
  if (daysLeft < 7) {
    const days = Math.round(daysLeft)
    return t(days === 1 ? 'dashboard.rangeDay' : 'dashboard.rangeDays', { count: days })
  }
  const weeks = Math.round(daysLeft / 7)
  return t(weeks === 1 ? 'dashboard.rangeWeek' : 'dashboard.rangeWeeks', { count: weeks })
}

/** Name cell: optional link and color dot stay fixed, the name is cut with an ellipsis. */
function nameLine(link: string, colors: unknown, name: string): string {
  return `<div class="dash-line">${link}${colorDot(colors)}<span class="dash-name">${name}</span></div>`
}

function spoolLink(id: number): string {
  return `<a class="dash-link" href="/spools/${id}">#${id}</a>`
}

function withColor(designation: string | null, colorName: string | null): string {
  return `${escapeHtml(designation)}${colorName ? ` (${escapeHtml(colorName)})` : ''}`
}

function sub(text: string): string {
  return `<div class="dash-sub">${text}</div>`
}

/** Short "03/26" style date. */
function shortDate(iso: string, lang: string): string {
  return new Date(iso).toLocaleDateString(lang, { month: '2-digit', year: '2-digit' })
}

export function renderStaleSpools(data: Partial<StaleSpoolsData> | null | undefined, ctx: WidgetContext): string {
  const { t } = ctx
  const items = list<StaleSpoolsData['items'][number]>(data?.items)
  if (items.length === 0) return empty(t('dashboard.staleEmpty', { count: data?.months ?? 0 }))
  const unknown = data?.unknown_value_count ?? 0
  const total = data?.total_count ?? items.length
  const rows = items.map(s => {
    const name = withColor(s.filament_designation, s.color_name)
    const maker = escapeHtml(s.manufacturer_name)
    return `<tr>
      <td title="${name} · ${maker}">${nameLine(spoolLink(s.spool_id), s.colors, name)}${sub(maker)}</td>
      <td class="num">${ctx.formatWeight(s.remaining_weight_g)}</td>
      <td class="num">${s.remaining_value === null ? '—' : ctx.formatPrice(s.remaining_value)}</td>
      <td class="num" title="${s.last_used_at ? escapeHtml(new Date(s.last_used_at).toLocaleDateString(ctx.lang)) : ''}">${s.last_used_at ? shortDate(s.last_used_at, ctx.lang) : escapeHtml(t('dashboard.staleNever'))}</td>
    </tr>`
  }).join('')
  const star = unknown > 0
    ? `<span title="${escapeHtml(t('dashboard.staleUnknownValue', { count: unknown }))}">*</span>`
    : ''
  const more = total > items.length
    ? `<p class="dash-note">${escapeHtml(t('dashboard.staleShown', { shown: items.length, total }))}</p>`
    : ''
  return `<table class="fm-table">
    <thead><tr>
      <th>${t('dashboard.spool')}</th><th class="num">${t('dashboard.remaining')}</th>
      <th class="num">${t('dashboard.staleValue')}</th><th class="num">${t('dashboard.staleLastUsed')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td>${escapeHtml(t('dashboard.staleTotal', { count: total }))}</td>
      <td class="num">${ctx.formatWeight(data?.total_weight_g ?? 0)}</td>
      <td class="num">${ctx.formatPrice(data?.total_value ?? 0)}${star}</td>
      <td></td>
    </tr></tfoot>
  </table>${more}`
}

export function renderPrinterSlots(data: Partial<PrinterSlotsData> | null | undefined, ctx: WidgetContext): string {
  const { t } = ctx
  const printers = list<PrinterSlotsData['printers'][number]>(data?.printers)
  if (printers.length === 0) {
    return `<p>${escapeHtml(t('dashboard.printersEmpty'))} <a href="/printers">${escapeHtml(t('dashboard.printersLink'))}</a></p>`
  }
  const rows = printers.map(printer => {
    const slots = list<PrinterSlotsData['printers'][number]['slots'][number]>(printer.slots).map(slot => {
      const label = escapeHtml(slot.name || `#${slot.slot_no}`)
      if (slot.spool_id === null) {
        return `<tr><td title="${label}">${label}</td><td colspan="2" class="dash-muted">${escapeHtml(t('dashboard.slotEmpty'))}</td></tr>`
      }
      const name = withColor(slot.filament_designation, slot.color_name)
      const detail = [slot.material_type, slot.manufacturer_name].filter(Boolean).map(escapeHtml).join(' · ')
      return `<tr>
        <td title="${label}">${label}</td>
        <td title="${name} · ${detail}">${nameLine(spoolLink(slot.spool_id), slot.colors, name)}${sub(detail)}</td>
        <td class="num">${slot.remaining_weight_g === null ? '—' : ctx.formatWeight(slot.remaining_weight_g)}</td>
      </tr>`
    }).join('')
    return `<tr class="dash-group"><td colspan="3">${escapeHtml(printer.printer_name)}</td></tr>${slots}`
  }).join('')
  return `<table class="fm-table">
    <thead><tr>
      <th>${t('dashboard.slot')}</th><th>${t('dashboard.spool')}</th><th class="num">${t('dashboard.remaining')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

export function renderRecentActivity(items: unknown, ctx: WidgetContext): string {
  const { t } = ctx
  const events = list<ActivityEvent>(items)
  if (events.length === 0) return empty(t('dashboard.activityEmpty'))
  const rows = events.map(e => {
    const spool = e.spool_id === null
      ? `<span class="dash-muted">${escapeHtml(t('spoolLog.deletedSpool'))}</span>`
      : `<div class="dash-line">${colorDot(list<{ hex_code?: string }>(e.colors).map(c => c?.hex_code))}${spoolLink(e.spool_id)}</div>`
    const weight = e.delta_weight_g !== null
      ? `${e.delta_weight_g > 0 ? '+' : ''}${number(e.delta_weight_g)} g`
      : e.measured_weight_g !== null ? `${number(e.measured_weight_g)} g` : '—'
    const label = escapeHtml(eventTypeLabel(e.event_type, t))
    return `<tr>
      <td title="${escapeHtml(new Date(e.event_at).toLocaleString(ctx.lang))}">${escapeHtml(formatRelativeTime(e.event_at, t, ctx.now))}</td>
      <td><span class="fm-pill dash-pill" title="${label}" style="${getEventTypeStyle(e.event_type)}">${label}</span></td>
      <td>${spool}</td>
      <td class="num">${weight}</td>
    </tr>`
  }).join('')
  return `<table class="fm-table">
    <thead><tr>
      <th>${t('dashboard.activityTime')}</th><th>${t('dashboard.activityEvent')}</th><th>${t('dashboard.spool')}</th><th class="num" title="${escapeHtml(t('dashboard.activityWeight'))}">Δ</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="dash-note"><a href="/spool-log">${escapeHtml(t('dashboard.activityAll'))}</a></p>`
}

export function renderTopConsumers(data: Partial<TopConsumersData> | null | undefined, ctx: WidgetContext): string {
  const { t } = ctx
  const items = list<TopConsumersData['items'][number]>(data?.items)
  if (items.length === 0) return empty(t('dashboard.topConsumersEmpty', { count: data?.days ?? 90 }))
  const max = Math.max(...items.map(i => i.consumed_g), 1)
  const rows = items.map(i => {
    const name = withColor(i.filament_designation, i.color_name)
    const detail = [i.material_type, i.manufacturer_name].filter(Boolean).map(escapeHtml).join(' · ')
    const width = Math.max(2, Math.round(i.consumed_g / max * 100))
    return `<tr>
      <td title="${name} · ${detail}"><div class="dash-line">${colorDot(i.colors)}<a class="dash-link dash-name" href="/filaments/${i.filament_id}">${name}</a></div>${sub(detail)}</td>
      <td class="num">${ctx.formatWeight(i.consumed_g)}<div class="dash-bar" role="img" aria-label="${escapeHtml(ctx.formatWeight(i.consumed_g))}"><span style="width:${width}%"></span></div></td>
      <td class="num">${i.spools_in_stock}</td>
    </tr>`
  }).join('')
  return `<table class="fm-table">
    <thead><tr>
      <th>${t('dashboard.filament')}</th>
      <th class="num">${t('dashboard.topConsumed', { count: data?.days ?? 90 })}</th><th class="num" title="${escapeHtml(t('dashboard.topInStockHint'))}">${t('dashboard.topInStock')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

export function renderStockRange(data: Partial<StockRangeData> | null | undefined, ctx: WidgetContext): string {
  const { t } = ctx
  const items = list<StockRangeData['items'][number]>(data?.items)
  if (items.length === 0) return empty(t('dashboard.rangeEmpty'))
  const rows = items.map(i => {
    const critical = i.days_left !== null && i.days_left < CRITICAL_RANGE_DAYS
    const used = t('dashboard.rangeConsumed', { value: ctx.formatWeight(i.consumed_g), count: data?.days ?? 90 })
    const hint = i.days_left === null ? ` title="${escapeHtml(t('dashboard.rangeNoneHint'))}"` : ''
    return `<tr>
      <td title="${escapeHtml(i.material_type)}"><a class="dash-link" href="/spools?material=${escapeHtml(encodeURIComponent(i.material_type))}">${escapeHtml(i.material_type)}</a></td>
      <td class="num" title="${escapeHtml(used)}">${ctx.formatWeight(i.remaining_g)}${sub(escapeHtml(used))}</td>
      <td class="num${critical ? ' is-critical' : ''}"${hint}>${escapeHtml(formatRange(i.days_left, t))}</td>
    </tr>`
  }).join('')
  return `<table class="fm-table">
    <thead><tr>
      <th>${t('dashboard.material')}</th><th class="num">${t('dashboard.remaining')}</th><th class="num">${t('dashboard.rangeColumn')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}
