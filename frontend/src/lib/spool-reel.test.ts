// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildReelSegments, formatSpoolMetrics, reelColorAt, renderSpoolReel, spoolRemainingWeight } from './spool-reel'
import { buildFilamentHeroStyle, buildFilamentSwatchStyle, getFilamentColors, renderFilamentHeaderColors } from './filament-detail'

describe('read-only spool metric presentation', () => {
  it('uses the server-resolved New weight without changing recorded values or guessing locally', () => {
    const spool = { remaining_weight_g: null, metrics: { remaining_percent: 100, remaining_length_m: 335, effective_remaining_weight_g: 1000 } }
    expect(spoolRemainingWeight(spool)).toBe(1000)
    expect(spool.remaining_weight_g).toBeNull()
    expect(spoolRemainingWeight({ remaining_weight_g: 0 })).toBe(0)
    expect(spoolRemainingWeight({ remaining_weight_g: -5 })).toBeNull()
    expect(spoolRemainingWeight({ remaining_weight_g: 500 })).toBe(500)
    expect(spoolRemainingWeight({ remaining_weight_g: 500, metrics: { remaining_percent: null, remaining_length_m: null, effective_remaining_weight_g: null } })).toBeNull()
  })
  it('formats supplied metrics, preserving zero and unknown instead of calculating from grams', () => {
    expect(formatSpoolMetrics({ remaining_percent: 50, remaining_length_m: 167.6418097083822 }, 'en'))
      .toMatchObject({ percentText: '50%', lengthText: '168', fraction: .5 })
    expect(formatSpoolMetrics({ remaining_percent: 0, remaining_length_m: 0 }, 'en'))
      .toMatchObject({ percentText: '0%', lengthText: '0', fraction: 0 })
    expect(formatSpoolMetrics(null, 'en')).toMatchObject({ percentText: null, lengthText: null, fraction: null })
    expect(formatSpoolMetrics({ remaining_percent: NaN, remaining_length_m: -3 }, 'en'))
      .toMatchObject({ percentText: null, lengthText: null, fraction: null })
    expect(formatSpoolMetrics({ remaining_percent: 150, remaining_length_m: 1000 }, 'de'))
      .toMatchObject({ percentText: '100%', lengthText: '1.000', fraction: 1 })
  })
  it('uses red/yellow/green opaque fills with readable neutral text and edge contrast', () => {
    const styles = [0, 50, 100].map(remaining_percent => formatSpoolMetrics({ remaining_percent, remaining_length_m: null }).pillStyle)
    expect(styles[0]).toContain('#e76557')
    expect(styles[1]).toContain('#f3cb4d')
    expect(styles[2]).toContain('#4ccb83')
    expect(styles.every(style => style.includes('color:#000'))).toBe(true)
  })
})

