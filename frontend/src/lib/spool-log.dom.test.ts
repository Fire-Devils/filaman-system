// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import * as filters from './table-column-filters'
import * as i18n from './i18n'
import * as colors from './colors'
import { escapeHtml } from './extra-fields'

const dependencies = { ...filters, ...i18n, ...colors, escapeHtml, initI18n: async () => {}, getAbortSignal: () => undefined, isAbortError: () => false }
const boot = () => bootAstroPage('spool-log', dependencies)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear() })

it('sends search, numeric column filters and sorting to the API and renders event text safely', async () => {
  i18n.setLang('en')
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://test')
    calls.push(url)
    return Response.json({ total: 1, page: 1, page_size: 50, items: [{
      id: 1, spool_id: 8, event_type: '<img src=x onerror=alert(1)>',
      event_at: '2026-01-01T12:00:00Z', measured_weight_g: 60.1, delta_weight_g: null,
      note: '<img src=x onerror=alert(2)>', manufacturer_name: 'München', material_type: 'PLA', colors: [],
    }] })
  }))
  await boot()
  await vi.waitFor(() => expect(document.querySelector('#events-table')!.textContent).toContain('München'))
  expect(document.querySelector('#events-table img')).toBeNull()
  expect(document.querySelector('#events-table')!.textContent).toContain('<img')
  expect(document.querySelector('#events-table')!.textContent).toContain('60.1 g')
  const search = document.querySelector<HTMLInputElement>('#filter-search')!
  expect(search).not.toBeNull()
  search.value = '100% & München'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(calls.at(-1)!.searchParams.get('search')).toBe('100% & München'))
  document.querySelector<HTMLButtonElement>('th.col-weight .fm-header-filter-trigger')!.click()
  const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel.open')!
  const value = panel.querySelector<HTMLInputElement>('input[type="number"]')!
  value.value = '60.1'
  value.dispatchEvent(new Event('input', { bubbles: true }))
  const apply = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === i18n.t('filters.apply'))!
  apply.click()
  await vi.waitFor(() => expect(JSON.parse(calls.at(-1)!.searchParams.get('filters')!)).toMatchObject({ weight: { type: 'number', value: '60.1' } }))
  document.querySelector<HTMLButtonElement>('th.col-weight .fm-header-sort-trigger')!.click()
  await vi.waitFor(() => expect(calls.at(-1)!.searchParams.get('sort_by')).toBe('weight'))
  expect(calls.at(-1)!.searchParams.get('sort_order')).toBe('asc')
  document.querySelector<HTMLButtonElement>('#filter-clear')!.click()
  await vi.waitFor(() => expect(calls.at(-1)!.searchParams.has('filters')).toBe(false))
  expect(search.value).toBe('')
})

it('keeps the latest search results when an older request finishes last', async () => {
  const replies: Array<(response: Response) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { replies.push(resolve) })))
  await boot()
  const search = document.querySelector<HTMLInputElement>('#filter-search')!
  search.value = 'latest'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(replies).toHaveLength(2))
  const result = (note: string) => Response.json({ total: 1, page: 1, items: [{
    id: 1, spool_id: 8, event_type: 'measurement', event_at: '2026-01-01T12:00:00Z',
    measured_weight_g: 60, delta_weight_g: null, colors: [], note,
  }] })
  replies[1](result('Latest result'))
  await vi.waitFor(() => expect(document.querySelector('#events-table')!.textContent).toContain('Latest result'))
  replies[0](result('Stale result'))
  // Drain the released mock response before checking that it was ignored.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(document.querySelector('#events-table')!.textContent).toContain('Latest result')
  expect(document.querySelector('#events-table')!.textContent).not.toContain('Stale result')
})
