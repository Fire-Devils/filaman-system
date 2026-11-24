// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { initInventoryScroll, inventoryLocalPages, inventoryApiPages } from './inventory-scroll'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function setup() {
  let onIntersection!: IntersectionObserverCallback
  const observer = { observe: vi.fn(), unobserve: vi.fn() }
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { onIntersection = callback }
    observe = observer.observe
    unobserve = observer.unobserve
  })
  document.body.innerHTML = `
    <div data-inventory-count></div>
    <table><tbody></tbody></table>
    <div class="fm-inventory-more" hidden><button></button><span role="status"></span></div>
  `
  const tbody = document.querySelector('tbody')!
  const more = document.querySelector<HTMLElement>('.fm-inventory-more')!
  const button = more.querySelector('button')!
  const list = initInventoryScroll<{ id: number }>(tbody, 'spools.spoolCount', (items, append) => {
    if (!append) tbody.replaceChildren()
    items.forEach(item => { tbody.insertRow().insertCell().textContent = String(item.id) })
  })
  return {
    ...list, tbody, more, button,
    scrollToEnd: () => onIntersection([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
  }
}

it('appends batches once, preserves existing rows, and hides the control when the list ends', async () => {
  const list = setup()
  const items = Array.from({ length: 51 }, (_, index) => ({ id: index + 1 }))
  await list.load(inventoryLocalPages(() => items))
  const first = list.tbody.children[0]
  expect(list.tbody.children).toHaveLength(50)
  list.scrollToEnd()
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.more.hidden).toBe(true))
  expect(list.tbody.children).toHaveLength(51)
  expect(list.tbody.children[0]).toBe(first)
  expect(list.get(51)).toEqual({ id: 51 })

  await list.load(inventoryLocalPages(() => [{ id: 52 }]))
  expect(list.tbody.children).toHaveLength(1)
  expect(list.get(51)).toBeUndefined()
})

it('keeps loaded rows on failure and discards a pending retry when filters change', async () => {
  const list = setup()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let finish!: (batch: { items: { id: number }[], total: number, hasMore: boolean }) => void
  const fetch = vi.fn()
    .mockResolvedValueOnce({ items: [{ id: 1 }], total: 2, hasMore: true })
    .mockRejectedValueOnce(new Error('Offline'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await list.load(fetch)
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.button.dataset.i18n).toBe('common.retry'))
  expect(list.tbody.textContent).toBe('1')
  list.scrollToEnd()
  expect(fetch).toHaveBeenCalledTimes(2)
  list.button.click()
  expect(fetch).toHaveBeenLastCalledWith(2)
  await list.load(inventoryLocalPages(() => [{ id: 3 }]), true)
  finish({ items: [{ id: 2 }], total: 2, hasMore: false })
  await Promise.resolve()
  expect(list.tbody.textContent).toBe('3')
  expect(list.more.hidden).toBe(true)
})

it('moves focus to a visible control after manually loading the last batch', async () => {
  const list = setup()
  const visible = document.createElement('button')
  const hidden = document.createElement('a')
  hidden.href = '/hidden'
  hidden.style.display = 'none'
  vi.spyOn(hidden, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
  vi.spyOn(visible, 'getClientRects').mockReturnValue([{ width: 10 }] as unknown as DOMRectList)
  await list.load(inventoryLocalPages(() => Array.from({ length: 51 }, (_, index) => ({ id: index + 1 }))), true,
    (items, append) => {
      items.forEach(() => {
        const cell = list.tbody.insertRow().insertCell()
        if (append) cell.append(hidden, visible)
      })
    })
  list.button.focus()
  list.button.click()
  await vi.waitFor(() => expect(list.more.hidden).toBe(true))
  expect(document.activeElement).toBe(visible)
})

it('reloads the prefix when a deletion shifts the next server page', async () => {
  const list = setup()
  const batch = (ids: number[], total: number, hasMore: boolean) =>
    ({ items: ids.map(id => ({ id })), total, hasMore })
  const fetch = vi.fn()
    .mockResolvedValueOnce(batch([4, 3], 4, true))
    .mockResolvedValueOnce(batch([1], 3, false))
    .mockResolvedValueOnce(batch([3, 2], 3, true))
    .mockResolvedValueOnce(batch([1], 3, false))
  await list.load(fetch)
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.more.hidden).toBe(true))
  expect(list.tbody.textContent).toBe('321')
  expect(list.get(4)).toBeUndefined()
})


it('shows total matches immediately without describing the loaded prefix', async () => {
  const list = setup()
  await list.load(inventoryLocalPages(() => Array.from({ length: 1400 }, (_, id) => ({ id }))))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('1400 spools')
  expect(list.tbody.children).toHaveLength(50)
})

