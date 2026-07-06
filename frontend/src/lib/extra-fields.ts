/**
 * Shared helpers for rendering system extra field inputs and display values.
 * Used by filament/spool create, edit, and detail pages.
 */

export interface SystemExtraFieldDef {
  id?: number
  key: string
  label: string
  field_type?: string
  options?: string[] | null
  default_value?: string | null
  formula?: unknown
  show_in_template?: boolean
  config?: {
    unit?: string
    decimal_places?: number | null
    min_bound?: number | null
    max_bound?: number | null
    max_length?: number | null
  } | null
}

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

const RESERVED_EXTRA_FIELD_PATH_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

export function isUnsafeExtraFieldPath(path: string): boolean {
  return path.split('.').some(segment => !segment || RESERVED_EXTRA_FIELD_PATH_SEGMENTS.has(segment))
}

export function hasOwnFieldValue(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export function setOwnFieldValue(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/**
 * Convert decimal_places config value to an HTML <input step> attribute value.
 *   null/undefined → "any"
 *   0             → "1"   (whole numbers)
 *   n             → "0.0…01" with n decimal places
 */
export function dpToStep(dp: number | null | undefined): string {
  if (dp == null) return 'any'
  if (dp === 0) return '1'
  return (1 / Math.pow(10, dp)).toFixed(dp)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeHttpUrl(value: unknown): string | null {
  const candidate = String(value).trim()
  try {
    const protocol = new URL(candidate).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}

/**
 * Keep ISO-8601 datetimes lossless in storage, but make them compact wherever
 * they are shown or printed. Invalid legacy values remain visible unchanged.
 */
export function formatDateTimeDisplay(value: unknown): string {
  const raw = String(value)
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(parsed)
}

/** Format a date or datetime without its time component for compact print output. */
export function formatDateDisplay(value: unknown): string {
  const raw = String(value)
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(parsed)
}

/** Convert an ISO datetime to the local, minute-precision shape accepted by datetime-local. */
export function formatDateTimeInputValue(value: unknown): string | null {
  const raw = String(value).trim()
  if (!raw) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  const pad = (part: number) => String(part).padStart(2, '0')
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  )
}

export const TODAY_EXTRA_FIELD_DEFAULT = 'TODAY'

function localDateInputValue(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseRangeEndpoints(minValue: unknown, maxValue: unknown): Record<string, number> | undefined {
  const min = finiteNumber(minValue)
  const max = finiteNumber(maxValue)
  if (min === null && max === null) return undefined
  return {
    ...(min !== null ? { min } : {}),
    ...(max !== null ? { max } : {}),
  }
}

/**
 * Decode the string-backed System Extra Field default into the value shape used
 * by the shared rich-field controls. Complex defaults use compact JSON while
 * scalar defaults keep their existing wire representation.
 */
export function parseExtraFieldDefaultValue(
  field: Pick<SystemExtraFieldDef, 'field_type' | 'default_value'>,
  now = new Date(),
): unknown {
  const raw = field.default_value
  if (raw === null || raw === undefined || raw === '') return undefined

  switch (field.field_type) {
    case 'range': {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const value = parsed as Record<string, unknown>
          return parseRangeEndpoints(value.min, value.max)
        }
      } catch {
        const parts = raw.split(/\s*(?:,|–|\.\.)\s*/)
        if (parts.length === 2) return parseRangeEndpoints(parts[0], parts[1])
      }
      return undefined
    }
    case 'multiselect':
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.map(String)
      } catch {
        return raw
          .split(/\r?\n|,/)
          .map(value => value.trim())
          .filter(Boolean)
      }
      return []
    case 'checkbox':
      return raw === 'true'
    case 'date':
      return raw.toUpperCase() === TODAY_EXTRA_FIELD_DEFAULT
        ? localDateInputValue(now)
        : raw
    default:
      return raw
  }
}

export function serializeExtraFieldDefaultValue(
  fieldType: string,
  value: unknown,
): string | null {
  if (fieldType === 'range') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const range = value as Record<string, unknown>
    const min = finiteNumber(range.min)
    const max = finiteNumber(range.max)
    if (min === null && max === null) return null
    return JSON.stringify({
      ...(min !== null ? { min } : {}),
      ...(max !== null ? { max } : {}),
    })
  }
  if (fieldType === 'multiselect') {
    if (!Array.isArray(value) || value.length === 0) return null
    return JSON.stringify(value.map(String))
  }
  if (fieldType === 'checkbox') return value === true ? 'true' : 'false'
  if (value === null || value === undefined || String(value) === '') return null
  return String(value)
}

