import { buildEntityExtraFieldsForPrint, getExtraFieldValue } from './entity-extra-fields'
import { isUnsafeExtraFieldPath, renderFieldPlainText, renderUnknownFieldPlainText, type SystemExtraFieldDef } from './extra-fields'

export type LabelExtraFieldSource = 'spool' | 'filament'
export type LabelExtraFieldOrigin = 'system' | 'custom'

export interface LabelExtraFieldCatalogItem {
  key: string
  label?: string
  source?: string
  origin?: LabelExtraFieldOrigin
  legacyAlias?: boolean
}

export interface LabelExtraFieldValue extends LabelExtraFieldCatalogItem {
  label: string
  value: unknown
  rawValue?: unknown
  fieldType?: string
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameFieldValue(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameFieldValue(a[key], b[key]))
}

function definitionMeaning(definition: Record<string, unknown>) {
  return Object.fromEntries(['label', 'field_type', 'options', 'config', 'default_value']
    .filter(key => definition[key] != null).map(key => [key, definition[key]]))
}

export function buildLegacyLabelAliases(
  record: Record<string, unknown>,
  filament: Record<string, unknown>,
  source: LabelExtraFieldSource,
  systemFields: Record<string, SystemExtraFieldDef> = {},
): (LabelExtraFieldValue & { value: string })[] {
  const aliases = record.label_field_aliases
  const definitions = { ...record.custom_field_definitions as Record<string, unknown> | undefined }
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    for (const [key, alias] of Object.entries(aliases)) {
      if (!isUnsafeExtraFieldPath(key) && alias && typeof alias === 'object'
        && alias.definition && !Object.hasOwn(definitions, key)) definitions[key] = alias.definition
    }
  }
  const fields = new Map<string, LabelExtraFieldValue & { value: string }>(buildEntityExtraFieldsForPrint(
    record.custom_fields as Record<string, unknown> | undefined,
    definitions,
    systemFields,
  ).filter(field => isBuiltInLabelField(source, field.key, field.label))
    .map(field => [field.key, { ...scopeLabelExtraField(field, source), legacyAlias: true }]))
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return [...fields.values()]
  const localDefinitions = record.custom_field_definitions as Record<string, SystemExtraFieldDef> | null
  for (const [key, alias] of Object.entries(aliases)) {
    const target = typeof alias === 'string' ? alias : alias?.target
    if (typeof target !== 'string' || isUnsafeExtraFieldPath(key)) continue
    const wire = typeof alias === 'object' && alias ? alias.wire : undefined
    const definition = typeof alias === 'object' && alias ? alias.definition ?? wire?.definition : undefined
    const sourcePath = Array.isArray(wire?.source)
      && (wire.source.length === 1 || (wire.source.length === 2 && wire.source[0] === 'spoolman_extra'))
      && wire.source.every((part: unknown) =>
      typeof part === 'string' && !isUnsafeExtraFieldPath(part)) ? wire.source as string[] : null
    const custom = record.custom_fields as Record<string, unknown> | null
    const current = sourcePath
      ? sourcePath.reduce<unknown>((value, part) => value && typeof value === 'object' && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part] : undefined, custom)
      : custom ? getExtraFieldValue(custom, key) : undefined
    const sourceKey = sourcePath?.at(-1) ?? key.replace(/^spoolman_extra\./, '')
    const currentDefinition = systemFields[key] ?? systemFields[sourceKey]
      ?? localDefinitions?.[key] ?? localDefinitions?.[sourceKey]
    const capturedDefinition = wire?.definition ?? definition
    const owned = wire?.retained === true && sameFieldValue(current, wire.value)
      && (!currentDefinition || (capturedDefinition && sameFieldValue(
        definitionMeaning(currentDefinition as unknown as Record<string, unknown>), definitionMeaning(capturedDefinition),
      )))
    const independent = current !== undefined && !owned
    const displayDefinition = independent ? currentDefinition ?? definition : definition
    // Promoted scalar temperatures follow the whole range when its minimum is cleared.
    const scalar = ['number', 'float', 'integer'].includes(displayDefinition?.field_type)
    const nativeTarget = !independent && scalar
      && typeof wire?.target === 'string' && target === `${wire.target}.min` ? wire.target : target
    let rawValue = independent ? current : getExtraFieldValue(filament, nativeTarget)
    if (!independent && scalar && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && ('min' in rawValue || 'max' in rawValue)) {
      const range = rawValue as { min?: unknown; max?: unknown }
      rawValue = range.min ?? range.max
    }
    fields.set(key, { key: `${source}.${key}`, label: displayDefinition?.label || key, source, legacyAlias: true,
      value: displayDefinition && typeof displayDefinition === 'object'
        ? renderFieldPlainText({ ...displayDefinition, key, label: displayDefinition.label || key }, rawValue)
        : renderUnknownFieldPlainText(rawValue), rawValue, fieldType: displayDefinition?.field_type })
  }
  return [...fields.values()]
}

