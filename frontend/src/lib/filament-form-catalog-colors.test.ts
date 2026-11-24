import { describe, expect, it } from 'vitest'
import { catalogColors } from './filament-form'

describe('catalogColors', () => {
  it('returns colors unchanged when filled', () => {
    const colors = [{ hex_code: '#112233', color_name: 'A', position: 1 }]
    expect(catalogColors({ colors, hex_color: '#FE602B' })).toBe(colors)
  })
  it('falls back to top-level hex_color when colors is empty', () => {
    expect(catalogColors({ colors: [], hex_color: '#FE602B', color_name: 'Neon Orange' }))
      .toEqual([{ hex_code: '#FE602B', color_name: 'Neon Orange', position: 1 }])
  })
  it('returns [] when nothing is set', () => {
    expect(catalogColors({ colors: [] })).toEqual([])
    expect(catalogColors({})).toEqual([])
  })
})
