export type LabelExtraFieldSource = 'spool' | 'filament'

const BUILT_IN_FIELD_NAMES: Record<LabelExtraFieldSource, Set<string>> = {
  filament: new Set([
    'color_swatch',
    'id',
    'filament_id',
    'name',
    'manufacturer',
    'manufacturer_id',
    'type',
    'subtype',
    'color_name',
    'manufacturer_color_name',
    'color',
    'colors',
    'color_hex',
    'color_hexes',
    'color_mode',
    'multi_color_style',
    'extruder_temp',
    'settings_extruder_temp',
    'bed_temp',
    'settings_bed_temp',
    'raw_material_weight_g',
    'weight',
    'diameter',
    'diameter_mm',
    'finish',
    'finish_type',
    'density',
    'density_g_cm3',
    'price',
    'default_spool_weight_g',
    'spool_outer_diameter_mm',
    'spool_width_mm',
    'spool_material',
    'shop_url',
  ]),
  spool: new Set([
    'lot_number',
    'external_id',
    'ext_id',
    'rfid_uid',
    'rfid',
    'location',
    'status',
    'purchase_date',
    'purchase_price',
    'remaining_weight_g',
    'remaining_wt',
    'initial_total_weight_g',
    'initial_weight_g',
    'empty_spool_weight_g',
    'empty_spool_wt',
    'low_weight_threshold_g',
    'low_wt',
    'stocked_in_at',
    'stocked_in',
    'last_used_at',
    'last_used',
  ]),
}

export function normalizeLabelFieldName(value: string) {
  return value
    .replace(/^(spool|filament)\./i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_.]/g, '')
}

export function isBuiltInLabelField(source: LabelExtraFieldSource | string, key: string, label?: string) {
  if (source !== 'spool' && source !== 'filament') return false
  const names = BUILT_IN_FIELD_NAMES[source]
  return names.has(normalizeLabelFieldName(key)) || (label ? names.has(normalizeLabelFieldName(label)) : false)
}
