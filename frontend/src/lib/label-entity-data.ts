export interface LabelColorEntry {
  display_name_override?: unknown
  color?: { name?: unknown; hex_code?: unknown }
}

export function toLabelString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function firstLabelValue(...values: unknown[]): string {
  for (const value of values) {
    const displayValue = toLabelString(value)
    if (displayValue !== '') return displayValue
  }
  return ''
}

export function getFilamentColors(filament: unknown): LabelColorEntry[] {
  const candidate = filament && typeof filament === 'object'
    ? (filament as { filament_colors?: unknown; colors?: unknown })
    : {}
  const list = Array.isArray(candidate.filament_colors)
    ? candidate.filament_colors
    : candidate.colors
  return Array.isArray(list) ? list as LabelColorEntry[] : []
}

export function getFirstFilamentColor(filament: unknown): LabelColorEntry {
  const candidate = filament && typeof filament === 'object'
    ? (filament as { filament_colors?: unknown; colors?: unknown })
    : {}
  for (const list of [candidate.filament_colors, candidate.colors]) {
    if (Array.isArray(list) && list.length > 0) return list[0] as LabelColorEntry ?? {}
  }
  return {}
}

export function getFilamentColorNames(filament: unknown): string {
  return getFilamentColors(filament)
    .map(color => firstLabelValue(color?.display_name_override, color?.color?.name))
    .filter(Boolean)
    .join(', ')
}

export function getFilamentColorHexes(filament: unknown): string {
  return getFilamentColors(filament)
    .map(color => toLabelString(color?.color?.hex_code))
    .filter(Boolean)
    .join(', ')
}
