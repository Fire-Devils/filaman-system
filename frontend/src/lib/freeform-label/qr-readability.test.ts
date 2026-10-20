import { describe, expect, it } from 'vitest'

import { getQrRecommendedSideMm } from './qr-readability'
import { formatDesignerNumber } from './number-format'

describe('QR print readability guidance', () => {
  it('rounds four-dot recommendations upward to a tenth for each printer resolution', () => {
    expect(getQrRecommendedSideMm(37, 200)).toBe(18.8)
    const recommended = getQrRecommendedSideMm(37, 300)
    expect(recommended).toBe(12.6)
    expect(formatDesignerNumber(recommended!)).toBe('12.6')
  })

  it('does not invent a recommendation when the encoded model is unavailable', () => {
    expect(getQrRecommendedSideMm(undefined, 200)).toBeUndefined()
    expect(getQrRecommendedSideMm(Number.NaN, 300)).toBeUndefined()
  })
})
