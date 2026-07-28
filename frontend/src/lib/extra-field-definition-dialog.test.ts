import { describe, expect, it } from 'vitest'

import { parseExtraFieldOptions } from './extra-field-definition-dialog'

describe('extra field definition option parsing', () => {
  it('keeps commas inside one option', () => {
    expect(parseExtraFieldOptions('Red, White\nBlue')).toEqual([
      'Red, White',
      'Blue',
    ])
  })

  it('trims and ignores empty lines without changing option text', () => {
    expect(parseExtraFieldOptions('  PLA  \n\nPETG/CF  ')).toEqual([
      'PLA',
      'PETG/CF',
    ])
  })
})
