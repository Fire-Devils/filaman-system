/**
 * Shared helpers for rendering system extra field inputs and display values.
 * Used by filament/spool create, edit, and detail pages.
 */

export interface SystemExtraFieldDef {
  id: number
  key: string
  label: string
  field_type: string
  options?: string[] | null
  default_value?: string | null
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
  flat: Record<string, any> = {}
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

  const scalarVal =
    rawValue != null
      ? escapeHtml(String(rawValue))
      : flat[field.key] != null
        ? escapeHtml(String(flat[field.key]))
        : ''
  const displayVal = scalarVal || (field.default_value ? escapeHtml(field.default_value) : '')

  switch (field.field_type) {
    case 'float': // legacy alias — falls through
    case 'number': {
      const numW = numberInputWidth(cfg)
      const numInput = `<input type="number" class="fm-input system-field-input" data-key="${key}" data-type="${escapeHtml(field.field_type)}" value="${displayVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px" />`
      if (unit) return `<div style="display:flex;align-items:center;gap:6px">${numInput}${unitHtml}</div>`
      return numInput
    }
    case 'range': {
      const rangeObj =
        typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
          ? (rawValue as Record<string, any>)
          : {}
      const minVal =
        rangeObj.min != null
          ? escapeHtml(String(rangeObj.min))
          : flat[field.key + '.min'] != null
            ? escapeHtml(String(flat[field.key + '.min']))
            : ''
      const maxVal =
        rangeObj.max != null
          ? escapeHtml(String(rangeObj.max))
          : flat[field.key + '.max'] != null
            ? escapeHtml(String(flat[field.key + '.max']))
            : ''
      const numW = numberInputWidth(cfg)
      return (
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">` +
        `<input type="number" class="fm-input system-field-input" data-key="${key}.min" data-type="number" placeholder="Min" value="${minVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px;flex-shrink:0" />` +
        `<span style="color:var(--text-muted)">–</span>` +
        `<input type="number" class="fm-input system-field-input" data-key="${key}.max" data-type="number" placeholder="Max" value="${maxVal}" step="${step}"${minAttr}${maxAttr} style="width:${numW}px;flex-shrink:0" />` +
        `${unitHtml}</div>`
      )
    }
    case 'date':
      return `<input type="date" class="fm-input system-field-input" data-key="${key}" data-type="date" value="${displayVal}" style="max-width:160px" />`
    case 'url':
      return `<input type="url" class="fm-input system-field-input" data-key="${key}" data-type="url" value="${displayVal}" placeholder="https://" />`
    case 'multiselect': {
      const selected: string[] = Array.isArray(rawValue) ? rawValue.map(String) : []
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
      return `<textarea class="fm-input system-field-input" data-key="${key}" data-type="textarea" rows="3" maxlength="${maxLen}" style="resize:vertical">${displayVal}</textarea>`
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
      const num = typeof value === 'number' ? value : parseFloat(String(value))
      if (isNaN(num)) return escapeHtml(String(value))
      const formatted = dp != null ? num.toFixed(dp) : String(num)
      return `<span>${escapeHtml(formatted)}${unitSpan}</span>`
    }
    case 'range': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return escapeHtml(String(value))
      const rv = value as Record<string, any>
      const minNum = typeof rv.min === 'number' ? rv.min : parseFloat(String(rv.min ?? ''))
      const maxNum = typeof rv.max === 'number' ? rv.max : parseFloat(String(rv.max ?? ''))
      const minStr = !isNaN(minNum) && dp != null ? minNum.toFixed(dp) : String(rv.min ?? '?')
      const maxStr = !isNaN(maxNum) && dp != null ? maxNum.toFixed(dp) : String(rv.max ?? '?')
      return `<span>${escapeHtml(minStr)}–${escapeHtml(maxStr)}${unitSpan}</span>`
    }
    case 'date':
      return `<span>${escapeHtml(String(value))}</span>`
    case 'url': {
      const url = String(value)
      // Only render as a link for safe schemes; show as plain text otherwise
      const safeSrc = /^https?:\/\//i.test(url) ? url : '#'
      return `<a href="${escapeHtml(safeSrc)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${escapeHtml(url)}</a>`
    }
    case 'multiselect':
      if (!Array.isArray(value)) return escapeHtml(String(value))
      return (value as any[]).map(v => `<span class="fm-pill">${escapeHtml(String(v))}</span>`).join(' ')
    case 'textarea':
      return `<div style="white-space:pre-wrap;font-size:0.9em">${escapeHtml(String(value))}</div>`
    case 'checkbox':
      return value === true || value === 'true' ? '✓' : '✗'
    default:
      return escapeHtml(String(value))
  }
}
