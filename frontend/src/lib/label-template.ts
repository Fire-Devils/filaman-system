/**
 * Label template parser for the Advanced Label Designer.
 *
 * Template syntax:
 *   {token}                — simple dot-path substitution; resolves to "?" if missing
 *   {prefix{token}suffix}  — optional block: rendered as prefix+value+suffix if token is not "?"
 *                            omitted entirely when token resolves to "?"
 *   **bold**               — <strong> text
 *   *italic*               — <em> text (single asterisk, not part of **)
 *   __underline__          — <u> text
 *   ^^caps^^               — uppercase text
 *   ==inverse==            — inverted text (black bg, white text)
 *   @@inverse@@            — inverted text using filament color with automatic black/white text
 *   [size=120]text[/size]  — inline relative size in percent (50..300)
 *   [size=120%]text[/size] — same as above; percent sign is optional
 *   {color_swatch[8]}      — inline color bar using filament.color_hex; width is in ch units (default 1)
 *   \n                     — line-break (<br>)
 *
 * SpoolData is a flat object passed from the print page; the "extra" key holds
 * extra-field values keyed by field key.
 */

export interface SpoolData {
  id: string | number
  // ── Filament profile fields ───────────────────────────────────────────────
  'filament.id': string
  'filament.name': string
  /** @deprecated compatibility alias for filament.type */
  'filament.material': string
  'filament.color': string
  'filament.colors': string
  'filament.color_hex': string
  'filament.color_hexes': string
  'filament.manufacturer': string
  'filament.manufacturer_id': string
  'filament.color_mode': string
  'filament.multi_color_style': string
  'filament.extruder_temp': string | number
  'filament.bed_temp': string | number
  'filament.raw_material_weight_g': string | number
  /** @deprecated compatibility alias for filament.raw_material_weight_g */
  'filament.weight': string | number
  'filament.type'?: string
  'filament.subtype'?: string
  'filament.manufacturer_color_name'?: string
  'filament.diameter'?: string
  'filament.finish'?: string
  'filament.density'?: string
  'filament.price'?: string
  'filament.default_spool_weight_g'?: string
  'filament.spool_outer_diameter_mm'?: string
  'filament.spool_width_mm'?: string
  'filament.spool_material'?: string
  'filament.shop_url'?: string
  // ── Spool model fields (only populated on spool print pages) ─────────────
  lot_number?: string
  external_id?: string
  rfid_uid?: string
  location?: string
  status?: string
  purchase_date?: string
  purchase_price?: string
  remaining_weight_g?: string
  initial_total_weight_g?: string
  empty_spool_weight_g?: string
  low_weight_threshold_g?: string
  stocked_in_at?: string
  last_used_at?: string
  extra?: Record<string, string>
  [key: string]: unknown
}

