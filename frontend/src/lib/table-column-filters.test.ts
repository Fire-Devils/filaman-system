import { describe, expect, it } from 'vitest'

import {
  emptyColumnFilter,
  matchesColumnFilter,
  sanitizeColumnFilters,
  systemExtraFieldFilterType,
  systemExtraFieldFilterValue,
  type ColorFilterValue,
  type ColumnFilterValue,
} from './table-column-filters'

describe('Persisted table filters', () => {
  it('discards removed filters and values whose type no longer matches the column', () => {
    const filters = {
      colors: { type: 'multi', values: ['Blue'] },
      colorRange: { ...emptyColumnFilter('color'), mode: 'color' },
      diameter: { type: 'number', operator: 'eq', value: '1.75', valueTo: '' },
    } as Record<string, ColumnFilterValue>

    expect(sanitizeColumnFilters(filters, [
      { key: 'colors', type: 'multi' },
      { key: 'diameter', type: 'multi' },
    ])).toEqual({ colors: { type: 'multi', values: ['Blue'] } })
  })

  it('ignores malformed saved values instead of failing page setup', () => {
    expect(sanitizeColumnFilters({
      colors: { type: 'multi' },
      designation: { type: 'text', operator: 'bogus', value: 'PLA' },
    }, [
      { key: 'colors', type: 'multi' },
      { key: 'designation', type: 'text' },
    ])).toEqual({})
  })
})

describe('System Extra Field table filters', () => {
  it.each([
    ['number', 'number'],
    ['float', 'number'],
    ['date', 'date'],
    ['dropdown', 'multi'],
    ['multiselect', 'multi'],
    ['checkbox', 'multi'],
    ['text', 'text'],
    ['textarea', 'text'],
    ['url', 'text'],
    ['range', 'text'],
    ['formula', 'text'],
    ['unknown', 'text'],
  ] as const)('maps %s fields to %s filters', (fieldType, filterType) => {
    expect(systemExtraFieldFilterType(fieldType)).toBe(filterType)
  })

  it('normalizes checkbox values for the Yes/No multi-select', () => {
    const field = { key: 'approved', label: 'Approved', field_type: 'checkbox' }
    expect(systemExtraFieldFilterValue(field, true)).toBe('true')
    expect(systemExtraFieldFilterValue(field, 'true')).toBe('true')
    expect(systemExtraFieldFilterValue(field, false)).toBe('false')
    expect(systemExtraFieldFilterValue(field, null)).toBe('false')
  })

  it('turns structured ranges into searchable text', () => {
    const field = { key: 'temperature', label: 'Temperature', field_type: 'range' }
    expect(systemExtraFieldFilterValue(field, { min: 190, max: 220 })).toBe('190 – 220')
  })

  it('keeps multi-select arrays intact for any-option matching', () => {
    const field = { key: 'tags', label: 'Tags', field_type: 'multiselect' }
    expect(systemExtraFieldFilterValue(field, ['dry', 'abrasive'])).toEqual(['dry', 'abrasive'])
  })
})

