import { describe, expect, it } from 'vitest'

import {
  buildSpoolDesignerDataFromLabelData,
  DESIGNER_DEFAULTS,
  FILAMENT_TOKENS,
  SPOOL_TOKENS,
  buildSpoolDataFromApiSpool,
} from './label-designer'
import { REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS } from './filament-label-data'
import { renderTemplateText } from './label-template'
import {
  createSpoolLabelLookups,
  resolveSpoolLabelRelations,
} from './spool-label-lookups'
import { buildSpoolLabelDataFromApi } from './spool-label-data'
import { formatDateDisplay, formatDateTimeDisplay } from './extra-fields'

const apiSpool = {
  id: 42,
  filament_id: 8,
  status_id: 3,
  location_id: 7,
  lot_number: 'LOT-42',
  external_id: 'spoolman:42',
  rfid_uid: 'AA:BB:CC:DD',
  purchase_date: '2026-01-02T00:00:00Z',
  purchase_price: 24.95,
  stocked_in_at: '2026-01-03T00:00:00Z',
  last_used_at: '2026-01-04T00:00:00Z',
  remaining_weight_g: 712,
  initial_total_weight_g: 1250,
  empty_spool_weight_g: 250,
  spool_core_weight_g: 42,
  low_weight_threshold_g: 100,
  custom_fields: {
    storage_note: 'Keep dry',
    certified_at: '2026-07-25T14:30:45.123Z',
  },
  custom_field_definitions: {
    certified_at: {
      label: 'Certified at',
      field_type: 'datetime',
    },
  },
  filament: {
    id: 8,
    manufacturer_id: 5,
    designation: 'Galaxy PLA',
    material_type: 'PLA',
    material_subgroup: 'Silk',
    manufacturer_color_name: 'Nebula',
    color_mode: 'multi',
    multi_color_style: 'gradient',
    raw_material_weight_g: 1000,
    diameter_mm: 1.75,
    finish_type: 'Glossy',
    density_g_cm3: 1.24,
    price: 22.5,
    default_spool_weight_g: 250,
    spool_outer_diameter_mm: 200,
    spool_width_mm: 65,
    spool_material: 'Cardboard',
    shop_url: 'https://example.test/galaxy-pla',
    custom_fields: {
      settings_extruder_temp: 215,
      settings_bed_temp: 60,
    },
    manufacturer: {
      id: 5,
      name: 'Example Filaments',
    },
    colors: [
      {
        display_name_override: 'Galaxy Blue',
        color: { name: 'Blue', hex_code: '#123456' },
      },
      {
        color: { name: 'Purple', hex_code: '#654321' },
      },
    ],
  },
  created_at: '2026-01-01T12:34:56Z',
}

const lookups = createSpoolLabelLookups(
  [{ id: 7, name: 'Rack A' }],
  [{ id: 3, label: 'Opened' }],
)

describe('spool label token contract', () => {
  it('advertises only backed built-in tokens while keeping complete spool timestamps and weights', () => {
    const filamentTokens = FILAMENT_TOKENS.map(({ token }) => token)
    const spoolTokens = SPOOL_TOKENS.map(({ token }) => token)
    const standardKeys = REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS.map(({ key }) => key)

    expect(filamentTokens).not.toContain('{filament.extruder_temp}')
    expect(filamentTokens).not.toContain('{filament.bed_temp}')
    expect(standardKeys).not.toContain('filament.extruder_temp')
    expect(standardKeys).not.toContain('filament.bed_temp')
    expect(DESIGNER_DEFAULTS.info.template).not.toMatch(/extruder_temp|bed_temp/)

    expect(spoolTokens).toContain('{spool_core_weight_g}')
    expect(spoolTokens).toContain('{stocked_in_at}')
    expect(spoolTokens).toContain('{created_at}')
  })

  it('continues resolving legacy temperature tokens in saved templates', () => {
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(renderTemplateText('{filament.extruder_temp}', data)).toBe('215')
    expect(renderTemplateText('{filament.bed_temp}', data)).toBe('60')
  })

  it('renders every advertised filament and spool token from the API wire shape', () => {
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)
    const canonical = buildSpoolLabelDataFromApi(apiSpool, lookups)

    expect(data.location).toBe('Rack A')
    expect(data.status).toBe('Opened')
    expect(data['filament.name']).toBe(canonical.designation)
    expect(data['filament.color']).toBe(canonical.color)
    expect(data.remaining_weight_g).toBe(canonical.remaining_weight_g)

    for (const { token } of [...FILAMENT_TOKENS, ...SPOOL_TOKENS]) {
      const rendered = renderTemplateText(token, data)
      expect(rendered, `${token} should render a value`).not.toBe('')
      expect(rendered, `${token} should not remain unresolved`).not.toContain('{')
    }
  })

  it('prefers resolved relationship objects while retaining ID lookup fallback', () => {
    expect(resolveSpoolLabelRelations(apiSpool, lookups)).toEqual({
      location: 'Rack A',
      status: 'Opened',
    })

    expect(resolveSpoolLabelRelations({
      ...apiSpool,
      location: { id: 7, name: 'Resolved Rack' },
      status: { id: 3, label: 'Resolved Status' },
    }, lookups)).toEqual({
      location: 'Resolved Rack',
      status: 'Resolved Status',
    })
  })

  it('omits optional wrappers cleanly when a relationship is unset', () => {
    const data = buildSpoolDataFromApiSpool({
      ...apiSpool,
      location_id: null,
      status_id: null,
    })

    expect(renderTemplateText('{Location: {location}}', data)).toBe('')
    expect(renderTemplateText('{Status: {status}}', data)).toBe('')
  })

  it('supports a date-only modifier while retaining compact datetime by default', () => {
    const raw = apiSpool.custom_fields.certified_at
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(renderTemplateText('{extra.spool.certified_at}', data))
      .toBe(formatDateTimeDisplay(raw))
    expect(renderTemplateText('{extra.spool.certified_at|date}', data))
      .toBe(formatDateDisplay(raw))
    expect(renderTemplateText('{Certified: {extra.spool.certified_at|date}}', data))
      .toBe(`Certified: ${formatDateDisplay(raw)}`)
  })

  it('keeps timestamp precision while allowing the date-only modifier', () => {
    const canonical = buildSpoolLabelDataFromApi(apiSpool, lookups)
    const single = buildSpoolDesignerDataFromLabelData(canonical)
    const batch = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(single.purchase_date).toBe(formatDateDisplay(canonical.purchase_date))
    expect(batch.purchase_date).toBe(single.purchase_date)

    for (const key of ['stocked_in_at', 'last_used_at', 'created_at'] as const) {
      expect(single[key]).toBe(canonical[key])
      expect(batch[key]).toBe(single[key])
      expect(single[key]).toContain(':')
      expect(renderTemplateText(`{${key}|date}`, single)).toBe(formatDateDisplay(canonical[key]))
    }
  })

  it('preserves literal Extra Field keys ending in the date modifier suffix', () => {
    const data = buildSpoolDataFromApiSpool({
      ...apiSpool,
      custom_fields: {
        ...apiSpool.custom_fields,
        'inspection|date': 'Literal field value',
      },
    }, lookups)

    expect(renderTemplateText('{extra.spool.inspection|date}', data))
      .toBe('Literal field value')
  })
})
