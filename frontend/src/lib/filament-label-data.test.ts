import { describe, expect, it } from 'vitest'

import {
  buildCanonicalFilamentLabelData,
  buildFilamentLabelDataFromParams,
} from './filament-label-data'

describe('canonical filament label data', () => {
  it('keeps API values canonical and uses URL values only as fallbacks', () => {
    const query = buildFilamentLabelDataFromParams('42', new URLSearchParams({
      designation: 'Stale query name',
      color: 'Query-only color',
    }))

    const result = buildCanonicalFilamentLabelData({
      id: 42,
      designation: 'Current API name',
    }, query, '42')

    expect(result.designation).toBe('Current API name')
    expect(result.color).toBe('Query-only color')
    expect(result.id).toBe('42')
  })
})
