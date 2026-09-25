export { renderSelectableTemplate } from '../label-template'
import { TEMPLATE_TEXT_MODIFIER_DELIMITERS, type TemplateTextModifier } from './text-modifiers'
import { LABEL_FONT_FAMILIES, type LabelFontFamily } from './types'
import { templateMarkupMatches, parseTemplateMarkup, resolveTemplateFont, templateFieldRanges, type TemplateFieldRange } from './template-markup'
export type { TemplateTextModifier } from './text-modifiers'

export interface TemplateSourceRange { start: number; end: number }
export interface FormattedTemplateRange extends TemplateSourceRange { template: string }

const sourceSelector = '[data-template-start][data-template-end]'

function sourceRange(element: HTMLElement): TemplateSourceRange {
  return { start: Number(element.dataset.templateStart), end: Number(element.dataset.templateEnd) }
}

/** Map a caret to source, snapping positions inside substitutions to a token edge. */
export function getTemplateCaretRange(root: HTMLElement, selection: Selection | null): TemplateSourceRange | null {
  if (!selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode)) return null
  const node = selection.anchorNode!
  const offset = selection.anchorOffset
  const leaf = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(sourceSelector)
  if (leaf && root.contains(leaf)) {
    const mapped = sourceRange(leaf)
    const position = leaf.hasAttribute('data-template-atomic')
      ? offset === 0 ? mapped.start : mapped.end
      : Math.min(mapped.end, mapped.start + offset)
    return { start: position, end: position }
  }
  const range = selection.getRangeAt(0)
  let position = 0
  for (const element of root.querySelectorAll<HTMLElement>(sourceSelector)) {
    const boundary = root.ownerDocument.createRange()
    boundary.selectNode(element)
    if (range.compareBoundaryPoints(Range.START_TO_START, boundary) <= 0) {
      position = sourceRange(element).start
      break
    }
    position = sourceRange(element).end
  }
  return { start: position, end: position }
}

