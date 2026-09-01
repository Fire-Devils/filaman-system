import {
  collectSystemFieldValues,
  escapeHtml,
  hasOwnFieldValue,
  isUnsafeExtraFieldPath,
  renderFieldDisplay,
  renderFieldPlainText,
  renderUnknownFieldPlainText,
  setOwnFieldValue,
  unflattenFieldValues,
  type CollectedSystemFieldValues,
  type SystemExtraFieldDef,
} from './extra-fields'
import {
  createExtraFieldDefinitionDialog,
  extraFieldDefinitionFromDialogDraft,
  type ExtraFieldDefinitionDialogResult,
} from './extra-field-definition-dialog'
import { t } from './i18n'
import type { LabelExtraFieldOrigin, LabelExtraFieldValue } from './label-extra-fields'

type ExtraFieldDialogWindow = Window & {
  __fmAlert: (message: string) => Promise<boolean>
  __fmConfirm: (message: string) => Promise<boolean>
}

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

export interface EntityExtraFieldForPrint extends LabelExtraFieldValue {
  label: string
  value: string
  rawValue: unknown
  origin: LabelExtraFieldOrigin
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

export function buildSystemExtraFieldDefinitionMap<T extends SystemExtraFieldDef>(
  definitions: Iterable<T>,
  isSystemOwned: (definition: T) => boolean,
): Record<string, SystemExtraFieldDef> {
  return Object.fromEntries(
    [...definitions]
      .filter(isSystemOwned)
      .map(definition => [definition.key, definition]),
  )
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
  const systemKeys = Object.keys(normalizeEntityExtraFieldDefinitions(systemDefinitions))
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
      origin: systemKeys.some(systemKey => extraFieldPathOverlaps(key, [systemKey]))
        ? 'system'
        : 'custom',
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
      origin: 'custom',
    })
  }

  return fields
}

export function unflattenCollectedSystemFieldValues(
  values: CollectedSystemFieldValues,
): Record<string, unknown> {
  const combined: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values.flat)) {
    setOwnFieldValue(combined, key, value)
  }
  for (const [key, value] of Object.entries(values.direct)) {
    setOwnFieldValue(combined, key, value)
  }
  return unflattenFieldValues(combined)
}

