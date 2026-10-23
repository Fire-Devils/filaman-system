import { describe, expect, it } from 'vitest'

import {
  buildSpoolDesignerDataFromLabelData,
  buildSpoolDataFromApiSpool,
} from './label-designer'
import {
  buildCanonicalFilamentLabelData,
  buildDesignerExtraFieldsFromFilament,
  buildFilamentLabelDataFromApi,
  buildFilamentLabelDataFromParams,
  buildFilamentPrintSearchParams,
  REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS,
} from './filament-label-data'
import { FILAMENT_TOKENS, SPOOL_TOKENS } from './label-token-catalog'
import { renderTemplateText } from './label-template'
import {
  createSpoolLabelLookups,
  resolveSpoolLabelRelations,
} from './spool-label-lookups'
import {
  buildSpoolLabelDataFromApi,
  buildSpoolLabelDataFromParams,
  buildSpoolPrintSearchParams,
  buildSpoolStandardModelFields,
  SPOOL_BUILT_IN_LABEL_FIELD_DEFS,
} from './spool-label-data'
import { isBuiltInLabelField } from './label-extra-fields'
import { formatDateDisplay, formatDateTimeDisplay } from './extra-fields'

describe('saved extra temperature spellings', () => {
  it.each([
    [{ custom_fields: { extruder_temp: 215, bed_temp: 60 } }, '215 / 60'],
    [{ extruder_temp_range_c: { min: 210, max: 220 }, bed_temp_range_c: { min: 60, max: 60 }, custom_fields: { extruder_temp: 999, bed_temp: 999 } }, '210–220 / 60'],
    [{}, ' / '],
  ])('renders API and query data for filament and spool single/batch: %j', (filament, expected) => {
    const spool = { id: 42, filament }
    const sources = [
      buildFilamentLabelDataFromApi(filament),
      buildFilamentLabelDataFromParams('8', buildFilamentPrintSearchParams(filament)),
      buildSpoolLabelDataFromApi(spool),
      buildSpoolLabelDataFromParams('42', buildSpoolPrintSearchParams(spool)),
    ]
    for (const data of sources) {
      expect(renderTemplateText('{extra.filament.extruder_temp} / {extra.filament.bed_temp}', buildSpoolDesignerDataFromLabelData(data))).toBe(expected)
    }
    expect(renderTemplateText('{extra.filament.extruder_temp} / {extra.filament.bed_temp}', buildSpoolDataFromApiSpool(spool))).toBe(expected)
    expect(buildDesignerExtraFieldsFromFilament(filament).map(field => field.key)).not.toContain('filament.extruder_temp')
  })
})

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
    extruder_temp_range_c: { min: 200, max: 220 },
    bed_temp_range_c: { min: 60, max: 60 },
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

const legacyDesignerTokens = [
  '{color_swatch[1]}',
  '{id}',
  '{filament.id}',
  '{filament.name}',
  '{filament.manufacturer}',
  '{filament.manufacturer_id}',
  '{filament.type}',
  '{filament.subtype}',
  '{filament.manufacturer_color_name}',
  '{filament.color}',
  '{filament.colors}',
  '{filament.color_hex}',
  '{filament.color_hexes}',
  '{filament.color_mode}',
  '{filament.multi_color_style}',
  '{filament.raw_material_weight_g}',
  '{filament.diameter}',
  '{filament.finish}',
  '{filament.density}',
  '{filament.price}',
  '{filament.default_spool_weight_g}',
  '{filament.spool_outer_diameter_mm}',
  '{filament.spool_width_mm}',
  '{filament.spool_material}',
  '{filament.shop_url}',
  ...SPOOL_BUILT_IN_LABEL_FIELD_DEFS
    .filter(({ key }) => !['rfid_uid_2', 'purchase_currency'].includes(key))
    .map(({ key }) => `{${key}}`),
]

const nativeFields = [
  ['extruder_temp_range_c', { min: 200, max: 220 }, '200–220'],
  ['bed_temp_range_c', { min: 60, max: null }, '60'],
  ['manufacturer_sku', 'SKU-42', 'SKU-42'],
  ['datasheet_url', 'https://example.test/spec.pdf', 'https://example.test/spec.pdf'],
  ['image_url', 'https://example.test/photo.png', 'https://example.test/photo.png'],
  ['is_discontinued', false, 'no'],
  ['drying_temp_c', 55, '55'],
  ['drying_time_hours', 0, '0'],
  ['softening_temp_c', null, ''],
  ['cooling_fan_range_percent', { min: 0, max: 100 }, '0–100'],
  ['chamber_temp_c', 0, '0'],
  ['max_volumetric_speed_mm3_s', 12.5, '12.5'],
  ['flow_ratio', 0.98, '0.98'],
  ['pressure_advance_k', 0, '0'],
  ['ams_compatibility', ['AMS', 'AMS 2 Pro'], 'AMS, AMS 2 Pro'],
  ['build_plate_compatibility', ['Textured PEI', 'Smooth PEI'], 'Textured PEI, Smooth PEI'],
  ['price_currency', 'EUR', 'EUR'],
] as const
const nativeFilament = { ...apiSpool.filament, ...Object.fromEntries(nativeFields.map(([key, value]) => [key, value])) }