/** Resolve browser selection offsets without ever indexing into a substituted token. */
export function getTemplateSelectionRange(root: HTMLElement, selection: Selection | Range | null): TemplateSourceRange | null {
  if (!selection) return null
  const range = 'rangeCount' in selection ? selection.rangeCount ? selection.getRangeAt(0) : null : selection
  if (!range || range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  let start = Infinity
  let end = -Infinity
  for (const element of root.querySelectorAll<HTMLElement>(sourceSelector)) {
    if (!range.intersectsNode(element)) continue
    const elementRange = document.createRange()
    elementRange.selectNodeContents(element.firstChild?.nodeType === Node.TEXT_NODE ? element.firstChild : element)
    // intersectsNode includes touching boundaries; discard zero-width contact.
    if (range.compareBoundaryPoints(Range.END_TO_START, elementRange) >= 0 || range.compareBoundaryPoints(Range.START_TO_END, elementRange) <= 0) continue
    const source = sourceRange(element)
    if (!element.hasAttribute('data-template-atomic')) {
      const node = element.firstChild
      const length = element.textContent?.length ?? 0
      if (node?.nodeType === Node.TEXT_NODE && length === source.end - source.start) {
        if (range.startContainer === node) source.start += range.startOffset
        if (range.endContainer === node) source.end = Number(element.dataset.templateStart) + range.endOffset
      }
    }
    start = Math.min(start, source.start)
    end = Math.max(end, source.end)
  }
  return Number.isFinite(start) && end > start ? { start, end } : null
}

/** Restore visible text after the preview DOM has been replaced. */
export function restoreTemplateSelection(root: HTMLElement, source: TemplateSourceRange, selection: Selection | null = root.ownerDocument.defaultView?.getSelection() ?? null): boolean {
  if (!selection) return false
  if (source.start === source.end) {
    const elements = [...root.querySelectorAll<HTMLElement>(sourceSelector)]
    const element = elements.find(element => {
      const mapped = sourceRange(element)
      return mapped.start <= source.start && mapped.end >= source.start
    }) ?? elements.find(element => sourceRange(element).start >= source.start) ?? elements.at(-1)
    const range = root.ownerDocument.createRange()
    if (!element) { range.selectNodeContents(root); range.collapse(false) }
    else {
      const mapped = sourceRange(element)
      if (!element.hasAttribute('data-template-atomic') && element.firstChild?.nodeType === Node.TEXT_NODE) {
        range.setStart(element.firstChild, Math.max(0, Math.min(element.firstChild.textContent?.length ?? 0, source.start - mapped.start)))
      } else if (source.start <= mapped.start) range.setStartBefore(element)
      else range.setStartAfter(element)
      range.collapse(true)
    }
    selection.removeAllRanges(); selection.addRange(range)
    return true
  }
  const leaves = [...root.querySelectorAll<HTMLElement>(sourceSelector)].filter(element => {
    const range = sourceRange(element)
    return range.end > source.start && range.start < source.end
  })
  if (leaves.length === 0) return false
  const first = leaves[0]
  const last = leaves[leaves.length - 1]
  const range = root.ownerDocument.createRange()
  const setBoundary = (element: HTMLElement, isStart: boolean) => {
    const mapped = sourceRange(element)
    const text = element.firstChild
    if (text?.nodeType === Node.TEXT_NODE && !element.hasAttribute('data-template-atomic')) {
      const linear = !element.hasAttribute('data-template-atomic') && text.textContent!.length === mapped.end - mapped.start
      const offset = linear
        ? Math.max(0, Math.min(text.textContent!.length, (isStart ? source.start : source.end) - mapped.start))
        : isStart ? 0 : text.textContent!.length
      if (isStart) range.setStart(text, offset)
      else range.setEnd(text, offset)
    } else if (isStart) range.setStartBefore(element)
    else range.setEndAfter(element)
  }
  setBoundary(first, true)
  setBoundary(last, false)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/** Copy a source slice with clipped, balanced formatting wrappers. */
export function copyTemplateRange(template: string, start: number, end: number, inheritedCondition?: string, preserveCrossingConditions = true): string {
  const ranges = syntaxRanges(template).sort((a, b) => a.start - b.start || b.end - a.end)
  const slice = (from: number, to: number, candidates: SyntaxRange[]): string => {
    let result = ''
    let cursor = from
    for (const range of candidates) {
      if (range.start < cursor || range.end > to) continue
      result += template.slice(Math.max(cursor, start), Math.max(cursor, Math.min(range.start, end)))
      if (range.end > start && range.start < end) {
        if (range.token) result += template.slice(range.start, range.end)
        else {
          const inner = slice(range.innerStart, range.innerEnd, candidates.filter(child => child !== range))
          if (inner) {
            const crossingLiteral = preserveCrossingConditions && !range.delimiter && !range.explicit
              && (start < range.start || end > range.end) && !/\{[^{}]*\}/.test(inner)
            const wrapped = range.delimiter || inheritedCondition !== range.condition && (range.explicit || crossingLiteral || /\{[^{}]*\}/.test(inner))
            const field = wrapped && !range.delimiter && !range.explicit && templateFieldRanges(inner)[0]
            const changedCondition = field && (field.condition ?? inner.slice(field.innerStart, field.innerEnd).trim()) !== range.condition
            result += crossingLiteral || changedCondition ? `[if={${range.condition}}]${inner}[/if]` : wrapped
              ? template.slice(range.start, range.innerStart) + inner + template.slice(range.innerEnd, range.end)
              : inner
          }
        }
      }
      cursor = range.end
    }
    return result + template.slice(Math.max(cursor, start), Math.max(cursor, Math.min(to, end)))
  }
  return slice(0, template.length, ranges)
}

/** Edit mapped text while preserving unselected text and balanced markup. */
export function replaceTemplateRange(template: string, start: number, end: number, replacement: string): FormattedTemplateRange {
  const ranges = syntaxRanges(template)
  for (const token of ranges.filter(range => range.token)) {
    if (start === end && start > token.start && start < token.end) start = end = token.end
    else if (end > token.start && start < token.end) { start = Math.min(start, token.start); end = Math.max(end, token.end) }
  }
  const canonicalEmphasis = [...ranges, ...syntaxRanges(replacement)].some(range => range.delimiter === '*' || range.delimiter === '***')
  const slice = (source: string, from: number, to: number, inheritedCondition?: string) => {
    // Edit remnants keep the existing rule: removing their last field leaves literal text.
    const fragment = copyTemplateRange(source, from, to, inheritedCondition, false)
    return canonicalEmphasis ? normalizeTemplateEmphasis(fragment) : fragment
  }
  if (canonicalEmphasis) replacement = normalizeTemplateEmphasis(replacement)
  let replacementCaret = replacement.length
  const replacementContexts = new Map<number, SyntaxRange[]>()
  const ancestors = (optional: SyntaxRange) => ranges.filter(range => range.delimiter && range.start < optional.start && range.end > optional.end)
  const editOptionalBody = (optional: SyntaxRange, replacement: string) => {
    const context = ancestors(optional).sort((a, b) => a.start - b.start || b.end - a.end)
    const inheritedOpening = context.map(range => template.slice(range.start, range.innerStart)).join('')
    const inheritedClosing = context.toReversed().map(range => template.slice(range.innerEnd, range.end)).join('')
    const body = inheritedOpening + template.slice(optional.innerStart, optional.innerEnd) + inheritedClosing
    const offset = inheritedOpening.length - optional.innerStart
    return { context, inner: replaceTemplateRange(body,
      Math.max(start, optional.innerStart) + offset,
      Math.min(end, optional.innerEnd) + offset, replacement) }
  }
  const replacementRanges = syntaxRanges(replacement)
  const formattedReplacement = replacementRanges.some(range => !range.token)
  const destinationOptional = ranges.find(range => !range.token && !range.delimiter && start >= range.innerStart && end <= range.innerEnd)
  const retainCondition = destinationOptional && (destinationOptional.explicit || replacementRanges.some(range =>
    !range.delimiter && (range.condition ?? replacement.slice(range.innerStart, range.innerEnd).trim()) !== destinationOptional.condition))
  if (destinationOptional && (retainCondition || formattedReplacement)) {
    // Rebuild the enclosing condition before touching a nested boundary. The
    // copied fragment only sheds conditions already supplied by this wrapper.
    const { inner, context } = editOptionalBody(destinationOptional,
      slice(replacement, 0, replacement.length, destinationOptional.condition))
    const before = slice(template, 0, destinationOptional.start)
    const conditional = retainCondition || templateFieldRanges(inner.template).length > 0
    const opening = conditional ? `[if={${destinationOptional.condition}}]` : ''
    const position = before.length + opening.length + inner.start
    return reassembleTemplateEdit({
      template: before + opening + inner.template + (conditional ? '[/if]' : '') + slice(template, destinationOptional.end, template.length),
      start: position, end: position,
    }, new Map(conditional ? [[syntaxRanges(before).filter(range => !range.token && !range.delimiter).length, context]] : []))
  }
  // A copied field at an edit boundary still owns the unselected part of its
  // condition. Rejoin those structural fragments before balancing the styles.
  for (const optional of ranges.filter(range => !range.token && !range.delimiter)) {
    const leading = optional.innerStart <= start && start < optional.innerEnd && end >= optional.end
    const trailing = start <= optional.start && end > optional.innerStart && end <= optional.innerEnd
    if (!leading && !trailing) continue
    const field = ranges.find(range => range.token && range.start >= optional.innerStart && range.end <= optional.innerEnd
      && range.start >= start && range.end <= end)
    const copiedRanges = syntaxRanges(replacement)
    const copied = copiedRanges.find(range => !range.token && !range.delimiter
      && range.condition === optional.condition
      && (optional.explicit || range.explicit || field && copiedRanges.some(token => token.token && token.start >= range.innerStart && token.end <= range.innerEnd
        && replacement.slice(token.start, token.end) === template.slice(field.start, field.end)))
      && !slice(replacement, leading ? 0 : range.end, leading ? range.start : replacement.length))
    if (!copied) continue
    const before = slice(replacement, 0, copied.start)
    const after = slice(replacement, copied.end, replacement.length)
    const { inner, context } = editOptionalBody(optional,
      slice(replacement, copied.innerStart, copied.innerEnd, optional.condition))
    const opening = template.slice(optional.start, optional.innerStart)
    const closing = template.slice(optional.innerEnd, optional.end)
    replacement = before + opening + inner.template + closing + after
    replacementCaret = leading ? replacement.length : before.length + opening.length + inner.start
    replacementContexts.set(copiedRanges.filter(range => !range.token && !range.delimiter).indexOf(copied), context)
    if (leading) start = optional.start
    else end = optional.end
  }
  const optional = ranges.find(range => !range.token && !range.delimiter && start >= range.innerStart && end <= range.innerEnd
    && !/\{[^{}]*\}/.test(template.slice(range.innerStart, start) + replacement + template.slice(end, range.innerEnd)))
  if (optional) return replaceTemplateRange(
    template.slice(0, optional.start) + template.slice(optional.innerStart, optional.innerEnd) + template.slice(optional.end),
    start - 1, end - 1, replacement,
  )
  // A formatted fragment carries its own wrappers; nesting identical delimiters
  // would close the destination's style instead of preserving the copied style.
  const container = ranges.filter(range => !formattedReplacement && !range.token && start >= range.innerStart && end <= range.innerEnd)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
  const from = container?.innerStart ?? 0
  const to = container?.innerEnd ?? template.length
  const inner = template.slice(from, to)
  const prefix = slice(inner, 0, start - from)
  const suffix = slice(inner, end - from, inner.length)
  if (container && !prefix && !replacement && !suffix) return replaceTemplateRange(template, container.start, container.end, '')
  const position = from + prefix.length + replacementCaret
  const result = { template: template.slice(0, from) + prefix + replacement + suffix + template.slice(to), start: position, end: position }
  const precedingOptionals = syntaxRanges(template.slice(0, from) + prefix).filter(range => !range.token && !range.delimiter).length
  return formattedReplacement ? reassembleTemplateEdit(result,
    new Map([...replacementContexts].map(([index, context]) => [precedingOptionals + index, context]))) : result
}

/** Adjacent source character/token, independent of an asynchronous preview render. */
export function adjacentTemplateRange(template: string, position: number, backward: boolean, unit: 'grapheme' | 'word' | 'line' = 'grapheme'): TemplateSourceRange | null {
  if (backward ? position <= 0 : position >= template.length) return null
  if (unit === 'line') {
    // Native ranges handle visual wrapping; a pending render uses source lines.
    const boundary = backward ? template.lastIndexOf('\n', position - 1) + 1 : template.indexOf('\n', position)
    const end = boundary < 0 ? template.length : boundary
    if (end !== position) return { start: Math.min(position, end), end: Math.max(position, end) }
  }
  const ranges = syntaxRanges(template)
  const segments = new Intl.Segmenter(undefined, { granularity: unit === 'word' ? 'word' : 'grapheme' }).segment(template)
  let index = backward ? position - 1 : position
  while (index >= 0 && index < template.length) {
    const token = ranges.find(range => range.token && index >= range.start && index < range.end)
    if (token) return {
      start: unit === 'word' && !backward ? Math.min(position, token.start) : token.start,
      end: unit === 'word' && backward ? Math.max(position, token.end) : token.end,
    }
    const delimiter = ranges.find(range => !range.token && (
      (index >= range.start && index < range.innerStart) || (index >= range.innerEnd && index < range.end)
    ))
    if (!delimiter) {
      const segment = segments.containing(index)!
      if (unit === 'word') {
        if (/^\s+$/.test(segment.segment)) {
          index = backward ? segment.index - 1 : segment.index + segment.segment.length
          continue
        }
        return { start: backward ? segment.index : position, end: backward ? position : segment.index + segment.segment.length }
      }
      return { start: segment.index, end: segment.index + segment.segment.length }
    }
    index += backward ? -1 : 1
  }
  if (unit === 'word' && index !== position) return { start: backward ? 0 : position, end: backward ? position : template.length }
  return null
}

interface SyntaxRange extends TemplateFieldRange { delimiter?: string }

/** Match the renderer's supported syntax, including nested wrappers and optional blocks. */
function syntaxRanges(template: string): SyntaxRange[] {
  const ranges: SyntaxRange[] = templateFieldRanges(template)
  const visitMarkup = (text: string, offset: number) => {
    for (const match of templateMarkupMatches(text)) {
      const part = match[0]
      const markup = parseTemplateMarkup(part)
      if (!markup) continue
      const start = offset + match.index!
      const end = start + part.length
      const innerStart = start + markup.opening.length
      const innerEnd = end - markup.closing.length
      ranges.push({ start, end, innerStart, innerEnd, delimiter: markup.opening })
      visitMarkup(markup.inner, innerStart)
    }
  }
  visitMarkup(template, 0)
  return ranges
}

function matchesModifier(range: SyntaxRange, modifier: TemplateTextModifier): boolean {
  return modifier !== 'date' && (range.delimiter === TEMPLATE_TEXT_MODIFIER_DELIMITERS[modifier]
    || (modifier === 'bold' && range.delimiter?.toLowerCase() === '[b]')
    || (modifier === 'italic' && range.delimiter?.toLowerCase() === '[i]')
    || ((modifier === 'bold' || modifier === 'italic') && range.delimiter === '***'))
}

/** A mixed selection is off; clicking its button applies the style throughout. */
export function isTemplateModifierActive(template: string, start: number, end: number, modifier: TemplateTextModifier): boolean {
  if (end <= start) return false
  const ranges = syntaxRanges(template)
  if (modifier === 'date') {
    const tokens = ranges.filter(range => range.token && range.end > start && range.start < end)
    return tokens.length > 0 && tokens.every(range => /\|date\s*\}$/i.test(template.slice(range.start, range.end)))
  }
  const styled = ranges.filter(range => matchesModifier(range, modifier))
  return isTemplateRangeStyled(ranges, styled, start, end)
}

function isTemplateRangeStyled(ranges: SyntaxRange[], styled: SyntaxRange[], start: number, end: number): boolean {
  if (end <= start) return false
  if (!styled.some(range => range.innerEnd > start && range.innerStart < end)) return false
  // Ignore syntax while checking that every selected character is styled.
  const covered = [...styled, ...ranges.filter(range => !range.token).flatMap(range => [
    { start: range.start, end: range.innerStart }, { start: range.innerEnd, end: range.end },
  ])].sort((a, b) => a.start - b.start)
  let cursor = start
  for (const range of covered) {
    if (range.start > cursor) break
    cursor = Math.max(cursor, range.end)
    if (cursor >= end) return true
  }
  return false
}

interface InlineStyle { key: Exclude<TemplateTextModifier, 'date'> | 'font' | 'size'; opening: string; closing: string }

function modifierStyle(modifier: Exclude<TemplateTextModifier, 'date'>): InlineStyle {
  const tag = modifier === 'bold' ? 'b' : modifier === 'italic' ? 'i' : null
  const delimiter = TEMPLATE_TEXT_MODIFIER_DELIMITERS[modifier]
  return { key: modifier, opening: tag ? `[${tag}]` : delimiter, closing: tag ? `[/${tag}]` : delimiter }
}

/** Split styles at selection edges; optional blocks and sizes remain structural. */
function formatTemplateRuns(template: string, ranges: SyntaxRange[], start: number, end: number, style?: InlineStyle, reassemble?: ReadonlyMap<number, SyntaxRange[]>): FormattedTemplateRange {
  type Run = { text: string; styles: InlineStyle[]; start?: number; end?: number }
  const remove = style && style.key !== 'font' && style.key !== 'size' && isTemplateModifierActive(template, start, end, style.key)
  const ordered = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)
  const optionals = ranges.filter(range => !range.token && !range.delimiter)
  const serialize = (runs: Run[]): Run => {
    const result: Run = { text: '', styles: [] }
    let opened: InlineStyle[] = []
    for (const run of runs) {
      // Font/emphasis changes must not split a continuous padded background.
      // Keep background nesting stable and never move it across a size wrapper.
      const styles = [...run.styles]
      let boundary = 0
      for (let index = 0; index < styles.length; index++) {
        if (styles[index].key === 'size') boundary = index + 1
        else if (styles[index].key === 'inverse' || styles[index].key === 'colorInverse') {
          styles.splice(boundary++, 0, styles.splice(index, 1)[0])
        }
      }
      let shared = 0
      while (shared < opened.length && shared < styles.length && opened[shared].opening === styles[shared].opening) shared++
      result.text += opened.slice(shared).reverse().map(item => item.closing).join('')
      result.text += styles.slice(shared).map(item => item.opening).join('')
      opened = styles
      if (run.start !== undefined) result.start ??= result.text.length + run.start
      if (run.end !== undefined) result.end = result.text.length + run.end
      result.text += run.text
    }
    result.text += opened.toReversed().map(item => item.closing).join('')
    return result
  }
  const visit = (from: number, to: number, styles: InlineStyle[]): Run[] => {
    const runs: Run[] = []
    const plain = (left: number, right: number) => {
      const boundaries = [left, start, end, right].filter(point => point >= left && point <= right).sort((a, b) => a - b)
      for (let i = 1; i < boundaries.length; i++) {
        const a = boundaries[i - 1], b = boundaries[i]
        if (a === b) continue
        const selected = a >= start && b <= end
        let applied = styles
        if (selected && style) {
          if (remove || style.key === 'font') applied = applied.filter(item => item.key !== style.key)
          if (!remove && !applied.some(item => item.key === style.key)) applied = [...applied, style]
        }
        runs.push({ text: template.slice(a, b), styles: applied,
          ...(selected ? { start: 0, end: b - a } : start === end && a < start ? { end: Math.min(b, start) - a } : {}) })
      }
    }
    let cursor = from
    for (const range of ordered) {
      if (range.start < cursor || range.end > to) continue
      plain(cursor, range.start)
      if (range.token) plain(range.start, range.end)
      else {
        // Normalization only rewrites emphasis; edits share this traversal for all styles.
        const modifiers = (Object.keys(TEMPLATE_TEXT_MODIFIER_DELIMITERS) as Array<Exclude<TemplateTextModifier, 'date'>>)
          .filter(modifier => (style || reassemble || modifier === 'bold' || modifier === 'italic') && matchesModifier(range, modifier))
        const added = modifiers.map(modifierStyle)
        const markup = range.delimiter && parseTemplateMarkup(template.slice(range.start, range.end))
        if ((style || reassemble) && markup && markup.kind === 'font') added.push({ key: 'font', opening: `[font=${markup.font}]`, closing: '[/font]' })
        if (reassemble && markup && markup.kind === 'size') added.push({ key: 'size', opening: markup.opening, closing: markup.closing })
        let inherited = styles
        for (const item of added) {
          if (item.key === 'font') inherited = inherited.filter(parent => parent.key !== 'font')
          if (item.key === 'size' || !inherited.some(parent => parent.key === item.key)) inherited = [...inherited, item]
        }
        const inner = visit(range.innerStart, range.innerEnd, inherited)
        if (added.length) runs.push(...inner)
        else {
          // Only inherited styles may cross a structural boundary: an empty
          // conditional must remove its own inverse padding along with its text.
          const context = reassemble?.get(optionals.indexOf(range))
          const candidates = context ? inner[0]?.styles ?? [] : styles
          const common = candidates.filter((item, index) => {
            const count = candidates.slice(0, index + 1).filter(style => style.opening === item.opening).length
            return (!context || context.filter(parent => item.key === 'font' || item.key === 'size'
              ? parent.delimiter?.toLowerCase() === item.opening.toLowerCase() : matchesModifier(parent, item.key)).length >= count)
              && inner.every(child => child.styles.filter(style => style.opening === item.opening).length >= count)
          })
          const run = serialize(inner.map(child => {
            const remaining = [...child.styles]
            for (const item of common) remaining.splice(remaining.findIndex(style => style.opening === item.opening), 1)
            return { ...child, styles: remaining }
          }))
          const opening = template.slice(range.start, range.innerStart)
          runs.push({ text: opening + run.text + template.slice(range.innerEnd, range.end), styles: common,
            ...(run.start !== undefined ? { start: opening.length + run.start } : {}),
            ...(run.end !== undefined ? { end: opening.length + run.end } : {}) })
        }
      }
      cursor = range.end
    }
    plain(cursor, to)
    return runs
  }
  const result = serialize(visit(0, template.length, []))
  return { template: result.text, start: start === end ? result.end ?? 0 : result.start ?? 0, end: result.end ?? 0 }
}

