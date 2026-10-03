import { describe, expect, it } from 'vitest'

import { getQrModuleCount, getQrRecommendedSideMm } from './qr-readability'
import { formatDesignerNumber } from './number-format'

describe('QR print readability guidance', () => {
  it('rounds the four-dot 300 DPI recommendation upward to the displayed hundredth', () => {
    const recommended = getQrRecommendedSideMm(37)

    expect(recommended).toBe(12.54)
    expect(formatDesignerNumber(recommended!)).toBe('12.54')
  })

  it('reads the actual encoded module count without trusting malformed QR models', () => {
    expect(getQrModuleCount({ _oQRCode: { getModuleCount: () => 41 } })).toBe(41)
    expect(getQrModuleCount({ _oQRCode: { getModuleCount: () => 0 } })).toBeUndefined()
    expect(getQrModuleCount({ _oQRCode: { getModuleCount: () => 21.5 } })).toBeUndefined()
    expect(getQrModuleCount({})).toBeUndefined()
    expect(getQrModuleCount(null)).toBeUndefined()
  })

  it('does not invent a recommendation when the encoded model is unavailable', () => {
    expect(getQrRecommendedSideMm(undefined)).toBeUndefined()
    expect(getQrRecommendedSideMm(Number.NaN)).toBeUndefined()
  })
})