export function formatExtraFieldDefaultValue(
  field: Pick<SystemExtraFieldDef, 'field_type' | 'default_value'>,
): string {
  if (!field.default_value) return '—'
  if (
    field.field_type === 'date' &&
    field.default_value.toUpperCase() === TODAY_EXTRA_FIELD_DEFAULT
  ) {
    return TODAY_EXTRA_FIELD_DEFAULT
  }
  const parsed = parseExtraFieldDefaultValue(field)
  if (field.field_type === 'range' && parsed && typeof parsed === 'object') {
    const range = parsed as Record<string, unknown>
    return `${range.min ?? ''}–${range.max ?? ''}`
  }
  if (field.field_type === 'multiselect' && Array.isArray(parsed)) return parsed.join(', ')
  if (field.field_type === 'checkbox') return parsed === true ? '✓' : '✗'
  return String(parsed ?? field.default_value)
}

/**
 * Estimate a good pixel width for a number <input> from its field config.
 * Counts the expected digit count from min/max bounds and decimal places so
 * the input is compact but wide enough for realistic values.
 */
function numberInputWidth(cfg: SystemExtraFieldDef['config']): number {
  const c = cfg ?? {}
  const absMax = Math.max(
    c.max_bound != null ? Math.abs(c.max_bound) : 0,
    c.min_bound != null ? Math.abs(c.min_bound) : 0,
    99,
  )
  const intDigits = Math.floor(absMax).toString().length
  const fracDigits = c.decimal_places ?? 0
  // chars: sign + integer digits + optional '.' + fractional digits
  const chars = 1 + intDigits + (fracDigits > 0 ? 1 + fracDigits : 0)
  // 10px/char + 24px input padding + 20px for browser spin buttons; min 80px
  return Math.max(80, chars * 10 + 44)
}

export interface CollectedSystemFieldValues {
  flat: Record<string, unknown>
  direct: Record<string, string[]>
}

export function readLosslessDateTimeInputValue(
  input: Pick<HTMLInputElement, 'dataset' | 'value'>,
): string {
  return (
    input.dataset.originalRaw !== undefined &&
    input.value === input.dataset.originalDisplay
  )
    ? input.dataset.originalRaw
    : input.value
}

/** Collect rendered controls once for all create/edit forms. */
export function collectSystemFieldValues(root: ParentNode = document): CollectedSystemFieldValues | null {
  const flat: Record<string, unknown> = {}
  const direct: Record<string, string[]> = {}
  const ranges = new Map<string, Partial<Record<'min' | 'max', HTMLInputElement>>>()

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('.system-field-input').forEach(input => {
    const key = input.dataset.key
    if (!key) return
    if (input.dataset.type === 'checkbox') {
      flat[key] = (input as HTMLInputElement).checked ? 'true' : 'false'
    } else if (input.dataset.type === 'number') {
      const value = input.value.trim()
      if (value) flat[key] = Number(value)
    } else {
      let value = input.value.trim()
      if (input.dataset.type === 'datetime') {
        value = readLosslessDateTimeInputValue(input).trim()
      }
      if (value) flat[key] = value
    }

    const rangeKey = input.dataset.rangeKey
    const rangeEnd = input.dataset.rangeEnd as 'min' | 'max' | undefined
    if (rangeKey && rangeEnd) {
      const entries = ranges.get(rangeKey) ?? {}
      entries[rangeEnd] = input as HTMLInputElement
      ranges.set(rangeKey, entries)
    }
  })

  for (const entries of ranges.values()) {
    const min = entries.min
    const max = entries.max
    max?.setCustomValidity('')
    if (min?.value && max?.value && Number(min.value) > Number(max.value)) {
      max.setCustomValidity('Maximum must be greater than or equal to minimum.')
      const clearRangeError = () => max.setCustomValidity('')
      min.addEventListener('input', clearRangeError, { once: true })
      max.addEventListener('input', clearRangeError, { once: true })
      max.reportValidity()
      return null
    }
    const key = min?.dataset.rangeKey ?? max?.dataset.rangeKey
    const preserveEmpty =
      min?.dataset.rangePresent === 'true' || max?.dataset.rangePresent === 'true'
    if (key && (min?.value || max?.value || preserveEmpty)) {
      flat[`${key}.min`] = min?.value ? Number(min.value) : null
      flat[`${key}.max`] = max?.value ? Number(max.value) : null
    }
  }

  root.querySelectorAll<HTMLInputElement>('.system-field-input-multi').forEach(input => {
    const key = input.dataset.key
    if (!key) return
    direct[key] ??= []
    if (input.checked) direct[key].push(input.value)
  })

  return { flat, direct }
}

