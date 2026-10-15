/* eslint-disable @typescript-eslint/no-explicit-any */
import { isBuiltInLabelField, scopeLabelExtraField, type LabelExtraFieldValue } from './label-extra-fields'
import { formatNumericRange, type SystemExtraFieldDef } from './extra-fields'
import { buildEntityExtraFieldsForPrint } from './entity-extra-fields'
import {
  firstLabelValue,
  getFilamentColorHexes,
  getFilamentColorNames,
  getFirstFilamentColor,
  toLabelString,
} from './label-entity-data'

export { getFirstFilamentColor } from './label-entity-data'

export interface FilamentLabelData {
  id: string
  designation: string
  manufacturer: string
  manufacturer_id: string
  type: string
  color: string
  colors: string
  color_hexes: string
  subtype: string
  mfr_id: string
  hex_code: string
  extruder_temp: string
  bed_temp: string
  extruder_temp_range_c: string
  bed_temp_range_c: string
  manufacturer_sku: string
  datasheet_url: string
  image_url: string
  is_discontinued: string
  drying_temp_c: string
  drying_time_hours: string
  softening_temp_c: string
  cooling_fan_range_percent: string
  chamber_temp_c: string
  max_volumetric_speed_mm3_s: string
  flow_ratio: string
  pressure_advance_k: string
  ams_compatibility: string
  build_plate_compatibility: string
  price_currency: string
  raw_material_weight_g: string
  weight: string
  diameter: string
  finish: string
  density: string
  price: string
  manufacturer_color_name: string
  default_spool_weight_g: string
  spool_outer_diameter_mm: string
  spool_width_mm: string
  spool_material: string
  shop_url: string
  color_mode: string
  multi_color_style: string
}

export interface FilamentExtraField extends LabelExtraFieldValue {
  label: string
  value: string
}

type FilamentExtraFieldDefinition = {
  key: string
  label: string
  dataKey: keyof FilamentLabelData
  valueFromApi: (filament: any) => string
}

const LABEL_PARAM_MAP: { dataKey: keyof FilamentLabelData; param: string }[] = [
  { dataKey: 'designation', param: 'designation' },
  { dataKey: 'manufacturer', param: 'mfr' },
  { dataKey: 'manufacturer_id', param: 'manufacturer_id' },
  { dataKey: 'type', param: 'type' },
  { dataKey: 'color', param: 'color' },
  { dataKey: 'colors', param: 'colors' },
  { dataKey: 'color_hexes', param: 'color_hexes' },
  { dataKey: 'subtype', param: 'subtype' },
  { dataKey: 'mfr_id', param: 'mfr_id' },
  { dataKey: 'hex_code', param: 'hex_code' },
  { dataKey: 'extruder_temp', param: 'extruder_temp' },
  { dataKey: 'bed_temp', param: 'bed_temp' },
  { dataKey: 'extruder_temp_range_c', param: 'extruder_temp_range_c' },
  { dataKey: 'bed_temp_range_c', param: 'bed_temp_range_c' },
  { dataKey: 'manufacturer_sku', param: 'manufacturer_sku' },
  { dataKey: 'datasheet_url', param: 'datasheet_url' },
  { dataKey: 'image_url', param: 'image_url' },
  { dataKey: 'is_discontinued', param: 'is_discontinued' },
  { dataKey: 'drying_temp_c', param: 'drying_temp_c' },
  { dataKey: 'drying_time_hours', param: 'drying_time_hours' },
  { dataKey: 'softening_temp_c', param: 'softening_temp_c' },
  { dataKey: 'cooling_fan_range_percent', param: 'cooling_fan_range_percent' },
  { dataKey: 'chamber_temp_c', param: 'chamber_temp_c' },
  { dataKey: 'max_volumetric_speed_mm3_s', param: 'max_volumetric_speed_mm3_s' },
  { dataKey: 'flow_ratio', param: 'flow_ratio' },
  { dataKey: 'pressure_advance_k', param: 'pressure_advance_k' },
  { dataKey: 'ams_compatibility', param: 'ams_compatibility' },
  { dataKey: 'build_plate_compatibility', param: 'build_plate_compatibility' },
  { dataKey: 'price_currency', param: 'price_currency' },
  { dataKey: 'raw_material_weight_g', param: 'raw_material_weight_g' },
  { dataKey: 'weight', param: 'weight' },
  { dataKey: 'diameter', param: 'diameter' },
  { dataKey: 'finish', param: 'finish' },
  { dataKey: 'density', param: 'density' },
  { dataKey: 'price', param: 'price' },
  { dataKey: 'manufacturer_color_name', param: 'color_name' },
  { dataKey: 'default_spool_weight_g', param: 'default_spool_wt' },
  { dataKey: 'spool_outer_diameter_mm', param: 'spool_outer_dia' },
  { dataKey: 'spool_width_mm', param: 'spool_width' },
  { dataKey: 'spool_material', param: 'spool_material' },
  { dataKey: 'shop_url', param: 'shop_url' },
  { dataKey: 'color_mode', param: 'color_mode' },
  { dataKey: 'multi_color_style', param: 'multi_color_style' },
]

