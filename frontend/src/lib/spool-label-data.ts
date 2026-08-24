import {
  buildFilamentLabelDataFromApi,
  type FilamentLabelData,
} from './filament-label-data'
import { buildEntityExtraFieldsForPrint } from './entity-extra-fields'
import { firstLabelValue, toLabelString } from './label-entity-data'
import { isBuiltInLabelField, type LabelExtraFieldSource } from './label-extra-fields'
import { type SystemExtraFieldDef } from './extra-fields'
import {
  EMPTY_SPOOL_LABEL_LOOKUPS,
  resolveSpoolLabelRelations,
  type SpoolLabelLookups,
} from './spool-label-lookups'

export interface SpoolLabelData extends FilamentLabelData {
  filament_id: string
  lot_number: string
  external_id: string
  rfid_uid: string
  location: string
  status: string
  purchase_date: string
  purchase_price: string
  remaining_weight_g: string
  initial_total_weight_g: string
  empty_spool_weight_g: string
  low_weight_threshold_g: string
  stocked_in_at: string
  last_used_at: string
}

export interface SpoolDesignerExtraField {
  key: string
  label?: string
  value: unknown
  rawValue?: unknown
  fieldType?: string
  source?: string
}

export type SpoolExtraFieldDefinitionMap = Partial<
  Record<LabelExtraFieldSource, Record<string, SystemExtraFieldDef>>
>

type SpoolLabelParam = {
  dataKey: Exclude<keyof SpoolLabelData, 'id'>
  params: string[]
}

const SPOOL_LABEL_PARAM_MAP: SpoolLabelParam[] = [
  { dataKey: 'filament_id', params: ['filament_id'] },
  { dataKey: 'designation', params: ['designation'] },
  { dataKey: 'manufacturer', params: ['mfr'] },
  { dataKey: 'manufacturer_id', params: ['manufacturer_id', 'mfr_id'] },
  { dataKey: 'type', params: ['type'] },
  { dataKey: 'color', params: ['color'] },
  { dataKey: 'colors', params: ['colors'] },
  { dataKey: 'subtype', params: ['subtype'] },
  { dataKey: 'mfr_id', params: ['mfr_id'] },
  { dataKey: 'hex_code', params: ['hex_code'] },
  { dataKey: 'color_hexes', params: ['color_hexes'] },
  { dataKey: 'extruder_temp', params: ['extruder_temp'] },
  { dataKey: 'bed_temp', params: ['bed_temp'] },
  { dataKey: 'raw_material_weight_g', params: ['raw_material_weight_g', 'weight'] },
  { dataKey: 'weight', params: ['weight'] },
  { dataKey: 'diameter', params: ['diameter'] },
  { dataKey: 'finish', params: ['finish'] },
  { dataKey: 'density', params: ['density'] },
  { dataKey: 'price', params: ['price'] },
  { dataKey: 'manufacturer_color_name', params: ['color_name'] },
  { dataKey: 'default_spool_weight_g', params: ['default_spool_wt'] },
  { dataKey: 'spool_outer_diameter_mm', params: ['spool_outer_dia'] },
  { dataKey: 'spool_width_mm', params: ['spool_width'] },
  { dataKey: 'spool_material', params: ['spool_material'] },
  { dataKey: 'shop_url', params: ['shop_url'] },
  { dataKey: 'color_mode', params: ['color_mode'] },
  { dataKey: 'multi_color_style', params: ['multi_color_style'] },
  { dataKey: 'lot_number', params: ['lot'] },
  { dataKey: 'external_id', params: ['ext_id'] },
  { dataKey: 'rfid_uid', params: ['rfid'] },
  { dataKey: 'location', params: ['location'] },
  { dataKey: 'status', params: ['status'] },
  { dataKey: 'purchase_date', params: ['purchase_date'] },
  { dataKey: 'purchase_price', params: ['purchase_price'] },
  { dataKey: 'remaining_weight_g', params: ['remaining_wt'] },
  { dataKey: 'initial_total_weight_g', params: ['initial_wt'] },
  { dataKey: 'empty_spool_weight_g', params: ['empty_spool_wt'] },
  { dataKey: 'low_weight_threshold_g', params: ['low_wt'] },
  { dataKey: 'stocked_in_at', params: ['stocked_in'] },
  { dataKey: 'last_used_at', params: ['last_used'] },
]

