import { SPOOL_BUILT_IN_LABEL_FIELD_DEFS } from './spool-label-data'

export interface LabelTokenChoice {
  token: string
  label: string
}

/** Shared filament/general choices preserve the legacy designer token contract. */
export const FILAMENT_TOKENS: readonly LabelTokenChoice[] = [
  { token: '{color_swatch[1]}', label: 'color_swatch' },
  { token: '{id}', label: 'id' },
  { token: '{filament.id}', label: 'filament_id' },
  { token: '{filament.name}', label: 'name' },
  { token: '{filament.manufacturer}', label: 'manufacturer' },
  { token: '{filament.manufacturer_id}', label: 'manufacturer_id' },
  { token: '{filament.type}', label: 'type' },
  { token: '{filament.subtype}', label: 'subtype' },
  { token: '{filament.manufacturer_color_name}', label: 'color_name' },
  { token: '{filament.color}', label: 'color' },
  { token: '{filament.colors}', label: 'colors' },
  { token: '{filament.color_hex}', label: 'color_hex' },
  { token: '{filament.color_hexes}', label: 'color_hexes' },
  { token: '{filament.color_mode}', label: 'color_mode' },
  { token: '{filament.multi_color_style}', label: 'multi_color_style' },
  { token: '{filament.raw_material_weight_g}', label: 'raw_material_weight_g' },
  { token: '{filament.diameter}', label: 'diameter' },
  { token: '{filament.finish}', label: 'finish' },
  { token: '{filament.density}', label: 'density' },
  { token: '{filament.price}', label: 'price' },
  { token: '{filament.default_spool_weight_g}', label: 'default_spool_wt' },
  { token: '{filament.spool_outer_diameter_mm}', label: 'spool_outer_dia' },
  { token: '{filament.spool_width_mm}', label: 'spool_width' },
  { token: '{filament.spool_material}', label: 'spool_material' },
  { token: '{filament.shop_url}', label: 'shop_url' },
]

/** Spool-only choices share the Standard label field definitions. */
export const SPOOL_TOKENS: readonly LabelTokenChoice[] = SPOOL_BUILT_IN_LABEL_FIELD_DEFS.map(
  ({ key, tokenLabel }) => ({ token: `{${key}}`, label: tokenLabel }),
)