describe('approved dimensional quarter reel', () => {
  it('keeps colorless and invalid-color windings visible with a checkerboard, while zero stays empty', () => {
    for (const colors of [[], ['invalid']]) {
      const full = new DOMParser().parseFromString(renderSpoolReel(1, colors, 'striped'), 'text/html')
      expect(full.querySelector('pattern')).not.toBeNull()
      expect(full.querySelectorAll('path').length).toBeGreaterThan(0)
      expect(full.querySelector('svg > path')?.getAttribute('stroke')).toMatch(/^url\(#/)
      expect(renderSpoolReel(null, colors, 'striped')).toBe(renderSpoolReel(1, colors, 'striped'))
      const empty = new DOMParser().parseFromString(renderSpoolReel(0, colors, 'striped'), 'text/html')
      expect(empty.querySelectorAll('path')).toHaveLength(0)
    }
  })
  it('backs translucent windings with the swatch checkerboard without changing saved alpha', () => {
    const translucent = new DOMParser().parseFromString(renderSpoolReel(1, ['#FFBB0080'], 'striped'), 'text/html')
    expect(translucent.querySelector('pattern')).not.toBeNull()
    expect(translucent.querySelector('path[stroke="rgba(255,187,0,0.5020)"]')).not.toBeNull()
    expect(translucent.querySelector('svg > path')?.getAttribute('stroke')).toMatch(/^url\(#/)
    expect(renderSpoolReel(1, ['#FFBB00'], 'striped')).not.toContain('<pattern')
  })
  it('keeps gradient coordinates on the original complete strand after consumption', () => {
    const full = buildReelSegments(1, ['#ff0000', '#0000ff'], 'gradient')
    for (const fraction of [.5, .05]) {
      const rest = buildReelSegments(fraction, ['#ff0000', '#0000ff'], 'gradient')
      expect(rest.length).toBeGreaterThan(0)
      expect(rest[0].progress).toBeGreaterThanOrEqual(1 - fraction)
      for (const segment of rest.slice(1)) {
        expect(full.find(other => other.from === segment.from && other.to === segment.to)).toEqual(segment)
      }
    }
  })
  it('draws every co-extruded colour beside each wrap, rather than alternating whole wraps', () => {
    const segments = buildReelSegments(1, ['#b15821', '#ffbb00'], 'striped')
    expect(segments.length).toBeLessThanOrEqual(1800)
    for (let i = 0; i < segments.length; i += 2) {
      expect(segments[i].from).toBe(segments[i + 1].from)
      expect(segments[i].to).toBe(segments[i + 1].to)
      expect(segments[i].a).not.toEqual(segments[i + 1].a)
      expect(segments[i].color).not.toBe(segments[i + 1].color)
    }
  })
  it('preserves premultiplied alpha and ordered gradient endpoints', () => {
    expect(reelColorAt(['#FF000080', '#0000FF00'], 0)).toBe('rgba(255,0,0,0.5020)')
    expect(reelColorAt(['#FF000080', '#0000FF00'], 1)).toBe('rgba(0,0,0,0.0000)')
    expect(reelColorAt(['#FF0000', '#00FF00', '#0000FF'], .5)).toBe('rgba(0,255,0,1.0000)')
  })
  it('renders a decorative clipped detailed flange, highlights and safe paint at all fill levels', () => {
    for (const fraction of [1, .5, .05, 0, null, NaN]) {
      const document = new DOMParser().parseFromString(renderSpoolReel(fraction, ['#FFBB0080'], 'striped'), 'text/html')
      const svg = document.querySelector('svg')!
      expect(svg.getAttribute('viewBox')).toBe('0 0 104 104')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.querySelector('image')?.getAttribute('href')).toBe('/reel-flange.webp')
      expect(svg.querySelectorAll('path').length > 0).toBe(fraction !== 0)
      expect(svg.querySelectorAll('path').length).toBeLessThanOrEqual(1800)
      if (fraction && Number.isFinite(fraction)) expect(svg.querySelector('g path')?.getAttribute('stroke-opacity')).toBeTruthy()
    }
    expect(renderSpoolReel(1, ['red\" onload=\"alert(1)'], 'striped')).not.toContain('onload')
    expect(buildReelSegments(0, ['#ff0000'], 'striped')).toEqual([])
    expect(buildReelSegments(-1, ['#ff0000'], 'striped')).toEqual([])
    expect(renderSpoolReel(null, ['#FFBB0080'], 'striped')).toBe(renderSpoolReel(1, ['#FFBB0080'], 'striped'))
  })
  it('uses the same saved colour order/mode for the reel, hero and labelled swatch', () => {
    const filament = { color_mode: 'multi', multi_color_style: 'striped', colors: [
      { position: 2, color: { hex_code: '#2563EB80', name: 'Blue' } },
      { position: 1, color: { hex_code: '#FF7A1A', name: 'Orange' } },
    ] }
    expect(getFilamentColors(filament)).toEqual(['#FF7A1A', '#2563EB80'])
    expect(buildFilamentHeroStyle(filament).indexOf('255, 122, 26')).toBeLessThan(buildFilamentHeroStyle(filament).indexOf('37, 99, 235'))
    expect(buildFilamentSwatchStyle(filament).indexOf('#FF7A1A')).toBeLessThan(buildFilamentSwatchStyle(filament).indexOf('37, 99, 235'))
    expect(renderFilamentHeaderColors(filament, 'Sold as')).toContain('Orange · Blue')
    expect(getFilamentColors({ ...filament, color_mode: 'single' })).toEqual(['#FF7A1A'])
  })
})
