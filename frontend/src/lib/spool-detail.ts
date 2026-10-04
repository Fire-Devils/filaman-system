export interface SpoolDetailField {
  type: 'number' | 'text' | 'date' | 'select'
  step?: string
  options?: string[]
  unit?: string
}

export interface SpoolDetailRow {
  key: string
  labelKey: string
  value: string
  field?: SpoolDetailField
}

export interface SpoolDetailSection {
  key: string
  titleKey: string
  rows: SpoolDetailRow[]
}

interface SpoolDetailData {
  [key: string]: unknown
  status?: string
  remaining?: string
  location?: string
  initial_total_weight_g?: number | null
  empty_spool_weight_g?: number | null
  spool_core_weight_g?: number | null
  spool_material?: string | null
  spool_outer_diameter_mm?: number | null
  spool_width_mm?: number | null
  low_weight_threshold_g?: number | null
  purchase_price?: number | null
  purchase_date?: string | null
  lot_number?: string | null
  external_id?: string | null
  rfid?: string | null
}

interface SpoolDetailDisplay {
  coreDisabled?: string
  coreGlobalDefault?: string
}

const empty = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value)
const weight = (value: unknown) => value === null || value === undefined || value === '' ? '—' : `${value} g`
const millimeters = (value: unknown) => value === null || value === undefined || value === '' ? '—' : `${value} mm`

export function formatSpoolDate(value: string | null | undefined): string | null {
  return value ? value.split('T')[0] : null
}

export function buildSpoolDetailSections(spool: SpoolDetailData, display: SpoolDetailDisplay = {}): SpoolDetailSection[] {
  return [
    {
      key: 'inventory',
      titleKey: 'spools.inventoryDetails',
      rows: [
        { key: 'status', labelKey: 'spools.status', value: empty(spool.status) },
        { key: 'remaining', labelKey: 'spools.remaining', value: empty(spool.remaining) },
        { key: 'location', labelKey: 'spools.location', value: empty(spool.location) },
        { key: 'low_weight_threshold_g', labelKey: 'spools.lowThresholdLabel', value: weight(spool.low_weight_threshold_g), field: { type: 'number', step: '1', unit: 'g' } },
      ],
    },
    {
      key: 'spool',
      titleKey: 'spools.spoolDetails',
      rows: [
        { key: 'initial_total_weight_g', labelKey: 'spools.initialWeightLabel', value: weight(spool.initial_total_weight_g), field: { type: 'number', step: '1', unit: 'g' } },
        { key: 'empty_spool_weight_g', labelKey: 'spools.emptySpoolWeightLabel', value: weight(spool.empty_spool_weight_g), field: { type: 'number', step: '1', unit: 'g' } },
        {
          key: 'spool_core_weight_g',
          labelKey: 'spools.spoolCoreWeightLabel',
          value: spool.spool_core_weight_g === 0
            ? display.coreDisabled ?? 'Off'
            : spool.spool_core_weight_g == null
              ? display.coreGlobalDefault ?? 'Global default'
              : weight(spool.spool_core_weight_g),
          field: { type: 'number', step: '1', unit: 'g' },
        },
        { key: 'spool_material', labelKey: 'spools.spoolMaterial', value: empty(spool.spool_material), field: { type: 'select', options: ['', 'Plastic', 'Cardboard', 'Metal', 'Other'] } },
        { key: 'spool_outer_diameter_mm', labelKey: 'spools.spoolOuterDiameterLabel', value: millimeters(spool.spool_outer_diameter_mm), field: { type: 'number', step: '0.1', unit: 'mm' } },
        { key: 'spool_width_mm', labelKey: 'spools.spoolWidthLabel', value: millimeters(spool.spool_width_mm), field: { type: 'number', step: '0.1', unit: 'mm' } },
      ],
    },
    {
      key: 'purchase',
      titleKey: 'spools.purchaseDetails',
      rows: [
        { key: 'purchase_price', labelKey: 'spools.purchasePrice', value: empty(spool.purchase_price), field: { type: 'number', step: '0.01' } },
        { key: 'purchase_date', labelKey: 'spools.purchaseDate', value: empty(spool.purchase_date), field: { type: 'date' } },
        { key: 'lot_number', labelKey: 'spools.lotNumber', value: empty(spool.lot_number), field: { type: 'text' } },
      ],
    },
    {
      key: 'identity',
      titleKey: 'spools.identityDetails',
      rows: [
        { key: 'external_id', labelKey: 'spools.externalId', value: empty(spool.external_id), field: { type: 'text' } },
        { key: 'rfid', labelKey: 'spools.rfidUid', value: empty(spool.rfid) },
      ],
    },
  ]
}

const numericFields = [
  'initial_total_weight_g',
  'empty_spool_weight_g',
  'spool_outer_diameter_mm',
  'spool_width_mm',
  'low_weight_threshold_g',
  'purchase_price',
] as const

export function buildSpoolUpdatePayload(form: Pick<FormData, 'get'>, usesSpoolCore: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const key of numericFields) {
    const value = String(form.get(key) ?? '').trim()
    payload[key] = value ? Number(value) : null
  }
  for (const key of ['spool_material', 'lot_number', 'external_id', 'purchase_date'] as const) {
    const value = String(form.get(key) ?? '').trim()
    payload[key] = value || null
  }
  const coreWeight = String(form.get('spool_core_weight_g') ?? '').trim()
  payload.spool_core_weight_g = usesSpoolCore ? (coreWeight ? Number(coreWeight) : null) : 0
  return payload
}
