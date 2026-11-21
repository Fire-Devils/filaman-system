import { describe, expect, it } from 'vitest'
import {
  TYPE_FILTER_ALL,
  TYPE_FILTER_NONE,
  TYPE_WRITE_IN,
  decodeTypeOption,
  encodeTypeOption,
  locationTypeOptions,
  matchesTypeFilter,
  resolveKnownType,
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

describe('resolveKnownType', () => {
  it('resolves canonical spelling case-insensitively', () => {
    const types = locationTypeOptions(['Dry Box'])
    expect(resolveKnownType(types, 'storage')).toBe('Storage')
    expect(resolveKnownType(types, ' dry box ')).toBe('Dry Box')
    expect(resolveKnownType(types, 'Unknown')).toBeNull()
    expect(resolveKnownType(types, null)).toBeNull()
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
    expect(matchesTypeFilter(TYPE_FILTER_NONE, TYPE_FILTER_NONE)).toBe(false)
  })

  it('compares types without caring about case and supports encoded option values', () => {
    expect(matchesTypeFilter('Storage', 'storage')).toBe(true)
    expect(matchesTypeFilter('Storage', encodeTypeOption('storage'))).toBe(true)
    expect(matchesTypeFilter(TYPE_FILTER_NONE, encodeTypeOption(TYPE_FILTER_NONE))).toBe(true)
    expect(matchesTypeFilter(TYPE_WRITE_IN, encodeTypeOption(TYPE_WRITE_IN))).toBe(true)
    expect(decodeTypeOption(encodeTypeOption(TYPE_WRITE_IN))).toBe(TYPE_WRITE_IN)
    expect(matchesTypeFilter('AMS', 'Storage')).toBe(false)
  })
})