/** One value per scoped key: a projected retained alias must replace its snapshot. */
export function buildLabelExtraFields(
  record: Record<string, unknown>,
  filament: Record<string, unknown>,
  source: LabelExtraFieldSource,
  systemFields: Record<string, SystemExtraFieldDef> = {},
  includeEmptyDefinitions = false,
): (LabelExtraFieldValue & { value: string })[] {
  const aliases = buildLegacyLabelAliases(record, filament, source, systemFields)
  const aliasKeys = new Set(aliases.map(field => field.key))
  return [...aliases, ...buildEntityExtraFieldsForPrint(
    record.custom_fields as Record<string, unknown> | undefined,
    record.custom_field_definitions as Record<string, unknown> | undefined,
    systemFields, includeEmptyDefinitions,
  ).filter(field => !isBuiltInLabelField(source, field.key, field.label))
    .map(field => scopeLabelExtraField(field, source)).filter(field => !aliasKeys.has(field.key))]
}

/** Historical choices stay available only while their saved selection is enabled. */
export function standardLabelExtraFields<T extends LabelExtraFieldCatalogItem>(
  fields: T[], selected: Record<string, unknown>, defaultSource: LabelExtraFieldSource = 'filament',
): T[] {
  return dedupeLabelExtraFields(fields, defaultSource)
    .filter(field => !field.legacyAlias || selected[field.key] === true)
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
    for (const source of sources) {
      const unique = new Map<string, T>()
      for (const field of fields) {
        if (field.legacyAlias) continue
        const fieldSource = field.source === 'spool' || field.source === 'filament'
          ? field.source
          : options.entityType
        if (fieldSource !== source || (field.origin ?? 'custom') !== origin || !field.key || (origin === 'custom' && options.batchMode)) continue
        if (!unique.has(field.key)) unique.set(field.key, field)
      }
      const sorted = [...unique.values()].sort((left, right) =>
        String(left.label || left.key).localeCompare(String(right.label || right.key)),
      )
      groups.push({ source, origin, fields: sorted })
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
  const freeform = container.matches('.freeform-extra-fields')
  const groupElement = document.createElement(freeform ? 'details' : 'div')
  if (freeform) (groupElement as HTMLDetailsElement).open = true
  groupElement.className = 'ds-tokens-group'
  const labelElement = document.createElement(freeform ? 'summary' : 'div')
  const chipsElement = document.createElement('div')
  labelElement.className = 'ds-tokens-group-label'
  labelElement.textContent = group.origin === 'system'
    ? options.translate('labelDesigner.extraFields', 'Extra Fields')
    : options.translate('labelDesigner.customFields', 'Custom Fields')
  chipsElement.className = 'ds-token-hints'

  let expanded = false
  const customLimit = 12
  const renderFields = () => {
    chipsElement.innerHTML = ''
    const visibleFields = !freeform && group.origin === 'custom' && !expanded
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

    if (group.origin === 'custom' && group.fields.length === 0 && !options.batchMode) {
      const empty = document.createElement('span')
      empty.className = 'ds-tokens-empty'
      empty.textContent = options.translate(
        `${translationRoot}.dsNoCustomFields`,
        `No ${entityName} Custom Fields are enabled.`,
      )
      chipsElement.appendChild(empty)
    }

    if (!freeform && group.origin === 'custom' && group.fields.length > customLimit) {
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

    if (group.origin === 'custom' && options.batchMode) {
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
    'settings_extruder_temp',
    'settings_bed_temp',
    'nozzle_temperature',
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
    'extruder_temp',
    'extruder_temp_range_c',
    'bed_temp',
    'bed_temp_range_c',
    'price',
    'default_spool_weight_g',
    'spool_outer_diameter_mm',
    'spool_width_mm',
    'spool_material',
    'shop_url',
  ]),
  spool: new Set([
    'settings_extruder_temp',
    'settings_bed_temp',
    'nozzle_temperature',
    'spool_material',
    'spool_outer_diameter_mm',
    'spool_width_mm',
    'rfid_uid_2',
    'purchase_currency',
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
    .replace(/^spoolman_extra\./, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_.]/g, '')
}

export function isBuiltInLabelField(source: LabelExtraFieldSource | string, key: string, label?: string) {
  if (source !== 'spool' && source !== 'filament') return false
  const names = BUILT_IN_FIELD_NAMES[source]
  return names.has(normalizeLabelFieldName(key)) || (label ? names.has(normalizeLabelFieldName(label)) : false)
}
