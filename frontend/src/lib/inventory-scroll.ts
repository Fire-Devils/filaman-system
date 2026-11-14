import { getAbortSignal, isAbortError } from './abort'
import { t } from './i18n'
import type { ColumnFilterValue } from './table-column-filters'

const batchSize = 50
type Batch<T> = { items: T[], total: number, hasMore: boolean }
type Source<T> = (page: number) => Batch<T> | Promise<Batch<T>>
type Render<T> = (items: T[], append: boolean) => void
type InventoryView = {
  columns: Record<string, ColumnFilterValue>
  sort: { key: string | null; direction: 'asc' | 'desc' | null }
  group?: boolean
}
type ListHistory<T> = { top: number; windowTop: number; search?: string; data: T }

// On Back/Forward, history.state already points at the destination when Astro
// prepares the swap. Keep the outgoing panel's snapshot until it is revisited.
const traversedScroll = new Map<number, unknown>()
if (typeof document !== 'undefined') {
  document.addEventListener('astro:before-swap', event => {
    const index = history.state?.index
    if (event.navigationType !== 'push' || typeof index !== 'number') return
    for (const entry of traversedScroll.keys()) {
      if (entry > index) traversedScroll.delete(entry)
    }
  })
}

export function trackListHistory<T>(main: HTMLElement | null, readData: () => T, signal?: AbortSignal) {
  const search = main?.querySelector<HTMLInputElement>('#filter-search')
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const index: number | undefined = history.state?.index
  const restored: ListHistory<T> | undefined = index === undefined
    ? navigation?.type === 'back_forward' ? history.state?.listHistory : undefined
    : (traversedScroll.get(index) ?? history.state?.listHistory) as ListHistory<T> | undefined
  if (index !== undefined) traversedScroll.delete(index)
  if (search && restored?.search !== undefined) search.value = restored.search

  function save() {
    if (!main) return
    const snapshot = { top: main.scrollTop, windowTop: window.scrollY, search: search?.value, data: readData() }
    if (history.state?.index === index) {
      history.replaceState({ ...history.state, listHistory: snapshot }, '')
    } else if (index !== undefined) {
      traversedScroll.set(index, structuredClone(snapshot))
    }
  }
  window.addEventListener('pagehide', save, { signal })
  document.addEventListener('astro:before-preparation', save, { signal })
  return {
    data: restored?.data,
    restoreScroll() {
      if (!main || !restored) return
      main.scrollTop = restored.top
      window.scrollTo(0, restored.windowTop)
    },
  }
}

