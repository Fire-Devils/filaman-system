// Layout helpers for the dashboard widgets: saved order, masonry columns and
// pointer-based drag sorting. The DOM-free parts are unit-tested directly.

export type DashboardLayout = 'grid' | 'masonry'

export const MASONRY_GAP = 12

/** Saved order first; widgets the order does not know (new ones) keep their markup order at the end. */
export function applyWidgetOrder<T extends string>(ids: readonly T[], order: readonly string[]): T[] {
  const known = new Set<string>(ids)
  const seen = new Set<string>()
  const result: T[] = []
  for (const id of order) {
    if (!known.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id as T)
  }
  for (const id of ids) if (!seen.has(id)) result.push(id)
  return result
}

export function masonryColumnCount(width: number): number {
  if (width >= 960) return 3
  if (width >= 620) return 2
  return 1
}

/** Greedy masonry: each item goes into the currently shortest column, ties go left. Zero-height items take no space. */
export function assignMasonryColumns(heights: readonly number[], columns: number, gap = 0): number[] {
  const totals = new Array<number>(Math.max(1, columns)).fill(0)
  return heights.map(height => {
    let best = 0
    for (let i = 1; i < totals.length; i++) if (totals[i] < totals[best]) best = i
    if (height > 0) totals[best] += height + gap
    return best
  })
}

function masonryColumns(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter((child): child is HTMLElement => child.classList.contains('dashboard-masonry-col'))
}

function currentOrder(parent: Element, items: readonly HTMLElement[]): HTMLElement[] {
  return Array.from(parent.children).filter((child): child is HTMLElement => items.includes(child as HTMLElement))
}

function sameList(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/** Plain grid: all items are direct children of the container, in order. */
export function layoutGrid(container: HTMLElement, items: readonly HTMLElement[]) {
  const columns = masonryColumns(container)
  if (columns.length || !sameList(currentOrder(container, items), items)) {
    items.forEach(item => container.append(item))
  }
  columns.forEach(column => column.remove())
}

/**
 * Distributes the items over `columns` columns. Existing columns are reused
 * and cards are only moved when their column or position changes, so scroll
 * positions inside the cards survive a re-layout that changes nothing.
 */
export function layoutMasonry(
  container: HTMLElement,
  items: readonly HTMLElement[],
  columns: number,
  measure: (item: HTMLElement) => number = item => item.offsetHeight,
  gap = MASONRY_GAP,
): number[] {
  let cols = masonryColumns(container)
  if (cols.length !== columns) {
    // Round-robin first so every card has its final column width when measured.
    cols.forEach(col => col.remove())
    cols = Array.from({ length: columns }, () => {
      const col = document.createElement('div')
      col.className = 'dashboard-masonry-col'
      container.append(col)
      return col
    })
    items.forEach((item, i) => cols[i % columns].append(item))
  }
  const heights = items.map(item => (item.style.display === 'none' ? 0 : measure(item)))
  const assignment = assignMasonryColumns(heights, columns, gap)
  const upToDate = cols.every((col, c) =>
    sameList(currentOrder(col, items), items.filter((_, i) => assignment[i] === c)))
  if (!upToDate) items.forEach((item, i) => cols[assignment[i]].append(item))
  return assignment
}

interface Box { left: number; top: number; width: number; height: number }

/** Which card the pointer is aiming at and whether the dragged card goes before or after it. */
export function dropTarget(boxes: readonly Box[], x: number, y: number): { index: number; before: boolean } | null {
  if (!boxes.length) return null
  let index = boxes.findIndex(b => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height)
  if (index < 0) {
    let best = Infinity
    boxes.forEach((b, i) => {
      const distance = Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2))
      if (distance < best) { best = distance; index = i }
    })
  }
  const box = boxes[index]
  const upper = box.top + box.height * 0.33
  const lower = box.top + box.height * 0.66
  const before = y < upper ? true : y > lower ? false : x < box.left + box.width / 2
  return { index, before }
}

export interface DragHooks {
  /** Cards in their current order. */
  getItems(): HTMLElement[]
  /** Renders the given item list in the active layout (grid or masonry). */
  relayout(items: HTMLElement[]): void
  /** Called with the final widget ids; the same order again after a cancel. */
  commit(ids: string[], cancelled: boolean): void
  signal?: AbortSignal
}

const EDGE = 64

/** Drag one widget by its handle. Works with mouse, touch and pen through pointer events. */
export function startWidgetDrag(event: PointerEvent, card: HTMLElement, hooks: DragHooks) {
  if (event.button > 0) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement | null
  const rect = card.getBoundingClientRect()
  const grabX = event.clientX - rect.left
  const grabY = event.clientY - rect.top
  const original = hooks.getItems()
  const placeholder = document.createElement('div')
  placeholder.className = `dashboard-drop-placeholder${card.classList.contains('dashboard-wide') ? ' dashboard-wide' : ''}`
  placeholder.style.height = `${rect.height}px`
  let items = original.map(item => (item === card ? placeholder : item))
  let x = event.clientX
  let y = event.clientY
  let frame = 0
  let done = false

  card.classList.add('dashboard-dragging')
  Object.assign(card.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` })
  try { handle?.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
  hooks.relayout(items)

  function update() {
    card.style.left = `${x - grabX}px`
    card.style.top = `${y - grabY}px`
    const candidates = items.filter(item => item !== placeholder && item.style.display !== 'none')
    const inside = placeholder.getBoundingClientRect()
    if (x >= inside.left && x <= inside.right && y >= inside.top && y <= inside.bottom) return
    const target = dropTarget(candidates.map(item => item.getBoundingClientRect()), x, y)
    if (!target) return
    const rest = items.filter(item => item !== placeholder)
    const at = rest.indexOf(candidates[target.index]) + (target.before ? 0 : 1)
    if (at === items.indexOf(placeholder)) return
    rest.splice(at, 0, placeholder)
    items = rest
    hooks.relayout(items)
    // A masonry rebuild can drop the column the card sits in.
    if (!card.isConnected) document.body.append(card)
  }

  function tick() {
    const scroll = y < EDGE ? -14 : y > window.innerHeight - EDGE ? 14 : 0
    if (scroll) { window.scrollBy(0, scroll); update() }
    frame = requestAnimationFrame(tick)
  }

  const onMove = (e: PointerEvent) => { x = e.clientX; y = e.clientY; update() }
  const onUp = () => finish(false)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true) }

  function finish(cancelled: boolean) {
    if (done) return
    done = true
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey)
    try { handle?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    const finalItems = cancelled ? original : items.map(item => (item === placeholder ? card : item))
    placeholder.remove()
    card.classList.remove('dashboard-dragging')
    card.style.width = card.style.left = card.style.top = ''
    hooks.relayout(finalItems)
    hooks.commit(finalItems.map(item => item.dataset.widget!), cancelled)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('keydown', onKey)
  hooks.signal?.addEventListener('abort', () => finish(true), { once: true })
  frame = requestAnimationFrame(tick)
}
