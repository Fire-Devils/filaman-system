// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { initInventoryScroll, inventoryLocalPages } from './inventory-scroll'

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
