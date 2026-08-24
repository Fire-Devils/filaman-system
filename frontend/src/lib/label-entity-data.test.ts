import { describe, expect, it } from 'vitest'
import {
  firstLabelValue,
  getFilamentColorHexes,
  getFilamentColorNames,
  getFirstFilamentColor,
  toLabelString,
} from './label-entity-data'

describe('label entity data normalization', () => {
  const filament = {
    filament_colors: [
      { display_name_override: 'Ocean', color: { name: 'Blue', hex_code: '123456' } },
      { color: { name: 'Black', hex_code: '000000' } },
    ],
    colors: [{ color: { name: 'Wrong list', hex_code: 'ffffff' } }],
  }

  it('prefers filament_colors and derives literal names and hex values', () => {
    expect(getFirstFilamentColor(filament).display_name_override).toBe('Ocean')
    expect(getFilamentColorNames(filament)).toBe('Ocean, Black')
    expect(getFilamentColorHexes(filament)).toBe('123456, 000000')
  })

  it('uses the first non-empty display value without stringifying nullish values', () => {
    expect(toLabelString(null)).toBe('')
    expect(firstLabelValue(undefined, '', 0, 'later')).toBe('0')
  })
})
