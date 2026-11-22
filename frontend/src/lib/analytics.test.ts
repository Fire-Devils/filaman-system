import { describe, expect, it } from 'vitest'
import { barPercents, formatDurationHours, formatMonthLabel, formatPercent, rangeToParams } from './analytics'

describe('analytics helpers', () => {
  const today = new Date(2026, 10, 22)

  it('maps ranges to from/to', () => {
    expect(rangeToParams('3m', today)).toEqual({ from: '2026-09-01', to: '2026-11-22' })
    expect(rangeToParams('12m', today)).toEqual({ from: '2025-12-01', to: '2026-11-22' })
    expect(rangeToParams('year', today)).toEqual({ from: '2026-01-01', to: '2026-11-22' })
    expect(rangeToParams('all', today).from).toBe('1970-01-01')
  })

  it('scales bars relative to the maximum', () => {
    expect(barPercents([50, 100, 0])).toEqual([50, 100, 0])
    expect(barPercents([1, 1000])[0]).toBe(2)
    expect(barPercents([0, 0])).toEqual([0, 0])
    expect(barPercents([])).toEqual([])
  })

  it('formats month labels per language', () => {
    expect(formatMonthLabel('2026-05', 'en')).toContain('26')
    expect(formatMonthLabel('2026-05', 'de').toLowerCase()).toContain('mai')
    expect(formatMonthLabel('bad', 'en')).toBe('bad')
  })

  it('formats percent and duration', () => {
    expect(formatPercent(0.857)).toBe('86 %')
    expect(formatPercent(null)).toBe('–')
    expect(formatDurationHours(5400)).toBe('1.5 h')
    expect(formatDurationHours(72000)).toBe('20 h')
  })
})