describe('spool label token contract', () => {
  it('keeps model fields in Standard checkboxes without advertising duplicate extra tokens', () => {
    const fields = buildSpoolStandardModelFields(buildSpoolLabelDataFromApi(apiSpool))
    expect(fields.map(field => field.key)).toEqual(expect.arrayContaining([
      'spool_material', 'spool_outer_diameter_mm', 'spool_width_mm', 'rfid_uid_2', 'purchase_currency',
    ]))
    expect(fields.filter(field => !isBuiltInLabelField('spool', field.key, field.label))).toEqual([])
  })

  it.each([
    ['spool_material', 'Cardboard'],
    ['spool_outer_diameter_mm', '200'],
    ['spool_width_mm', '65'],
    ['rfid_uid_2', 'SECONDARY'],
    ['purchase_currency', 'USD'],
  ])('renders saved extra.%s after session data is consumed', (key, expected) => {
    const spool = { ...apiSpool, rfid_uid_2: 'SECONDARY' }
    const single = buildSpoolDesignerDataFromLabelData(buildSpoolLabelDataFromApi(spool, lookups, '', 'USD'))
    const batch = buildSpoolDataFromApiSpool(spool, lookups, undefined, 'USD')
    for (const data of [single, batch]) {
      expect(renderTemplateText(`{${key}}|{extra.${key}}`, data)).toBe(`${expected}|${expected}`)
    }
    expect(renderTemplateText(`{extra.${key}}`, { ...single, extra: { [key]: 'Explicit value' } })).toBe('Explicit value')
  })

  it.each([
    [true, 'yes'],
    [false, 'no'],
    [null, ''],
    [undefined, ''],
  ] as const)('renders discontinued value %s through API and filament/spool query roundtrips', (value, expected) => {
    const filament = { ...apiSpool.filament, is_discontinued: value }
    const spool = { ...apiSpool, filament }
    const filamentData = buildFilamentLabelDataFromApi(filament)
    const filamentFallback = buildFilamentLabelDataFromParams('8', buildFilamentPrintSearchParams(filament))
    const spoolData = buildSpoolLabelDataFromApi(spool, lookups)
    const spoolFallback = buildSpoolLabelDataFromParams('42', buildSpoolPrintSearchParams(spool, lookups))
    for (const data of [filamentData, filamentFallback, spoolData, spoolFallback]) {
      expect(data.is_discontinued).toBe(expected)
      expect(renderTemplateText('{filament.is_discontinued}', buildSpoolDesignerDataFromLabelData(data))).toBe(expected)
    }
    expect(renderTemplateText('{filament.is_discontinued}', buildSpoolDataFromApiSpool(spool, lookups))).toBe(expected)
  })

  it.each(nativeFields)('roundtrips native filament.%s through spool query fallback', (key, _value, expected) => {
    const spool = { ...apiSpool, filament: nativeFilament }
    const fallback = buildSpoolLabelDataFromParams('42', buildSpoolPrintSearchParams(spool, lookups))
    expect(fallback[key]).toBe(expected)
    expect(renderTemplateText(`{filament.${key}}`, buildSpoolDesignerDataFromLabelData(fallback))).toBe(expected)
  })

  it('offers and renders spool-owned tokens in representative single and batch data', () => {
    const spool = { ...apiSpool, rfid_uid_2: 'SECONDARY' }
    const single = buildSpoolDesignerDataFromLabelData(buildSpoolLabelDataFromApi(spool, lookups, '', 'USD'))
    const batch = buildSpoolDataFromApiSpool(spool, lookups, undefined, 'USD')
    for (const [key, value] of Object.entries({ spool_material: 'Cardboard', spool_outer_diameter_mm: '200', spool_width_mm: '65', rfid_uid_2: 'SECONDARY', purchase_currency: 'USD' })) {
      expect(SPOOL_TOKENS).toContainEqual(expect.objectContaining({ token: `{${key}}`, section: key === 'purchase_currency' ? 'purchase' : key === 'rfid_uid_2' ? 'identity' : 'physical' }))
      expect(renderTemplateText(`{${key}}`, single)).toBe(value)
      expect(renderTemplateText(`{${key}}`, batch)).toBe(value)
    }
  })
  it.each(nativeFields)('renders and offers canonical filament.%s through API and query fallbacks', (key, _value, expected) => {
    const spool = { ...apiSpool, filament: nativeFilament }
    const filamentQuery = buildFilamentLabelDataFromParams('8', buildFilamentPrintSearchParams(nativeFilament))
    const canonical = buildCanonicalFilamentLabelData({}, filamentQuery, '8')
    const current = buildCanonicalFilamentLabelData(nativeFilament, buildFilamentLabelDataFromParams('8', new URLSearchParams({ [key]: 'Stale query' })), '8')
    const token = `{filament.${key}}`
    for (const data of [
      buildSpoolDataFromApiSpool(spool, lookups),
      buildSpoolDesignerDataFromLabelData(canonical),
    ]) expect(renderTemplateText(token, data)).toBe(expected)
    expect(current[key]).toBe(expected || 'Stale query')
    expect(FILAMENT_TOKENS.map(choice => choice.token)).toContain(token)
  })

  it('omits all unset native values and optional wrappers without serializing nulls', () => {
    for (const value of [undefined, null]) {
      const filament = Object.fromEntries(nativeFields.map(([key]) => [key, value]))
      const data = buildSpoolDesignerDataFromLabelData(buildFilamentLabelDataFromApi(filament))
      for (const [key] of nativeFields) {
        expect(renderTemplateText(`{filament.${key}}`, data)).toBe('')
        expect(renderTemplateText(`{Value: {filament.${key}}}`, data)).toBe('')
      }
    }
  })

  it('gives every picker choice a section and hides the legacy temperature aliases', () => {
    for (const choice of [...FILAMENT_TOKENS, ...SPOOL_TOKENS]) expect(choice.section).toBeTruthy()
    expect(FILAMENT_TOKENS.map(choice => choice.token)).not.toContain('{filament.extruder_temp}')
    expect(FILAMENT_TOKENS.map(choice => choice.token)).not.toContain('{filament.bed_temp}')
  })

  it('keeps Standard fields focused while retaining complete spool timestamps and weights', () => {
    const spoolKeys = SPOOL_BUILT_IN_LABEL_FIELD_DEFS.map(({ key }) => key)
    const standardKeys = REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS.map(({ key }) => key)

    expect(standardKeys).toContain('filament.extruder_temp')
    expect(standardKeys).toContain('filament.bed_temp')

    expect(spoolKeys).toContain('spool_core_weight_g')
    expect(spoolKeys).toContain('stocked_in_at')
    expect(spoolKeys).toContain('created_at')
  })

  it('continues resolving legacy temperature tokens in saved templates', () => {
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(renderTemplateText('{filament.extruder_temp}', data)).toBe('200–220')
    expect(renderTemplateText('{filament.bed_temp}', data)).toBe('60')
  })

  it('continues rendering every token supported by saved legacy Designer templates', () => {
    const data = buildSpoolDataFromApiSpool(apiSpool, lookups)
    const canonical = buildSpoolLabelDataFromApi(apiSpool, lookups)

    expect(data.location).toBe('Rack A')
    expect(data.status).toBe('Opened')
    expect(data['filament.name']).toBe(canonical.designation)
    expect(data['filament.color']).toBe(canonical.color)
    expect(data.remaining_weight_g).toBe(canonical.remaining_weight_g)

    for (const token of legacyDesignerTokens) {
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
      .toBe('2026/07/25')
    expect(renderTemplateText('{Certified: {extra.spool.certified_at|date}}', data))
      .toBe('Certified: 2026/07/25')
  })

  it('keeps timestamp precision while allowing the date-only modifier', () => {
    const canonical = buildSpoolLabelDataFromApi(apiSpool, lookups)
    const single = buildSpoolDesignerDataFromLabelData(canonical)
    const batch = buildSpoolDataFromApiSpool(apiSpool, lookups)

    expect(single.purchase_date).toBe(formatDateDisplay(canonical.purchase_date))
    expect(batch.purchase_date).toBe(single.purchase_date)

    for (const [key, expected] of [
      ['stocked_in_at', '2026/01/03'], ['last_used_at', '2026/01/04'], ['created_at', '2026/01/01'],
    ] as const) {
      expect(single[key]).toBe(canonical[key])
      expect(batch[key]).toBe(single[key])
      expect(single[key]).toContain(':')
      expect(renderTemplateText(`{${key}|date}`, single)).toBe(expected)
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
