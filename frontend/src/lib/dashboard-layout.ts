// Layout helpers for the dashboard widgets: saved order, masonry columns and
// pointer-based drag sorting. The DOM-free parts are unit-tested directly.

export type DashboardLayout = 'grid' | 'masonry'

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

function currentOrder(parent: Element, items: readonly HTMLElement[]): HTMLElement[] {
  return Array.from(parent.children).filter((child): child is HTMLElement => items.includes(child as HTMLElement))
}

function sameList(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/** Puts the items into the container in the given order; only moves cards whose position changed. */
export function layoutItems(container: HTMLElement, items: readonly HTMLElement[]) {
  if (!sameList(currentOrder(container, items), items)) items.forEach(item => container.append(item))
}

export type WidgetWidth = 1 | 2 | 3 | 'full'
export type WidgetHeight = 'auto' | 's' | 'm' | 'l'
export interface WidgetSize { w: WidgetWidth; h: WidgetHeight }

export const WIDGET_WIDTHS: readonly WidgetWidth[] = [1, 2, 3, 'full']
export const WIDGET_HEIGHTS: readonly WidgetHeight[] = ['auto', 's', 'm', 'l']
/** Fixed card heights in px; must match the data-h rules in the dashboard styles. */
export const HEIGHT_PX: Record<Exclude<WidgetHeight, 'auto'>, number> = { s: 240, m: 360, l: 520 }
/** Height of one implicit masonry row in px. */
export const ROW_UNIT = 4

export function isWidgetWidth(value: unknown): value is WidgetWidth {
  return value === 1 || value === 2 || value === 3 || value === 'full'
}

export function isWidgetHeight(value: unknown): value is WidgetHeight {
  return value === 'auto' || value === 's' || value === 'm' || value === 'l'
}

/** Keeps only well-formed saved sizes (unknown shapes and values are dropped). */
export function normalizeWidgetSizes(raw: unknown): Record<string, WidgetSize> {
  const result: Record<string, WidgetSize> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const size = value as Partial<WidgetSize> | null
    if (size && isWidgetWidth(size.w) && isWidgetHeight(size.h)) result[id] = { w: size.w, h: size.h }
  }
  return result
}

/** Columns a card occupies: its width capped at the available columns; one column ignores widths. */
export function effectiveSpan(width: WidgetWidth | undefined, columns: number, defaultSpan = 1): number {
  const cols = Math.max(1, columns)
  if (cols === 1) return 1
  if (width === undefined) return Math.min(defaultSpan, cols)
  return width === 'full' ? cols : Math.min(width, cols)
}

/** The saved width for a span: covering every column means the full row. */
export function widthFromSpan(span: number, columns: number): WidgetWidth {
  const wanted = Math.max(1, Math.round(span))
  if (wanted >= Math.max(1, columns) || wanted > 3) return 'full'
  return wanted as 1 | 2 | 3
}

/** Column span for a card dragged to `width` px wide inside a grid of `columns` equal columns. */
export function spanFromWidth(width: number, containerWidth: number, columns: number, gap: number): number {
  const cols = Math.max(1, columns)
  if (!(containerWidth > 0)) return 1
  const unit = (containerWidth + gap) / cols
  return Math.min(cols, Math.max(1, Math.round((width + gap) / unit)))
}

/** Height step for a card dragged to `height` px; very small means back to automatic. */
export function heightFromPixels(height: number): WidgetHeight {
  if (height < 180) return 'auto'
  if (height < 300) return 's'
  if (height < 440) return 'm'
  return 'l'
}

/** Implicit masonry rows a card needs, including its bottom margin. */
export function rowSpan(height: number, margin = 0, unit = ROW_UNIT): number {
  return Math.max(1, Math.ceil((Math.max(0, height) + Math.max(0, margin)) / unit))
}

/** Number of grid columns for the current width; the plain grid takes its count from `--dash-grid-cols` in the styles. */
export function gridColumnCount(container: HTMLElement, layout: DashboardLayout): number {
  if (layout === 'masonry') return masonryColumnCount(container.clientWidth)
  const tracks = parseInt(getComputedStyle(container).getPropertyValue('--dash-grid-cols'), 10)
  if (tracks > 0) return tracks
  const width = container.clientWidth
  return width >= 1040 ? 4 : width >= 688 ? 2 : 1
}

export interface SizeContext {
  layout: DashboardLayout
  columns: number
  sizeOf(id: string): WidgetSize | undefined
  defaultSpan(card: HTMLElement): number
}

/**
 * Applies column spans and fixed heights to the cards. In masonry the cards
 * also get a row span from their measured height; `grid-auto-flow: dense`
 * then fills the gaps. Placeholders (no widget id) keep the span they were given.
 */
export function applyCardSizes(container: HTMLElement, items: readonly HTMLElement[], ctx: SizeContext) {
  const masonry = ctx.layout === 'masonry'
  container.style.setProperty('--dash-cols', String(ctx.columns))
  for (const item of items) {
    const id = item.dataset.widget
    if (id) {
      const size = ctx.sizeOf(id)
      item.dataset.h = size?.h ?? 'auto'
      item.style.gridColumn = `span ${effectiveSpan(size?.w, ctx.columns, ctx.defaultSpan(item))}`
    }
  }
  if (!masonry) {
    items.forEach(item => { item.style.gridRow = '' })
    return
  }
  // Widths are final now, so the heights read here are the real ones.
  for (const item of items) {
    if (item.style.display === 'none') { item.style.gridRow = ''; continue }
    const margin = parseFloat(getComputedStyle(item).marginBottom) || 0
    const span = `span ${rowSpan(item.offsetHeight, margin)}`
    if (item.style.gridRow !== span) item.style.gridRow = span
  }
}

export interface ResizeHooks {
  container: HTMLElement
  columns(): number
  gap: number
  /** Called whenever the size under the pointer changes. */
  preview(size: WidgetSize): void
  /** Final size; the unchanged start size again after a cancel. */
  commit(size: WidgetSize, cancelled: boolean): void
  signal?: AbortSignal
}

/** Drag the resize handle of a card: x snaps to columns, y to the height steps. */
export function startWidgetResize(event: PointerEvent, card: HTMLElement, start: WidgetSize, hooks: ResizeHooks) {
  if (event.button > 0) return
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget as HTMLElement | null
  const rect = card.getBoundingClientRect()
  const containerWidth = hooks.container.getBoundingClientRect().width || hooks.container.clientWidth
  const x0 = event.clientX
  const y0 = event.clientY
  let current = start
  let done = false
  try { handle?.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }

  const onMove = (e: PointerEvent) => {
    const cols = hooks.columns()
    const span = spanFromWidth(rect.width + (e.clientX - x0), containerWidth, cols, hooks.gap)
    const next: WidgetSize = { w: widthFromSpan(span, cols), h: heightFromPixels(rect.height + (e.clientY - y0)) }
    if (next.w === current.w && next.h === current.h) return
    current = next
    hooks.preview(next)
  }
  const onUp = () => finish(false)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true) }

  function finish(cancelled: boolean) {
    if (done) return
    done = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey)
    try { handle?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    hooks.commit(cancelled ? start : current, cancelled)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('keydown', onKey)
  hooks.signal?.addEventListener('abort', () => finish(true), { once: true })
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
  placeholder.className = 'dashboard-drop-placeholder'
  placeholder.style.gridColumn = card.style.gridColumn
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
    // A relayout could detach the dragged card.
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