/** Expand dot-separated field paths while preserving already parsed value types. */
export function unflattenFieldValues(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.')
    let current = result
    keys.forEach((key, index) => {
      if (index === keys.length - 1) {
        setOwnFieldValue(current, key, value)
      } else {
        const child = hasOwnFieldValue(current, key) ? current[key] : undefined
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          setOwnFieldValue(current, key, {})
        }
        current = current[key] as Record<string, unknown>
      }
    })
  }
  return result
}

/**
 * Render the appropriate <input> / <select> / <textarea> for a system extra field.
 *
 * @param field      Field definition from the API
 * @param rawValue   Raw value from custom_fields[key] (object for range, array
 *                   for multiselect, scalar otherwise). Pass null/undefined when
 *                   creating a new record.
 * @param flat       Flattened custom_fields (dot-notation). Used as fallback for
 *                   scalar types and for range .min/.max when rawValue is absent.
 */
export function renderFieldInput(
  field: SystemExtraFieldDef,
  rawValue: unknown,
  flat: Record<string, unknown> = {}
): string {
  const key = escapeHtml(field.key)
  const cfg = field.config ?? {}
  const dp = cfg.decimal_places ?? null
  const step = dpToStep(dp)
  const unit = cfg.unit ?? ''
  const minAttr = cfg.min_bound != null ? ` min="${cfg.min_bound}"` : ''
  const maxAttr = cfg.max_bound != null ? ` max="${cfg.max_bound}"` : ''
  const unitHtml = unit
    ? `<span style="color:var(--text-muted);font-size:0.85rem;flex-shrink:0">${escapeHtml(unit)}</span>`
    : ''

  const defaultValue = parseExtraFieldDefaultValue(field)
  const scalarVal =
    rawValue != null && String(rawValue) !== ''
      ? rawValue
      : flat[field.key] != null && String(flat[field.key]) !== ''
        ? flat[field.key]
        : defaultValue
  const displayVal =
    scalarVal !== null &&
    scalarVal !== undefined &&
    !Array.isArray(scalarVal) &&
    typeof scalarVal !== 'object'
      ? escapeHtml(String(scalarVal))
      : ''

  switch (field.field_type) {
    case 'float': // legacy alias — falls through
    case 'number': {
      const numW = numberInputWidth(cfg)
      const numInput = `<input type="number" class="fm-input system-field-input" data-key="${key}" data-type="${escapeHtml(field.field_type)}" value="${displayVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px" />`
      if (unit) return `<div style="display:flex;align-items:center;gap:6px">${numInput}${unitHtml}</div>`
      return numInput
    }
    case 'range': {
      const hasRangeValue =
        typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
      const rangeObj =
        hasRangeValue
          ? (rawValue as Record<string, unknown>)
          : {}
      const defaultRange =
        defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)
          ? (defaultValue as Record<string, unknown>)
          : {}
      const minVal =
        rangeObj.min != null
          ? escapeHtml(String(rangeObj.min))
          : flat[field.key + '.min'] != null
            ? escapeHtml(String(flat[field.key + '.min']))
            : defaultRange.min != null
              ? escapeHtml(String(defaultRange.min))
              : ''
      const maxVal =
        rangeObj.max != null
          ? escapeHtml(String(rangeObj.max))
          : flat[field.key + '.max'] != null
            ? escapeHtml(String(flat[field.key + '.max']))
            : defaultRange.max != null
              ? escapeHtml(String(defaultRange.max))
              : ''
      const numW = numberInputWidth(cfg)
      return (
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">` +
        `<input type="number" class="fm-input system-field-input" data-key="${key}.min" data-type="number" data-range-key="${key}" data-range-end="min" data-range-present="${hasRangeValue}" placeholder="Min" value="${minVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px;flex-shrink:0" />` +
        `<span style="color:var(--text-muted)">–</span>` +
        `<input type="number" class="fm-input system-field-input" data-key="${key}.max" data-type="number" data-range-key="${key}" data-range-end="max" data-range-present="${hasRangeValue}" placeholder="Max" value="${maxVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px;flex-shrink:0" />` +
        `${unitHtml}</div>`
      )
    }
    case 'date':
      return `<input type="date" class="fm-input system-field-input" data-key="${key}" data-type="date" value="${displayVal}" style="max-width:160px" />`
    case 'datetime': {
      const storedValue =
        rawValue != null
          ? String(rawValue)
          : flat[field.key] != null
            ? String(flat[field.key])
            : field.default_value ?? ''
      const inputValue = formatDateTimeInputValue(storedValue)
      if (inputValue === null) {
        return `<input type="text" class="fm-input system-field-input" data-key="${key}" data-type="datetime" value="${escapeHtml(storedValue)}" />`
      }
      return `<input type="datetime-local" class="fm-input system-field-input" data-key="${key}" data-type="datetime" data-original-raw="${escapeHtml(storedValue)}" data-original-display="${escapeHtml(inputValue)}" value="${escapeHtml(inputValue)}" style="max-width:220px" />`
    }
    case 'url':
      return `<input type="url" class="fm-input system-field-input" data-key="${key}" data-type="url" value="${displayVal}" placeholder="https://" />`
    case 'multiselect': {
      const selected: string[] = Array.isArray(rawValue)
        ? rawValue.map(String)
        : Array.isArray(flat[field.key])
          ? (flat[field.key] as unknown[]).map(String)
        : Array.isArray(defaultValue)
          ? defaultValue.map(String)
          : []
      const opts = (field.options ?? [])
        .map(opt => {
          const esc = escapeHtml(opt)
          const chk = selected.includes(opt) ? ' checked' : ''
          return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" class="system-field-input-multi" data-key="${key}" data-type="multiselect" value="${esc}"${chk} />${esc}</label>`
        })
        .join('')
      return `<div style="display:flex;flex-direction:column;gap:4px">${opts}</div>`
    }
    case 'textarea': {
      const maxLen = cfg.max_length ?? 2000
      return `<textarea class="fm-input system-field-input" data-key="${key}" data-type="textarea" rows="3" maxlength="${maxLen}" placeholder="e.g. The quick brown fox jumps over the lazy dog." style="resize:vertical">${displayVal}</textarea>`
    }
    case 'checkbox': {
      const chk = displayVal === 'true' || rawValue === true ? ' checked' : ''
      return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" class="system-field-input" data-key="${key}" data-type="checkbox"${chk} /> ${escapeHtml(field.label)}</label>`
    }
    case 'dropdown': {
      const optsHtml = (field.options ?? [])
        .map(opt => {
          const esc = escapeHtml(opt)
          const sel = displayVal === esc ? ' selected' : ''
          return `<option value="${esc}"${sel}>${esc}</option>`
        })
        .join('')
      return `<select class="fm-select system-field-input" data-key="${key}" data-type="dropdown"><option value=""></option>${optsHtml}</select>`
    }
    case 'formula':
      return `<span style="color:var(--text-muted);font-style:italic;font-size:0.9rem">(computed)</span>`
    default: // text and unknown
      return `<input type="text" class="fm-input system-field-input" data-key="${key}" data-type="text" value="${displayVal}" />`
  }
}

