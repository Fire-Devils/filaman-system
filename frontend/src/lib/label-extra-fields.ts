export type LabelExtraFieldSource = 'spool' | 'filament'
export type LabelExtraFieldOrigin = 'system' | 'custom'

export interface LabelExtraFieldCatalogItem {
  key: string
  label?: string
  source?: string
  origin?: LabelExtraFieldOrigin
}

export interface LabelExtraFieldValue extends LabelExtraFieldCatalogItem {
  label: string
  value: unknown
  rawValue?: unknown
  fieldType?: string
}

export interface LabelExtraFieldCatalogGroup<T extends LabelExtraFieldCatalogItem = LabelExtraFieldCatalogItem> {
  source: LabelExtraFieldSource
  origin: LabelExtraFieldOrigin
  fields: T[]
}

export function scopeLabelExtraField<T extends { key: string }>(
  field: T,
  source: LabelExtraFieldSource,
): T & { key: string; source: LabelExtraFieldSource } {
  return {
    ...field,
    key: `${source}.${field.key}`,
    source,
  }
}

export function dedupeLabelExtraFields<T extends LabelExtraFieldCatalogItem>(
  fields: T[],
  defaultSource: LabelExtraFieldSource,
): T[] {
  const unique = new Map<string, T>()
  for (const field of fields) {
    if (!field?.key) continue
    const source = field.source === 'filament' || field.source === 'spool'
      ? field.source
      : defaultSource
    const identity = `${source}:${field.key}`
    if (!unique.has(identity)) unique.set(identity, field)
  }
  return [...unique.values()]
}

export function buildLabelExtraFieldCatalogGroups<T extends LabelExtraFieldCatalogItem>(
  fields: T[],
  options: { entityType: LabelExtraFieldSource; batchMode: boolean },
): LabelExtraFieldCatalogGroup<T>[] {
  const sources: LabelExtraFieldSource[] = options.entityType === 'spool'
    ? ['filament', 'spool']
    : ['filament']
  const groups: LabelExtraFieldCatalogGroup<T>[] = []

  for (const origin of ['system', 'custom'] as const) {
    if (origin === 'custom' && options.batchMode) continue
    for (const source of sources) {
      const unique = new Map<string, T>()
      for (const field of fields) {
        const fieldSource = field.source === 'spool' || field.source === 'filament'
          ? field.source
          : options.entityType
        if (fieldSource !== source || (field.origin ?? 'custom') !== origin || !field.key) continue
        if (!unique.has(field.key)) unique.set(field.key, field)
      }
      const sorted = [...unique.values()].sort((left, right) =>
        String(left.label || left.key).localeCompare(String(right.label || right.key)),
      )
      if (origin === 'system' || sorted.length > 0) {
        groups.push({ source, origin, fields: sorted })
      }
    }
  }

  return groups
}

export function appendLabelExtraFieldCatalogGroup<T extends LabelExtraFieldCatalogItem>(
  container: HTMLElement,
  group: LabelExtraFieldCatalogGroup<T>,
  options: {
    batchMode: boolean
    makeChip: (token: string, label: string) => HTMLElement
    translate: (key: string, fallback: string) => string
  },
): void {
  const entityName = group.source === 'filament' ? 'Filament' : 'Spool'
  const translationRoot = `${group.source}s`
  const groupElement = document.createElement('div')
  const labelElement = document.createElement('div')
  const chipsElement = document.createElement('div')
  labelElement.className = 'ds-tokens-group-label'
  labelElement.textContent = group.origin === 'system'
    ? options.translate(`${translationRoot}.dsSystemExtraFieldsLabel`, `${entityName} System Extra Fields`)
    : options.translate(`${translationRoot}.dsCustomFieldsLabel`, `${entityName} Custom Fields`)
  chipsElement.className = 'ds-token-hints'

  let expanded = false
  const customLimit = 12
  const renderFields = () => {
    chipsElement.innerHTML = ''
    const visibleFields = group.origin === 'custom' && !expanded
      ? group.fields.slice(0, customLimit)
      : group.fields
    for (const field of visibleFields) {
      const label = field.label && field.label !== field.key ? field.label : field.key
      chipsElement.appendChild(options.makeChip(`{extra.${field.key}}`, label))
    }

    if (group.origin === 'system' && group.fields.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'ds-tokens-empty'
      empty.textContent = options.translate(
        `${translationRoot}.dsNoSystemExtraFields`,
        `No ${entityName} System Extra Fields are configured.`,
      )
      chipsElement.appendChild(empty)
    }

    if (group.origin === 'custom' && group.fields.length > customLimit) {
      const toggle = document.createElement('button')
      toggle.className = 'ds-custom-fields-toggle'
      toggle.type = 'button'
      toggle.textContent = expanded
        ? options.translate('common.showFewerCustomFields', 'Show fewer Custom Fields')
        : options.translate('common.showAllCustomFields', 'Show all {count} Custom Fields')
          .replace('{count}', String(group.fields.length))
      toggle.addEventListener('click', () => {
        expanded = !expanded
        renderFields()
      })
      chipsElement.appendChild(toggle)
    }

    if (group.origin === 'system' && options.batchMode) {
      const note = document.createElement('span')
      note.className = 'ds-tokens-empty ds-batch-custom-fields-note'
      note.textContent = options.translate(
        `${translationRoot}.dsBatchCustomFieldsDisabled`,
        `Per-${group.source} Custom Fields are not enabled for batch printing.`,
      )
      chipsElement.appendChild(note)
    }
  }

  groupElement.appendChild(labelElement)
  groupElement.appendChild(chipsElement)
  container.appendChild(groupElement)
  renderFields()
}

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
    'spool_core_weight_g',
    'spool_core_wt',
    'low_weight_threshold_g',
    'low_wt',
    'stocked_in_at',
    'stocked_in',
    'last_used_at',
    'last_used',
    'created_at',
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
