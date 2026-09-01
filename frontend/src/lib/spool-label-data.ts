import {
  buildFilamentLabelDataFromApi,
  type FilamentLabelData,
} from './filament-label-data'
import { buildEntityExtraFieldsForPrint } from './entity-extra-fields'
import { firstLabelValue, toLabelString } from './label-entity-data'
import {
  isBuiltInLabelField,
  scopeLabelExtraField,
  type LabelExtraFieldSource,
  type LabelExtraFieldValue,
} from './label-extra-fields'
import { formatDateDisplay, type SystemExtraFieldDef } from './extra-fields'
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
  spool_core_weight_g: string
  low_weight_threshold_g: string
  stocked_in_at: string
  last_used_at: string
  created_at: string
}

export type SpoolBuiltInLabelFieldDefinition = {
  key: Exclude<keyof SpoolLabelData, keyof FilamentLabelData | 'filament_id'>
  label: string
  tokenLabel: string
  dateOnly?: boolean
}

export const SPOOL_BUILT_IN_LABEL_FIELD_DEFS: SpoolBuiltInLabelFieldDefinition[] = [
  { key: 'lot_number',             label: 'Lot Number',                tokenLabel: 'lot_number' },
  { key: 'external_id',            label: 'External ID',               tokenLabel: 'external_id' },
  { key: 'rfid_uid',               label: 'RFID UID',                  tokenLabel: 'rfid_uid' },
  { key: 'location',               label: 'Location',                  tokenLabel: 'location' },
  { key: 'status',                 label: 'Status',                    tokenLabel: 'status' },
  { key: 'purchase_date',          label: 'Purchase Date',             tokenLabel: 'purchase_date', dateOnly: true },
  { key: 'purchase_price',         label: 'Purchase Price',            tokenLabel: 'purchase_price' },
  { key: 'remaining_weight_g',     label: 'Remaining Weight (g)',      tokenLabel: 'remaining_weight_g' },
  { key: 'initial_total_weight_g', label: 'Initial Weight (g)',        tokenLabel: 'initial_weight_g' },
  { key: 'empty_spool_weight_g',   label: 'Empty Spool Weight (g)',    tokenLabel: 'empty_spool_wt' },
  { key: 'spool_core_weight_g',    label: 'Spool Core Weight (g)',     tokenLabel: 'spool_core_weight_g' },
  { key: 'low_weight_threshold_g', label: 'Low Weight Threshold (g)',  tokenLabel: 'low_weight_g' },
  { key: 'stocked_in_at',          label: 'Stocked In',                tokenLabel: 'stocked_in_at', dateOnly: true },
  { key: 'last_used_at',           label: 'Last Used',                 tokenLabel: 'last_used_at', dateOnly: true },
  { key: 'created_at',             label: 'Created At',                tokenLabel: 'created_at', dateOnly: true },
]

export function buildSpoolStandardModelFields(data: SpoolLabelData) {
  return SPOOL_BUILT_IN_LABEL_FIELD_DEFS.map(definition => ({
    key: definition.key,
    label: definition.label,
    value: definition.dateOnly
      ? formatDateDisplay(data[definition.key])
      : data[definition.key],
  }))
}

export type SpoolDesignerExtraField = LabelExtraFieldValue

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
  { dataKey: 'spool_core_weight_g', params: ['spool_core_weight_g', 'spool_core_wt'] },
  { dataKey: 'low_weight_threshold_g', params: ['low_wt'] },
  { dataKey: 'stocked_in_at', params: ['stocked_in'] },
  { dataKey: 'last_used_at', params: ['last_used'] },
  { dataKey: 'created_at', params: ['created_at'] },
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
    spool_core_weight_g: '',
    low_weight_threshold_g: '',
    stocked_in_at: '',
    last_used_at: '',
    created_at: '',
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
  const manufacturer = filamentRecord.manufacturer
  const manufacturerRecord = manufacturer && typeof manufacturer === 'object'
    ? manufacturer as Record<string, unknown>
    : {}
  const filamentData = buildFilamentLabelDataFromApi(filament, '')
  const relations = resolveSpoolLabelRelations(record, lookups)

  return {
    ...emptySpoolLabelData(firstLabelValue(record.id, fallbackId)),
    ...filamentData,
    id: firstLabelValue(record.id, fallbackId),
    filament_id: firstLabelValue(record.filament_id, filamentRecord.id),
    type: firstLabelValue(filamentRecord.material_type, filamentRecord.type),
    mfr_id: firstLabelValue(manufacturerRecord.id, filamentRecord.manufacturer_id),
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
    spool_core_weight_g: toLabelString(record.spool_core_weight_g),
    low_weight_threshold_g: toLabelString(record.low_weight_threshold_g),
    stocked_in_at: toLabelString(record.stocked_in_at),
    last_used_at: toLabelString(record.last_used_at),
    created_at: toLabelString(record.created_at),
    spool_outer_diameter_mm: firstLabelValue(
      record.spool_outer_diameter_mm,
      filamentRecord.spool_outer_diameter_mm,
      manufacturerRecord.spool_outer_diameter_mm,
    ),
    spool_width_mm: firstLabelValue(
      record.spool_width_mm,
      filamentRecord.spool_width_mm,
      manufacturerRecord.spool_width_mm,
    ),
    spool_material: firstLabelValue(
      record.spool_material,
      filamentRecord.spool_material,
      manufacturerRecord.spool_material,
    ),
  }
}

export function buildSpoolPrintSearchParams(
  spool: unknown,
  lookups: SpoolLabelLookups = EMPTY_SPOOL_LABEL_LOOKUPS,
): URLSearchParams {
  const data = buildSpoolLabelDataFromApi(spool, lookups)
  const params = new URLSearchParams()
  for (const { dataKey, params: names } of SPOOL_LABEL_PARAM_MAP) {
    if (toLabelString(data[dataKey]) !== '') params.set(names[0], data[dataKey])
  }
  return params
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
    .map(field => scopeLabelExtraField(field, source))
}
