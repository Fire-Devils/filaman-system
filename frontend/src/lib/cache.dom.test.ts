// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

it('refetches color facets instead of accepting the previous deployed spool cache shape', async () => {
  vi.resetModules()
  sessionStorage.setItem('filaman-cache-session', 'same-tab')
  localStorage.setItem('filaman-cache:spool-filter-options', JSON.stringify({
    data: { used_status_ids: [1], by_status: { 1: { manufacturers: [], materials: [], locations: [] } } },
    timestamp: Date.now(), sessionId: 'same-tab',
  }))
  const { cachedFetch, CACHE_KEYS } = await import('./cache')
  const fresh = { used_status_ids: [1], by_status: { 1: { colors: [], has_empty_colors: false } } }
  const fetch = vi.fn(async () => fresh)
  expect(await cachedFetch(CACHE_KEYS.SPOOL_FILTER_OPTIONS, fetch)).toEqual(fresh)
  expect(fetch).toHaveBeenCalledOnce()
})