function reassembleTemplateEdit(result: FormattedTemplateRange, contexts: ReadonlyMap<number, SyntaxRange[]>): FormattedTemplateRange {
  return formatTemplateRuns(result.template, syntaxRanges(result.template), result.start, result.end, undefined, contexts)
}

/** Canonicalize parsed emphasis without changing any selected text or styles. */
export function normalizeTemplateEmphasis(template: string): string {
  return formatTemplateRuns(template, syntaxRanges(template), 0, 0).template
}

/** Only substituted fields are atomic; formatting never widens to a style wrapper. */
function snapTemplateRange(template: string, start: number, end: number, ranges: SyntaxRange[]): TemplateSourceRange {
  start = Math.max(0, Math.min(template.length, Math.trunc(start)))
  end = Math.max(start, Math.min(template.length, Math.trunc(end)))
  if (start !== end) for (const range of ranges.filter(range => range.token)) {
    if (end > range.start && start < range.end) {
      start = Math.min(start, range.start)
      end = Math.max(end, range.end)
    }
  }
  return { start, end }
}

/** Format selected source characters, preserving every neighboring style. */
export function formatTemplateRange(template: string, start: number, end: number, modifier: TemplateTextModifier): FormattedTemplateRange {
  const ranges = syntaxRanges(template)
  ;({ start, end } = snapTemplateRange(template, start, end, ranges))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return { template, start, end }
  if (modifier === 'date') {
    const tokens = ranges.filter(range => range.token && range.start >= start && range.end <= end)
    const remove = tokens.length > 0 && tokens.every(range => /\|date\s*\}$/i.test(template.slice(range.start, range.end)))
    let delta = 0
    for (const token of tokens.sort((a, b) => b.start - a.start)) {
      const original = template.slice(token.start, token.end)
      const replacement = remove ? original.replace(/\|date\s*\}$/i, '}') : /\|date\s*\}$/i.test(original) ? original : `${original.slice(0, -1)}|date}`
      template = template.slice(0, token.start) + replacement + template.slice(token.end)
      delta += replacement.length - original.length
    }
    return { template, start, end: end + delta }
  }
  return formatTemplateRuns(template, ranges, start, end, modifierStyle(modifier))
}