describe('Color range table filters', () => {
  it('starts the chromatic range near but outside the neutral center', () => {
    const filter = emptyColumnFilter('color') as ColorFilterValue
    filter.mode = 'color'

    expect(matchesColumnFilter(['#FFF0E0'], filter)).toBe(true)
    expect(matchesColumnFilter(['#FFF7F0'], filter)).toBe(false)
  })

  it('excludes near-black colors from the default chromatic range', () => {
    const filter = emptyColumnFilter('color') as ColorFilterValue
    filter.mode = 'color'

    expect(matchesColumnFilter(['#260D00'], filter)).toBe(false)
    expect(matchesColumnFilter(['#2B1600'], filter)).toBe(true)
  })

  it('matches chromatic colors inside the hue arc and saturation radii', () => {
    const filter = {
      type: 'color',
      mode: 'color',
      hueFrom: 10,
      hueTo: 45,
      saturationFrom: 25,
      saturationTo: 90,
      valueFrom: 60,
      valueTo: 80,
      valuePreview: 80,
      includeTransparent: false,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#A64B1B'], filter)).toBe(true)
    expect(matchesColumnFilter(['#A64B1B80'], filter)).toBe(false)
    expect(matchesColumnFilter(['#A64B1B80'], { ...filter, includeTransparent: true })).toBe(true)
    expect(matchesColumnFilter(['#FF8A33'], filter)).toBe(false)
    expect(matchesColumnFilter(['#FFCCCC'], filter)).toBe(false)
    expect(matchesColumnFilter(['#00FF00'], filter)).toBe(false)
  })

  it('supports hue arcs that wrap through zero degrees', () => {
    const filter = {
      type: 'color',
      mode: 'color',
      hueFrom: 330,
      hueTo: 20,
      saturationFrom: 50,
      saturationTo: 100,
      valueFrom: 0,
      valueTo: 100,
      valuePreview: 100,
      includeTransparent: false,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#FF0000'], filter)).toBe(true)
    expect(matchesColumnFilter(['#00FF00'], filter)).toBe(false)
  })

  it('matches only the selected soft neutral family', () => {
    const base = {
      type: 'color',
      mode: 'none',
      hueFrom: 0,
      hueTo: 60,
      saturationFrom: 20,
      saturationTo: 100,
      valueFrom: 0,
      valueTo: 100,
      valuePreview: 100,
      includeTransparent: false,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#262626'], { ...base, mode: 'black' })).toBe(true)
    expect(matchesColumnFilter(['#FFF5E6'], { ...base, mode: 'black' })).toBe(false)
    expect(matchesColumnFilter(['#FFF5E6'], { ...base, mode: 'white' })).toBe(true)
    expect(matchesColumnFilter(['#808080'], { ...base, mode: 'white' })).toBe(false)
    expect(matchesColumnFilter(['#808080'], { ...base, mode: 'grey' })).toBe(true)
    expect(matchesColumnFilter(['#262626'], { ...base, mode: 'grey' })).toBe(false)
    expect(matchesColumnFilter(['not-a-color'], { ...base, mode: 'grey' })).toBe(false)
  })

  it('uses customized neutral brightness and saturation ranges', () => {
    const filter = {
      type: 'color',
      mode: 'black',
      hueFrom: 10,
      hueTo: 45,
      saturationFrom: 10,
      saturationTo: 100,
      valueFrom: 16,
      valueTo: 100,
      valuePreview: 100,
      neutralSaturationTo: 10,
      neutralValueFrom: 5,
      neutralValueTo: 10,
      includeTransparent: false,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#191919'], filter)).toBe(true)
    expect(matchesColumnFilter(['#191717'], filter)).toBe(true)
    expect(matchesColumnFilter(['#191616'], filter)).toBe(false)
    expect(matchesColumnFilter(['#262626'], filter)).toBe(false)
  })

  it('optionally includes colors with a non-opaque alpha channel', () => {
    const filter = {
      type: 'color',
      mode: 'none',
      hueFrom: 0,
      hueTo: 360,
      saturationFrom: 0,
      saturationTo: 100,
      valueFrom: 0,
      valueTo: 100,
      valuePreview: 100,
      includeTransparent: true,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#0066CC80'], filter)).toBe(true)
    expect(matchesColumnFilter(['#0066CCFE'], filter)).toBe(true)
    expect(matchesColumnFilter(['#0066CC'], filter)).toBe(false)
  })

  it('keeps transparent colors inside the selected neutral family', () => {
    const base = {
      type: 'color',
      mode: 'black',
      hueFrom: 0,
      hueTo: 360,
      saturationFrom: 0,
      saturationTo: 100,
      valueFrom: 0,
      valueTo: 100,
      valuePreview: 100,
      includeTransparent: true,
    } satisfies ColorFilterValue

    expect(matchesColumnFilter(['#00000080'], base)).toBe(true)
    expect(matchesColumnFilter(['#FF000080'], base)).toBe(false)
    expect(matchesColumnFilter(['#0000FF80'], { ...base, mode: 'white' })).toBe(false)
    expect(matchesColumnFilter(['#FFFFFF80'], { ...base, mode: 'white' })).toBe(true)
    expect(matchesColumnFilter(['#00000080'], { ...base, includeTransparent: false })).toBe(false)
  })
})

describe('Date table filters', () => {
  it('matches timestamps by the date displayed in the local timezone', () => {
    const timestamp = '2026-09-12T01:00:00Z'
    const local = new Date(timestamp)
    const displayedDate = [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, '0'),
      String(local.getDate()).padStart(2, '0'),
    ].join('-')

    expect(matchesColumnFilter(timestamp, {
      type: 'date', operator: 'on', value: displayedDate, valueTo: '',
    })).toBe(true)
  })
})
