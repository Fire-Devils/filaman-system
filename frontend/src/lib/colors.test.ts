import { describe, expect, it } from 'vitest'

import {
  composeHexWithAlpha,
  getAlphaPercent,
  normalizeHexCode,
  toCssColor,
  toOpaqueRgbHex,
} from './colors'

describe('color helpers', () => {
  it('normalizes supported RGB and RGBA forms', () => {
    expect(normalizeHexCode('abc')).toBe('#AABBCC')
    expect(normalizeHexCode('#abcd')).toBe('#AABBCCDD')
    expect(normalizeHexCode('00d4d488')).toBe('#00D4D488')
  })

  it('rejects malformed values instead of returning unsafe CSS fallbacks', () => {
    expect(normalizeHexCode('#12345')).toBe('')
    expect(normalizeHexCode('not-a-color')).toBe('')
    expect(toCssColor('not-a-color')).toBe('transparent')
  })

  it('converts alpha colors for CSS and opaque consumers', () => {
    expect(toOpaqueRgbHex('#BE000022')).toBe('#BE0000')
    expect(toCssColor('#BE000080')).toBe('rgba(190, 0, 0, 0.502)')
  })

  it('round-trips opacity controls through trailing alpha bytes', () => {
    expect(composeHexWithAlpha('#00D4D4', 50)).toBe('#00D4D480')
    expect(getAlphaPercent('#00D4D480')).toBe(50)
    expect(composeHexWithAlpha('#00D4D480', 100)).toBe('#00D4D4')
  })
})