function hasDisplayValue(value: unknown): boolean {
  return toLabelString(value) !== ''
}

export function buildFilamentLabelDataFromParams(id: string, params: URLSearchParams): FilamentLabelData {
  const data: FilamentLabelData = {
    id,
    designation: '',
    manufacturer: '',
    manufacturer_id: '',
    type: '',
    color: '',
    colors: '',
    color_hexes: '',
    subtype: '',
    mfr_id: '',
    hex_code: '',
    extruder_temp: '',
    bed_temp: '',
    extruder_temp_range_c: '',
    bed_temp_range_c: '',
    manufacturer_sku: '',
    datasheet_url: '',
    image_url: '',
    is_discontinued: '',
    drying_temp_c: '',
    drying_time_hours: '',
    softening_temp_c: '',
    cooling_fan_range_percent: '',
    chamber_temp_c: '',
    max_volumetric_speed_mm3_s: '',
    flow_ratio: '',
    pressure_advance_k: '',
    ams_compatibility: '',
    build_plate_compatibility: '',
    price_currency: '',
    raw_material_weight_g: '',
    weight: '',
    diameter: '',
    finish: '',
    density: '',
    price: '',
    manufacturer_color_name: '',
    default_spool_weight_g: '',
    spool_outer_diameter_mm: '',
    spool_width_mm: '',
    spool_material: '',
    shop_url: '',
    color_mode: '',
    multi_color_style: '',
  }
  for (const { dataKey, param } of LABEL_PARAM_MAP) {
    data[dataKey] = params.get(param) || ''
  }
  return data
}

function getLegacyTemperatureValue(filament: any, field: 'extruder_temp' | 'bed_temp'): string {
  const settingsField = `settings_${field}`
  const customFields = filament?.custom_fields as Record<string, unknown> | undefined
  const standardValue = field === 'extruder_temp' ? filament?.extruder_temp_range_c : filament?.bed_temp_range_c
  return toLabelString(
    formatNumericRange(standardValue) ||
      (filament?.[settingsField] ?? customFields?.[field] ?? customFields?.[settingsField]),
  )
}

export function buildFilamentLabelDataFromApi(filament: any, fallbackId: string | number = ''): FilamentLabelData {
  const firstColor = getFirstFilamentColor(filament)
  const color = firstLabelValue(
    firstColor?.display_name_override,
    filament?.manufacturer_color_name,
    firstColor?.color?.name,
  )
  return {
    id: toLabelString(filament?.id ?? fallbackId),
    designation: toLabelString(filament?.designation),
    manufacturer: toLabelString(filament?.manufacturer?.name),
    manufacturer_id: toLabelString(filament?.manufacturer_id ?? filament?.manufacturer?.id),
    type: toLabelString(filament?.material_type),
    color: toLabelString(color),
    colors: getFilamentColorNames(filament),
    color_hexes: getFilamentColorHexes(filament),
    subtype: toLabelString(filament?.material_subgroup),
    mfr_id: toLabelString(filament?.manufacturer?.id),
    hex_code: toLabelString(firstColor?.color?.hex_code),
    extruder_temp: getLegacyTemperatureValue(filament, 'extruder_temp'),
    bed_temp: getLegacyTemperatureValue(filament, 'bed_temp'),
    extruder_temp_range_c: formatNumericRange(filament?.extruder_temp_range_c),
    bed_temp_range_c: formatNumericRange(filament?.bed_temp_range_c),
    manufacturer_sku: toLabelString(filament?.manufacturer_sku),
    datasheet_url: toLabelString(filament?.datasheet_url),
    image_url: toLabelString(filament?.image_url),
    is_discontinued: filament?.is_discontinued == null ? '' : filament.is_discontinued ? 'yes' : 'no',
    drying_temp_c: toLabelString(filament?.drying_temp_c),
    drying_time_hours: toLabelString(filament?.drying_time_hours),
    softening_temp_c: toLabelString(filament?.softening_temp_c),
    cooling_fan_range_percent: formatNumericRange(filament?.cooling_fan_range_percent),
    chamber_temp_c: toLabelString(filament?.chamber_temp_c),
    max_volumetric_speed_mm3_s: toLabelString(filament?.max_volumetric_speed_mm3_s),
    flow_ratio: toLabelString(filament?.flow_ratio),
    pressure_advance_k: toLabelString(filament?.pressure_advance_k),
    ams_compatibility: toLabelString(filament?.ams_compatibility?.join(', ')),
    build_plate_compatibility: toLabelString(filament?.build_plate_compatibility?.join(', ')),
    price_currency: toLabelString(filament?.price_currency),
    raw_material_weight_g: toLabelString(filament?.raw_material_weight_g ?? filament?.weight),
    weight: toLabelString(filament?.raw_material_weight_g ?? filament?.weight),
    diameter: toLabelString(filament?.diameter_mm),
    finish: toLabelString(filament?.finish_type),
    density: toLabelString(filament?.density_g_cm3),
    price: toLabelString(filament?.price),
    manufacturer_color_name: toLabelString(filament?.manufacturer_color_name),
    default_spool_weight_g: toLabelString(filament?.default_spool_weight_g),
    spool_outer_diameter_mm: toLabelString(filament?.spool_outer_diameter_mm),
    spool_width_mm: toLabelString(filament?.spool_width_mm),
    spool_material: toLabelString(filament?.spool_material),
    shop_url: toLabelString(filament?.shop_url),
    color_mode: toLabelString(filament?.color_mode),
    multi_color_style: toLabelString(filament?.multi_color_style),
  }
}

