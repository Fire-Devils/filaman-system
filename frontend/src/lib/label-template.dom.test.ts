// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { parseTemplate, renderSelectableTemplate, renderTemplateText } from './label-template'
import { buildSpoolDataFromFlatLabel } from './label-designer'
import { copyTemplateRange, getTemplateFontForRange, getTemplateSelectionRange, isTemplateModifierActive } from './freeform-label/template-selection'

describe('balanced inline markup', () => {
  it.each([
    '==PLA== **not bold** {id}', '[b]literal[/b] [font=Fraunces]font[/font]',
    '^^Mixed Straße^^ __text__ @@color@@ [size=200]size[/size]',
    '[[FM_SWATCH|1|bands|#FF0000]]',
  ])('keeps field markup literal while preserving template styling: %s', value => {
    const data = buildSpoolDataFromFlatLabel({ id: 42, designation: value })
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      const plain = render('{filament.name}', data)
      expect(plain.textContent).toBe(value)
      expect(plain.querySelector('strong, em, u, [style]')).toBeNull()
      const styled = render('[b]=={filament.name}==[/b]', data)
      expect(styled.textContent).toBe(value)
      expect(styled.querySelector('strong > [style*="background"]')?.textContent).toBe(value)
    }
  })

  it('does not join template and field delimiters into new markup', () => {
    const data = { ...buildSpoolDataFromFlatLabel({ id: 42 }), extra: { open: '*', close: '*' } }
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      const result = render('*{extra.open}word{extra.close}*', data)
      expect(result.textContent).toBe('*word*') // template italics surround literal field asterisks
      expect(result.querySelector('strong')).toBeNull()
      expect(result.querySelector('em')?.textContent).toBe('*word*')
    }
  })
  it.each([
    ['[b]', '[/b]'], ['[i]', '[/i]'], ['[b][i]', '[/i][/b]'],
    ['[b][if={id}]', '[/if][/b]'], ['[font=Fraunces]', '[/font]'], ['[size=120]', '[/size]'],
  ])('handles maximum-length balanced nesting in %s', (opening, closing) => {
    const depth = Math.floor(7999 / (opening.length + closing.length))
    const source = opening.repeat(depth) + 'A' + closing.repeat(depth)
    const start = opening.length * depth
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      expect(render(source, buildSpoolDataFromFlatLabel({ id: 42 })).textContent).toBe('A')
    }
    expect(copyTemplateRange(source, start, start + 1)).toBe(source)
    if (opening.startsWith('[font')) expect(getTemplateFontForRange(source, start, start + 1)).toBe('Fraunces')
    else if (opening.startsWith('[b]') || opening === '[i]') {
      expect(isTemplateModifierActive(source, start, start + 1, opening.startsWith('[b]') ? 'bold' : 'italic')).toBe(true)
    }
  })

  it.each([
    ['[font=Fraunces]A[font=Space Mono]B[/font]C[/font]', '[style*="Fraunces"] [style*="Space Mono"]'],
    ['[size=120]A[size=150%]B[/size]C[/size]', '[style*="120%"] [style*="150%"]'],
    ['[b]A[b]B[/b]C[/b]', 'strong strong'],
    ['[i]A[i]B[/i]C[/i]', 'em em'],
  ])('renders nested same-kind tags in %s', (source, selector) => {
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      const fragment = render(source, buildSpoolDataFromFlatLabel({ id: 42 }))
      expect(fragment.textContent).toBe('ABC')
      expect(fragment.querySelector(selector)?.textContent).toBe('B')
      expect(fragment.firstElementChild?.textContent).toBe('ABC')
    }
  })

  it.each([
    ['[font=Fraunces]A[font=Space Mono]B[/font]', '[font=Fraunces]AB'],
    ['A[/font][font=Fraunces]B[/font]', 'A[/font]B'],
    ['[font=Fraunces]A[b]B[/font]C[/b]', '[font=Fraunces]A[b]B[/font]C[/b]'],
  ])('keeps unmatched or crossed tag boundaries literal in %s', (source, expected) => {
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      expect(render(source, buildSpoolDataFromFlatLabel({ id: 42 })).textContent).toBe(expected)
    }
  })
})

describe('explicit field conditions', () => {
  it.each([
    ['Color: {id} {filament.color}!', 'Color: 42 Blue!'],
    ['[b]Color: {id}[/b]\n[font=Fraunces]{filament.color}[/font]', 'Color: 42Blue'],
    ['[if={id}]{id}[/if] {filament.color}', '42 Blue'],
    ['Literal phrase', 'Literal phrase'],
  ])('retains the named condition independently of body fields in %s', (body, expected) => {
    const source = `[if={filament.color}]${body}[/if]`
    const present = buildSpoolDataFromFlatLabel({ id: 42, color: 'Blue' })
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      expect(render(source, present).textContent).toBe(expected)
      expect(render(source, { ...present, 'filament.color': '' }).textContent).toBe('')
    }
  })

  it('maps only body fields and preserves multiline source offsets', () => {
    const source = '[if={filament.color}]Color:\n{id} {filament.color}[/if]'
    const root = document.createElement('div')
    root.append(renderSelectableTemplate(source, buildSpoolDataFromFlatLabel({ id: 42, color: 'Blue' })))
    expect(root.querySelectorAll('[data-template-atomic]')).toHaveLength(2)
    const selection = document.createRange()
    selection.selectNodeContents(root.querySelector('[data-template-atomic]')!)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: source.indexOf('{id}'), end: source.indexOf('{id}') + 4 })
    expect(root.querySelectorAll('br')).toHaveLength(1)
  })
})

describe('bounded token expansion', () => {
  it('caps repeated token expansions before constructing oversized source maps', () => {
    const template = '{filament.name}'.repeat(520)
    const data = buildSpoolDataFromFlatLabel({ id: 1, designation: 'x'.repeat(255) })
    const root = document.createElement('div')
    root.append(renderSelectableTemplate(template, data))
    expect(root.textContent).toBe('x'.repeat(12000))
    expect(renderTemplateText(template, data)).toBe('x'.repeat(12000))
    const selection = document.createRange()
    selection.selectNodeContents(root.lastChild!)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 705, end: 720 })
  })

  it.each([
    ['^^{filament.name}^^', 'Straße'.repeat(25000), 'STRASSE'.repeat(1714) + 'ST'],
    ['^^{filament.name}', 'lower'.repeat(30000), '^^' + 'lower'.repeat(2399) + 'low'],
    ['{filament.name}', '^^^^'.repeat(40000) + 'Straße', '^'.repeat(12000)],
    ['{filament.name}', '**' + 'X'.repeat(132600) + '**', '**' + 'X'.repeat(11998)],
  ])('retains caps and plain-text overflow semantics for %s', (template, value, expected) => {
    const data = buildSpoolDataFromFlatLabel({ id: 1, designation: value })
    for (const render of [parseTemplate, renderSelectableTemplate]) {
      const fragment = render(template, data)
      expect(fragment.textContent).toBe(expected)
      expect(fragment.querySelector('strong')).toBeNull()
    }
  })

  it('maps Unicode caps expansions with template-authored delimiters', () => {
    const root = document.createElement('div')
    root.append(renderSelectableTemplate('^^{filament.name}^^', {
      ...buildSpoolDataFromFlatLabel({ id: 1, designation: 'Straße😀' }), extra: { open: '^', close: '^' },
    }))
    expect(root.textContent).toBe('STRASSE😀')
    const selection = document.createRange()
    selection.selectNodeContents(root)
    expect(getTemplateSelectionRange(root, selection)).toEqual({ start: 2, end: 17 })
  })
})