/** Set a font on selected text while keeping other inline styles and tokens intact. */
export function formatTemplateFontRange(template: string, start: number, end: number, family: LabelFontFamily): FormattedTemplateRange {
  const ranges = syntaxRanges(template)
  ;({ start, end } = snapTemplateRange(template, start, end, ranges))
  if (!LABEL_FONT_FAMILIES.includes(family) || !Number.isFinite(start) || !Number.isFinite(end) || start === end) return { template, start, end }
  return formatTemplateRuns(template, ranges, start, end, { key: 'font', opening: `[font=${family}]`, closing: '[/font]' })
}

export function getTemplateFontForRange(template: string, start: number, end: number): LabelFontFamily | null {
  const ranges = syntaxRanges(template)
  const fonts = ranges.filter(range => range.delimiter?.toLowerCase().startsWith('[font='))
  return LABEL_FONT_FAMILIES.find(family => {
    const styled = fonts.filter(range => resolveTemplateFont(range.delimiter!.slice(6, -1)) === family)
    return isTemplateRangeStyled(ranges, styled, start, end) && fonts.every(range =>
      styled.includes(range) || range.innerEnd <= start || range.innerStart >= end
      || isTemplateRangeStyled(ranges, styled.filter(child => child.start > range.start && child.end < range.end),
        Math.max(start, range.innerStart), Math.min(end, range.innerEnd)))
  }) ?? null
}
