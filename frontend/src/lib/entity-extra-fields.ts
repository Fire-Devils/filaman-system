import {
  collectSystemFieldValues,
  escapeHtml,
  hasOwnFieldValue,
  isUnsafeExtraFieldPath,
  renderFieldDisplay,
  renderFieldInput,
  renderFieldPlainText,
  renderUnknownFieldPlainText,
  setOwnFieldValue,
  unflattenFieldValues,
  type SystemExtraFieldDef,
} from './extra-fields'

export type EntityExtraFieldDefinition = Omit<
  SystemExtraFieldDef,
  'id' | 'key' | 'default_value'
>

export type EntityExtraFieldDefinitions = Record<string, EntityExtraFieldDefinition>

export interface EntityExtraFieldPayload {
  customFields: Record<string, unknown> | null
  customFieldDefinitions: EntityExtraFieldDefinitions | null
}

export interface FlattenedExtraFieldValue {
  key: string
  label: string
  value: unknown
  definition?: SystemExtraFieldDef
}

export interface EntityExtraFieldForPrint {
  key: string
  label: string
  value: string
  rawValue: unknown
  fieldType?: string
}

export function definitionForFlattenedExtraField(
  field: FlattenedExtraFieldValue,
): SystemExtraFieldDef {
  return field.definition ?? {
    id: 0,
    key: field.key,
    label: field.label,
    field_type: 'text',
  }
}

export function extraFieldPathOverlaps(key: string, otherKeys: Iterable<string>): boolean {
  for (const otherKey of otherKeys) {
    if (
      key === otherKey ||
      key.startsWith(`${otherKey}.`) ||
      otherKey.startsWith(`${key}.`)
    ) {
      return true
    }
  }
  return false
}

export function resolveRecordExtraFieldDefinition(
  key: string,
  batchDefinition: SystemExtraFieldDef,
  recordDefinitions: Record<string, SystemExtraFieldDef>,
  systemOwned: boolean,
): SystemExtraFieldDef {
  if (systemOwned) return batchDefinition
  return recordDefinitions[key] ?? {
    id: 0,
    key,
    label: key,
    field_type: 'text',
  }
}

export function renderRecordExtraField(
  key: string,
  rawValue: unknown,
  batchDefinition: SystemExtraFieldDef,
  recordDefinitions: Record<string, SystemExtraFieldDef>,
  systemOwned: boolean,
): { label: string; value: string } {
  const definition = resolveRecordExtraFieldDefinition(
    key,
    batchDefinition,
    recordDefinitions,
    systemOwned,
  )
  return {
    label: definition.label,
    value: renderFieldPlainText(definition, rawValue),
  }
}

export function normalizeEntityExtraFieldDefinitions(
  definitions: EntityExtraFieldDefinitions | Record<string, unknown> | null | undefined,
): Record<string, SystemExtraFieldDef> {
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return {}

  return Object.fromEntries(
    Object.entries(definitions)
      .filter(
        ([key, definition]) =>
          !isUnsafeExtraFieldPath(key) &&
          definition &&
          typeof definition === 'object' &&
          !Array.isArray(definition),
      )
      .map(([key, definition]) => {
        const normalized = definition as EntityExtraFieldDefinition
        return [
          key,
          {
            ...normalized,
            key,
            label: normalized.label || key,
            field_type: normalized.field_type || 'text',
          } as SystemExtraFieldDef,
        ]
      }),
  )
}

export function mergeEntityExtraFieldDefinitions(
  entityDefinitions: EntityExtraFieldDefinitions | Record<string, unknown> | null | undefined,
  systemDefinitions: Record<string, SystemExtraFieldDef> = {},
): Record<string, SystemExtraFieldDef> {
  const normalizedEntity = normalizeEntityExtraFieldDefinitions(entityDefinitions)
  const normalizedSystem = normalizeEntityExtraFieldDefinitions(systemDefinitions)
  const systemKeys = Object.keys(normalizedSystem)

  return {
    ...Object.fromEntries(
      Object.entries(normalizedEntity).filter(
        ([key]) => !extraFieldPathOverlaps(key, systemKeys),
      ),
    ),
    ...normalizedSystem,
  }
}

