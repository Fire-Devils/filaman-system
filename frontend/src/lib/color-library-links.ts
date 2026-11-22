import type { ColumnFilterValue } from './table-column-filters'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Usage cell of the Color Library: plain text for unused colors, links to the filtered lists otherwise. */
export function colorUsageHtml(id: number, usageCount: number, t: Translate): string {
  if (!(usageCount > 0)) return t('colors.usedIn', { count: usageCount })
  const color = encodeURIComponent(String(id))
  return `<a href="/filaments?color_id=${color}" class="color-usage-link">${t('colors.usedInFilaments', { count: usageCount })}</a>`
    + ` &middot; <a href="/spools?color_id=${color}" class="color-usage-link">${t('colors.showSpools')}</a>`
}

type ColorOption = { value: string; colorStops?: { id: number }[]; color_stops?: { id: number }[] }

/** Builds the colors column filter for URL `color_id` values; unknown ids are ignored. */
export function colorFilterFromIds(rawIds: string[], options: ColorOption[]): ColumnFilterValue | null {
  const wanted = new Set(rawIds.map(Number).filter(Number.isInteger))
  const values: string[] = []
  const colorStopIds: [string, number[]][] = []
  for (const option of options) {
    const ids = [...new Set((option.colorStops || option.color_stops || []).map(stop => stop.id).filter(id => wanted.has(id)))]
    if (!ids.length || !option.value) continue
    values.push(option.value)
    colorStopIds.push([option.value, ids])
  }
  return values.length ? { type: 'multi', values, colorStopIds } : null
}
