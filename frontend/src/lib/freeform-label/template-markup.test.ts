import { describe, expect, it } from 'vitest'

import {
  templateMarkupMatches,
  parseTemplateMarkup,
  resolveTemplateFont,
} from './template-markup'

describe('shared template markup recognition', () => {
  it('matches nested supported markup without sharing global regex state', () => {
    const source = '[font=Fraunces][size=120]**Hello**[/size][/font]'
    const first = [...templateMarkupMatches(source)].map(match => match[0])
    const second = [...templateMarkupMatches(source)].map(match => match[0])

    expect(first).toEqual([source])
    expect(second).toEqual(first)
    expect(parseTemplateMarkup(source)).toMatchObject({ kind: 'font', font: 'Fraunces' })
  })

  it('recognizes renderer swatches only when requested', () => {
    const source = 'A [[FM_SWATCH|8|bands|#00AAFF,#112233]] B'

    expect([...templateMarkupMatches(source)]).toEqual([])
    expect([...templateMarkupMatches(source, { swatches: true })].map(match => match[0]))
      .toEqual(['[[FM_SWATCH|8|bands|#00AAFF,#112233]]'])
  })

  it('rejects unsupported font names consistently', () => {
    expect(resolveTemplateFont('fraunces')).toBe('Fraunces')
    expect(resolveTemplateFont('Comic Sans')).toBeNull()
    expect(parseTemplateMarkup('[font=Comic Sans]Hello[/font]')).toBeNull()
  })
})
