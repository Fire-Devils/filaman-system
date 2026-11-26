import { describe, expect, it } from 'vitest'

import de from '../i18n/de.json'
import en from '../i18n/en.json'
import fr from '../i18n/fr.json'
import { ALL_PROFILE_FIELDS, PROFILE_GROUPS, buildProfilePayload, profileCoreSummary, profilePrinterLabel } from './print-profiles'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe('print profile form payload', () => {
  it('turns empty values into null and parses numbers by field kind', () => {
    const payload = buildProfilePayload({
      nozzle_temp_c: '215.4',
      bed_temp_c: '',
      pressure_advance_k: '0.04',
      extruder_type: ' direct ',
      z_hop_only_when_retracting: 'true',
      material_notes: '',
    })
    expect(payload).toMatchObject({
      nozzle_temp_c: 215,
      bed_temp_c: null,
      pressure_advance_k: 0.04,
      extruder_type: 'direct',
      z_hop_only_when_retracting: true,
      material_notes: null,
    })
  })

  it('maps the tri-state select to boolean or null', () => {
    expect(buildProfilePayload({ z_hop_only_when_retracting: 'false' }).z_hop_only_when_retracting).toBe(false)
    expect(buildProfilePayload({ z_hop_only_when_retracting: '' }).z_hop_only_when_retracting).toBeNull()
  })

  it('keeps numeric ranges aligned with the backend contract', () => {
    const range = (key: string) => {
      const field = ALL_PROFILE_FIELDS.find(f => f.key === key)!
      return [field.min, field.max]
    }
    expect(range('nozzle_temp_c')).toEqual([150, 500])
    expect(range('pressure_advance_k')).toEqual([0, 2])
    expect(range('bridge_flow_percent')).toEqual([50, 150])
  })
})

describe('print profile cards', () => {
  it('summarises only stored core values', () => {
    const rows = profileCoreSummary({ id: 1, filament_id: 1, printer_id: 1, profile_name: 'x', nozzle_temp_c: 215, bed_temp_c: null, print_speed_mm_s: 200 })
    expect(rows.map(r => r.value)).toEqual(['215 °C / —', '200 mm/s'])
  })

  it('shows printer name with model', () => {
    expect(profilePrinterLabel({ printer_name: 'Werkstatt', printer_manufacturer: 'Prusa', printer_model: 'MK4' })).toBe('Werkstatt (Prusa MK4)')
    expect(profilePrinterLabel({ printer_name: 'Werkstatt' })).toBe('Werkstatt')
  })
})

describe('print profile translations', () => {
  it('has the same keys in de, en and fr and covers every field and group', () => {
    const keys = leafPaths(en.printProfiles).sort()
    expect(leafPaths(de.printProfiles).sort()).toEqual(keys)
    expect(leafPaths(fr.printProfiles).sort()).toEqual(keys)
    for (const field of ALL_PROFILE_FIELDS) expect(keys).toContain(`fields.${field.key}`)
    for (const group of PROFILE_GROUPS) expect(keys).toContain(`groups.${group.id}`)
    const printerKeys = ['modelSearch', 'modelNotListedHint', 'printerManufacturer', 'printerModel', 'modelDidYouMean']
    for (const catalog of [de, en, fr]) for (const key of printerKeys) expect(catalog.printers).toHaveProperty(key)
  })
})
