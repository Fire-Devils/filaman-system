import { filamentSections } from './filament-fields'

const fieldUnits: Record<string, string> = Object.fromEntries(filamentSections.flatMap(section =>
  section.fields.flatMap(field => field.unit ? [[field.key, field.unit]] : [])))
const labelUnits: Record<string, string> = {
  ...fieldUnits, diameter: fieldUnits.diameter_mm, density: fieldUnits.density_g_cm3,
  remaining_weight_g: 'g', initial_total_weight_g: 'g', empty_spool_weight_g: 'g',
  spool_core_weight_g: 'g', low_weight_threshold_g: 'g',
}

export function getLabelTokenUnit(token: string): string | undefined {
  const key = token.slice(1, -1).replace(/^filament\./, '')
  return Object.hasOwn(labelUnits, key) ? labelUnits[key] : undefined
}
