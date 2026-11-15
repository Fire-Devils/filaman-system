import { astroPageFunction } from '../../tests/helpers/astro-script'
import { expect, it } from 'vitest'
import type { HeaderFilterOption } from './table-column-filters'

const production = astroPageFunction('filaments/index', 'populateFilterDropdowns')

it.each([false, true])('clears unavailable filament colors after failed facets, preserving aborts (aborted=%s)', async (aborted) => {
  const original: HeaderFilterOption[] = [{ value: 'Blue', label: 'Blue', colorHexes: ['#0000FF'] }]
  let colors = original
  const populate = new Function('getAbortSignal', 'cachedFetch', 'CACHE_KEYS', 'filHeaderFilters', 'isAbortError', 'console', `${production}; return populateFilterDropdowns;`)(
    () => undefined, async () => { throw new Error('Offline') }, { FILAMENT_FILTER_OPTIONS: 'test' },
    { setOptions: (key: string, options: HeaderFilterOption[]) => { if (key === 'colors') colors = options } },
    () => aborted, { error: () => {} },
  )
  await populate()
  expect(colors).toEqual(aborted ? original : [])
})
