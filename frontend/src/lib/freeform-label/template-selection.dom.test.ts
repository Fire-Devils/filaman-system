// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { parseTemplate, type SpoolData } from '../label-template'
import { adjacentTemplateRange, copyTemplateRange, replaceTemplateRange, formatTemplateRange, formatTemplateFontRange, getTemplateFontForRange, isTemplateModifierActive, getTemplateSelectionRange, renderSelectableTemplate, restoreTemplateSelection, normalizeTemplateEmphasis } from './template-selection'
import { wrapTemplateToken } from './text-modifiers'

const data = { id: '42', 'filament.color': 'Ocean Blue', 'filament.name': 'Straße', purchase_date: '2026-09-05T12:00:00Z' } as SpoolData
function render(template: string) {
  const root = document.createElement('div')
  root.append(renderSelectableTemplate(template, data))
  return root
}

describe('selectable template rendering', () => {
  it('does not delete past either end of the source', () => {
    expect(adjacentTemplateRange('\nHello', 0, true, 'line')).toBeNull()
    expect(adjacentTemplateRange('Hello\n', 6, false, 'line')).toBeNull()
  })

  it.each([
    'Print {filament.color} now',
    '**Color: __{filament.color}__**\n*Sample*',
    '***{filament.color}***',
    '^^{filament.name} & Straße^^',
    '{Color: {filament.color}!} {Missing {extra.nope}}',
    '[size=120]@@{filament.color}@@[/size] ==42==',
    '[font=Fraunces]**{filament.color}**[/font] plain',
    '{purchase_date|date}',
  ])('preserves parser text and formatting for %s', template => {
    const expected = document.createElement('div')
    expected.append(parseTemplate(template, data))
    const actual = render(template)
    actual.querySelectorAll('[data-template-start]').forEach(span => {
      if (span.hasAttribute('data-template-leaf')) span.replaceWith(...span.childNodes)
      else [...span.attributes].filter(attr => attr.name.startsWith('data-template-')).forEach(attr => span.removeAttribute(attr.name))
    })
    expect(actual.innerHTML).toBe(expected.innerHTML)
  })

  it('expands a partial rendered token selection to its complete source token', () => {
    const root = render('Print {filament.color} now')
    const token = root.querySelector('[data-template-atomic]')!
    const selection = document.createRange()
    selection.setStart(token.firstChild!, 2)
    selection.setEnd(token.firstChild!, 7)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 6, end: 22 })
  })

  it('maps literal substrings and mixed selections through nested markup', () => {
    const root = render('**Print {filament.color} now**')
    const spans = root.querySelectorAll('[data-template-leaf]')
    const selection = document.createRange()
    selection.setStart(spans[0].firstChild!, 2)
    selection.setEnd(spans[1].firstChild!, 3)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 4, end: 24 })
    selection.setEnd(spans[0].firstChild!, 4)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 4, end: 6 })
  })

  it('ignores clipped empty leaves at either representation of a text boundary', () => {
    const source = 'a{==P{filament.color}S==}z'
    const root = render(source)
    const leaves = root.querySelectorAll('[data-template-leaf]')
    const selection = document.createRange()
    selection.setStart(leaves[0].firstChild!, 1)
    selection.setEnd(leaves[1].firstChild!, 1)
    const mapped = getTemplateSelectionRange(root, selection)!
    expect(mapped).toEqual({ start: source.indexOf('P'), end: source.indexOf('P') + 1 })
    const pasted = replaceTemplateRange(source, mapped.start, mapped.end, copyTemplateRange(source, mapped.start, mapped.end))
    const missing = parseTemplate(pasted.template, {} as SpoolData)
    expect(missing.textContent).toBe('az')
    expect(missing.querySelectorAll('span[style*="padding"]')).toHaveLength(0)

    selection.setStart(leaves[3].firstChild!, 0)
    selection.setEnd(leaves[4].firstChild!, 0)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: source.indexOf('S'), end: source.indexOf('S') + 1 })

    selection.setStart(leaves[1].firstChild!, 0)
    selection.setEnd(leaves[2].firstChild!, 0)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: source.indexOf('P'), end: source.indexOf('P') + 1 })
    selection.setStart(leaves[2].firstChild!, leaves[2].textContent!.length)
    selection.setEnd(leaves[3].firstChild!, 1)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: source.indexOf('S'), end: source.indexOf('S') + 1 })
  })

  it('excludes touching uppercase expansions from adjacent literal selections', () => {
    const root = render('a^^ß^^z')
    const leaves = root.querySelectorAll('[data-template-leaf]')
    const selection = document.createRange()
    selection.setStart(leaves[0].firstChild!, 0)
    selection.setEnd(leaves[1].firstChild!, 0)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 0, end: 1 })
    selection.setStart(leaves[1].firstChild!, 2)
    selection.setEnd(leaves[2].firstChild!, 1)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 6, end: 7 })
  })

  it('maps literal uppercase expansions to their original character', () => {
    const root = render('^^Straße^^')
    const selection = document.createRange()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.includes('SS')) node = walker.nextNode()
    selection.setStart(node!, node!.textContent!.indexOf('SS'))
    selection.setEnd(node!, node!.textContent!.indexOf('SS') + 1)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 6, end: 7 })
  })

  it('rejects selections outside the text element and collapsed carets', () => {
    const root = render('Hello')
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(true)
    expect(getTemplateSelectionRange(root, range)).toBeNull()
    range.selectNodeContents(document.createElement('div'))
    expect(getTemplateSelectionRange(root, range)).toBeNull()
  })

  it('restores a mapped selection after rerendering', () => {
    const root = render('**{filament.color}**')
    document.body.append(root)
    const selection = window.getSelection()!
    expect(restoreTemplateSelection(root, { start: 2, end: 18 }, selection)).toBe(true)
    expect(selection.toString()).toBe('Ocean Blue')
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 2, end: 18 })
    root.remove()
  })

  it('keeps original source offsets after omitted conditionals and line breaks', () => {
    const root = render('{Missing {extra.nope}}\nHi {filament.color}')
    const token = root.querySelector('[data-template-atomic]')!
    const range = document.createRange()
    range.selectNodeContents(token)
    expect(root.textContent).toBe('Hi Ocean Blue')
    expect(root.querySelectorAll('br')).toHaveLength(1)
    expect(getTemplateSelectionRange(root, range)).toEqual({ start: 26, end: 42 })
  })

  it('annotates a color swatch as one atomic token without changing its drawing', () => {
    const template = '{color_swatch[8]}'
    const swatchData = { ...data, 'filament.color_hex': '#00AAFF' }
    const root = document.createElement('div')
    root.append(renderSelectableTemplate(template, swatchData))
    const swatch = root.querySelector<HTMLElement>('[data-template-atomic]')!
    const range = document.createRange()
    range.selectNode(swatch)
    expect(getTemplateSelectionRange(root, range)).toEqual({ start: 0, end: 17 })
    expect(swatch.style.width).toBe('8ch')
    expect(swatch.style.background).toBe('#00AAFF')
  })

  it('preserves bounded plain-text fallback for oversized resolved values', () => {
    const longData = { ...data, 'filament.color': '**' + 'X'.repeat(12001) + '**' }
    const root = document.createElement('div')
    root.append(renderSelectableTemplate('{filament.color}', longData))
    expect(root.textContent).toBe('**' + 'X'.repeat(11998))
    expect(root.querySelector('strong')).toBeNull()
    const range = document.createRange()
    range.selectNodeContents(root.firstChild!)
    expect(getTemplateSelectionRange(root, range)).toEqual({ start: 0, end: 16 })
  })
})