/**
 * Render a read-only display value for a system extra field.
 * Returns an HTML string (safe for innerHTML).
 */
export function renderFieldDisplay(field: SystemExtraFieldDef, value: unknown): string {
  if (value === null || value === undefined) return '—'
  const cfg = field.config ?? {}
  const unit = cfg.unit ?? ''
  const dp = cfg.decimal_places ?? null
  const unitSpan = unit
    ? ` <span style="color:var(--text-muted);font-size:0.85rem">${escapeHtml(unit)}</span>`
    : ''

  switch (field.field_type) {
    case 'float': // legacy alias — falls through
    case 'number': {
      const num = finiteNumber(value)
      if (num == null) return escapeHtml(String(value))
      const formatted = dp != null ? num.toFixed(dp) : String(num)
      return `<span>${escapeHtml(formatted)}${unitSpan}</span>`
    }
    case 'range': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return escapeHtml(String(value))
      const rv = value as Record<string, unknown>
      const minNum = finiteNumber(rv.min)
      const maxNum = finiteNumber(rv.max)
      const minStr = minNum != null && dp != null ? minNum.toFixed(dp) : String(rv.min ?? '?')
      const maxStr = maxNum != null && dp != null ? maxNum.toFixed(dp) : String(rv.max ?? '?')
      return `<span>${escapeHtml(minStr)}–${escapeHtml(maxStr)}${unitSpan}</span>`
    }
    case 'date':
      return `<span>${escapeHtml(String(value))}</span>`
    case 'datetime':
      return `<span>${escapeHtml(formatDateTimeDisplay(value))}</span>`
    case 'url': {
      const url = String(value)
      const safeSrc = safeHttpUrl(url)
      if (!safeSrc) return escapeHtml(url)
      return `<a href="${escapeHtml(safeSrc)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${escapeHtml(url)}</a>`
    }
    case 'multiselect':
      if (!Array.isArray(value)) return escapeHtml(String(value))
      return value.map(v => `<span class="fm-pill">${escapeHtml(String(v))}</span>`).join(' ')
    case 'textarea':
      return `<div style="white-space:pre-wrap;font-size:0.9em">${escapeHtml(String(value))}</div>`
    case 'checkbox':
      return value === true || value === 'true' ? '✓' : '✗'
    default:
      return escapeHtml(String(value))
  }
}

