import { describe, expect, it } from 'vitest'

import {
  buildSpoolLabelDataFromApi,
  buildSpoolLabelDataFromParams,
  mergeMissingSpoolLabelData,
} from './spool-label-data'
import { buildSpoolDataFromApiSpool } from './label-designer'
import { createSpoolLabelLookups } from './spool-label-lookups'

const apiSpool = {
  id: 7,
  filament_id: 11,
  location_id: 4,
  status_id: 2,
  lot_number: 'LOT-42',
  external_id: 'external-7',
  rfid_uid: 'AABBCCDD',
  purchase_date: '2026-01-02',
  purchase_price: 24.95,
  remaining_weight_g: 734,
  initial_total_weight_g: 1000,
  empty_spool_weight_g: 250,
  low_weight_threshold_g: 100,
  stocked_in_at: '2026-01-03',
  last_used_at: '2026-01-04',
  filament: {
    id: 11,
    designation: 'Midnight Blue',
    manufacturer_id: 3,
    material_type: 'PLA',
    material_subgroup: 'Matte',
    manufacturer_color_name: 'Fallback Blue',
    settings_extruder_temp: 210,
    settings_bed_temp: 60,
    raw_material_weight_g: 1000,
    diameter_mm: 1.75,
    finish_type: 'Matte',
    density_g_cm3: 1.24,
    price: 21.5,
    default_spool_weight_g: 250,
    spool_outer_diameter_mm: 200,
    spool_width_mm: 65,
    spool_material: 'Cardboard',
    shop_url: 'https://example.test/blue',
    color_mode: 'multi',
    multi_color_style: 'gradient',
    manufacturer: { id: 3, name: 'Preview Materials' },
    filament_colors: [
      { display_name_override: 'Ocean', color: { name: 'Blue', hex_code: '123456' } },
      { color: { name: 'Black', hex_code: '000000' } },
    ],
  },
}

const lookups = createSpoolLabelLookups(
  [{ id: 4, name: 'Dry Box' }],
  [{ id: 2, label: 'Opened' }],
)

describe('spool label data normalization', () => {
  it('normalizes complete API spool data with resolved relationships', () => {
    expect(buildSpoolLabelDataFromApi(apiSpool, lookups)).toMatchObject({
      id: '7',
      filament_id: '11',
      designation: 'Midnight Blue',
      manufacturer: 'Preview Materials',
      color: 'Ocean',
      color_hexes: '123456, 000000',
      location: 'Dry Box',
      status: 'Opened',
      lot_number: 'LOT-42',
      remaining_weight_g: '734',
    })
  })

  it('keeps non-empty query fallback values when API data is merged into it', () => {
    const fallback = buildSpoolLabelDataFromParams('7', new URLSearchParams([
      ['designation', 'Query designation'],
      ['remaining_wt', '999'],
    ]))

    mergeMissingSpoolLabelData(fallback, buildSpoolLabelDataFromApi(apiSpool, lookups))

    expect(fallback.designation).toBe('Query designation')
    expect(fallback.remaining_weight_g).toBe('999')
    expect(fallback.color).toBe('Ocean')
  })

  it('normalizes nullish API fields to empty strings', () => {
    expect(buildSpoolLabelDataFromApi({
      id: null,
      filament: { id: null, designation: null, manufacturer: { name: null } },
      lot_number: null,
      remaining_weight_g: null,
    }, lookups)).toMatchObject({
      id: '',
      filament_id: '',
      designation: '',
      manufacturer: '',
      lot_number: '',
      remaining_weight_g: '',
    })
  })

  it('preserves explicit blank temperature settings over legacy custom fields', () => {
    const spool = {
      ...apiSpool,
      filament: {
        ...apiSpool.filament,
        settings_extruder_temp: '',
        settings_bed_temp: '',
        custom_fields: { extruder_temp: 210, bed_temp: 60 },
      },
    }

    const canonical = buildSpoolLabelDataFromApi(spool, lookups)
    const designer = buildSpoolDataFromApiSpool(spool, lookups)

    expect(canonical.extruder_temp).toBe('')
    expect(canonical.bed_temp).toBe('')
    expect(designer['filament.extruder_temp']).toBe('')
    expect(designer['filament.bed_temp']).toBe('')
  })
})