describe('inline font formatting', () => {
  it('maps, copies, and edits nested font overrides without changing neighboring fonts', () => {
    const source = '[font=Fraunces]A[font=Space Mono]{id}B[/font]C[/font]'
    const root = render(source)
    const token = root.querySelector('[data-template-atomic]')!
    const selection = document.createRange()
    selection.selectNodeContents(token)
    const mapped = getTemplateSelectionRange(root, selection)!
    const start = source.indexOf('{id}')
    expect(mapped).toEqual({ start, end: start + 4 })
    expect(getTemplateFontForRange(source, start, start + 4)).toBe('Space Mono')
    expect(getTemplateFontForRange(source, source.indexOf('A'), source.indexOf('C') + 1)).toBeNull()
    const copied = copyTemplateRange(source, start, start + 4)
    expect(render(copied).textContent).toBe('42')
    expect(render(copied).querySelector('[style*="Space Mono"]')?.textContent).toBe('42')
    const result = replaceTemplateRange(source, start, start + 4, copied)
    expect(render(result.template).textContent).toBe('A42BC')
    expect(render(result.template).querySelector('[style*="Space Mono"]')?.textContent).toBe('42B')
    const changed = formatTemplateFontRange(source, start, start + 4, 'Roboto Condensed')
    const updated = render(changed.template)
    expect(updated.textContent).toBe('A42BC')
    expect(updated.querySelector('[style*="Roboto Condensed"]')?.textContent).toBe('42')
    expect(updated.querySelector('[style*="Space Mono"]')?.textContent).toBe('B')
    expect([...updated.querySelectorAll('[style*="Fraunces"]')].map(node => node.textContent).join('')).toBe('AC')
  })

  it.each([
    ['**Hello**', 'strong', 'Hello'],
    ['__Hello__', 'u', 'Hello'],
    ['^^Hello^^', null, 'HELLO'],
    ['[size=120]Hello[/size]', 'span[style*="font-size"]', 'Hello'],
    ['**[font=Space Mono]Hello[/font]**', 'strong', 'Hello'],
    ['[font=Space Mono]**Hello**[/font]', 'strong', 'Hello'],
  ])('changes a substring font while preserving enclosing styles in %s', (source, styledSelector, visible) => {
    const start = source.indexOf('Hello') + 1
    const result = formatTemplateFontRange(source, start, start + 3, 'Fraunces')
    const root = render(result.template)
    expect(root.textContent).toBe(visible)
    expect(root.querySelector('span[style*="Fraunces"]')?.textContent).toBe(visible.slice(1, 4))
    if (styledSelector) expect([...root.querySelectorAll(styledSelector)].map(node => node.textContent).join('')).toBe(visible)
    expect(getTemplateFontForRange(result.template, result.start, result.end)).toBe('Fraunces')
  })

  it('keeps token formatting when changing a nested font', () => {
    const source = '**[font=Space Mono]Color: __{filament.color}__![/font]**'
    const result = formatTemplateFontRange(source, source.indexOf('{') + 2, source.indexOf('}') - 1, 'Fraunces')
    const root = render(result.template)
    expect(root.textContent).toBe('Color: Ocean Blue!')
    expect(root.querySelector('strong')?.textContent).toBe('Color: Ocean Blue!')
    expect(root.querySelector('span[style*="Fraunces"]')?.closest('u')?.textContent).toBe('Ocean Blue')
    expect(getTemplateFontForRange(result.template, result.start, result.end)).toBe('Fraunces')
  })

  it('renders selected text in another family while leaving the box font alone', () => {
    const result = formatTemplateFontRange('Red and blue', 8, 12, 'Fraunces')
    expect(result.template).toBe('Red and [font=Fraunces]blue[/font]')
    const root = render(result.template)
    expect(root.textContent).toBe('Red and blue')
    expect(root.querySelector('span[style*="font-family"]')?.getAttribute('style')).toContain('Fraunces')
  })

  it('changes a fonted substring without losing surrounding text or token boundaries', () => {
    const source = '[font=Fraunces]Hello {filament.color}[/font]'
    const result = formatTemplateFontRange(source, source.indexOf('{') + 2, source.indexOf('}') - 1, 'Space Mono')
    expect(result.template).toBe('[font=Fraunces]Hello [/font][font=Space Mono]{filament.color}[/font]')
    expect(render(result.template).textContent).toBe('Hello Ocean Blue')
    expect(getTemplateFontForRange(result.template, result.start, result.end)).toBe('Space Mono')
    const again = formatTemplateFontRange(result.template, result.start, result.end, 'Roboto Condensed')
    expect(again.template).toBe('[font=Fraunces]Hello [/font][font=Roboto Condensed]{filament.color}[/font]')
  })

  it('does not interpret an unlisted font as a CSS value', () => {
    const source = '[font=Bad; color:red]text[/font]'
    const root = render(source)
    expect(root.querySelector('[style*="font-family"]')).toBeNull()
    expect(root.textContent).toBe(source)
    expect(copyTemplateRange(source, source.indexOf('text'), source.indexOf('text') + 4)).toBe('text')
  })
})