/**
 * Render a system extra field for plain-text surfaces such as printed labels.
 * This keeps label tokens from falling back to raw object/array stringification
 * for rich field types like range and multiselect.
 */
export function renderFieldPlainText(field: SystemExtraFieldDef, value: unknown): string {
  if (value === null || value === undefined) return ''
  const cfg = field.config ?? {}
  const unit = cfg.unit ? ` ${cfg.unit}` : ''
  const dp = cfg.decimal_places ?? null

  switch (field.field_type) {
    case 'float': // legacy alias — falls through
    case 'number': {
      const num = finiteNumber(value)
      if (num == null) return String(value)
      return `${dp != null ? num.toFixed(dp) : String(num)}${unit}`
    }
    case 'range': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return renderUnknownFieldPlainText(value)
      }
      const rv = value as Record<string, unknown>
      const minNum = finiteNumber(rv.min)
      const maxNum = finiteNumber(rv.max)
      const minStr = minNum != null && dp != null ? minNum.toFixed(dp) : String(rv.min ?? '')
      const maxStr = maxNum != null && dp != null ? maxNum.toFixed(dp) : String(rv.max ?? '')
      return `${minStr}–${maxStr}${unit}`.trim()
    }
    case 'multiselect':
      return Array.isArray(value) ? value.map(String).join(', ') : String(value)
    case 'datetime':
      return formatDateTimeDisplay(value)
    case 'checkbox':
      return value === true || value === 'true' ? '✓' : '✗'
    default:
      return renderUnknownFieldPlainText(value)
  }
}

export function renderUnknownFieldPlainText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    if ('min' in objectValue || 'max' in objectValue) {
      return `${objectValue.min ?? ''}–${objectValue.max ?? ''}`.trim()
    }
    return JSON.stringify(value)
  }
  return String(value)
}
