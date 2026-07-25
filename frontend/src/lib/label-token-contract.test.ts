import { describe, expect, it } from 'vitest'

import {
  FILAMENT_TOKENS,
  SPOOL_TOKENS,
  buildSpoolDataFromApiSpool,
} from './label-designer'
import { renderTemplateText } from './label-template'
import {
  createSpoolLabelLookups,
  resolveSpoolLabelRelations,
} from './spool-label-lookups'

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
  low_weight_threshold_g: 100,
  custom_fields: { storage_note: 'Keep dry' },
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
      extruder_temp: 215,
      bed_temp: 60,
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
}

const lookups = createSpoolLabelLookups(
  [{ id: 7, name: 'Rack A' }],
  [{ id: 3, label: 'Opened' }],
)

describe('spool label token contract', () => {
  it('renders every advertised filament and spool token from the API wire shape', () => {
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(data.location).toBe('Rack A')
    expect(data.status).toBe('Opened')

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
})