it('shows filtered matches against the library total including zero and all matches', async () => {
  const list = setup()
  await list.load(inventoryLocalPages(() => [{ id: 1 }], false, () => 1400))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('1 of 1400 spools')
  await list.load(inventoryLocalPages(() => [], false, () => 1400))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('0 of 1400 spools')
  await list.load(inventoryLocalPages(() => [{ id: 1 }], false, () => 1))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('1 of 1 spools')
})


it('gets an unfiltered server total without downloading the inventory', async () => {
  const list = setup()
  const urls: URL[] = []
  vi.stubGlobal('fetch', async (path: string) => {
    const url = new URL(path, 'http://test'); urls.push(url)
    return { ok: true, json: async () => url.searchParams.has('type')
      ? { items: [{ id: 1 }], total: 1 } : { items: [{ id: 1 }], total: 1400 } }
  })
  await list.load(inventoryApiPages('/api/v1/spools', new URLSearchParams({ type: 'PLA' })))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('1 of 1400 spools')
  expect(urls).toHaveLength(2)
  const count = urls.find(url => url.searchParams.get('page_size') === '1')!
  expect(count.searchParams.has('type')).toBe(false)
  expect(count.searchParams.get('include_archived')).toBe('true')
})

it('keeps an unfiltered count accurate when insertion repairs the next page', async () => {
  const list = setup()
  let items = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }))
  vi.stubGlobal('fetch', async (path: string) => {
    const url = new URL(path, 'http://test'), size = Number(url.searchParams.get('page_size')), page = Number(url.searchParams.get('page') || '1')
    return { ok: true, json: async () => ({ items: items.slice((page - 1) * size, page * size), total: items.length }) }
  })
  await list.load(inventoryApiPages('/api/v1/filaments', new URLSearchParams()))
  items = [{ id: 61 }, ...items]
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.tbody.children).toHaveLength(61))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('61 spools')
})

it('refreshes filtered denominators when the server total changes between pages', async () => {
  const list = setup()
  let full = 100, matches = 60
  vi.stubGlobal('fetch', async (path: string) => {
    const url = new URL(path, 'http://test'), size = Number(url.searchParams.get('page_size')), page = Number(url.searchParams.get('page') || '1')
    const total = url.searchParams.has('type') ? matches : full
    return { ok: true, json: async () => ({ items: Array.from({ length: total }, (_, id) => ({ id })).slice((page - 1) * size, page * size), total }) }
  })
  await list.load(inventoryApiPages('/api/v1/filaments', new URLSearchParams({ type: 'PLA' })))
  full = 101; matches = 61
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.tbody.children).toHaveLength(61))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('61 of 101 spools')
})


it.each([false, true])('keeps rows and reuses the auxiliary count across pages (count fails: %s)', async countFails => {
  const list = setup()
  let countReads = 0
  vi.stubGlobal('fetch', async (path: string) => {
    const url = new URL(path, 'http://test')
    if (url.searchParams.get('page_size') === '1') {
      countReads++
      if (countFails) throw new Error('Count offline')
      return { ok: true, json: async () => ({ total: 100 }) }
    }
    const page = Number(url.searchParams.get('page'))
    return { ok: true, json: async () => ({ items: Array.from({ length: page === 1 ? 50 : 1 }, (_, i) => ({ id: (page - 1) * 50 + i })), total: 51 }) }
  })
  const source = inventoryApiPages<{ id: number }>('/api/v1/filaments', new URLSearchParams({ type: 'PLA' }))
  await list.load(source)
  expect(list.tbody.children).toHaveLength(50)
  list.scrollToEnd()
  await vi.waitFor(() => expect(list.tbody.children).toHaveLength(51))
  expect(countReads).toBe(1)
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe(countFails ? '51 spools' : '51 of 100 spools')
})

it('ignores a failed local count but propagates count cancellation', async () => {
  const source = inventoryLocalPages(() => [{ id: 1 }], false, () => { throw new Error('Offline') })
  expect((await source(1)).items).toEqual([{ id: 1 }])
  const aborted = inventoryLocalPages(() => [{ id: 1 }], false, () => Promise.reject(new DOMException('Gone', 'AbortError')))
  await expect(aborted(1)).rejects.toHaveProperty('name', 'AbortError')
})

it('propagates server count cancellation instead of rendering stale rows', async () => {
  vi.stubGlobal('fetch', async (path: string) => {
    if (new URL(path, 'http://test').searchParams.get('page_size') === '1') throw new DOMException('Gone', 'AbortError')
    return { ok: true, json: async () => ({ items: [{ id: 1 }], total: 1 }) }
  })
  await expect(inventoryApiPages('/api/v1/filaments', new URLSearchParams({ type: 'PLA' }))(1)).rejects.toHaveProperty('name', 'AbortError')
})


it('bounds a separately read local denominator by the matching rows', async () => {
  const list = setup()
  await list.load(inventoryLocalPages(() => [{id: 1}, {id: 2}], true, () => 1))
  expect(document.querySelector('[data-inventory-count]')!.textContent).toBe('2 of 2 spools')
})
