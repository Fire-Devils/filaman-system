import { describe, expect, it } from 'vitest'
import {
  buildDryPayload,
  dryDialogDefaults,
  isMoistureLevel,
  moistureBadgeClass,
  moistureLabelKey,
  needsDrying,
  parseMoisture,
  referenceKind,
} from './moisture'

describe('moisture helpers', () => {
  it('accepts only the four known levels', () => {
    expect(['dry', 'fair', 'damp', 'wet'].every(isMoistureLevel)).toBe(true)
    expect(isMoistureLevel('soaked')).toBe(false)
    expect(isMoistureLevel(null)).toBe(false)
  })

  it('parses a moisture object and rejects bad input', () => {
    expect(parseMoisture({ level: 'damp', days_exposed: 12.7, reference_at: '2026-11-01T00:00:00Z', sensitivity: 'high' }))
      .toEqual({ level: 'damp', days_exposed: 12, reference_at: '2026-11-01T00:00:00Z', sensitivity: 'high' })
    expect(parseMoisture(null)).toBeNull()
    expect(parseMoisture({ level: 'x', days_exposed: 1 })).toBeNull()
    expect(parseMoisture({ level: 'wet', days_exposed: -1 })).toBeNull()
    expect(parseMoisture({ level: 'wet', days_exposed: 'n/a' })).toBeNull()
  })

  it('builds label keys and badge classes', () => {
    expect(moistureLabelKey('wet')).toBe('moisture.level.wet')
    expect(moistureBadgeClass('fair')).toBe('fm-moisture-badge fm-moisture-fair')
  })

  it('recommends drying from damp upwards', () => {
    expect(['dry', 'fair'].map(level => needsDrying(level as 'dry' | 'fair'))).toEqual([false, false])
    expect(['damp', 'wet'].map(level => needsDrying(level as 'damp' | 'wet'))).toEqual([true, true])
  })

  it('tells whether the reference is the last drying run', () => {
    const ref = { reference_at: '2026-11-05T10:00:00Z' }
    expect(referenceKind(ref, '2026-11-05T10:00:00+00:00')).toBe('dried')
    expect(referenceKind(ref, '2026-11-01T10:00:00Z')).toBe('opened')
    expect(referenceKind(ref, null)).toBe('opened')
  })

  it('prefills the dialog from the filament and ignores missing values', () => {
    expect(dryDialogDefaults({ drying_temp_c: 55, drying_time_hours: 6 })).toEqual({ temp: '55', hours: '6' })
    expect(dryDialogDefaults({ drying_temp_c: null })).toEqual({ temp: '', hours: '' })
    expect(dryDialogDefaults(null)).toEqual({ temp: '', hours: '' })
  })

  it('builds the dry payload without blank or invalid numbers', () => {
    expect(buildDryPayload({ temp: '55', hours: '6', note: ' dryer ' })).toEqual({ temp_c: 55, duration_hours: 6, note: 'dryer' })
    expect(buildDryPayload({ temp: '', hours: '0', note: '  ' })).toEqual({})
    expect(buildDryPayload({ temp: 'abc', hours: '-2' })).toEqual({})
    expect(buildDryPayload({ temp: '0' })).toEqual({ temp_c: 0 })
  })
})
