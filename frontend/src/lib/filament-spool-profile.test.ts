import { describe, expect, it } from 'vitest'
import { matchSpoolProfile } from './filament-spool-profile'
const profile = { id: 735, name: '170g Spool', empty_weight_g: 170, spool_material: 'Cardboard', outer_diameter_mm: 200, width_mm: 68, image_file: '735.png' }
const values = { default_spool_weight_g: 170, spool_material: ' cardboard ', spool_outer_diameter_mm: 200, spool_width_mm: 68 }
describe('manual reel matching', () => {
  it('matches all four reel properties without altering values', () => {
    expect(matchSpoolProfile(values, [profile])).toEqual([profile])
    expect(values.default_spool_weight_g).toBe(170)
  })
  it('returns both candidates rather than choosing an ambiguous image', () => {
    expect(matchSpoolProfile(values, [profile, { ...profile, id: 736, image_file: 'other.png' }])).toHaveLength(2)
  })
  it.each([null, undefined, '', 0, NaN, Infinity])('does not infer from missing or invalid width %s', width => {
    expect(matchSpoolProfile({ ...values, spool_width_mm: width }, [profile])).toEqual([])
  })
  it('does not match by weight alone or overwrite a measurement', () => {
    expect(matchSpoolProfile({ ...values, spool_width_mm: 67 }, [profile])).toEqual([])
    expect(matchSpoolProfile({ default_spool_weight_g: 170 }, [profile])).toEqual([])
  })
})
