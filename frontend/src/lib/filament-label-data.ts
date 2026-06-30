/* eslint-disable @typescript-eslint/no-explicit-any */

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

export interface FilamentExtraField {
  key: string
  label: string
  value: string
  source?: string
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

function toLabelString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function hasDisplayValue(value: unknown): boolean {
  return toLabelString(value) !== ''
}

export function getFirstFilamentColor(filament: any): any {
  const colorLists = [filament?.filament_colors, filament?.colors]
  for (const list of colorLists) {
    if (Array.isArray(list) && list.length > 0) return list[0] ?? {}
  }
  return {}
}

function getFilamentColors(filament: any): any[] {
  const list = Array.isArray(filament?.filament_colors)
    ? filament.filament_colors
    : filament?.colors
  return Array.isArray(list) ? list : []
}

function getFilamentColorNames(filament: any): string {
  return getFilamentColors(filament)
    .map(color => color?.display_name_override || color?.color?.name)
    .filter(Boolean)
    .join(', ')
}

function getFilamentColorHexes(filament: any): string {
  return getFilamentColors(filament)
    .map(color => color?.color?.hex_code)
    .filter(Boolean)
    .join(', ')
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

export function buildFilamentLabelDataFromApi(filament: any, fallbackId: string | number = ''): FilamentLabelData {
  const firstColor = getFirstFilamentColor(filament)
  const color = firstColor?.display_name_override
    || filament?.manufacturer_color_name
    || firstColor?.color?.name
    || ''
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
    extruder_temp: toLabelString(filament?.settings_extruder_temp),
    bed_temp: toLabelString(filament?.settings_bed_temp),
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
  { key: 'filament.extruder_temp', label: 'Extruder Temp (°C)', dataKey: 'extruder_temp', valueFromApi: f => toLabelString(f?.settings_extruder_temp) },
  { key: 'filament.bed_temp',      label: 'Bed Temp (°C)',      dataKey: 'bed_temp',      valueFromApi: f => toLabelString(f?.settings_bed_temp) },
  { key: 'filament.diameter',      label: 'Diameter (mm)',      dataKey: 'diameter',      valueFromApi: f => toLabelString(f?.diameter_mm) },
  { key: 'filament.density',       label: 'Density (g/cm³)',    dataKey: 'density',       valueFromApi: f => toLabelString(f?.density_g_cm3) },
  { key: 'filament.weight',        label: 'Weight (g)',         dataKey: 'weight',        valueFromApi: f => toLabelString(f?.raw_material_weight_g ?? f?.weight) },
  { key: 'filament.finish',        label: 'Finish',             dataKey: 'finish',        valueFromApi: f => toLabelString(f?.finish_type) },
  { key: 'filament.price',         label: 'Price',              dataKey: 'price',         valueFromApi: f => toLabelString(f?.price) },
]

export function buildReducedStandardFilamentExtraFieldsFromLabelData(data: FilamentLabelData): FilamentExtraField[] {
  return REDUCED_STANDARD_FILAMENT_EXTRA_FIELD_DEFS
    .map(def => ({ key: def.key, label: def.label, value: data[def.dataKey], source: 'filament' }))
    .filter(field => hasDisplayValue(field.value))
}

export function buildFilamentExtraFieldsForPrint(
  filament: any,
  systemFieldMap: Record<string, { label?: string }>,
): FilamentExtraField[] {
  const fields = buildReducedStandardFilamentExtraFieldsFromLabelData(buildFilamentLabelDataFromApi(filament))
  const customFlat: Record<string, unknown> = filament?.custom_fields ?? {}
  for (const [key, def] of Object.entries(systemFieldMap)) {
    const raw = customFlat[key]
    fields.push({
      key: `filament.${key}`,
      label: def.label ?? key,
      value: toLabelString(raw),
      source: 'filament',
    })
  }
  for (const [key, value] of Object.entries(customFlat)) {
    if (!systemFieldMap[key]) {
      fields.push({
        key: `filament.${key}`,
        label: key,
        value: toLabelString(value),
        source: 'filament',
      })
    }
  }
  return fields
}

export function buildDesignerExtraFieldsFromFilament(filament: any): FilamentExtraField[] {
  const customFields = filament?.custom_fields ?? {}
  return Object.entries(customFields as Record<string, unknown>).map(([key, value]) => ({
    key: `filament.${key}`,
    label: key,
    value: toLabelString(value),
    source: 'filament',
  }))
}
