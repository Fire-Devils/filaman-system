import { astroPageFunction } from '../../tests/helpers/astro-script'
import { expect, it, vi } from 'vitest'
import { colorFilterFromIds, colorUsageHtml } from './color-library-links'

const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? `:${params.count}` : ''}`

it('renders links only for colors in use', () => {
  expect(colorUsageHtml(7, 0, t)).toBe('colors.usedIn:0')
  const html = colorUsageHtml(7, 3, t)
  expect(html).toContain('href="/filaments?color_id=7"')
  expect(html).toContain('colors.usedInFilaments:3')
  expect(html).toContain('href="/spools?color_id=7"')
  expect(html).toContain('colors.showSpools')
})

it('builds the colors filter from known ids and ignores unknown ones', () => {
  const options = [
    { value: 'Red', color_stops: [{ id: 1 }, { id: 2 }] },
    { value: 'Blue', colorStops: [{ id: 3 }] },
  ]
  expect(colorFilterFromIds(['2', '3'], options)).toEqual({
    type: 'multi', values: ['Red', 'Blue'], colorStopIds: [['Red', [2]], ['Blue', [3]]],
  })
  expect(colorFilterFromIds(['99', 'abc'], options)).toBeNull()
})

it.each([
  ['filaments', [{ value: 'Red', color_stops: [{ id: 5 }] }]],
  ['spools', null],
])('%s page presets the colors filter from color_id and ignores unknown ids', (page, colors) => {
  const run = (search: string) => {
    const columnFilters: Record<string, unknown> = {}
    const setValue = vi.fn()
    const removeFilterUrlParams = vi.fn()
    const deps = {
      urlParams: new URLSearchParams(search), columnFilters, colorFilterFromIds, removeFilterUrlParams,
      updateFilterResets: vi.fn(), filHeaderFilters: { setValue }, splHeaderFilters: { setValue },
      spoolFilterFacets: { by_status: { 1: { colors: [{ value: 'Red', color_stops: [{ id: 5 }] }] } } },
    }
    const names = Object.keys(deps).join(',')
    const fn = new Function(...Object.keys(deps), `${astroPageFunction(`${page}/index`, 'applyUrlColorFilter')}; return applyUrlColorFilter;`)(...Object.values(deps))
    fn(colors)
    return { columnFilters, setValue, removeFilterUrlParams, names }
  }
  const hit = run('?color_id=5')
  expect(hit.columnFilters.colors).toEqual({ type: 'multi', values: ['Red'], colorStopIds: [['Red', [5]]] })
  expect(hit.setValue).toHaveBeenCalledWith('colors', hit.columnFilters.colors)
  expect(hit.removeFilterUrlParams).toHaveBeenCalledWith('color_id')
  const miss = run('?color_id=404')
  expect(miss.setValue).not.toHaveBeenCalled()
  if (page === 'spools') {
    // A color without spools filters by id server-side, so the list is empty, not unfiltered.
    expect(miss.columnFilters.colors).toEqual({ type: 'multi', values: ['#color'], colorStopIds: [['#color', [404]]] })
  } else {
    expect(miss.columnFilters.colors).toBeUndefined()
  }
  expect(run('?color_id=abc').columnFilters.colors).toBeUndefined()
})