function emptySpoolLabelData(id: string): SpoolLabelData {
  return {
    ...buildFilamentLabelDataFromApi({}, id),
    filament_id: '',
    lot_number: '',
    external_id: '',
    rfid_uid: '',
    location: '',
    status: '',
    purchase_date: '',
    purchase_price: '',
    remaining_weight_g: '',
    initial_total_weight_g: '',
    empty_spool_weight_g: '',
    low_weight_threshold_g: '',
    stocked_in_at: '',
    last_used_at: '',
  }
}

export function buildSpoolLabelDataFromParams(id: string, params: URLSearchParams): SpoolLabelData {
  const data = emptySpoolLabelData(id)
  for (const { dataKey, params: names } of SPOOL_LABEL_PARAM_MAP) {
    data[dataKey] = firstLabelValue(...names.map(name => params.get(name)))
  }
  return data
}

export function buildSpoolLabelDataFromApi(
  spool: unknown,
  lookups: SpoolLabelLookups = EMPTY_SPOOL_LABEL_LOOKUPS,
  fallbackId: string | number = '',
): SpoolLabelData {
  const record = spool && typeof spool === 'object'
    ? spool as Record<string, unknown>
    : {}
  const filament = record.filament
  const filamentRecord = filament && typeof filament === 'object'
    ? filament as Record<string, unknown>
    : {}
  const filamentData = buildFilamentLabelDataFromApi(filament, '')
  const relations = resolveSpoolLabelRelations(record, lookups)

  return {
    ...emptySpoolLabelData(firstLabelValue(record.id, fallbackId)),
    ...filamentData,
    id: firstLabelValue(record.id, fallbackId),
    filament_id: toLabelString(filamentRecord.id),
    extruder_temp: toLabelString(
      filamentRecord.settings_extruder_temp
        ?? (filamentRecord.custom_fields as Record<string, unknown> | undefined)?.extruder_temp,
    ),
    bed_temp: toLabelString(
      filamentRecord.settings_bed_temp
        ?? (filamentRecord.custom_fields as Record<string, unknown> | undefined)?.bed_temp,
    ),
    lot_number: toLabelString(record.lot_number),
    external_id: toLabelString(record.external_id),
    rfid_uid: toLabelString(record.rfid_uid),
    location: relations.location,
    status: relations.status,
    purchase_date: toLabelString(record.purchase_date),
    purchase_price: toLabelString(record.purchase_price),
    remaining_weight_g: toLabelString(record.remaining_weight_g),
    initial_total_weight_g: toLabelString(record.initial_total_weight_g),
    empty_spool_weight_g: toLabelString(record.empty_spool_weight_g),
    low_weight_threshold_g: toLabelString(record.low_weight_threshold_g),
    stocked_in_at: toLabelString(record.stocked_in_at),
    last_used_at: toLabelString(record.last_used_at),
  }
}

export function mergeMissingSpoolLabelData(target: SpoolLabelData, source: SpoolLabelData): void {
  for (const key of Object.keys(target) as (keyof SpoolLabelData)[]) {
    if (toLabelString(target[key]) === '' && toLabelString(source[key]) !== '') {
      target[key] = source[key]
    }
  }
}

export function buildDesignerExtraFieldsFromApiSpool(
  spool: unknown,
  fieldDefs?: SpoolExtraFieldDefinitionMap,
): SpoolDesignerExtraField[] {
  const record = spool && typeof spool === 'object'
    ? spool as Record<string, unknown>
    : {}
  const filament = record.filament && typeof record.filament === 'object'
    ? record.filament as Record<string, unknown>
    : {}
  return [
    ...buildDesignerExtraFields(
      record.custom_fields as Record<string, unknown> | undefined,
      record.custom_field_definitions as Record<string, unknown> | undefined,
      fieldDefs?.spool,
      'spool',
    ),
    ...buildDesignerExtraFields(
      filament.custom_fields as Record<string, unknown> | undefined,
      filament.custom_field_definitions as Record<string, unknown> | undefined,
      fieldDefs?.filament,
      'filament',
    ),
  ]
}

function buildDesignerExtraFields(
  values: Record<string, unknown> | undefined,
  entityDefinitions: Record<string, unknown> | undefined,
  systemDefinitions: Record<string, SystemExtraFieldDef> | undefined,
  source: LabelExtraFieldSource,
): SpoolDesignerExtraField[] {
  return buildEntityExtraFieldsForPrint(values, entityDefinitions, systemDefinitions)
    .filter(field => !isBuiltInLabelField(source, field.key, field.label))
    .map(field => ({
      key: `${source}.${field.key}`,
      label: field.label,
      value: field.value,
      rawValue: field.rawValue,
      fieldType: field.fieldType,
      source,
    }))
}
