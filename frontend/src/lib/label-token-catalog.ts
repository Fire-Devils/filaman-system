import { SPOOL_BUILT_IN_LABEL_FIELD_DEFS } from './spool-label-data'

export interface LabelTokenChoice {
  token: string
  label: string
  section: string
}

/** Shared filament/general choices preserve the legacy designer token contract. */
export const FILAMENT_TOKENS: readonly LabelTokenChoice[] = [
  { token: '{color_swatch[1]}', label: 'color_swatch', section: 'identity' },
  { token: '{id}', label: 'id', section: 'identity' },
  { token: '{filament.id}', label: 'filament_id', section: 'identity' },
  { token: '{filament.name}', label: 'name', section: 'identity' },
  { token: '{filament.manufacturer}', label: 'manufacturer', section: 'identity' },
  { token: '{filament.manufacturer_id}', label: 'manufacturer_id', section: 'identity' },
  { token: '{filament.type}', label: 'type', section: 'material' },
  { token: '{filament.subtype}', label: 'subtype', section: 'material' },
  { token: '{filament.manufacturer_color_name}', label: 'color_name', section: 'identity' },
  { token: '{filament.color}', label: 'color', section: 'identity' },
  { token: '{filament.colors}', label: 'colors', section: 'identity' },
  { token: '{filament.color_hex}', label: 'color_hex', section: 'identity' },
  { token: '{filament.color_hexes}', label: 'color_hexes', section: 'identity' },
  { token: '{filament.color_mode}', label: 'color_mode', section: 'identity' },
  { token: '{filament.multi_color_style}', label: 'multi_color_style', section: 'identity' },
  { token: '{filament.raw_material_weight_g}', label: 'raw_material_weight_g', section: 'material' },
  { token: '{filament.diameter}', label: 'diameter', section: 'material' },
  { token: '{filament.finish}', label: 'finish', section: 'material' },
  { token: '{filament.density}', label: 'density', section: 'material' },
  { token: '{filament.price}', label: 'price', section: 'material' },
  { token: '{filament.default_spool_weight_g}', label: 'default_spool_wt', section: 'packaging' },
  { token: '{filament.spool_outer_diameter_mm}', label: 'spool_outer_dia', section: 'packaging' },
  { token: '{filament.spool_width_mm}', label: 'spool_width', section: 'packaging' },
  { token: '{filament.spool_material}', label: 'spool_material', section: 'packaging' },
  { token: '{filament.shop_url}', label: 'shop_url', section: 'identity' },
  { token: '{filament.extruder_temp_range_c}', label: 'extruder_temp_range_c', section: 'temperatures' },
  { token: '{filament.bed_temp_range_c}', label: 'bed_temp_range_c', section: 'temperatures' },
  { token: '{filament.manufacturer_sku}', label: 'manufacturer_sku', section: 'identity' },
  { token: '{filament.datasheet_url}', label: 'datasheet_url', section: 'identity' },
  { token: '{filament.image_url}', label: 'image_url', section: 'identity' },
  { token: '{filament.is_discontinued}', label: 'is_discontinued', section: 'identity' },
  { token: '{filament.drying_temp_c}', label: 'drying_temp_c', section: 'drying' },
  { token: '{filament.drying_time_hours}', label: 'drying_time_hours', section: 'drying' },
  { token: '{filament.softening_temp_c}', label: 'softening_temp_c', section: 'temperatures' },
  { token: '{filament.cooling_fan_range_percent}', label: 'cooling_fan_range_percent', section: 'print_behavior' },
  { token: '{filament.chamber_temp_c}', label: 'chamber_temp_c', section: 'temperatures' },
  { token: '{filament.max_volumetric_speed_mm3_s}', label: 'max_volumetric_speed_mm3_s', section: 'print_behavior' },
  { token: '{filament.flow_ratio}', label: 'flow_ratio', section: 'print_behavior' },
  { token: '{filament.pressure_advance_k}', label: 'pressure_advance_k', section: 'print_behavior' },
  { token: '{filament.ams_compatibility}', label: 'ams_compatibility', section: 'compatibility' },
  { token: '{filament.build_plate_compatibility}', label: 'build_plate_compatibility', section: 'compatibility' },
  { token: '{filament.price_currency}', label: 'price_currency', section: 'material' },
]

/** Spool-only choices share the Standard label field definitions. */
const SPOOL_TOKEN_SECTIONS: Record<string, string> = {
  lot_number: 'identity',
  external_id: 'identity',
  rfid_uid: 'identity',
  location: 'inventory',
  status: 'inventory',
  purchase_date: 'purchase',
  purchase_price: 'purchase',
  remaining_weight_g: 'physical',
  initial_total_weight_g: 'physical',
  empty_spool_weight_g: 'physical',
  spool_core_weight_g: 'physical',
  low_weight_threshold_g: 'physical',
  stocked_in_at: 'lifecycle',
  last_used_at: 'lifecycle',
  created_at: 'lifecycle',
}

export const SPOOL_TOKENS: readonly LabelTokenChoice[] = SPOOL_BUILT_IN_LABEL_FIELD_DEFS.map(
  ({ key, tokenLabel }) => ({ token: `{${key}}`, label: tokenLabel, section: SPOOL_TOKEN_SECTIONS[key] }),
)