describe('optional template fragments', () => {
  it('retains nested conditions when a self-paste crosses only their literal boundary', () => {
    const source = 'a{P{id}Q{R{filament.color}S}T}z'
    for (const [start, end] of [[source.indexOf('Q'), source.indexOf('R') + 1], [source.indexOf('S'), source.indexOf('T') + 1]]) {
      const pasted = replaceTemplateRange(source, start, end, copyTemplateRange(source, start, end))
      expect(render(pasted.template).textContent).toBe('aP42QROcean BlueSTz')
      expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('aP42QTz')
      expect(parseTemplate(pasted.template, {} as SpoolData).textContent).toBe('az')
    }
    expect(copyTemplateRange(source, source.indexOf('R'), source.indexOf('R') + 1)).toBe('R')
  })

  it('keeps a copied fragment under its original condition when only a nested field is selected', () => {
    const source = 'a{P{id}Q{R{filament.color}S}T}z'
    const start = source.indexOf('Q'), end = source.indexOf('T') + 1
    const copied = copyTemplateRange(source, start, end)
    expect(parseTemplate(copied, { id: '42' } as SpoolData).textContent).toBe('QT')
    expect(parseTemplate(copied, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('')
    expect(render(copied).textContent).toBe('QROcean BlueST')
    const result = replaceTemplateRange(source, start, end, copied)
    expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('aP42QTz')
    expect(parseTemplate(result.template, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('az')
    expect(render(result.template).textContent).toBe('aP42QROcean BlueSTz')
  })

  it.each(['P', 'Q'])('keeps nested conditions when a formatted paste crosses their boundary from %s', first => {
    const source = 'a{P{id}Q{R{filament.color}S}T}z'
    const start = source.indexOf(first), end = source.indexOf('{filament.color}') + '{filament.color}'.length
    const result = replaceTemplateRange(source, start, end, copyTemplateRange(source, start, end))
    expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('aP42QTz')
    expect(parseTemplate(result.template, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('az')
    expect(render(result.template).textContent).toBe('aP42QROcean BlueSTz')
  })

  it.each([
    '{Spool {id}{ Color: {filament.color}}}',
    '{Spool {id}[if={filament.color}] Color[/if]}',
    '{Spool {id}{ Color: {filament.color}}{ Name: {filament.name}}}',
  ])('preserves unselected nested conditions after a formatted self-paste in %s', source => {
    const start = source.indexOf('{id}')
    const copied = copyTemplateRange(source, start, start + 4)
    const result = replaceTemplateRange(source, start, start + 4, copied)
    expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('Spool 42')
    expect(parseTemplate(result.template, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('')
    expect(render(result.template).textContent).toBe(source.includes(' Name: ')
      ? 'Spool 42 Color: Ocean Blue Name: Straße' : source.includes(' Color: ') ? 'Spool 42 Color: Ocean Blue' : 'Spool 42 Color')
  })

  it.each([1, 11])('preserves independent literal-only pasted conditions at %s', position => {
    const source = '{Spool {id}}'
    const result = replaceTemplateRange(source, position, position, '[if={filament.color}]Color [/if]')
    expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('Spool 42')
    expect(parseTemplate(result.template, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('')
    expect(render(result.template).textContent).toBe(position === 1 ? 'Color Spool 42' : 'Spool 42Color ')
  })

  it('preserves surviving destination styles when a boundary paste carries a different style', () => {
    const source = '[b]a{P{filament.color}S}z[/b]'
    const end = source.indexOf('{filament.color}') + '{filament.color}'.length
    const result = replaceTemplateRange(source, 3, end, 'a[i]{{filament.color}}[/i]')
    const root = render(result.template)
    expect(root.textContent).toBe('aOcean BlueSz')
    expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('Sz')
    expect(root.querySelector('em')?.textContent).toBe('Ocean Blue')
  })

  it('retains an explicit condition when its visible field is replaced or deleted', () => {
    const source = '[if={filament.color}]Color: {filament.color}![/if]'
    const start = source.indexOf('Color: ') + 7
    for (const replacement of ['', 'Red', '{id}']) {
      const result = replaceTemplateRange(source, start, start + '{filament.color}'.length, replacement)
      expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('')
      expect(render(result.template).textContent).toBe(`Color: ${replacement === '{id}' ? '42' : replacement}!`)
    }
  })

  it.each(['{id}', '[i]{id}[/i]', '[i]{{id}}[/i]'])('retains the original condition when inserting %s before or after its field', inserted => {
    const wrappers = [['', ''], ['[b]', '[/b]'], ['[font=Fraunces][size=150]==', '==[/size][/font]']]
    for (const [opening, closing] of wrappers) for (const prefix of [true, false]) {
      const source = `a{${opening}P{filament.color}S${closing}}z`
      const at = prefix ? source.indexOf('P') + 1 : source.indexOf('S')
      const result = replaceTemplateRange(source, at, at, inserted)
      expect(render(result.template).textContent, result.template).toBe(prefix ? 'aP42Ocean BlueSz' : 'aPOcean Blue42Sz')
      expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent, result.template).toBe('az')
      expect(parseTemplate(result.template, { 'filament.color': 'Blue' } as SpoolData).textContent).toBe('aPBlueSz')
      const bodyStart = result.template.indexOf('P'), bodyEnd = result.template.indexOf('S') + 1
      const copied = copyTemplateRange(result.template, bodyStart, bodyEnd)
      const pasted = replaceTemplateRange(result.template, bodyStart, bodyEnd, copied)
      expect(render(pasted.template).textContent).toBe(render(result.template).textContent)
      expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('az')
    }
  })

  it('keeps copied formatted literals under their original field condition', () => {
    const source = '[b]{P{filament.color}S}[/b]'
    const copied = copyTemplateRange(source, 4, 5)
    const pasted = replaceTemplateRange(source, 4, 5, copied)
    expect(render(pasted.template).textContent).toBe('POcean BlueS')
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('')
    expect([...render(pasted.template).querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('POcean BlueS')
  })

  it.each([[0, 19], [3, 22]])('keeps surviving conditional literals when pasting their field across source bounds %s:%s', (start, end) => {
    const source = 'a{b{filament.color}d}e'
    const copied = copyTemplateRange(source, start, end)
    const pasted = replaceTemplateRange(source, start, end, copied)
    expect(render(pasted.template).textContent).toBe('abOcean Bluede')
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('ae')
  })

  it.each(['==', '@@'])('does not add padded %s spans when reassembling a copied conditional', delimiter => {
    const source = `${delimiter}a{P{filament.color}S}z${delimiter}`
    const start = source.indexOf('P')
    const pasted = replaceTemplateRange(source, start, start + 1, copyTemplateRange(source, start, start + 1))
    expect(render(pasted.template).querySelectorAll('span[style*="padding"]')).toHaveLength(1)
    expect(render(pasted.template).textContent).toBe('aPOcean BlueSz')
  })

  it.each(['==', '@@'])('keeps %s padding owned by its original conditional', delimiter => {
    const source = `a{${delimiter}P{filament.color}S${delimiter}}z`
    const start = source.indexOf('P')
    const pasted = replaceTemplateRange(source, start, start + 1, copyTemplateRange(source, start, start + 1))
    expect(render(pasted.template).querySelectorAll('span[style*="padding"]')).toHaveLength(1)
    const missing = parseTemplate(pasted.template, { id: '42' } as SpoolData)
    expect(missing.textContent).toBe('az')
    expect(missing.querySelectorAll('span[style*="padding"]')).toHaveLength(0)
  })

  it('keeps conditional ownership when a boundary paste also adds or removes other conditionals', () => {
    const source = 'a{==P{filament.color}S==}z'
    const end = source.indexOf('{filament.color}') + '{filament.color}'.length
    const copied = copyTemplateRange(source, 0, end)
    const added = replaceTemplateRange(source, 0, end, '{@@N{filament.color}M@@}' + copied)
    expect(render(added.template).textContent).toBe('NOcean BlueMaPOcean BlueSz')
    expect(render(added.template).querySelectorAll('span[style*="padding"]')).toHaveLength(2)
    const missing = parseTemplate(added.template, {} as SpoolData)
    expect(missing.textContent).toBe('az')
    expect(missing.querySelectorAll('span[style*="padding"]')).toHaveLength(0)

    const multiple = 'a{==P{filament.color}S==}m{@@T{id}U@@}z'
    const removed = replaceTemplateRange(multiple, multiple.indexOf('{filament.color}'), multiple.lastIndexOf('z'), '{{filament.color}==S==}m')
    expect(render(removed.template).textContent).toBe('aPOcean BlueSmz')
    const empty = parseTemplate(removed.template, {} as SpoolData)
    expect(empty.textContent).toBe('amz')
    expect(empty.querySelectorAll('span[style*="padding"]')).toHaveLength(0)
  })

  it('preserves clipboard identity for literals, fields, and complete conditional blocks in every style', () => {
    const wrappers = [
      ['', ''], ['[b]', '[/b]'], ['[i]', '[/i]'], ['__', '__'], ['^^', '^^'], ['==', '=='], ['@@', '@@'],
      ...['Space Grotesk', 'Fraunces', 'Roboto Condensed', 'Space Mono'].map(font => [`[font=${font}]`, '[/font]']),
      ['[size=120]', '[/size]'], ['[b]^^[i]__', '__[/i]^^[/b]'],
      ['[size=120]==', '==[/size]'], ['==[size=120]', '[/size]=='],
      ['[size=120]@@', '@@[/size]'], ['@@[size=120]', '[/size]@@'],
      ['[size=120][font=Fraunces]', '[/font][/size]'], ['[font=Fraunces][size=120]', '[/size][/font]'],
    ]
    const read = (root: HTMLElement) => {
      const characters: Array<{ node: Node; offset: number; character: string; styles: string[] }> = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const styles: string[] = []
        for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
          if (element.tagName !== 'SPAN' || element.hasAttribute('style')) styles.push(element.tagName + (element.getAttribute('style') ?? ''))
        }
        for (let offset = 0; offset < node.textContent!.length; offset++) characters.push({ node, offset, character: node.textContent![offset], styles })
      }
      return characters
    }
    const sample = { ...data, 'filament.color': 'c', 'filament.color_hex': '#123456' }
    const snapshot = (source: string, values: SpoolData) => {
      const root = document.createElement('div')
      root.append(renderSelectableTemplate(source, values))
      return {
        characters: read(root).map(({ character, styles }) => ({ character, styles })),
        backgrounds: [...root.querySelectorAll('span[style*="padding"]')].map(node => node.textContent),
      }
    }
    for (const [opening, closing] of wrappers) for (const source of [
      `${opening}a{P{filament.color}S}z${closing}`,
      `a${opening}{P{filament.color}S}${closing}z`,
      `a{${opening}P{filament.color}S${closing}}z`,
      `${opening}a[if={filament.color}]P{filament.color}S[/if]z${closing}`,
      `a${opening}[if={filament.color}]P{filament.color}S[/if]${closing}z`,
      `a[if={filament.color}]${opening}P{filament.color}S${closing}[/if]z`,
      `a[if={id}]${opening}P{filament.color}S${closing}[/if]z`,
      `a[if={id}][if={filament.color}]${opening}P{filament.color}S${closing}[/if][/if]z`,
    ]) for (const [from, to] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [0, 2], [3, 5], [1, 3], [2, 4], [1, 4], [0, 3], [0, 4], [1, 5], [2, 5], [0, 5]]) {
      const root = document.createElement('div')
      root.append(renderSelectableTemplate(source, sample))
      const characters = read(root), selection = document.createRange()
      selection.setStart(characters[from].node, characters[from].offset)
      selection.setEnd(characters[to - 1].node, characters[to - 1].offset + 1)
      const mapped = getTemplateSelectionRange(root, selection)!
      const copied = copyTemplateRange(source, mapped.start, mapped.end)
      const pasted = replaceTemplateRange(source, mapped.start, mapped.end, copied)
      for (const values of [sample, { id: '42' } as SpoolData, { ...sample, id: '' }]) {
        expect(snapshot(pasted.template, values), `${source} [${from}, ${to}]`).toEqual(snapshot(source, values))
      }
      root.replaceChildren(renderSelectableTemplate(pasted.template, sample))
      document.body.append(root)
      restoreTemplateSelection(root, pasted)
      const caret = document.createRange(), restored = window.getSelection()!
      caret.selectNodeContents(root)
      caret.setEnd(restored.anchorNode!, restored.anchorOffset)
      expect(caret.toString(), `${source} [${from}, ${to}] => ${pasted.template}`).toBe(root.textContent!.slice(0, to))
      root.remove()
    }
  })

  it('keeps a pasted font independent of the surrounding conditional font', () => {
    const source = '[font=Fraunces]{P{filament.color}S}[/font]'
    const start = source.indexOf('P')
    const pasted = replaceTemplateRange(source, start, start + 1, '[font=Space Mono]X[/font]')
    const root = render(pasted.template)
    expect(root.textContent).toBe('XOcean BlueS')
    expect(root.querySelector('[style*="Space Mono"]')?.textContent).toBe('X')
    expect(root.querySelector('[style*="Fraunces"]')?.textContent).toBe('Ocean BlueS')
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('')
  })

  it.each(['*', '**', '***'])('keeps legacy %s emphasis unambiguous when joining copied text', delimiter => {
    const source = `${delimiter}abc${delimiter}`
    const start = delimiter.length + 1
    const copied = copyTemplateRange(source, start, start + 1)
    const pasted = replaceTemplateRange(source, start, start + 1, copied)
    const root = render(pasted.template)
    expect(root.textContent).toBe('abc')
    if (delimiter.length !== 2) expect([...root.querySelectorAll('em')].map(node => node.textContent).join('')).toBe('abc')
    if (delimiter.length !== 1) expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('abc')
  })

  it('keeps a newly pasted field under the surviving original condition', () => {
    const source = 'a{P{filament.color}S}z'
    const pasted = replaceTemplateRange(source, 2, 3, '[i]{{id}}[/i]')
    expect(render(pasted.template).textContent).toBe('a42Ocean BlueSz')
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('az')
    expect(render(pasted.template).querySelector('em')?.textContent).toBe('42')
  })

  it.each(['a{P{filament.color}S}', '[b]a{P{filament.color}S}[/b]', '[font=Fraunces]a{__P{filament.color}__S}[/font]'])('pastes a copied conditional field back without nesting wrappers in %s', source => {
    const start = source.indexOf('P'), end = source.indexOf('{filament.color}') + '{filament.color}'.length
    const copied = copyTemplateRange(source, start, end)
    const pasted = replaceTemplateRange(source, start, end, copied)
    expect(render(pasted.template).textContent).toBe('aPOcean BlueS')
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('a')
    if (source.startsWith('[b]')) expect([...render(pasted.template).querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('aPOcean BlueS')
    if (source.startsWith('[font')) {
      expect([...render(pasted.template).querySelectorAll('span[style*="Fraunces"]')].map(node => node.textContent).join('')).toBe('aPOcean BlueS')
      expect([...render(pasted.template).querySelectorAll('u')].map(node => node.textContent).join('')).toBe('POcean Blue')
    }
  })

  it('keeps orphaned optional literals visible after cutting and reinserting their field', () => {
    const source = 'a{P{filament.color}S}'
    const copied = copyTemplateRange(source, 2, 19)
    const cut = replaceTemplateRange(source, 2, 19, '')
    const pasted = replaceTemplateRange(cut.template, cut.start, cut.end, copied)
    expect(render(pasted.template).textContent).toBe('aPOcean BlueS')
    // Once its field is cut, the surviving literal suffix is ordinary text.
    expect(parseTemplate(pasted.template, { id: '42' } as SpoolData).textContent).toBe('aS')
  })

  it.each([
    ['{Color: {filament.color}!}', 'Color', 'Color'],
    ['{Color: {filament.color}!}', '!', '!'],
    ['{**Color**: {filament.color}!}', 'Color', '**Color**'],
    ['{Color: {filament.color}!}', '{filament.color}', '{{filament.color}}'],
  ])('copies %s selection %s with only meaningful optional braces', (source, selection, copied) => {
    const start = source.indexOf(selection)
    const result = copyTemplateRange(source, start, start + selection.length)
    expect(result).toBe(copied)
    expect(render(result).textContent).toBe(selection === '{filament.color}' ? 'Ocean Blue' : selection)
  })

  it('preserves token-free text when cutting across an optional block boundary', () => {
    const source = '{Color: {filament.color}!} tail'
    const result = replaceTemplateRange(source, source.indexOf('{filament.color}'), source.length, '')
    expect(render(result.template).textContent).toBe('Color: ')
  })

  it.each([
    ['{Color: {filament.color}!}', '', 'Color: !'],
    ['{Color: **{filament.color}**!}', '', 'Color: !'],
    ['{Color: **{filament.color}**!}', 'Blue', 'Color: Blue!'],
  ])('preserves surrounding text when replacing the last token in %s with %s', (source, replacement, visible) => {
    const start = source.indexOf('{filament.color}')
    const result = replaceTemplateRange(source, start, start + '{filament.color}'.length, replacement)
    const root = render(result.template)
    expect(root.textContent).toBe(visible)
    if (replacement) expect(root.querySelector('strong')?.textContent).toBe('Blue')
  })
})

describe('source range formatting', () => {
  it.each([120, 150])('preserves multiplicative nested sizes after a formatted edit with inner size %s', size => {
    const source = `[size=150]A[size=${size}]B[/size]C[/size]`
    const start = source.indexOf('A')
    const copied = copyTemplateRange(source, start, start + 1)
    const result = replaceTemplateRange(source, start, start + 1, copied)
    const root = render(result.template)
    expect(root.textContent).toBe('ABC')
    expect(root.querySelector(`[style*="150%"] [style*="${size}%"]`)?.textContent).toBe('B')
    expect(root.firstElementChild?.textContent).toBe('ABC')
  })

  it('keeps repeated size nesting local to its conditional text after a paste', () => {
    const source = '[size=150]A[if={id}][size=150]B[/size]C[/if]D[/size]'
    const start = source.indexOf('B')
    const result = replaceTemplateRange(source, start, start + 1, copyTemplateRange(source, start, start + 1))
    const root = render(result.template)
    expect(root.textContent).toBe('ABCD')
    expect([...root.querySelectorAll('[style*="150%"] [style*="150%"]')].map(node => node.textContent).join('')).toBe('B')
    expect(parseTemplate(result.template, {} as SpoolData).textContent).toBe('AD')
  })

  it('keeps a padded run continuous when changing an enclosing font or emphasis', () => {
    const font = '[font=Fraunces]==abc==[/font]'
    const start = font.indexOf('abc') + 1
    const changed = render(formatTemplateFontRange(font, start, start + 1, 'Space Mono').template)
    expect(changed.querySelectorAll('span[style*="padding"]')).toHaveLength(1)
    expect(changed.querySelector('span[style*="Space Mono"]')?.textContent).toBe('b')
    expect([...changed.querySelectorAll('span[style*="Fraunces"]')].map(node => node.textContent).join('')).toBe('ac')
    const bold = '[b]==abc==[/b]'
    const at = bold.indexOf('abc') + 1
    const unbold = render(formatTemplateRange(bold, at, at + 1, 'bold').template)
    expect(unbold.querySelectorAll('span[style*="padding"]')).toHaveLength(1)
    expect([...unbold.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('ac')
    expect(unbold.textContent).toBe('abc')
  })

  it.each(['==', '@@'])('keeps inherited %s padding outside optional blocks during text and font formatting', delimiter => {
    const source = `${delimiter}a{P{filament.color}S}z${delimiter}`
    const start = source.indexOf('P')
    for (const result of [formatTemplateRange(source, start, start + 1, 'bold'), formatTemplateFontRange(source, start, start + 1, 'Fraunces')]) {
      expect(render(result.template).querySelectorAll('span[style*="padding"]')).toHaveLength(1)
      const missing = parseTemplate(result.template, {} as SpoolData)
      expect(missing.textContent).toBe('az')
      expect(missing.querySelectorAll('span[style*="padding"]')).toHaveLength(1)
    }
  })
  it.each(['underline', 'caps', 'inverse', 'colorInverse'] as const)('keeps partial crossing %s edits inside the selected text', modifier => {
    let source = '[b]ab[/b]cde'
    let range = { start: 4, end: 11 }
    for (let turn = 0; turn < 4; turn++) {
      const result = formatTemplateRange(source, range.start, range.end, modifier)
      const root = render(result.template)
      document.body.append(root)
      expect(root.textContent).toBe(modifier === 'caps' && turn % 2 === 0 ? 'aBCDe' : 'abcde')
      expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe(modifier === 'caps' && turn % 2 === 0 ? 'aB' : 'ab')
      restoreTemplateSelection(root, result)
      expect(window.getSelection()!.toString()).toBe(modifier === 'caps' && turn % 2 === 0 ? 'BCD' : 'bcd')
      if (modifier === 'underline') expect([...root.querySelectorAll('u')].map(node => node.textContent).join('')).toBe(turn % 2 === 0 ? 'bcd' : '')
      if (modifier === 'inverse' || modifier === 'colorInverse') expect([...root.querySelectorAll<HTMLElement>('span[style]')].filter(node => node.style.display === 'inline-block').map(node => node.textContent).join('')).toBe(turn % 2 === 0 ? 'bcd' : '')
      source = result.template; range = result; root.remove()
    }
  })

  it('changes crossing font selections without replacing the neighboring font', () => {
    const source = '[font=Fraunces]ab[/font]cde'
    let result = formatTemplateFontRange(source, source.indexOf('ab') + 1, source.lastIndexOf('e'), 'Space Mono')
    for (const family of ['Space Mono', 'Roboto Condensed', 'Space Grotesk'] as const) {
      result = formatTemplateFontRange(result.template, result.start, result.end, family)
      const root = render(result.template)
      expect(root.textContent).toBe('abcde')
      expect(root.querySelector('span[style*="Fraunces"]')?.textContent).toBe('a')
      expect([...root.querySelectorAll(`span[style*="${family}"]`)].map(node => node.textContent).join('')).toBe('bcd')
      document.body.append(root)
      restoreTemplateSelection(root, result)
      expect(window.getSelection()!.toString()).toBe('bcd')
      root.remove()
    }
  })

  it('reports a uniform font across independently formatted runs', () => {
    const result = formatTemplateFontRange('[b]ab[/b]cde', 4, 11, 'Fraunces')
    expect(getTemplateFontForRange(result.template, result.start, result.end)).toBe('Fraunces')
    expect(getTemplateFontForRange(result.template, 0, result.template.length)).toBeNull()
  })

  it('reports the effective font of a differently formatted substring and rejects a mixed selection', () => {
    const source = '[font=Fraunces]a[/font][b][font=Space Mono]b[/font][/b][font=Fraunces]c[/font]'
    const start = source.indexOf('b[/font]')
    expect(getTemplateFontForRange(source, start, start + 1)).toBe('Space Mono')
    expect(getTemplateFontForRange(source, source.indexOf('a[/font]'), source.indexOf('c[/font]') + 1)).toBeNull()
    expect(render(source).querySelector('strong span[style*="Space Mono"]')?.textContent).toBe('b')
  })

  it.each(['==a@@bc@@d==e', '@@a==bc==d@@e'])('preserves background ordering outside a selection in %s', source => {
    const before = render(source)
    const target = before.querySelector('[data-template-leaf]')!
    const range = document.createRange()
    range.selectNodeContents(target)
    const mapped = getTemplateSelectionRange(before, range)!
    const result = formatTemplateRange(source, mapped.start, mapped.end, 'underline')
    const root = render(result.template)
    const middle = [...root.querySelectorAll<HTMLElement>('[data-template-leaf]')].find(node => node.textContent === 'bc')!
    expect(middle.parentElement!.style.cssText).toBe(before.querySelectorAll<HTMLElement>('[data-template-leaf]')[1].parentElement!.style.cssText)
    expect(root.textContent).toBe('abcde')
  })

  it.each([
    '**Bold** and *italic* and ***both***',
    '__**Bold***Italic*__ [font=Fraunces]*Font*[/font]',
    '^^**Caps**^^ {Color: ***{filament.color}***!}',
    'Unmatched * and literal **',
  ])('normalizes saved emphasis in %s without changing rendered text or styles', source => {
    const normalized = normalizeTemplateEmphasis(source)
    const original = document.createElement('div')
    original.append(parseTemplate(source, data))
    const updated = document.createElement('div')
    updated.append(parseTemplate(normalized, data))
    expect(updated.innerHTML).toBe(original.innerHTML)
    expect(normalizeTemplateEmphasis(normalized)).toBe(normalized)
  })
  it('preserves every emphasis transition across expanded caps and optional blocks', () => {
    const styles = ['plain', 'bold', 'italic', 'both'] as const
    const wrap = (text: string, style: typeof styles[number]) => style === 'plain' ? text : style === 'both'
      ? wrapTemplateToken(wrapTemplateToken(text, 'italic'), 'bold') : wrapTemplateToken(text, style)
    for (const left of styles) for (const right of styles) for (const optional of [false, true]) {
      const source = wrap('a', left) + (optional ? `{${wrap('b', right)}{filament.color}}` : `^^${wrap('b', right)}^^`)
      const root = render(source)
      expect(root.textContent, source).toBe(optional ? 'abOcean Blue' : 'aB')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const actual: Array<{ bold: boolean; italic: boolean }> = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) actual.push(...Array.from(node.textContent!, () => ({
        bold: !!node.parentElement?.closest('strong'), italic: !!node.parentElement?.closest('em'),
      })))
      expect(actual.slice(0, 2), source).toEqual([left, right].map(style => ({ bold: style === 'bold' || style === 'both', italic: style === 'italic' || style === 'both' })))
      expect(actual.slice(2).every(style => !style.bold && !style.italic)).toBe(true)
    }
  })
  it('copies, edits, and changes fonts without losing explicit emphasis tags', () => {
    const source = '[b][i]abcde[/i][/b]'
    expect(render(copyTemplateRange(source, 7, 10)).innerHTML).toContain('<strong><em>')
    expect(render(copyTemplateRange(source, 7, 10)).textContent).toBe('bcd')
    const edited = replaceTemplateRange(source, 7, 10, 'XYZ')
    expect(render(edited.template).querySelector('strong em')?.textContent).toBe('aXYZe')
    const font = formatTemplateFontRange(source, 7, 10, 'Fraunces')
    const root = render(font.template)
    expect(root.textContent).toBe('abcde')
    expect(root.querySelector('strong em')?.textContent).toBe('abcde')
    expect(root.querySelector('span[style]')?.textContent).toBe('bcd')
  })
  it.each([
    ['a^^bc^^', 0, 4, 'aBC', 'aB'],
    ['a{P{filament.color}S}', 0, 3, 'aPOcean BlueS', 'aP'],
  ] as const)('keeps formatting unambiguous when %s expands away a wrapper', (source, start, end, visible, italic) => {
    const result = formatTemplateRange(source, start, end, 'italic')
    const root = render(result.template)
    expect(root.textContent).toBe(visible)
    expect([...root.querySelectorAll('em')].map(node => node.textContent).join('')).toBe(italic)
    const off = formatTemplateRange(result.template, result.start, result.end, 'italic')
    expect(render(off.template).textContent).toBe(visible)
    expect(render(off.template).querySelector('em')).toBeNull()
    if (source.includes('filament')) expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe('a')
  })
  it('preserves adjacent italic and bold runs when removing an enclosing bold style', () => {
    const result = formatTemplateRange('**ab *cd* ef** gh', 2, 8, 'bold')
    const root = render(result.template)
    expect(root.textContent).toBe('ab cd ef gh')
    expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe(' ef')
    expect([...root.querySelectorAll('em')].map(node => node.textContent).join('')).toBe('cd')
  })
  it.each([
    ['italic', 'bold', '*'],
    ['bold', 'italic', '**'],
  ] as const)('toggles partial %s text with %s without changing characters or neighboring styles', (outer, modifier, delimiter) => {
    for (const wrapper of ['', '__', '==', '@@', '^^', '[font=Fraunces]', '[size=120]']) {
      const closing = wrapper.startsWith('[font') ? '[/font]' : wrapper.startsWith('[size') ? '[/size]' : wrapper
      for (const [from, to] of [[0, 2], [1, 4], [3, 5]]) {
        let source = `${wrapper}${delimiter}abcde${delimiter}${closing}`
        let start = source.indexOf('abcde') + from
        let end = source.indexOf('abcde') + to
        for (let turn = 0; turn < 4; turn++) {
          const result = formatTemplateRange(source, start, end, modifier)
          const root = render(result.template)
          const visible = wrapper === '^^' ? 'ABCDE' : 'abcde'
          expect(root.textContent, result.template).toBe(visible)
          if (wrapper === '__') expect(root.querySelector('u')?.textContent).toBe(visible)
          if (wrapper === '[font=Fraunces]') expect(root.querySelector<HTMLElement>('span[style]')?.style.fontFamily).toContain('Fraunces')
          if (wrapper === '[size=120]') expect(root.querySelector<HTMLElement>('span[style]')?.style.fontSize).toBe('120%')
          if (wrapper === '==' || wrapper === '@@') expect(root.querySelector<HTMLElement>('span[style]')?.style.display).toBe('inline-block')
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          const styles: Array<{ bold: boolean; italic: boolean }> = []
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            styles.push(...Array.from(node.textContent!, () => ({ bold: !!node.parentElement?.closest('strong'), italic: !!node.parentElement?.closest('em') })))
          }
          expect(styles, result.template).toEqual(Array.from('abcde', (_, index) => ({
            bold: outer === 'bold' || modifier === 'bold' && turn % 2 === 0 && index >= from && index < to,
            italic: outer === 'italic' || modifier === 'italic' && turn % 2 === 0 && index >= from && index < to,
          })))
          source = result.template; start = result.start; end = result.end
        }
      }
    }
  })
  it('formats only selected literal characters', () => {
    expect(formatTemplateRange('Hello world', 1, 4, 'bold')).toEqual({ template: 'H[b]ell[/b]o world', start: 4, end: 7 })
  })
  it('protects tokens even if supplied offsets fall inside token syntax', () => {
    expect(formatTemplateRange('A {filament.color} Z', 5, 9, 'italic')).toEqual({ template: 'A [i]{filament.color}[/i] Z', start: 5, end: 21 })
  })
  it('toggles the same selected wrapper without leaving markup characters', () => {
    expect(formatTemplateRange('A **{filament.color}** Z', 4, 20, 'bold')).toEqual({ template: 'A {filament.color} Z', start: 2, end: 18 })
  })
  it('supports combined nested styles and whole-element formatting', () => {
    expect(render(formatTemplateRange('**{filament.color}**', 2, 18, 'underline').template).querySelector('strong u')?.textContent).toBe('Ocean Blue')
    expect(formatTemplateRange('A {filament.color}', 0, 18, 'inverse').template).toBe('==A {filament.color}==')
  })
  it('renders combined bold and italic and independently toggles either style', () => {
    const result = formatTemplateRange('**{filament.color}**', 2, 18, 'italic')
    const fragment = parseTemplate(result.template, data)
    expect(fragment.textContent).toBe('Ocean Blue')
    expect(fragment.querySelector('strong em')?.textContent).toBe('Ocean Blue')
    const unbold = render(formatTemplateRange(result.template, result.start, result.end, 'bold').template)
    expect(unbold.querySelector('strong')).toBeNull()
    expect(unbold.querySelector('em')?.textContent).toBe('Ocean Blue')
    const unitalic = render(formatTemplateRange(result.template, result.start, result.end, 'italic').template)
    expect(unitalic.querySelector('em')).toBeNull()
    expect(unitalic.querySelector('strong')?.textContent).toBe('Ocean Blue')
  })
  it('keeps conditional blocks valid when formatting token or crossing their boundary', () => {
    expect(render(formatTemplateRange('{Color: {filament.color}!} tail', 8, 24, 'bold').template).querySelector('strong')?.textContent).toBe('Ocean Blue')
    const result = formatTemplateRange('{Color: {filament.color}!} tail', 10, 29, 'bold')
    const root = render(result.template)
    expect(root.textContent).toBe('Color: Ocean Blue! tail')
    expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('Ocean Blue! ta')
    expect(parseTemplate(result.template, { id: '42' } as SpoolData).textContent).toBe(' tail')
  })
  it('splits a crossing formatting boundary without styling neighboring characters', () => {
    const root = render(formatTemplateRange('**Hello** world', 4, 12, 'underline').template)
    expect(root.textContent).toBe('Hello world')
    expect([...root.querySelectorAll('u')].map(node => node.textContent).join('')).toBe('llo wo')
    expect(root.querySelector('strong')?.textContent).toBe('Hello')
  })
  it('removes a repeated style from a literal substring while keeping its neighbors styled', () => {
    const result = formatTemplateRange('**Hello**', 3, 6, 'bold')
    expect(result.template.slice(result.start, result.end)).toBe('ell')
    const fragment = parseTemplate(result.template, data)
    expect(fragment.textContent).toBe('Hello')
    expect([...fragment.querySelectorAll('strong')].map(element => element.textContent)).toEqual(['H', 'o'])
  })
  it('toggles date on complete selected tokens without changing literal text', () => {
    const result = formatTemplateRange('On {purchase_date} today', 0, 24, 'date')
    expect(result.template).toBe('On {purchase_date|date} today')
    expect(formatTemplateRange(result.template, result.start, result.end, 'date').template).toBe('On {purchase_date} today')
    expect(formatTemplateRange('Hello world', 0, 11, 'date').template).toBe('Hello world')
  })
})


describe('selection formatting state', () => {
  it('preserves text, styles, and selection through every ordered pair of overlapping format operations', () => {
    const modifiers = ['bold', 'italic', 'underline', 'caps', 'inverse', 'colorInverse'] as const
    const operations = [...modifiers, 'Fraunces', 'Space Mono'] as const
    const spans = [[0, 2], [1, 4], [2, 5]] as const
    type Styles = Record<typeof modifiers[number], boolean> & { font: string }
    const read = (root: HTMLElement) => {
      const result: Array<{ node: Node; offset: number; character: string; styles: Omit<Styles, 'caps'> }> = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const styles = { bold: false, italic: false, underline: false, inverse: false, colorInverse: false, font: '' }
        for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
          styles.bold ||= element.tagName === 'STRONG'
          styles.italic ||= element.tagName === 'EM'
          styles.underline ||= element.tagName === 'U'
          styles.inverse ||= ['#000', 'rgb(0, 0, 0)'].includes(element.style.backgroundColor)
          styles.colorInverse ||= element.style.background.includes('123456')
          if (!styles.font && element.style.fontFamily) styles.font = element.style.fontFamily.split(',')[0].replaceAll('"', '')
        }
        for (let offset = 0; offset < node.textContent!.length; offset++) result.push({ node, offset, character: node.textContent![offset], styles })
      }
      return result
    }
    const root = document.createElement('div')
    document.body.append(root)
    for (const initial of ['abcde', '[if={id}]abcde[/if]', 'a[if={id}]bcd[/if]e'])
      for (const first of operations) for (const second of operations) for (const a of spans) for (const b of spans) {
      let source = initial
      const expected: Styles[] = Array.from('abcde', () => ({ bold: false, italic: false, underline: false, caps: false, inverse: false, colorInverse: false, font: '' }))
      for (const [operation, [from, to]] of [[first, a], [second, b], [second, b], [first, a]] as const) {
        root.replaceChildren(renderSelectableTemplate(source, { ...data, 'filament.color_hex': '#123456' }))
        const characters = read(root), range = document.createRange()
        range.setStart(characters[from].node, characters[from].offset)
        range.setEnd(characters[to - 1].node, characters[to - 1].offset + 1)
        const mapped = getTemplateSelectionRange(root, range)!
        let result
        if (operation === 'Fraunces' || operation === 'Space Mono') {
          result = formatTemplateFontRange(source, mapped.start, mapped.end, operation)
          expected.slice(from, to).forEach(styles => { styles.font = operation })
        } else {
          result = formatTemplateRange(source, mapped.start, mapped.end, operation)
          const on = !expected.slice(from, to).every(styles => styles[operation])
          expected.slice(from, to).forEach(styles => { styles[operation] = on })
        }
        root.replaceChildren(renderSelectableTemplate(result.template, { ...data, 'filament.color_hex': '#123456' }))
        const want = expected.map(({ caps, ...styles }, index) => ({ character: caps ? 'abcde'[index].toUpperCase() : 'abcde'[index], styles }))
        expect(read(root).map(({ character, styles }) => ({ character, styles })), `${first} → ${second}: ${result.template}`).toEqual(want)
        if (initial !== 'abcde') expect(parseTemplate(result.template, { ...data, id: '' }).textContent)
          .toBe(initial.startsWith('[if') ? '' : want[0].character + want[4].character)
        restoreTemplateSelection(root, result)
        expect(window.getSelection()!.toString()).toBe(want.slice(from, to).map(item => item.character).join(''))
        source = result.template
      }
    }
    root.remove()
  })

  it('toggles enclosing styles through nested markup without accumulating delimiters', () => {
    let source = '**__{filament.color}__**'
    for (let i = 0; i < 6; i++) {
      const start = source.indexOf('{')
      const end = source.indexOf('}') + 1
      expect(isTemplateModifierActive(source, start, end, 'bold')).toBe(i % 2 === 0)
      expect(isTemplateModifierActive(source, start, end, 'underline')).toBe(true)
      source = formatTemplateRange(source, start, end, 'bold').template
      expect(render(source).textContent).toBe('Ocean Blue')
      expect(source.length).toBeLessThanOrEqual(27)
    }
  })
  it('turns mixed formatting on uniformly and then off', () => {
    const source = '**Hello** world'
    expect(isTemplateModifierActive(source, 2, source.length, 'bold')).toBe(false)
    const on = formatTemplateRange(source, 2, source.length, 'bold')
    expect(render(on.template).querySelector('strong')?.textContent).toBe('Hello world')
    expect(isTemplateModifierActive(on.template, on.start, on.end, 'bold')).toBe(true)
    expect(formatTemplateRange(on.template, on.start, on.end, 'bold').template).toBe('Hello world')
  })
  it('removes bold from part of combined bold/italic while retaining italic', () => {
    const result = formatTemplateRange('***Hello***', 4, 7, 'bold')
    const root = render(result.template)
    expect(root.textContent).toBe('Hello')
    expect([...root.querySelectorAll('strong')].map(node => node.textContent).join('')).toBe('Ho')
    expect([...root.querySelectorAll('em')].map(node => node.textContent).join('')).toBe('Hello')
    expect(isTemplateModifierActive(result.template, result.start, result.end, 'bold')).toBe(false)
  })
})
