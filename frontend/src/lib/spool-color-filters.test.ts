import { astroPageFunction } from '../../tests/helpers/astro-script'
import { expect, it } from 'vitest'
import type { HeaderFilterOption } from './table-column-filters'

const production = astroPageFunction('spools/index', 'updateSpoolFilterOptions')
const blue = { value: 'Blue', label: 'Blue', color_hexes: ['#0000FF'] }
const red = { value: 'Red', label: 'Red', color_hexes: ['#FF0000'] }
const scope = (colors: typeof blue[], has_empty_colors = false) => ({ manufacturers: [], materials: [], locations: [], has_empty_location: false, colors, has_empty_colors })

it('keeps selected names removable without adding out-of-scope wheel samples', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const columnFilters: Record<string, { type: 'multi'; values: string[] }> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `const allLocations = new Map(), hideSealedInput = { checked: false }; ${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1, 2, 3], by_status: {
      1: scope([blue], true),
      2: scope([{ ...blue, color_hexes: ['#000080'] }]),
      3: scope([red]),
    } },
    [{ id: 1, key: 'opened' }, { id: 2, key: 'new' }, { id: 3, key: 'archived' }],
    columnFilters,
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } },
    () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([
    { value: '', label: 'Empty' },
    { value: 'Blue', label: 'Blue', colorHexes: ['#0000FF', '#000080'] },
  ])
  columnFilters.status = { type: 'multi', values: ['3'] }
  update()
  expect(options.colors).toEqual([{ value: 'Red', label: 'Red', colorHexes: ['#FF0000'] }])
  columnFilters.colors = { type: 'multi', values: ['Blue', ''] }
  update()
  expect(options.colors).toEqual([
    { value: '', label: 'Empty' },
    { value: 'Blue', label: 'Blue', colorHexes: [] },
    { value: 'Red', label: 'Red', colorHexes: ['#FF0000'] },
  ])
  delete columnFilters.colors
  update()
  expect(options.colors).toEqual([{ value: 'Red', label: 'Red', colorHexes: ['#FF0000'] }])
  delete columnFilters.status
  update()
  expect(options.colors.map(option => option.value)).toEqual(['', 'Blue'])
})

it('does not assume archived statuses are active when status reference loading failed', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `const allLocations = new Map(), hideSealedInput = { checked: false }; ${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1, 3], by_status: { 1: scope([blue]), 3: scope([red]) } },
    [], {}, { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([])
})

it('keeps a selected name removable after its last spool-backed color disappears', () => {
  const options: Record<string, HeaderFilterOption[]> = {}
  const update = new Function('spoolFilterFacets', 'statuses', 'columnFilters', 'splHeaderFilters', 't', `const allLocations = new Map(), hideSealedInput = { checked: false }; ${production}; return updateSpoolFilterOptions;`)(
    { used_status_ids: [1], by_status: { 1: scope([red]) } },
    [{ id: 1, key: 'active' }], { colors: { type: 'multi', values: ['Deleted Blue'] } },
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => 'Empty',
  )
  update()
  expect(options.colors).toEqual([
    { value: 'Deleted Blue', label: 'Deleted Blue', colorHexes: [] },
    { value: 'Red', label: 'Red', colorHexes: ['#FF0000'] },
  ])
})

it.each([false, true])('handles failed facet refresh without blocking rows or swallowing aborts (aborted=%s)', async (aborted) => {
  const refreshSource = astroPageFunction('spools/index', 'refreshSpoolFilterOptions')
  const options: Record<string, HeaderFilterOption[]> = { colors: [{ value: 'Blue', label: 'Blue', colorHexes: ['#0000FF'] }] }
  let rowsReloaded = false
  const refresh = new Function('getAbortSignal', 'fetchSpoolFilterFacets', 'updateSpoolFilterOptions', 'splHeaderFilters', 'isAbortError', 'console', `let spoolFilterFacets = {}; ${refreshSource}; return refreshSpoolFilterOptions;`)(
    () => undefined, async () => { throw new Error('Offline') }, () => {},
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, () => aborted, { error: () => {} },
  )
  const result = refresh().then(() => { rowsReloaded = true })
  if (aborted) {
    await expect(result).rejects.toThrow('Offline')
    expect(rowsReloaded).toBe(false)
    expect(options.colors[0].colorHexes).toEqual(['#0000FF'])
    return
  }
  await result
  expect(rowsReloaded).toBe(true)
  expect(options.colors).toEqual([])
})


it('keeps refreshed spool facets when an older fallback location load finishes later', async () => {
  const loadSource = astroPageFunction('spools/index', 'loadFilters')
  const refreshSource = astroPageFunction('spools/index', 'refreshSpoolFilterOptions')
  const options: Record<string, HeaderFilterOption[]> = {}
  let release!: (response: { ok: boolean; json: () => Promise<{ items: { id: number; name: string }[] }> }) => void
  let started!: () => void
  const locationsStarted = new Promise<void>(resolve => { started = resolve })
  const locationsResponse = new Promise(resolve => { release = resolve })
  let reads = 0
  const methods = new Function('fetchSpoolFilterFacets', 'fetch', 'splHeaderFilters', 'console', `
    const statuses = [{ id: 1, key: 'active' }], columnFilters = {};
    let spoolFilterFacets; const allLocations = new Map(), hideSealedInput = { checked: false };
    const getAbortSignal = () => undefined, isAbortError = () => false, t = key => key;
    ${production}; ${refreshSource}; ${loadSource};
    return { loadFilters, refreshSpoolFilterOptions, allLocations };
  `)(async () => {
      if (++reads === 1) throw new Error('Temporarily unavailable')
      return { used_status_ids: [1], by_status: { 1: { ...scope([red]), locations: [{ value: '7', label: 'New shelf' }] } } }
    },
    () => { started(); return locationsResponse },
    { setOptions: (key: string, values: HeaderFilterOption[]) => { options[key] = values } }, { error() {} })
  const initial = methods.loadFilters()
  await locationsStarted
  await methods.refreshSpoolFilterOptions()
  expect(options.colors[0].value).toBe('Red')
  release({ ok: true, json: async () => ({ items: [{ id: 7, name: 'Old shelf' }] }) })
  await initial
  expect(methods.allLocations.get('7').label).toBe('New shelf')
  expect(options.colors[0].value).toBe('Red')
})

it('refreshes row location names for every status, including archived-only shelves', () => {
  const shelfScope = { ...scope([]), locations: [{ value: '7', label: 'Old shelf' }] }
  const facets = { used_status_ids: [1, 3], by_status: { 1: scope([]), 3: shelfScope } }
  const locationName = astroPageFunction('spools/index', 'getLocationName')
  const read = new Function('spoolFilterFacets', `
    const allLocations = new Map(), hideSealedInput = { checked: false };
    const statuses = [{id:1, key:'opened'}, {id:3, key:'archived'}], columnFilters = {};
    const splHeaderFilters = {setOptions() {}}, t = key => key;
    ${production}; ${locationName};
    return () => { updateSpoolFilterOptions(); return getLocationName(7) };
  `)(facets)
  expect(read()).toBe('Old shelf')
  shelfScope.locations[0].label = 'New shelf'
  expect(read()).toBe('New shelf')
})