const SWATCH_MARKER_RE = /^\[\[FM_SWATCH\|(\d{1,3})\|(#[0-9A-F]{6})\]\]$/
const MAX_TEMPLATE_CHARS = 8000
const MAX_MARKUP_CHARS = 12000

export function normalizeHexColor(raw: unknown): string | null {

  if (raw === undefined || raw === null) return null
  const hex = String(raw).trim().replace(/^#/, '')
  if (!hex) return null
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [a, b, c] = hex.split('')
    return `#${(a + a + b + b + c + c).toUpperCase()}`
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toUpperCase()}`
  return null
}

export function getReadableTextColor(backgroundHex: string | null): '#000' | '#fff' {
  if (!backgroundHex) return '#fff'
  const hex = backgroundHex.replace('#', '')
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  const luminance = (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2])
  const contrastWithBlack = (luminance + 0.05) / 0.05
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  return contrastWithBlack >= contrastWithWhite ? '#000' : '#fff'
}

function getFilamentColorTheme(data: SpoolData): { background: string; foreground: '#000' | '#fff' } {
  const background = normalizeHexColor(data['filament.color_hex']) ?? '#000000'
  return { background, foreground: getReadableTextColor(background) }
}

function parseColorSwatchToken(token: string): number | null {
  const m = token.trim().match(/^color(?:-|_)swatch(?:\[(\d{1,3})\])?$/i)
  if (!m) return null
  const width = m[1] ? Number(m[1]) : 1
  return Math.max(1, Math.min(40, width))
}

function renderColorSwatchMarker(token: string, data: SpoolData): string | null {
  const widthCh = parseColorSwatchToken(token)
  if (widthCh === null) return null
  const hex = normalizeHexColor(data['filament.color_hex'])
  if (!hex) return ''
  return `[[FM_SWATCH|${widthCh}|${hex}]]`
}

function applyCapsMarkup(text: string): string {
  return text.replace(/\^\^([\s\S]*?)\^\^/g, (_match, inner: string) => inner.toUpperCase())
}

/** Resolve a dot-path token against the spool data object. */
function resolveToken(token: string, data: SpoolData): string {
  if (token.startsWith('extra.')) {
    const key = token.slice(6)
    const val = data.extra?.[key]
    return val !== undefined && val !== '' ? String(val) : '?'
  }
  const val = (data as Record<string, unknown>)[token]
  if (val === undefined || val === null || val === '') return '?'
  return String(val)
}

/** Expand {token} and {prefix{token}suffix} placeholders to plain text. */
export function renderTemplateText(template: string, data: SpoolData): string {
  const boundedTemplate = template.length > MAX_TEMPLATE_CHARS
    ? template.slice(0, MAX_TEMPLATE_CHARS)
    : template
  // Match both optional-block {{inner}} style and simple {token}
  // Process longest matches first (optional blocks) before simple tokens.
  const rendered = boundedTemplate.replace(
    /{(?:[^{}]|{[^{}]*})*}/g,
    (match) => {
      // Optional block: {prefix{token}suffix}
      const optional = match.match(/^\{(.*?)\{([^{}]+)\}(.*?)\}$/)
      if (optional) {
        const [, prefix, token, suffix] = optional
        const swatchMarker = renderColorSwatchMarker(token, data)
        if (swatchMarker !== null) return swatchMarker === '' ? '' : prefix + swatchMarker + suffix
        const resolved = resolveToken(token, data)
        return resolved === '?' ? '' : prefix + resolved + suffix
      }
      // Simple token: {token}
      const token = match.slice(1, -1)
      const swatchMarker = renderColorSwatchMarker(token, data)
      if (swatchMarker !== null) return swatchMarker
      const resolved = resolveToken(token, data)
      return resolved === '?' ? '' : resolved
    }
  )
  // Caps runs after token resolution so wrapped tokens uppercase their values,
  // without forcing fields like color_hex to be uppercase by default.
  return applyCapsMarkup(rendered)
}

/** Apply inline markup to rendered template text. */
function applyMarkup(text: string, frag: DocumentFragment | HTMLElement, data: SpoolData): void {
  // Regex: match swatch marker, [size=NNN]...[/size] (case-insensitive),
  // bold (**...**), underline (__...__), italic (*...*), inverse (==...==), filament inverse (@@...@@)
  const regex = /(\[\[FM_SWATCH\|\d{1,3}\|#[0-9A-F]{6}\]\]|\[size=\d{1,3}%?\][\s\S]*?\[\/size\]|\*\*[\s\S]*?\*\*|__[\s\S]*?__|\*(?!\*)([\s\S]*?)\*(?!\*)|==[\s\S]*?==|@@[\s\S]*?@@)/gi
  let last = 0

  const appendPlainText = (raw: string, container: DocumentFragment | HTMLElement) => {
    // Split on newlines and insert <br>
    const lines = raw.split('\n')
    lines.forEach((line, i) => {
      if (line) container.appendChild(document.createTextNode(line))
      if (i < lines.length - 1) container.appendChild(document.createElement('br'))
    })
  }

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    // Text before this match
    if (match.index > last) {
      appendPlainText(text.slice(last, match.index), frag)
    }

    const part = match[0]

    const swatch = part.match(SWATCH_MARKER_RE)
    if (swatch) {
      const [, widthCh, hex] = swatch
      const el = document.createElement('span')
      el.style.display = 'inline-block'
      el.style.width = `${Number(widthCh)}ch`
      el.style.height = '0.82em'
      el.style.backgroundColor = hex
      el.style.borderRadius = '0.14em'
      el.style.border = '1px solid rgba(0,0,0,0.28)'
      el.style.verticalAlign = 'baseline'
      el.style.margin = '0 0.2ch'
      frag.appendChild(el)
    } else if (/^\[size=/i.test(part) && /\[\/size\]$/i.test(part)) {
      const sized = part.match(/^\[size=(\d{1,3})%?\]([\s\S]*?)\[\/size\]$/i)
      if (sized) {
        const [, rawPct, inner] = sized
        const pct = Math.max(50, Math.min(300, Number(rawPct)))
        const el = document.createElement('span')
        el.style.fontSize = `${pct}%`
        applyMarkup(inner, el, data)
        frag.appendChild(el)
      } else {
        appendPlainText(part, frag)
      }
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const inner = part.slice(2, -2)
      const el = document.createElement('strong')
      applyMarkup(inner, el, data)
      frag.appendChild(el)
    } else if (part.startsWith('__') && part.endsWith('__')) {
      const inner = part.slice(2, -2)
      const el = document.createElement('u')
      applyMarkup(inner, el, data)
      frag.appendChild(el)
    } else if (part.startsWith('==') && part.endsWith('==')) {
      const inner = part.slice(2, -2)
      const el = document.createElement('span')
      el.style.backgroundColor = '#000'
      el.style.color = '#fff'
      el.style.padding = '0 0.6mm'
      el.style.display = 'inline-block'
      applyMarkup(inner, el, data)
      frag.appendChild(el)
    } else if (part.startsWith('@@') && part.endsWith('@@')) {
      const inner = part.slice(2, -2)
      const theme = getFilamentColorTheme(data)
      const el = document.createElement('span')
      el.style.backgroundColor = theme.background
      el.style.color = theme.foreground
      el.style.padding = '0 0.6mm'
      el.style.display = 'inline-block'
      applyMarkup(inner, el, data)
      frag.appendChild(el)
    } else if (part.startsWith('*') && part.endsWith('*')) {
      const inner = part.slice(1, -1)
      const el = document.createElement('em')
      applyMarkup(inner, el, data)
      frag.appendChild(el)
    }

    last = match.index + part.length
  }

  // Remaining text after last match
  if (last < text.length) {
    appendPlainText(text.slice(last), frag)
  }
}

/**
 * Parse a template string with spool data and return a DocumentFragment
 * ready to append into the DOM.
 */
export function parseTemplate(template: string, data: SpoolData): DocumentFragment {
  const plainText = renderTemplateText(template, data)
  const frag = document.createDocumentFragment()
  if (plainText.length > MAX_MARKUP_CHARS) {
    frag.appendChild(document.createTextNode(plainText.slice(0, MAX_MARKUP_CHARS)))
    return frag
  }
  applyMarkup(plainText, frag, data)
  return frag
}
