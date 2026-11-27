import { describe, expect, it } from 'vitest'
import { buildDonutSlices, renderDonutSvg } from './dashboard-charts'

const items = (values: number[]) => values.map((value, i) => ({ name: `M${i}`, value, detail: '' }))
const opts = { otherLabel: 'Other' }
const svgOpts = { ariaLabel: 'a', centerValue: '1 kg', centerLabel: 'rest', tip: (s: { name: string }) => s.name }

describe('buildDonutSlices', () => {
  it('drops zero entries, sorts and computes percent', () => {
    const slices = buildDonutSlices(items([100, 0, 300]), opts)
    expect(slices.map(s => s.name)).toEqual(['M2', 'M0'])
    expect(slices.map(s => s.percent)).toEqual([75, 25])
  })
  it('merges everything beyond six into "other"', () => {
    const slices = buildDonutSlices(items([8, 7, 6, 5, 4, 3, 2, 1]), opts)
    expect(slices).toHaveLength(7)
    const other = slices[6]
    expect(other).toMatchObject({ name: 'Other', value: 3, other: true, color: 'var(--text-muted)' })
    expect(slices.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100)
  })
  it('returns nothing when all values are zero', () => {
    expect(buildDonutSlices(items([0, 0]), opts)).toEqual([])
  })
})

describe('renderDonutSvg', () => {
  it('draws one path with tooltip per slice', () => {
    const svg = renderDonutSvg(buildDonutSlices(items([1, 1]), opts), svgOpts)
    expect(svg.match(/<path /g)).toHaveLength(2)
    expect(svg).toContain('<title>M0</title>')
    expect(svg).toContain('1 kg')
  })
  it('draws a single slice as a full ring (two arcs per circle)', () => {
    const svg = renderDonutSvg(buildDonutSlices(items([5]), opts), svgOpts)
    expect(svg.match(/<path /g)).toHaveLength(1)
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg.match(/ A /g)).toHaveLength(4)
    expect(svg).not.toContain('NaN')
  })
  it('escapes names in tooltips', () => {
    const svg = renderDonutSvg(buildDonutSlices([{ name: '<b>', value: 1, detail: '' }], opts), { ...svgOpts, tip: s => s.name })
    expect(svg).not.toContain('<b>')
  })
})
