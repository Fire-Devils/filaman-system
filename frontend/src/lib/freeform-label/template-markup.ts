import { LABEL_FONT_FAMILIES, type LabelFontFamily } from './types'

const TEXT_MARKUP_SOURCE = String.raw`\*\*\*[\s\S]*?\*\*\*|\*\*[\s\S]*?\*\*|__[\s\S]*?__|\*(?!\*)([\s\S]*?)\*(?=\*{3}(?!\*)|[^*]|$)|==[\s\S]*?==|@@[\s\S]*?@@|\^\^[\s\S]*?\^\^`
const TAG_MARKUP_SOURCE = String.raw`\[(?:(font)=[^\]\n]+|(size)=\d{1,3}%?|([bi]))\]|\[\/(font|size|b|i)\]`
const SWATCH_MARKUP_SOURCE = String.raw`\[\[FM_SWATCH\|\d{1,3}\|(bands|layers)\|(?:#[0-9A-F]{6})(?:,#[0-9A-F]{6})*\]\]`

export type TemplateMarkupKind = 'font' | 'size' | 'delimiter' | 'swatch'

export interface TemplateMarkup {
  kind: TemplateMarkupKind
  opening: string
  closing: string
  inner: string
  font?: LabelFontFamily
  sizePercent?: number
}

export interface TemplateFieldRange {
  start: number
  end: number
  innerStart: number
  innerEnd: number
  token?: boolean
  condition?: string
  explicit?: boolean
}

/** Shared field/condition boundaries; the explicit header is never a visible token. */
export function templateFieldRanges(template: string): TemplateFieldRange[] {
  const ranges: TemplateFieldRange[] = []
  const stack: Array<{ start: number; innerStart: number; explicit: boolean; condition?: string }> = []
  for (const match of template.matchAll(/\[if=\{([^{}\n]+)\}\]|\[\/if\]|\{|\}/gi)) {
    const part = match[0], start = match.index!
    if (part === '{' || match[1] !== undefined) {
      stack.push({ start, innerStart: start + part.length, explicit: part !== '{', condition: match[1]?.trim() })
      continue
    }
    const frame = stack.at(-1)
    if (!frame || frame.explicit !== (part !== '}')) continue
    stack.pop()
    const range = { ...frame, end: start + part.length, innerEnd: start, token: !frame.explicit && frame.condition === undefined }
    ranges.push(range)
    const parent = stack.at(-1)
    if (parent && parent.condition === undefined) parent.condition = range.condition ?? template.slice(range.innerStart, range.innerEnd).trim()
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}

/** Match balanced tags before recursing into their bodies; malformed tags stay literal. */
export function* templateMarkupMatches(template: string, { swatches = false }: { swatches?: boolean } = {}): Generator<RegExpExecArray> {
  const ends = new Map<number, number>()
  const stack: Array<{ tag: string; start: number }> = []
  for (const match of template.matchAll(new RegExp(TAG_MARKUP_SOURCE, 'gi'))) {
    if (match[4]) {
      const opening = stack.pop()
      if (opening?.tag === match[4].toLowerCase()) ends.set(opening.start, match.index! + match[0].length)
      else stack.length = 0
    } else stack.push({ tag: (match[1] ?? match[2] ?? match[3]).toLowerCase(), start: match.index! })
  }
  const regex = new RegExp(`${swatches ? `${SWATCH_MARKUP_SOURCE}|` : ''}${TAG_MARKUP_SOURCE}|${TEXT_MARKUP_SOURCE}`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(template)) !== null) {
    if (match[0].startsWith('[') && !match[0].startsWith('[[')) {
      const end = ends.get(match.index)
      if (end === undefined) continue
      match[0] = template.slice(match.index, end)
      regex.lastIndex = end
    }
    yield match
  }
}

export function resolveTemplateFont(name: string): LabelFontFamily | null {
  return LABEL_FONT_FAMILIES.find(font => font.toLowerCase() === name.toLowerCase()) ?? null
}

export function parseTemplateMarkup(part: string): TemplateMarkup | null {
  if (/^\[\[FM_SWATCH\|/i.test(part)) return { kind: 'swatch', opening: part, closing: '', inner: '' }

  const emphasis = part.match(/^\[([bi])\]([\s\S]*?)\[\/\1\]$/i)
  if (emphasis) return { kind: 'delimiter', opening: part.slice(0, 3), closing: part.slice(-4), inner: emphasis[2] }

  const font = part.match(/^\[font=([^\]\n]+)\]([\s\S]*?)\[\/font\]$/i)
  if (font) {
    const family = resolveTemplateFont(font[1])
    return family ? { kind: 'font', opening: part.slice(0, part.indexOf(']') + 1), closing: '[/font]', inner: font[2], font: family } : null
  }

  const size = part.match(/^\[size=(\d{1,3})%?\]([\s\S]*?)\[\/size\]$/i)
  if (size) return {
    kind: 'size',
    opening: part.slice(0, part.indexOf(']') + 1),
    closing: '[/size]',
    inner: size[2],
    sizePercent: Math.max(50, Math.min(300, Number(size[1]))),
  }

  const delimiter = part.startsWith('***') ? '***'
    : part.startsWith('**') ? '**'
      : part.startsWith('*') ? '*'
        : part.slice(0, 2)
  return part.endsWith(delimiter)
    ? { kind: 'delimiter', opening: delimiter, closing: delimiter, inner: part.slice(delimiter.length, -delimiter.length) }
    : null
}
