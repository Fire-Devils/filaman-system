import { expect, it } from 'vitest'
import { colorDot, formatRange, formatRelativeTime } from './dashboard-widgets'

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`

it('formats the stock range as days, weeks, over a year or no consumption', () => {
  expect(formatRange(null, t)).toBe('dashboard.rangeNone')
  expect(formatRange(0.4, t)).toBe('dashboard.rangeUnderDay')
  expect(formatRange(1.2, t)).toBe('dashboard.rangeDay{"count":1}')
  expect(formatRange(4, t)).toBe('dashboard.rangeDays{"count":4}')
  expect(formatRange(7, t)).toBe('dashboard.rangeWeek{"count":1}')
  expect(formatRange(45, t)).toBe('dashboard.rangeWeeks{"count":6}')
  expect(formatRange(365, t)).toBe('dashboard.rangeWeeks{"count":52}')
  expect(formatRange(366, t)).toBe('dashboard.rangeOverYear')
})

it('formats short relative times through the translation keys', () => {
  const now = Date.parse('2026-11-27T12:00:00Z')
  expect(formatRelativeTime('2026-11-27T10:00:00Z', t, now)).toBe('dashboard.agoHours{"count":2}')
  expect(formatRelativeTime('2026-03-27T12:00:00Z', t, now)).toBe('dashboard.agoMonths{"count":8}')
  expect(formatRelativeTime('2026-11-27T11:59:50Z', t, now)).toBe('dashboard.agoNow')
})

it('only lets validated hex colors into the style attribute', () => {
  expect(colorDot(['#ff0000'])).toContain('background:#FF0000')
  expect(colorDot(['00FF00FF'])).toContain('background:#00FF00')
  const bad = colorDot(['red;background:url(x)'])
  expect(bad).toContain('is-empty')
  expect(bad).not.toContain('style=')
  expect(colorDot(undefined)).toContain('is-empty')
})