export function inventoryApiPages<T>(path: string, query: URLSearchParams): Source<T> {
  return async page => {
    const params = new URLSearchParams(query)
    params.set('page', String(page))
    params.set('page_size', String(batchSize))
    const response = await fetch(`${path}?${params}`, { credentials: 'include', signal: getAbortSignal() })
    if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`)
    const { items, total }: { items: T[], total: number } = await response.json()
    return { items, total, hasMore: items.length > 0 && page * batchSize < total }
  }
}

export function inventoryLocalPages<T>(getItems: () => T[] | Promise<T[]>, grouped = false): Source<T> {
  let result: T[] | undefined
  return async page => {
    const items = result ??= await getItems()
    const end = page * batchSize
    return {
      items: grouped ? items : items.slice(end - batchSize, end),
      total: items.length,
      hasMore: !grouped && end < items.length,
    }
  }
}

export function initInventoryScroll<T extends { id: number }>(
  tbody: HTMLElement, countKey: string, render: Render<T>, afterRender?: () => void, signal?: AbortSignal,
  getView?: () => InventoryView,
) {
  const count = document.querySelector<HTMLElement>('[data-inventory-count]')!
  const more = document.querySelector<HTMLElement>('.fm-inventory-more')!
  const button = more.querySelector('button')!
  const status = more.querySelector('[role="status"]')!
  const observer = new IntersectionObserver(entries => {
    if (!failed && entries.some(entry => entry.isIntersecting)) void loadMore()
  }, { rootMargin: '0px 0px 480px' })
  const loaded = new Map<number, T>()
  let source: Source<T> | undefined
  let drawRows = render
  const listHistory = trackListHistory(tbody.closest('main'), () => ({ nextPage, view: getView?.() }), signal)
  let nextPage: number = listHistory.data?.nextPage ?? 1
  let total = 0
  let hasMore = false
  let loading = false
  let failed = false
  let generation = 0
  button.addEventListener('click', () => { void loadMore() })
  signal?.addEventListener('abort', () => { pause(); observer.disconnect() }, { once: true })

  function updateControls() {
    count.textContent = loaded.size > 0 && loaded.size < total
      ? `${t('common.showing')} 1-${loaded.size} ${t('common.of')} ${total}`
      : t(countKey, { count: total })
    observer.unobserve(more)
    more.hidden = !hasMore
    button.dataset.i18n = failed ? 'common.retry' : 'common.loadMore'
    button.textContent = t(button.dataset.i18n)
    button.setAttribute('aria-disabled', String(loading))
    status.textContent = loading ? t('common.loading') : failed ? t('common.errorLoadingData') : ''
    if (hasMore && !loading && !failed) observer.observe(more)
  }

  function pause() {
    generation++
    source = undefined
    observer.unobserve(more)
    more.hidden = true
    loading = failed = false
  }

  function add(batch: Batch<T>) {
    const added = batch.items.filter(item => {
      if (loaded.has(item.id)) return false
      loaded.set(item.id, item)
      return true
    })
    total = batch.total
    hasMore = batch.hasMore
    nextPage++
    return added
  }

  async function fetchPrefix(read: Source<T>, pages: number, request: number) {
    const batches: Batch<T>[] = []
    for (let page = 1; page <= pages; page++) {
      const batch = await read(page)
      if (request !== generation) return
      batches.push(batch)
      if (!batch.hasMore) break
    }
    return batches
  }

  function replace(batches: Batch<T>[]) {
    loaded.clear()
    nextPage = 1
    batches.forEach(add)
    drawRows([...loaded.values()], false)
  }

  async function load(next: Source<T>, reset = false, draw = render) {
    pause()
    if (reset) nextPage = 1
    const request = generation
    try {
      const batches = await fetchPrefix(next, Math.max(1, nextPage - 1), request)
      if (!batches || request !== generation) return false
      source = next
      drawRows = draw
      replace(batches)
      if (generation === 1 && !reset) listHistory.restoreScroll()
      updateControls()
      afterRender?.()
      return true
    } catch (error) {
      if (request !== generation || isAbortError(error)) return false
      count.textContent = ''
      throw error
    }
  }

  async function loadMore() {
    if (!source || !hasMore || loading) return
    const request = generation
    loading = true
    failed = false
    updateControls()
    try {
      const batch = await source(nextPage)
      if (request !== generation) return
      const previousRows = tbody.children.length
      // shortcut: repair detectable offset shifts; use a server revision for same-count changes.
      if (batch.total !== total || batch.items.some(item => loaded.has(item.id))) {
        const batches = await fetchPrefix(source, nextPage, request)
        if (!batches || request !== generation) return
        replace(batches)
      } else {
        const added = add(batch)
        if (added.length) drawRows(added, true)
      }
      afterRender?.()
      if (document.activeElement === button) {
        const first = tbody.children[previousRows] ?? tbody.lastElementChild
        const controls = first?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href]')
        const target = controls && Array.from(controls).find(control => control.getClientRects().length)
        if (target) target.focus()
        else if (first instanceof HTMLElement) {
          first.tabIndex = -1
          first.focus()
        }
      }
    } catch (error) {
      if (request !== generation || isAbortError(error)) return
      console.error('Failed to load more inventory:', error)
      failed = true
    } finally {
      if (request === generation) {
        loading = false
        updateControls()
      }
    }
  }

  return { load, pause, view: listHistory.data?.view, get: (id: number) => loaded.get(id) }
}
