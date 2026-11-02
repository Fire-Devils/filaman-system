import { escapeHtml } from './extra-fields'
import { t } from './i18n'

// Structured config stays read-only because saves replace driver_config wholesale.
export interface SchemaProperty {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  enumNames?: string[]
  minimum?: number
  maximum?: number
}

export interface DriverSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

/** Shared controls; each page keeps its own form state and save handler. */
export function renderDriverConfigFields(schema: DriverSchema, config: Record<string, unknown>, driverKey: string): string {
  return Object.entries(schema.properties || {}).map(([key, prop]) => {
    const name = escapeHtml(key)
    const id = `config-${name}`
    const required = schema.required?.includes(key) ? ' required' : ''
    const rawValue = config[key] ?? prop.default
    const value = escapeHtml(String(rawValue ?? ''))
    let control: string
    if (isStructuredProp(prop, rawValue)) {
      control = `<pre id="${id}" style="margin: 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; overflow-x: auto;">${escapeHtml(JSON.stringify(rawValue ?? null, null, 2))}</pre>
        <p class="fm-field-hint">${t('printers.configReadOnly')} <a href="/admin/system">${t('nav.plugins')} (${escapeHtml(driverKey)})</a></p>`
    } else if (prop.type === 'boolean') {
      control = `<input class="fm-checkbox" id="${id}" name="${name}" type="checkbox"${rawValue === true || rawValue === 'true' ? ' checked' : ''}>`
    } else if (Array.isArray(prop.enum)) {
      const options = prop.enum.map((option, i) => `<option value="${escapeHtml(String(option))}"${String(option) === String(rawValue ?? '') ? ' selected' : ''}>${escapeHtml(String(prop.enumNames?.[i] ?? option))}</option>`).join('')
      control = `<select class="fm-input" id="${id}" name="${name}"${required}>${options}</select>`
    } else {
      const numeric = prop.type === 'integer' || prop.type === 'number'
      const bounds = numeric ? `${prop.minimum !== undefined ? ` min="${escapeHtml(String(prop.minimum))}"` : ''}${prop.maximum !== undefined ? ` max="${escapeHtml(String(prop.maximum))}"` : ''}` : ''
      control = `<input class="fm-input" id="${id}" name="${name}" type="${numeric ? 'number' : 'text'}" value="${value}"${bounds}${required}>`
    }
    return `<div><label class="fm-label" for="${id}">${escapeHtml(prop.title || key)}${required ? ' *' : ''}</label>${control}${prop.description ? `<p class="fm-field-hint">${escapeHtml(prop.description)}</p>` : ''}</div>`
  }).join('')
}

/**
 * Whether a property has no meaningful text-input representation.
 *
 * The schema type decides when it is present; the value is the fallback for
 * schemas that omit `type` but hold structured data anyway.
 */
export function isStructuredProp(
  prop: SchemaProperty | null | undefined,
  value: unknown
): boolean {
  if (prop?.type === 'array' || prop?.type === 'object') return true
  return typeof value === 'object' && value !== null
}

/** Value read off a form control, already normalised by the caller. */
export type FieldValue = string | number | boolean | null

/**
 * Build the driver_config payload for a save.
 *
 * `edited` holds the values read from the form controls; `current` is the config
 * as stored. Structured properties are taken from `current`, never from the
 * form, and are omitted when the stored config has no value for them.
 */
export function buildDriverConfigPayload(
  props: Record<string, SchemaProperty>,
  current: Record<string, unknown>,
  edited: Record<string, FieldValue>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(props)) {
    if (isStructuredProp(prop, current[key])) {
      if (current[key] !== undefined) payload[key] = current[key]
      continue
    }
    if (key in edited) payload[key] = edited[key]
  }

  return payload
}
