import { describe, expect, it } from 'vitest'
import { amsFinish, amsSwatchFill, amsSwatchHexes } from './ams-swatch'

describe('ams swatch', () => {
  it('keeps valid hexes and falls back to one color', () => {
    expect(amsSwatchHexes(['#0a0a0a', 'nope', '#D9D330'])).toEqual(['#0A0A0A', '#D9D330'])
    expect(amsSwatchHexes([], '#f8a813')).toEqual(['#F8A813'])
    expect(amsSwatchHexes(null, 'red')).toEqual([])
  })

  it('stripes multiple colors and blends a gradient', () => {
    const colors = ['#0A0A0A', '#909292', '#B80517', '#D9D330']
    expect(amsSwatchFill(colors, 'striped')).toBe(
      'linear-gradient(90deg, #0A0A0A 0.00% 25.00%, #909292 25.00% 50.00%, #B80517 50.00% 75.00%, #D9D330 75.00% 100.00%)',
    )
    expect(amsSwatchFill(colors, 'gradient')).toBe(
      'linear-gradient(105deg, #0A0A0A, #909292, #B80517, #D9D330)',
    )
    expect(amsSwatchFill(['#456DF1'], 'gradient')).toBe('#456DF1')
  })

  it('only paints glow and translucent finishes', () => {
    expect(amsFinish('Glow')).toBe('glow')
    expect(amsFinish('translucent')).toBe('translucent')
    expect(amsFinish('neon')).toBe('')
    expect(amsFinish('solid')).toBe('')
  })
})
