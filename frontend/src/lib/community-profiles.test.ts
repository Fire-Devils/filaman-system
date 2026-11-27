import { describe, expect, it } from 'vitest'

import { countSuffix, renderCommunityCard, hasMoreResults, profileModelLabel, profileModelMismatch, profileOriginText, SEARCH_MAX_RESULTS } from './community-profiles'

describe('community profile model mismatch', () => {
  const profile = { printer_model_id: 5 }

  it('is silent when the printer has the same model', () => {
    expect(profileModelMismatch(profile, { filamentdb_printer_model_id: 5 })).toBeNull()
  })

  it('warns when the printer has another model', () => {
    expect(profileModelMismatch(profile, { filamentdb_printer_model_id: 6 })).toBe('mismatch')
  })

  it('warns when the printer is not linked to a model', () => {
    expect(profileModelMismatch(profile, { filamentdb_printer_model_id: null })).toBe('unlinked')
    expect(profileModelMismatch(profile, {})).toBe('unlinked')
  })

  it('has nothing to compare when the profile names no model or no printer is chosen', () => {
    expect(profileModelMismatch({ printer_model_id: undefined }, { filamentdb_printer_model_id: 5 })).toBeNull()
    expect(profileModelMismatch(profile, undefined)).toBeNull()
  })
})

describe('community profile origin text', () => {
  it('reads flat manufacturer and model fields', () => {
    expect(profileModelLabel({ id: 1, printer_manufacturer: 'Bambu Lab', printer_model: 'X1C' })).toBe('Bambu Lab X1C')
  })

  it('reads a nested model reference', () => {
    expect(profileModelLabel({ id: 1, printer_model: { manufacturer: 'Prusa', model: 'MK4' } })).toBe('Prusa MK4')
  })

  it('combines model and nozzle', () => {
    const text = profileOriginText({ id: 1, printer_manufacturer: 'Bambu Lab', printer_model: 'X1C', nozzle_diameter_mm: 0.4 })
    expect(text).toContain('Bambu Lab X1C')
    expect(text).toContain('0.4')
  })

  it('is empty when the profile names neither', () => {
    expect(profileOriginText({ id: 1 })).toBe('')
  })
})

describe('community search paging', () => {
  it('offers more only while results are left and below the cap', () => {
    expect(hasMoreResults(20, 45)).toBe(true)
    expect(hasMoreResults(45, 45)).toBe(false)
    expect(hasMoreResults(20, undefined)).toBe(false)
    expect(hasMoreResults(SEARCH_MAX_RESULTS, 1000)).toBe(false)
  })
})

describe('community profile count suffix', () => {
  it('shows the count in brackets, also for zero', () => {
    expect(countSuffix(3)).toBe(' (3)')
    expect(countSuffix(0)).toBe(' (0)')
  })

  it('shows nothing when the count is unknown', () => {
    expect(countSuffix(null)).toBe('')
    expect(countSuffix(undefined)).toBe('')
  })
})

describe('community card adopt button', () => {
  const opts = { canRate: false, canAdopt: true }

  it('offers adopting for a foreign, not yet imported profile', () => {
    const html = renderCommunityCard({ id: 3 } as never, opts)
    expect(html).toContain('data-cp-duplicate="0"')
    expect(html).not.toContain('data-cp-duplicate="1"')
  })

  it('offers a duplicate for own or already imported profiles', () => {
    expect(renderCommunityCard({ id: 3, is_own: true } as never, opts)).toContain('data-cp-duplicate="1"')
    expect(renderCommunityCard({ id: 3 } as never, { ...opts, duplicate: true })).toContain('data-cp-duplicate="1"')
  })
})