export function flattenExtraFieldValues(
  value: Record<string, unknown> | null | undefined,
  definitions: Record<string, Partial<SystemExtraFieldDef> & { label?: string }> = {},
  prefix = '',
): FlattenedExtraFieldValue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []

  const fields: FlattenedExtraFieldValue[] = []
  for (const [key, raw] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    const definition = definitions[path]
      ? {
          ...definitions[path],
          key: path,
          label: definitions[path].label ?? path,
          field_type: definitions[path].field_type ?? 'text',
        } as SystemExtraFieldDef
      : undefined

    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      definition?.field_type !== 'range'
    ) {
      fields.push(...flattenExtraFieldValues(raw as Record<string, unknown>, definitions, path))
      continue
    }

    fields.push({
      key: path,
      label: definition?.label ?? path,
      value: raw,
      definition,
    })
  }
  return fields
}

export function buildEntityExtraFieldsForPrint(
  values: Record<string, unknown> | null | undefined,
  entityDefinitions: EntityExtraFieldDefinitions | Record<string, unknown> | null | undefined,
  systemDefinitions: Record<string, SystemExtraFieldDef> = {},
  includeEmptyDefinitions = false,
): EntityExtraFieldForPrint[] {
  const definitions = mergeEntityExtraFieldDefinitions(entityDefinitions, systemDefinitions)
  const sourceValues = values ?? {}
  const fields: EntityExtraFieldForPrint[] = []
  const emittedKeys = new Set<string>()

  for (const [key, definition] of Object.entries(definitions)) {
    const rawValue = getExtraFieldValue(sourceValues, key)
    if (rawValue === undefined && !includeEmptyDefinitions) continue
    emittedKeys.add(key)
    fields.push({
      key,
      label: definition.label,
      value: renderFieldPlainText(definition, rawValue),
      rawValue,
      fieldType: definition.field_type,
    })
  }

  for (const field of flattenExtraFieldValues(sourceValues, definitions)) {
    if (extraFieldPathOverlaps(field.key, emittedKeys)) continue
    emittedKeys.add(field.key)
    fields.push({
      key: field.key,
      label: field.label,
      value: field.definition
        ? renderFieldPlainText(field.definition, field.value)
        : renderUnknownFieldPlainText(field.value),
      rawValue: field.value,
      fieldType: field.definition?.field_type,
    })
  }

  return fields
}

export function collectExtraFieldPayload(
  systemRoot: ParentNode,
  editor: EntityExtraFieldEditor,
): EntityExtraFieldPayload | null {
  const systemValues = collectSystemFieldValues(systemRoot)
  if (!systemValues) return null
  const entityPayload = editor.getPayload()
  if (!entityPayload) return null

  const systemCustomFields = unflattenFieldValues(systemValues.flat)
  for (const [key, value] of Object.entries(systemValues.direct)) {
    systemCustomFields[key] = value
  }
  return {
    customFields: mergeExtraFieldValues(systemCustomFields, entityPayload.customFields),
    customFieldDefinitions: entityPayload.customFieldDefinitions,
  }
}

interface DraftField {
  id: number
  key: string
  label: string
  fieldType: string
  options: string[]
  unit: string
  decimalPlaces: string
  minBound: string
  maxBound: string
  maxLength: string
  value: unknown
}

export interface EntityExtraFieldEditor {
  setData: (
    customFields?: Record<string, unknown> | null,
    definitions?: EntityExtraFieldDefinitions | null,
  ) => void
  setSystemFieldKeys: (keys: string[]) => void
  getPayload: () => EntityExtraFieldPayload | null
}

const FIELD_TYPES = [
  'text',
  'number',
  'range',
  'dropdown',
  'multiselect',
  'checkbox',
  'date',
  'datetime',
  'url',
  'textarea',
] as const

let nextDraftId = 1

function asOptionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function definitionFromDraft(draft: DraftField): SystemExtraFieldDef {
  const config: NonNullable<SystemExtraFieldDef['config']> = {}
  if (draft.unit.trim() && ['number', 'range'].includes(draft.fieldType)) {
    config.unit = draft.unit.trim()
  }
  if (draft.decimalPlaces !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.decimal_places = asOptionalNumber(draft.decimalPlaces)
  }
  if (draft.minBound !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.min_bound = asOptionalNumber(draft.minBound)
  }
  if (draft.maxBound !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.max_bound = asOptionalNumber(draft.maxBound)
  }
  if (draft.maxLength !== '' && draft.fieldType === 'textarea') {
    config.max_length = asOptionalNumber(draft.maxLength)
  }

  return {
    key: '__entity_value',
    label: draft.label.trim() || draft.key.trim() || 'Value',
    field_type: draft.fieldType,
    options:
      ['dropdown', 'multiselect'].includes(draft.fieldType) && draft.options.length
        ? draft.options
        : null,
    config: Object.keys(config).length ? config : null,
  }
}

function createDraft(
  key = '',
  value: unknown = '',
  definition?: EntityExtraFieldDefinition,
): DraftField {
  const config = definition?.config ?? {}
  return {
    id: nextDraftId++,
    key,
    label: definition?.label ?? key,
    fieldType: definition?.field_type ?? 'text',
    options: definition?.options ? [...definition.options] : [],
    unit: config.unit ?? '',
    decimalPlaces:
      config.decimal_places === null || config.decimal_places === undefined
        ? ''
        : String(config.decimal_places),
    minBound:
      config.min_bound === null || config.min_bound === undefined
        ? ''
        : String(config.min_bound),
    maxBound:
      config.max_bound === null || config.max_bound === undefined
        ? ''
        : String(config.max_bound),
    maxLength:
      config.max_length === null || config.max_length === undefined
        ? ''
        : String(config.max_length),
    value,
  }
}

function isSystemKey(key: string, systemKeys: Set<string>): boolean {
  return extraFieldPathOverlaps(key, systemKeys)
}

function flattenUnregisteredValues(
  input: Record<string, unknown>,
  excludedKeys: Set<string>,
  prefix = '',
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (excludedKeys.has(path)) continue
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      flattenUnregisteredValues(value as Record<string, unknown>, excludedKeys, path, output)
    } else {
      setOwnFieldValue(output, path, value)
    }
  }
  return output
}

export function getExtraFieldValue(input: Record<string, unknown>, path: string): unknown {
  if (isUnsafeExtraFieldPath(path)) return undefined
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    const record = current as Record<string, unknown>
    return hasOwnFieldValue(record, key) ? record[key] : undefined
  }, input)
}