export function collectExtraFieldPayload(
  systemRoot: ParentNode,
  editor: EntityExtraFieldEditor,
): EntityExtraFieldPayload | null {
  const systemValues = collectSystemFieldValues(systemRoot)
  if (!systemValues) return null
  const entityPayload = editor.getPayload()
  if (!entityPayload) return null

  const systemCustomFields = unflattenCollectedSystemFieldValues(systemValues)
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

let nextDraftId = 1

function definitionFromDraft(draft: DraftField): SystemExtraFieldDef {
  return extraFieldDefinitionFromDialogDraft(draft, '__entity_value')
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

export function renderUnregisteredExtraFieldRows(
  customFields: Record<string, unknown>,
  definitions: EntityExtraFieldDefinitions | Record<string, SystemExtraFieldDef> | null | undefined,
  excludedKeys: Iterable<string> = [],
): string {
  const normalizedDefinitions = normalizeEntityExtraFieldDefinitions(definitions)
  const excluded = [...excludedKeys]
  return flattenExtraFieldValues(customFields, normalizedDefinitions)
    .filter(
      field =>
        !field.definition &&
        !extraFieldPathOverlaps(field.key, excluded),
    )
    .map(
      field => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border);">
        <span style="color: var(--text-muted); font-weight: 500;">${escapeHtml(field.key)}</span>
        <span style="font-family: monospace; word-break: break-all;">${escapeHtml(renderUnknownFieldPlainText(field.value))}</span>
      </div>
      `,
    )
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
  const dialog = createExtraFieldDefinitionDialog({ mode: 'entity' })

  function fieldTypeLabel(fieldType: string): string {
    const translated = t(`admin.fieldType_${fieldType}`)
    return translated === `admin.fieldType_${fieldType}` ? fieldType : translated
  }

  function applyDialogResult(draft: DraftField, result: ExtraFieldDefinitionDialogResult): void {
    draft.key = result.key.trim()
    draft.label = result.label.trim()
    draft.fieldType = result.fieldType
    draft.options = [...result.options]
    draft.unit = result.unit
    draft.decimalPlaces = result.decimalPlaces
    draft.minBound = result.minBound
    draft.maxBound = result.maxBound
    draft.maxLength = result.maxLength
    draft.value = result.value
  }

  function validateDialogResult(result: ExtraFieldDefinitionDialogResult, currentId?: number): void {
    const key = result.key.trim()
    if (isUnsafeExtraFieldPath(key)) {
      throw new Error('Custom-field keys cannot contain empty or reserved path segments.')
    }
    if (isSystemKey(key, systemKeys)) {
      throw new Error('This key is already defined as a System Extra Field.')
    }
    const overlap = drafts.find(
      (draft) =>
        draft.id !== currentId &&
        (key === draft.key.trim() || key.startsWith(`${draft.key.trim()}.`) || draft.key.trim().startsWith(`${key}.`)),
    )
    if (overlap) {
      throw new Error('Custom-field keys must be unique and cannot overlap nested paths.')
    }
  }

  function openAddDialog(): void {
    const next = createDraft()
    dialog.open({
      title: t('admin.addField'),
      draft: next,
      onSubmit(result) {
        validateDialogResult(result)
        applyDialogResult(next, result)
        drafts.push(next)
        render()
      },
    })
  }

  function openEditDialog(draft: DraftField): void {
    dialog.open({
      title: t('admin.editField'),
      draft,
      onSubmit(result) {
        validateDialogResult(result, draft.id)
        applyDialogResult(draft, result)
        render()
      },
    })
  }

  function render(): void {
    if (!drafts.length) {
      container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem">${escapeHtml(options.emptyText ?? '')}</div>`
      return
    }

    const rows = drafts
      .map((draft) => {
        const definition = definitionFromDraft(draft)
        const optionsInfo =
          ['dropdown', 'multiselect'].includes(draft.fieldType) && draft.options.length
            ? ` <span title="${escapeHtml(draft.options.join('\n'))}" style="color:var(--text-muted);cursor:help;font-size:0.8rem">(${draft.options.length})</span>`
            : ''
        return `<tr data-entity-extra-id="${draft.id}">
          <td style="font-family:monospace;color:var(--accent-2)">${escapeHtml(draft.key)}</td>
          <td>${escapeHtml(draft.label || draft.key)}</td>
          <td><span class="fm-pill">${escapeHtml(fieldTypeLabel(draft.fieldType))}</span>${optionsInfo}</td>
          <td style="max-width:260px;word-break:break-word">${renderFieldDisplay(definition, draft.value)}</td>
          <td style="text-align:right;white-space:nowrap">
            <button type="button" class="entity-extra-edit" style="color:var(--accent);background:none;border:none;cursor:pointer;margin-right:8px">${escapeHtml(t('common.edit'))}</button>
            <button type="button" class="entity-extra-remove" style="color:var(--error-text);background:none;border:none;cursor:pointer">${escapeHtml(t('common.delete'))}</button>
          </td>
        </tr>`
      })
      .join('')

    container.innerHTML = `<div style="overflow-x:auto"><table class="fm-table">
      <thead style="background:var(--bg-soft)"><tr>
        <th>${escapeHtml(t('admin.keyJson'))}</th>
        <th>${escapeHtml(t('admin.displayLabel'))}</th>
        <th>${escapeHtml(t('admin.fieldType'))}</th>
        <th>${escapeHtml(t('admin.fieldValue'))}</th>
        <th style="text-align:right">${escapeHtml(t('common.actions'))}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`

    container.querySelectorAll<HTMLButtonElement>('.entity-extra-edit').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest<HTMLElement>('[data-entity-extra-id]')
        const draft = drafts.find((item) => item.id === Number(row?.dataset.entityExtraId))
        if (draft) openEditDialog(draft)
      })
    })
    container.querySelectorAll<HTMLButtonElement>('.entity-extra-remove').forEach((button) => {
      button.addEventListener('click', async () => {
        const dialogWindow = window as unknown as ExtraFieldDialogWindow
        if (!(await dialogWindow.__fmConfirm(t('admin.deleteFieldConfirm')))) return
        const row = button.closest<HTMLElement>('[data-entity-extra-id]')
        drafts = drafts.filter((item) => item.id !== Number(row?.dataset.entityExtraId))
        render()
      })
    })
  }

  addButton.addEventListener('click', openAddDialog)

  function reportValidationError(message: string): null {
    void (window as unknown as ExtraFieldDialogWindow).__fmAlert(message)
    return null
  }

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
      systemKeys = new Set(keys)
      drafts = drafts.filter((draft) => !isSystemKey(draft.key.trim(), systemKeys))
      render()
    },
    getPayload() {
      const values: Record<string, unknown> = {}
      const definitions: EntityExtraFieldDefinitions = {}
      const seen = new Set<string>()

      for (const draft of drafts) {
        const key = draft.key.trim()
        if (!key) continue
        if (isUnsafeExtraFieldPath(key)) {
          return reportValidationError('Custom-field keys cannot contain empty or reserved path segments.')
        }
        const overlapsLocalKey = [...seen].some(
          (existing) => key === existing || key.startsWith(`${existing}.`) || existing.startsWith(`${key}.`),
        )
        if (overlapsLocalKey || isSystemKey(key, systemKeys)) {
          return reportValidationError(
            overlapsLocalKey
              ? 'Custom-field keys must be unique and cannot overlap nested paths.'
              : 'This key is already defined as a System Extra Field.',
          )
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
