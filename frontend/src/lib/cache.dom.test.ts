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

it.each(['getItem', 'setItem'] as const)('keeps shared layout imports usable when sessionStorage.%s fails', async method => {
  vi.resetModules()
  sessionStorage.clear()
  vi.spyOn(sessionStorage, method).mockImplementation(() => { throw new DOMException('Storage unavailable', 'QuotaExceededError') })
  const { cachedFetch } = await import('./cache')
  const load = vi.fn(async () => ['fresh'])
  expect(await cachedFetch('quota-fixture', load)).toEqual(['fresh'])
  expect(await cachedFetch('quota-fixture', load)).toEqual(['fresh'])
  expect(load).toHaveBeenCalledOnce()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

it.each(['old-first', 'fresh-first'])('returns current data when invalidation crosses an unfinished read (%s)', async order => {
  vi.resetModules()
  const { cachedFetch, invalidateAllCaches } = await import('./cache')
  const old = deferred<string>()
  const fresh = deferred<string>()
  const oldRead = cachedFetch('manufacturers', () => old.promise)
  invalidateAllCaches()
  const freshRead = cachedFetch('manufacturers', () => fresh.promise)
  if (order === 'old-first') {
    old.resolve('Before edit')
    await Promise.resolve()
    fresh.resolve('After edit')
  } else {
    fresh.resolve('After edit')
    await freshRead
    old.resolve('Before edit')
  }
  expect(await oldRead).toBe('After edit')
  expect(await freshRead).toBe('After edit')
  expect(JSON.parse(localStorage.getItem('filaman-cache:manufacturers')!).data).toBe('After edit')
})

it.each(['key', 'prefix', 'all'])('invalidates pending %s reads without a saved entry', async kind => {
  vi.resetModules()
  const { cachedFetch, invalidateCache, invalidateCachePrefix, invalidateAllCaches } = await import('./cache')
  const old = deferred<string>()
  let reads = 0
  const read = cachedFetch('locations-list', () => ++reads === 1 ? old.promise : Promise.resolve('current'))
  if (kind === 'key') invalidateCache('locations-list')
  if (kind === 'prefix') invalidateCachePrefix('locations')
  if (kind === 'all') invalidateAllCaches()
  old.resolve('obsolete')
  expect(await read).toBe('current')
  expect(reads).toBe(2)
})

it('shares unfinished reads and permits retries after a current read fails', async () => {
  vi.resetModules()
  const { cachedFetch } = await import('./cache')
  const pending = deferred<string>()
  let reads = 0
  const fetch = () => { reads++; return pending.promise }
  const first = cachedFetch('colors', fetch)
  const second = cachedFetch('colors', fetch)
  const rejected = Promise.allSettled([first, second])
  pending.reject(new Error('offline'))
  expect((await rejected).every(result => result.status === 'rejected')).toBe(true)
  expect(reads).toBe(1)
  expect(await cachedFetch('colors', async () => 'online')).toBe('online')
})

it('replaces obsolete errors without discarding a newer unfinished read', async () => {
  vi.resetModules()
  const { cachedFetch, invalidateCache } = await import('./cache')
  const old = deferred<string>()
  const fresh = deferred<string>()
  const first = cachedFetch('colors', () => old.promise)
  const firstResult = first.catch(error => error.message)
  invalidateCache('colors')
  const second = cachedFetch('colors', () => fresh.promise)
  old.reject(new Error('obsolete failure'))
  await Promise.resolve()
  fresh.resolve('fresh')
  expect(await firstResult).toBe('fresh')
  expect(await second).toBe('fresh')
})

it('keeps unrelated pending reads on prefix invalidation and works when localStorage writes fail', async () => {
  vi.resetModules()
  const { cachedFetch, invalidateCachePrefix } = await import('./cache')
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
  const pending = deferred<string>()
  let reads = 0
  const fetch = () => { reads++; return pending.promise }
  const first = cachedFetch('colors', fetch)
  invalidateCachePrefix('locations')
  const second = cachedFetch('colors', fetch)
  pending.resolve('red')
  expect(await first).toBe('red')
  expect(await second).toBe('red')
  expect(reads).toBe(1)
})

it('makes progress after repeated invalidations and catches synchronous fetch failures', async () => {
  vi.resetModules()
  const { cachedFetch, invalidateAllCaches } = await import('./cache')
  const old = deferred<string>()
  const middle = deferred<string>()
  const first = cachedFetch('locations', () => old.promise)
  invalidateAllCaches()
  const second = cachedFetch('locations', () => middle.promise)
  invalidateAllCaches()
  const third = cachedFetch('locations', async () => 'latest')
  middle.resolve('middle')
  old.resolve('old')
  expect(await Promise.all([first, second, third])).toEqual(['latest', 'latest', 'latest'])
  await expect(cachedFetch('failure', () => { throw new Error('offline') })).rejects.toThrow('offline')
  expect(await cachedFetch('failure', async () => 'recovered')).toBe('recovered')
})

it('lets a new panel retry a joined request cancelled by the old panel', async () => {
  vi.resetModules()
  const { cachedFetch } = await import('./cache')
  const aborted = deferred<string>()
  const owner = cachedFetch('locations', () => aborted.promise)
  const ownerResult = owner.catch(error => error.name)
  const replacement = cachedFetch('locations', async () => 'new panel data')
  aborted.reject(new DOMException('Panel changed', 'AbortError'))
  expect(await ownerResult).toBe('AbortError')
  expect(await replacement).toBe('new panel data')
})