export function renderEntityExtraFieldRows(
  customFields: Record<string, unknown>,
  definitions: EntityExtraFieldDefinitions | null | undefined,
  excludedKeys: Iterable<string> = [],
): string {
  return Object.entries(definitions ?? {})
    .filter(
      ([key]) =>
        !extraFieldPathOverlaps(key, excludedKeys) &&
        getExtraFieldValue(customFields, key) !== undefined,
    )
    .map(([key, definition]) => {
      const field = { ...definition, key, label: definition.label || key }
      return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border);">
        <span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(field.label)}</span>
        <span style="word-break: break-all;">${renderFieldDisplay(field, getExtraFieldValue(customFields, key))}</span>
      </div>
      `
    })
    .join('')
}

export function mergeExtraFieldValues(
  ...sources: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}

  function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(source)) {
      const existing = hasOwnFieldValue(target, key) ? target[key] : undefined
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        merge(existing as Record<string, unknown>, value as Record<string, unknown>)
      } else if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const nested: Record<string, unknown> = {}
        merge(nested, value as Record<string, unknown>)
        setOwnFieldValue(target, key, nested)
      } else {
        setOwnFieldValue(target, key, value)
      }
    }
  }

  for (const source of sources) {
    if (source) merge(result, source)
  }
  return Object.keys(result).length ? result : null
}

function storedDefinition(draft: DraftField): EntityExtraFieldDefinition | null {
  const rendered = definitionFromDraft(draft)
  const label = draft.label.trim()
  const hasMetadata =
    rendered.field_type !== 'text' ||
    (label !== '' && label !== draft.key.trim()) ||
    Boolean(rendered.options?.length) ||
    Boolean(rendered.config && Object.keys(rendered.config).length)
  if (!hasMetadata) return null
  return {
    label: label || draft.key.trim(),
    field_type: rendered.field_type,
    options: rendered.options,
    config: rendered.config,
  }
}

export function createEntityExtraFieldEditor(options: {
  container: HTMLElement
  addButton: HTMLElement
  emptyText?: string
}): EntityExtraFieldEditor {
  const { container, addButton } = options
  let drafts: DraftField[] = []
  let systemKeys = new Set<string>()

  function syncDraftsFromDom(): boolean {
    for (const row of container.querySelectorAll<HTMLElement>('[data-entity-extra-id]')) {
      const id = Number(row.dataset.entityExtraId)
      const draft = drafts.find(item => item.id === id)
      if (!draft) continue

      draft.key = row.querySelector<HTMLInputElement>('.entity-extra-key')?.value ?? draft.key
      draft.label = row.querySelector<HTMLInputElement>('.entity-extra-label')?.value ?? draft.label
      draft.fieldType =
        row.querySelector<HTMLSelectElement>('.entity-extra-type')?.value ?? draft.fieldType
      draft.unit = row.querySelector<HTMLInputElement>('.entity-extra-unit')?.value ?? ''
      draft.decimalPlaces =
        row.querySelector<HTMLInputElement>('.entity-extra-decimals')?.value ?? ''
      draft.minBound =
        row.querySelector<HTMLInputElement>('.entity-extra-min-bound')?.value ?? ''
      draft.maxBound =
        row.querySelector<HTMLInputElement>('.entity-extra-max-bound')?.value ?? ''
      draft.maxLength =
        row.querySelector<HTMLInputElement>('.entity-extra-max-length')?.value ?? ''
      const optionsValue =
        row.querySelector<HTMLTextAreaElement>('.entity-extra-options')?.value ?? ''
      draft.options = optionsValue
        .split(/\r?\n|,/)
        .map(value => value.trim())
        .filter(Boolean)

      const values = collectSystemFieldValues(row)
      if (!values) return false
      const nested = unflattenFieldValues(values.flat)
      draft.value = values.direct.__entity_value ?? nested.__entity_value
      if (
        draft.value === undefined &&
        ['text', 'url', 'date', 'datetime', 'textarea', 'dropdown'].includes(draft.fieldType)
      ) {
        draft.value = ''
      }
    }
    return true
  }

  function render(): void {
    if (!drafts.length) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem">${escapeHtml(options.emptyText ?? '')}</div>`
      return
    }

    container.innerHTML = drafts
      .map(draft => {
        const definition = definitionFromDraft(draft)
        const typeOptions = FIELD_TYPES.map(
          type =>
            `<option value="${type}"${draft.fieldType === type ? ' selected' : ''}>${type}</option>`,
        ).join('')
        const numericConfig = ['number', 'range'].includes(draft.fieldType)
          ? `<div style="display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:8px">
              <input class="fm-input entity-extra-unit" value="${escapeHtml(draft.unit)}" placeholder="Unit (e.g. °C)" />
              <input type="number" min="0" max="10" class="fm-input entity-extra-decimals" value="${escapeHtml(draft.decimalPlaces)}" placeholder="Decimals" />
              <input type="number" class="fm-input entity-extra-min-bound" value="${escapeHtml(draft.minBound)}" placeholder="Min bound" />
              <input type="number" class="fm-input entity-extra-max-bound" value="${escapeHtml(draft.maxBound)}" placeholder="Max bound" />
            </div>`
          : ''
        const choiceConfig = ['dropdown', 'multiselect'].includes(draft.fieldType)
          ? `<textarea class="fm-input entity-extra-options" rows="2" placeholder="Options, one per line">${escapeHtml(draft.options.join('\n'))}</textarea>`
          : ''
        const textareaConfig =
          draft.fieldType === 'textarea'
            ? `<input type="number" min="1" class="fm-input entity-extra-max-length" value="${escapeHtml(draft.maxLength)}" placeholder="Maximum length" />`
            : ''

        return `<div data-entity-extra-id="${draft.id}" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;display:grid;gap:10px;background:var(--bg-soft)">
          <div style="display:grid;grid-template-columns:minmax(130px,1fr) minmax(150px,1fr) minmax(120px,0.7fr) auto;gap:8px;align-items:center">
            <input class="fm-input entity-extra-key" value="${escapeHtml(draft.key)}" placeholder="Key" />
            <input class="fm-input entity-extra-label" value="${escapeHtml(draft.label)}" placeholder="Label (optional)" />
            <select class="fm-select entity-extra-type">${typeOptions}</select>
            <button type="button" class="fm-btn fm-btn-danger entity-extra-remove" aria-label="Remove field" style="padding:6px 10px">&times;</button>
          </div>
          ${numericConfig}${choiceConfig}${textareaConfig}
          <div class="entity-extra-value">${renderFieldInput(definition, draft.value)}</div>
        </div>`
      })
      .join('')

    container.querySelectorAll<HTMLSelectElement>('.entity-extra-type').forEach(select => {
      select.addEventListener('change', () => {
        if (!syncDraftsFromDom()) return
        render()
      })
    })
    container
      .querySelectorAll<HTMLInputElement>(
        '.entity-extra-unit,.entity-extra-decimals,.entity-extra-min-bound,.entity-extra-max-bound,.entity-extra-max-length',
      )
      .forEach(input => {
        input.addEventListener('change', () => {
          if (!syncDraftsFromDom()) return
          render()
        })
      })
    container.querySelectorAll<HTMLTextAreaElement>('.entity-extra-options').forEach(input => {
      input.addEventListener('change', () => {
        if (!syncDraftsFromDom()) return
        render()
      })
    })
    container.querySelectorAll<HTMLButtonElement>('.entity-extra-remove').forEach(button => {
      button.addEventListener('click', () => {
        if (!syncDraftsFromDom()) return
        const row = button.closest<HTMLElement>('[data-entity-extra-id]')
        drafts = drafts.filter(item => item.id !== Number(row?.dataset.entityExtraId))
        render()
      })
    })
  }

  addButton.addEventListener('click', () => {
    if (!syncDraftsFromDom()) return
    drafts.push(createDraft())
    render()
  })

  return {
    setData(customFields = null, definitions = null) {
      const values = customFields ?? {}
      const defs = definitions ?? {}
      const excludedKeys = new Set([...systemKeys, ...Object.keys(defs)])
      drafts = []

      for (const [key, definition] of Object.entries(defs)) {
        if (isSystemKey(key, systemKeys)) continue
        drafts.push(createDraft(key, getExtraFieldValue(values, key), definition))
      }
      const remaining = flattenUnregisteredValues(values, excludedKeys)
      for (const [key, value] of Object.entries(remaining)) {
        if (isSystemKey(key, systemKeys)) continue
        drafts.push(createDraft(key, renderUnknownFieldPlainText(value)))
      }
      render()
    },
    setSystemFieldKeys(keys) {
      if (!syncDraftsFromDom()) return
      systemKeys = new Set(keys)
      drafts = drafts.filter(draft => !isSystemKey(draft.key.trim(), systemKeys))
      render()
    },
    getPayload() {
      if (!syncDraftsFromDom()) return null
      const values: Record<string, unknown> = {}
      const definitions: EntityExtraFieldDefinitions = {}
      const seen = new Set<string>()

      for (const draft of drafts) {
        const key = draft.key.trim()
        if (!key) continue
        const keyInput = container
          .querySelector<HTMLElement>(`[data-entity-extra-id="${draft.id}"]`)
          ?.querySelector<HTMLInputElement>('.entity-extra-key')
        keyInput?.setCustomValidity('')
        if (isUnsafeExtraFieldPath(key)) {
          keyInput?.setCustomValidity(
            'Custom-field keys cannot contain empty or reserved path segments.',
          )
          keyInput?.reportValidity()
          return null
        }
        const overlapsLocalKey = [...seen].some(
          existing =>
            key === existing ||
            key.startsWith(`${existing}.`) ||
            existing.startsWith(`${key}.`),
        )
        if (overlapsLocalKey || isSystemKey(key, systemKeys)) {
          keyInput?.setCustomValidity(
            overlapsLocalKey
              ? 'Custom-field keys must be unique and cannot overlap nested paths.'
              : 'This key is already defined as a System Extra Field.',
          )
          keyInput?.reportValidity()
          return null
        }
        seen.add(key)
        if (draft.value !== undefined) setOwnFieldValue(values, key, draft.value)
        const definition = storedDefinition(draft)
        if (definition) definitions[key] = definition
      }

      return {
        customFields: Object.keys(values).length ? unflattenFieldValues(values) : null,
        customFieldDefinitions: Object.keys(definitions).length ? definitions : null,
      }
    },
  }
}
