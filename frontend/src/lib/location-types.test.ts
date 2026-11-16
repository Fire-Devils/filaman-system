import { describe, expect, it } from 'vitest'
import {
  TYPE_FILTER_ALL,
  TYPE_FILTER_NONE,
  locationTypeOptions,
  matchesTypeFilter,
} from './location-types'

describe('locationTypeOptions', () => {
  it('always lists the built-ins first', () => {
    expect(locationTypeOptions([])).toEqual(['AMS', 'Storage'])
  })

  it('adds write-ins once, sorted, without repeating built-ins', () => {
    expect(locationTypeOptions(['Dry Box', 'storage', null, ' ', 'Cabinet', 'dry box', 'AMS'])).toEqual([
      'AMS',
      'Storage',
      'Cabinet',
      'Dry Box',
    ])
  })
})

describe('matchesTypeFilter', () => {
  it('shows everything for the all filter', () => {
    expect(matchesTypeFilter(null, TYPE_FILTER_ALL)).toBe(true)
    expect(matchesTypeFilter('AMS', TYPE_FILTER_ALL)).toBe(true)
  })

  it('matches untyped locations only for the none filter', () => {
    expect(matchesTypeFilter(null, TYPE_FILTER_NONE)).toBe(true)
    expect(matchesTypeFilter('Storage', TYPE_FILTER_NONE)).toBe(false)
  })

  it('compares types without caring about case', () => {
    expect(matchesTypeFilter('Storage', 'storage')).toBe(true)
    expect(matchesTypeFilter('AMS', 'Storage')).toBe(false)
  })
})
