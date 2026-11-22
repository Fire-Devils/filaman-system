import { describe, expect, it } from 'vitest'
import { buildCompletePayload, buildCreatePayload, formatDuration, formatGrams, parseGrams, statusPillStyle } from './print-jobs'

describe('print job helpers', () => {
  it('parses grams with comma or dot and rejects bad input', () => {
    expect(parseGrams('12,5')).toBe(12.5)
    expect(parseGrams(' 40 ')).toBe(40)
    expect(parseGrams('')).toBeNull()
    expect(parseGrams('-3')).toBeNull()
    expect(parseGrams('abc')).toBeNull()
  })

  it('builds the complete payload and refuses invalid weights', () => {
    expect(buildCompletePayload(false, [{ usageId: 4, value: '10,5' }])).toEqual({
      success: false,
      usages: [{ usage_id: 4, used_weight_g: 10.5 }],
    })
    expect(buildCompletePayload(true, [{ usageId: 4, value: 'x' }])).toBeNull()
  })

  it('builds the create payload, skipping empty lines', () => {
    const base = {
      name: ' Vase ', projectId: '3', newProjectName: '', printerId: '', notes: ' ', complete: true, success: true,
      rows: [{ spoolId: '7', grams: '25' }, { spoolId: '', grams: '' }],
    }
    expect(buildCreatePayload(base)).toEqual({
      name: 'Vase', project_id: 3, complete: true, success: true, usages: [{ spool_id: 7, planned_weight_g: 25 }],
    })
    expect(buildCreatePayload({ ...base, name: '  ' })).toBeNull()
    expect(buildCreatePayload({ ...base, rows: [{ spoolId: '7', grams: '' }] })).toBeNull()
    expect(buildCreatePayload({ ...base, projectId: 'new' })?.project_id).toBeUndefined()
  })

  it('formats values for the table', () => {
    expect(formatGrams(12.34)).toBe('12.3 g')
    expect(formatGrams(null)).toBe('–')
    expect(formatDuration(3720)).toBe('1 h 2 min')
    expect(formatDuration(600)).toBe('10 min')
    expect(statusPillStyle('failed')).toContain('--error-text')
  })
})