export function mergeMissingFilamentLabelData(target: FilamentLabelData, source: FilamentLabelData) {
  for (const key of Object.keys(target) as (keyof FilamentLabelData)[]) {
    if (!hasDisplayValue(target[key]) && hasDisplayValue(source[key])) {
      target[key] = source[key]
    }
  }
}

export function buildCanonicalFilamentLabelData(
  filament: unknown,
  queryFallback: FilamentLabelData,
  fallbackId: string | number = '',
): FilamentLabelData {
  const canonical = buildFilamentLabelDataFromApi(filament, fallbackId)
  mergeMissingFilamentLabelData(canonical, queryFallback)
  return canonical
}

export function buildFilamentPrintSearchParams(filament: any): URLSearchParams {
  const data = buildFilamentLabelDataFromApi(filament)
  const params = new URLSearchParams()
  for (const { dataKey, param } of LABEL_PARAM_MAP) {
    if (hasDisplayValue(data[dataKey])) params.set(param, data[dataKey])
  }
  return params
}

// Standard labels are intentionally reduced to common, high-signal fields.
// The advanced designer still receives the full filament data for token use.
export const REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS: FilamentExtraFieldDefinition[] = [
  {
    key: 'filament.extruder_temp',
    label: 'Extruder temperature (°C)',
    dataKey: 'extruder_temp',
    valueFromApi: f => getLegacyTemperatureValue(f, 'extruder_temp'),
  },
  {
    key: 'filament.bed_temp',
    label: 'Bed temperature (°C)',
    dataKey: 'bed_temp',
    valueFromApi: f => getLegacyTemperatureValue(f, 'bed_temp'),
  },
  {
    key: 'filament.diameter',
    label: 'Diameter (mm)',
    dataKey: 'diameter',
    valueFromApi: f => toLabelString(f?.diameter_mm),
  },
  {
    key: 'filament.density',
    label: 'Density (g/cm³)',
    dataKey: 'density',
    valueFromApi: f => toLabelString(f?.density_g_cm3),
  },
  {
    key: 'filament.weight',
    label: 'Weight (g)',
    dataKey: 'weight',
    valueFromApi: f => toLabelString(f?.raw_material_weight_g ?? f?.weight),
  },
  {
    key: 'filament.finish',
    label: 'Finish',
    dataKey: 'finish',
    valueFromApi: f => toLabelString(f?.finish_type),
  },
  {
    key: 'filament.price',
    label: 'Price',
    dataKey: 'price',
    valueFromApi: f => toLabelString(f?.price),
  },
]

export function buildReducedStandardFilamentExtraFieldsFromLabelData(data: FilamentLabelData): FilamentExtraField[] {
  return REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS.map(def => ({
    key: def.key,
    label: def.label,
    value: data[def.dataKey],
    source: 'filament',
  })).filter(field => hasDisplayValue(field.value))
}

export function buildFilamentExtraFieldsForPrint(
  filament: any,
  systemFieldMap: Record<string, Partial<SystemExtraFieldDef> & { label?: string }>,
): FilamentExtraField[] {
  const fields = buildReducedStandardFilamentExtraFieldsFromLabelData(buildFilamentLabelDataFromApi(filament))
  const customFields = buildEntityExtraFieldsForPrint(
    filament?.custom_fields,
    filament?.custom_field_definitions,
    systemFieldMap as Record<string, SystemExtraFieldDef>,
    true,
  )
  for (const field of customFields) {
    if (isBuiltInLabelField('filament', field.key, field.label)) continue
    fields.push(scopeLabelExtraField(field, 'filament'))
  }
  return fields
}

export function buildDesignerExtraFieldsFromFilament(
  filament: any,
  systemFieldMap: Record<string, Partial<SystemExtraFieldDef> & { label?: string }> = {},
): FilamentExtraField[] {
  return buildEntityExtraFieldsForPrint(
    filament?.custom_fields,
    filament?.custom_field_definitions,
    systemFieldMap as Record<string, SystemExtraFieldDef>,
  )
    .filter(field => !isBuiltInLabelField('filament', field.key, field.label))
    .map(field => scopeLabelExtraField(field, 'filament'))
}
