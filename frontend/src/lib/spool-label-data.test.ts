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

  it('does not replace normalized API fields with query fallbacks', () => {
    const fallback = buildSpoolLabelDataFromParams('7', new URLSearchParams([
      ['designation', 'Query designation'],
      ['remaining_wt', '999'],
      ['lot', 'Query lot'],
    ]))
    const canonical = buildSpoolLabelDataFromApi(apiSpool, lookups)

    mergeMissingSpoolLabelData(canonical, fallback)

    expect(canonical.designation).toBe('Midnight Blue')
    expect(canonical.remaining_weight_g).toBe('734')
    expect(canonical.lot_number).toBe('LOT-42')
    expect(canonical.color).toBe('Ocean')
  })

  it('uses a query fallback when the normalized API field is missing', () => {
    const fallback = buildSpoolLabelDataFromParams('7', new URLSearchParams([
      ['lot', 'Query lot'],
      ['spool_outer_dia', '185'],
      ['spool_width', '58'],
      ['spool_material', 'Query plastic'],
    ]))
    const canonical = buildSpoolLabelDataFromApi({
      ...apiSpool,
      lot_number: null,
      filament: {
        ...apiSpool.filament,
        spool_outer_diameter_mm: null,
        spool_width_mm: null,
        spool_material: null,
        manufacturer: {
          ...apiSpool.filament.manufacturer,
          spool_outer_diameter_mm: null,
          spool_width_mm: null,
          spool_material: null,
        },
      },
    }, lookups)

    mergeMissingSpoolLabelData(canonical, fallback)

    expect(canonical).toMatchObject({
      lot_number: 'Query lot',
      spool_outer_diameter_mm: '185',
      spool_width_mm: '58',
      spool_material: 'Query plastic',
    })
  })

  it('prefers per-spool geometry and material over filament and manufacturer defaults', () => {
    const spool = {
      ...apiSpool,
      spool_outer_diameter_mm: 210,
      spool_width_mm: 72,
      spool_material: 'Reusable ABS',
      filament: {
        ...apiSpool.filament,
        spool_outer_diameter_mm: 200,
        spool_width_mm: 65,
        spool_material: 'Cardboard',
        manufacturer: {
          ...apiSpool.filament.manufacturer,
          spool_outer_diameter_mm: 190,
          spool_width_mm: 60,
          spool_material: 'Plastic',
        },
      },
    }

    expect(buildSpoolLabelDataFromApi(spool, lookups)).toMatchObject({
      spool_outer_diameter_mm: '210',
      spool_width_mm: '72',
      spool_material: 'Reusable ABS',
    })
  })

  it('uses manufacturer geometry and material defaults when spool and filament values are absent', () => {
    const spool = {
      ...apiSpool,
      filament: {
        ...apiSpool.filament,
        spool_outer_diameter_mm: null,
        spool_width_mm: null,
        spool_material: null,
        manufacturer: {
          ...apiSpool.filament.manufacturer,
          spool_outer_diameter_mm: 190,
          spool_width_mm: 60,
          spool_material: 'Plastic',
        },
      },
    }

    expect(buildSpoolLabelDataFromApi(spool, lookups)).toMatchObject({
      spool_outer_diameter_mm: '190',
      spool_width_mm: '60',
      spool_material: 'Plastic',
    })
  })

  it('prefers filament geometry and material over manufacturer defaults', () => {
    const spool = {
      ...apiSpool,
      filament: {
        ...apiSpool.filament,
        spool_outer_diameter_mm: 200,
        spool_width_mm: 65,
        spool_material: 'Cardboard',
        manufacturer: {
          ...apiSpool.filament.manufacturer,
          spool_outer_diameter_mm: 190,
          spool_width_mm: 60,
          spool_material: 'Plastic',
        },
      },
    }

    expect(buildSpoolLabelDataFromApi(spool, lookups)).toMatchObject({
      spool_outer_diameter_mm: '200',
      spool_width_mm: '65',
      spool_material: 'Cardboard',
    })
  })

  it('accepts a top-level filament id when the nested filament omits it', () => {
    const spool = {
      ...apiSpool,
      filament_id: 41,
      filament: {
        ...apiSpool.filament,
        id: null,
      },
    }

    expect(buildSpoolLabelDataFromApi(spool, lookups).filament_id).toBe('41')
  })

  it('accepts filament.type and uses manufacturer_id as the logo-manufacturer fallback', () => {
    const spool = {
      ...apiSpool,
      filament: {
        ...apiSpool.filament,
        material_type: null,
        type: 'PETG',
        manufacturer_id: 23,
        manufacturer: { name: 'Fallback Materials' },
      },
    }

    expect(buildSpoolLabelDataFromApi(spool, lookups)).toMatchObject({
      type: 'PETG',
      manufacturer_id: '23',
      mfr_id: '23',
    })
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
