import type { SpoolData } from './label-template'
import {
  buildDesignerExtraFieldsFromApiSpool,
  buildSpoolLabelDataFromApi,
  type SpoolExtraFieldDefinitionMap,
} from './spool-label-data'
import {
  EMPTY_SPOOL_LABEL_LOOKUPS,
  type SpoolLabelLookups,
} from './spool-label-lookups'
import { formatDateDisplay } from './extra-fields'
import type { LabelExtraFieldValue } from './label-extra-fields'
import { clampFinite } from './freeform-label/geometry'
import { renderFreeformLabel } from './freeform-label/render'
import type { LabelDesignV2 } from './freeform-label/types'

export function getDesignerLabelDimensions(design: LabelDesignV2) {
  return {
    widthMm: clampFinite(Number(design.label.widthMm), 20, 300, 60),
    heightMm: clampFinite(Number(design.label.heightMm), 10, 200, 40),
  }
}

export type DesignerExtraField = LabelExtraFieldValue

export interface DesignerFlatLabelData {
  id: string | number
  filament_id?: unknown
  designation?: unknown
  manufacturer?: unknown
  manufacturer_id?: unknown
  type?: unknown
  subtype?: unknown
  color?: unknown
  colors?: unknown
  hex_code?: unknown
  color_hexes?: unknown
  color_mode?: unknown
  multi_color_style?: unknown
  extruder_temp?: unknown
  bed_temp?: unknown
  raw_material_weight_g?: unknown
  weight?: unknown
  diameter?: unknown
  finish?: unknown
  density?: unknown
  price?: unknown
  manufacturer_color_name?: unknown
  default_spool_weight_g?: unknown
  spool_outer_diameter_mm?: unknown
  spool_width_mm?: unknown
  spool_material?: unknown
  shop_url?: unknown
  lot_number?: unknown
  external_id?: unknown
  rfid_uid?: unknown
  location?: unknown
  status?: unknown
  purchase_date?: unknown
  purchase_price?: unknown
  remaining_weight_g?: unknown
  initial_total_weight_g?: unknown
  empty_spool_weight_g?: unknown
  spool_core_weight_g?: unknown
  low_weight_threshold_g?: unknown
  stocked_in_at?: unknown
  last_used_at?: unknown
  created_at?: unknown
  extraFields?: DesignerExtraField[]
}

const toStringValue = (value: unknown): string => (
  value === undefined || value === null ? '' : String(value)
)

export function buildSpoolDataFromFlatLabel(data: DesignerFlatLabelData): SpoolData {
  const extra: Record<string, string> = {}
  const extraRaw: Record<string, unknown> = {}
  for (const ef of data.extraFields ?? []) {
    if (!ef?.key) continue
    extra[ef.key] = ef.value === undefined || ef.value === null ? '' : String(ef.value)
    extraRaw[ef.key] = ef.rawValue ?? ef.value
  }
  const rawMaterialWeight = data.raw_material_weight_g ?? data.weight
  return {
    id: data.id,
    'filament.id': toStringValue(data.filament_id ?? data.id),
    'filament.name': toStringValue(data.designation),
    'filament.type': toStringValue(data.type),
    'filament.subtype': toStringValue(data.subtype),
    // Retain aliases used by already-saved templates.
    'filament.material': toStringValue(data.type),
    'filament.color': toStringValue(data.color),
    'filament.colors': toStringValue(data.colors ?? data.color),
    'filament.color_hex': toStringValue(data.hex_code),
    'filament.color_hexes': toStringValue(data.color_hexes ?? data.hex_code),
    'filament.color_mode': toStringValue(data.color_mode),
    'filament.multi_color_style': toStringValue(data.multi_color_style),
    'filament.manufacturer': toStringValue(data.manufacturer),
    'filament.manufacturer_id': toStringValue(data.manufacturer_id),
    'filament.extruder_temp': toStringValue(data.extruder_temp),
    'filament.bed_temp': toStringValue(data.bed_temp),
    'filament.raw_material_weight_g': toStringValue(rawMaterialWeight),
    'filament.weight': toStringValue(rawMaterialWeight),
    'filament.diameter': toStringValue(data.diameter),
    'filament.finish': toStringValue(data.finish),
    'filament.density': toStringValue(data.density),
    'filament.price': toStringValue(data.price),
    'filament.manufacturer_color_name': toStringValue(data.manufacturer_color_name),
    'filament.default_spool_weight_g': toStringValue(data.default_spool_weight_g),
    'filament.spool_outer_diameter_mm': toStringValue(data.spool_outer_diameter_mm),
    'filament.spool_width_mm': toStringValue(data.spool_width_mm),
    'filament.spool_material': toStringValue(data.spool_material),
    'filament.shop_url': toStringValue(data.shop_url),
    lot_number: toStringValue(data.lot_number),
    external_id: toStringValue(data.external_id),
    rfid_uid: toStringValue(data.rfid_uid),
    location: toStringValue(data.location),
    status: toStringValue(data.status),
    purchase_date: toStringValue(data.purchase_date),
    purchase_price: toStringValue(data.purchase_price),
    remaining_weight_g: toStringValue(data.remaining_weight_g),
    initial_total_weight_g: toStringValue(data.initial_total_weight_g),
    empty_spool_weight_g: toStringValue(data.empty_spool_weight_g),
    spool_core_weight_g: toStringValue(data.spool_core_weight_g),
    low_weight_threshold_g: toStringValue(data.low_weight_threshold_g),
    stocked_in_at: toStringValue(data.stocked_in_at),
    last_used_at: toStringValue(data.last_used_at),
    created_at: toStringValue(data.created_at),
    extra,
    extraRaw,
  }
}

export function buildSpoolDesignerDataFromLabelData(
  data: DesignerFlatLabelData,
): SpoolData {
  return buildSpoolDataFromFlatLabel({
    ...data,
    purchase_date: formatDateDisplay(data.purchase_date),
  })
}

export function buildSpoolDataFromApiSpool(
  spool: unknown,
  lookups: SpoolLabelLookups = EMPTY_SPOOL_LABEL_LOOKUPS,
  fieldDefs?: SpoolExtraFieldDefinitionMap,
): SpoolData {
  const data = buildSpoolLabelDataFromApi(spool, lookups)
  return buildSpoolDesignerDataFromLabelData({
    ...data,
    extraFields: buildDesignerExtraFieldsFromApiSpool(spool, fieldDefs),
  })
}

export interface RenderDesignerLabelOptions {
  element: HTMLElement
  design: LabelDesignV2
  data: SpoolData
  logoUrl?: string | null
  previewBorder?: boolean
  isStale?: () => boolean
  entityPath?: string
  resolveAssetUrl?: (assetId: string) => string | null | Promise<string | null>
  interactive?: boolean
}

export async function renderDesignerLabel(options: RenderDesignerLabelOptions) {
  if (!options.design || options.design.version !== 2) {
    throw new Error('A version 2 label design is required')
  }
  await renderFreeformLabel({
    element: options.element,
    design: options.design,
    data: options.data,
    logoUrl: options.logoUrl,
    resolveAssetUrl: options.resolveAssetUrl,
    previewBorder: options.previewBorder,
    interactive: options.interactive,
    isStale: options.isStale,
    entityPath: options.entityPath === 'filaments' ? 'filaments' : 'spools',
  })
}
