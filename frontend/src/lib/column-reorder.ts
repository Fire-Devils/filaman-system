/**
 * Shared Column Reorder utility
 *
 * Adds drag & drop reordering to keyed table columns. Unkeyed columns stay fixed.
 * Persists column order in localStorage.
 *
 * Usage:
 *   import { initColumnReorder } from '../../lib/column-reorder'
 *
 *   const reorder = initColumnReorder({
 *     tableSelector: '.fm-table',
 *     storageKey: 'filaman-column-order-spools',
 *   })
 *
 *   // After each re-render (pagination, filter, sort):
 *   reorder.applyOrder()
 *
 *   // After dynamic columns are added (e.g. extra fields):
 *   reorder.refreshColumns()
 */

import { getColKey } from './column-key'

// ── Types ──────────────────────────────────────────────────────────

export interface ColumnReorderOptions {
  /** CSS selector for the table element */
  tableSelector: string
  /** localStorage key for persisting order, e.g. 'filaman-column-order-spools' */
  storageKey: string
  /** Optional callback fired after columns are reordered */
  onReorder?: (order: string[]) => void
}

export interface ColumnReorder {
  /** Reorder all rows (header + body) to match the saved order. Call after re-render. */
  applyOrder: () => void
  /** Return the current column order as key array */
  getOrder: () => string[]
  /** Reset to default order (removes saved preference) */
  resetOrder: () => void
  /** Re-scan header for new columns and re-attach drag handlers. Call after dynamic columns added. */
  refreshColumns: () => void
  /** Remove all event listeners */
  destroy: () => void
}

// ── CSS injection ──────────────────────────────────────────────────

const REORDER_STYLE_ID = 'col-reorder-css'

function ensureReorderStyles(): void {
  if (document.getElementById(REORDER_STYLE_ID)) return
  const s = document.createElement('style')
  s.id = REORDER_STYLE_ID
  s.textContent = `
.fm-table th[draggable="true"] { cursor: grab; }
.fm-table th[draggable="true"]:active { cursor: grabbing; }
.fm-table th.col-dragging { opacity: 0.4; }
.fm-table th.col-drop-before { box-shadow: inset 3px 0 0 var(--accent); }
.fm-table th.col-drop-after  { box-shadow: inset -3px 0 0 var(--accent); }
`
  document.head.appendChild(s)
}

// ── Helpers ────────────────────────────────────────────────────────

function loadOrder(storageKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[]
    }
  } catch { /* ignore */ }
  return null
}

function saveOrder(storageKey: string, order: string[]): void {
  localStorage.setItem(storageKey, JSON.stringify(order))
}

// ── Reorder a single row ──────────────────────────────────────────

function reorderRow(row: Element, order: string[]): void {
  const cells = Array.from(row.children) as HTMLElement[]
  if (cells.length <= 1) return

  // Skip rows with colspan (loading/empty message rows or group headers)
  const firstCell = cells[0] as HTMLTableCellElement
  if (firstCell.colSpan > 1) return

  // Separate into: leading fixed, reorderable (by key), trailing fixed
  const leading: HTMLElement[] = []
  const reorderable = new Map<string, HTMLElement>()
  const trailing: HTMLElement[] = []

  // Find the last reorderable cell index
  let lastReorderableIdx = -1
  for (let i = cells.length - 1; i >= 0; i--) {
    if (getColKey(cells[i])) { lastReorderableIdx = i; break }
  }

  let passedFirstReorderable = false
  cells.forEach((cell, i) => {
    const key = getColKey(cell)
    if (key) {
      passedFirstReorderable = true
      reorderable.set(key, cell)
    } else if (!passedFirstReorderable) {
      leading.push(cell)
    } else if (i > lastReorderableIdx) {
      trailing.push(cell)
    } else {
      // Fixed cell between reorderable ones — keep at current relative position
      trailing.push(cell)
    }
  })

  // Build ordered cells
  const ordered: HTMLElement[] = [...leading]
  const used = new Set<string>()

  order.forEach(key => {
    const cell = reorderable.get(key)
    if (cell) { ordered.push(cell); used.add(key) }
  })

  // Append any reorderable cells not in the saved order (e.g. newly added extra fields)
  reorderable.forEach((cell, key) => {
    if (!used.has(key)) ordered.push(cell)
  })

  ordered.push(...trailing)

  if (ordered.every((cell, index) => cell === cells[index])) return
  const focused = document.activeElement
  ordered.forEach(cell => row.appendChild(cell))
  if (focused instanceof HTMLElement && row.contains(focused) && document.activeElement !== focused) {
    focused.focus({ preventScroll: true })
  }
}

// ── Init ───────────────────────────────────────────────────────────

export function initColumnReorder(opts: ColumnReorderOptions): ColumnReorder {
  ensureReorderStyles()

  const table = document.querySelector(opts.tableSelector) as HTMLTableElement
  if (!table) {
    // Return no-op if table not found
    return { applyOrder() {}, getOrder: () => [], resetOrder() {}, refreshColumns() {}, destroy() {} }
  }

  let currentOrder: string[] = []
  let cleanupFns: (() => void)[] = []

  /** Scan header for reorderable column keys (in current DOM order) */
  function scanKeys(): string[] {
    const headerRow = table.querySelector('thead tr')
    if (!headerRow) return []
    const keys: string[] = []
    Array.from(headerRow.children).forEach(th => {
      const key = getColKey(th)
      if (key) keys.push(key)
    })
    return keys
  }

  /** Compute the effective order: saved order validated against current columns */
  function computeOrder(): string[] {
    const domKeys = scanKeys()
    const saved = loadOrder(opts.storageKey)
    if (!saved) return [...domKeys]

    const domSet = new Set(domKeys)
    const savedSet = new Set(saved)
    return [
      ...saved.filter(k => domSet.has(k)),
      ...domKeys.filter(k => !savedSet.has(k)),
    ]
  }

  /** Apply column order to all rows in the table */
  function applyOrder(): void {
    if (currentOrder.length) {
      table.querySelectorAll('tr').forEach(row => reorderRow(row, currentOrder))
    }
    if (table.parentElement?.matches('.fm-inventory-table')) {
      table.dispatchEvent(new Event('filaman:columns-changed'))
    }
  }

  /** Set up drag & drop handlers on header cells */
  function setupDrag(): void {
    // Clean up previous handlers
    cleanupFns.forEach(fn => fn())
    cleanupFns = []

    const headerRow = table.querySelector('thead tr')
    if (!headerRow) return

    const ths = Array.from(headerRow.querySelectorAll('th')) as HTMLElement[]
    let draggedKey: string | null = null
    const isCompact = () => table.parentElement?.matches('.fm-inventory-table[data-compact]')

    ths.forEach(th => {
      const key = getColKey(th)
      if (!key) return // skip fixed columns

      th.draggable = true

      const onDragStart = (e: DragEvent) => {
        if (isCompact()) {
          e.preventDefault()
          return
        }
        draggedKey = key
        th.classList.add('col-dragging')
        e.dataTransfer!.effectAllowed = 'move'
        e.dataTransfer!.setData('text/plain', key)
      }

      const onDragEnd = () => {
        draggedKey = null
        th.classList.remove('col-dragging')
        // Clear all indicators
        headerRow.querySelectorAll('.col-drop-before, .col-drop-after').forEach(el => {
          el.classList.remove('col-drop-before', 'col-drop-after')
        })
      }

      const onDragOver = (e: DragEvent) => {
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'

        const targetKey = getColKey(th)
        if (!targetKey || targetKey === draggedKey) return

        // Show indicator on left or right half
        const rect = th.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        const isLeft = e.clientX < midX

        th.classList.toggle('col-drop-before', isLeft)
        th.classList.toggle('col-drop-after', !isLeft)
      }

      const onDragEnter = (e: DragEvent) => {
        e.preventDefault()
      }

      const onDragLeave = () => {
        th.classList.remove('col-drop-before', 'col-drop-after')
      }

      const onDrop = (e: DragEvent) => {
        e.preventDefault()
        const fromKey = e.dataTransfer!.getData('text/plain')
        const toKey = getColKey(th)

        th.classList.remove('col-drop-before', 'col-drop-after')

        if (isCompact() || !fromKey || !toKey || fromKey === toKey) return

        const fromIdx = currentOrder.indexOf(fromKey)
        const toIdx = currentOrder.indexOf(toKey)
        if (fromIdx === -1 || toIdx === -1) return

        // Determine if dropping before or after
        const rect = th.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        const dropBefore = e.clientX < midX

        // Remove from current position
        currentOrder.splice(fromIdx, 1)

        // Recalculate target index (it may have shifted after splice)
        let insertIdx = currentOrder.indexOf(toKey)
        if (!dropBefore) insertIdx += 1

        currentOrder.splice(insertIdx, 0, fromKey)

        // Save and apply
        saveOrder(opts.storageKey, currentOrder)
        applyOrder()
        opts.onReorder?.(currentOrder)
      }

      th.addEventListener('dragstart', onDragStart)
      th.addEventListener('dragend', onDragEnd)
      th.addEventListener('dragover', onDragOver)
      th.addEventListener('dragenter', onDragEnter)
      th.addEventListener('dragleave', onDragLeave)
      th.addEventListener('drop', onDrop)

      cleanupFns.push(() => {
        th.draggable = false
        th.removeEventListener('dragstart', onDragStart)
        th.removeEventListener('dragend', onDragEnd)
        th.removeEventListener('dragover', onDragOver)
        th.removeEventListener('dragenter', onDragEnter)
        th.removeEventListener('dragleave', onDragLeave)
        th.removeEventListener('drop', onDrop)
      })
    })
  }

  // ── Initialize ────────────────────────────────────────────────────

  let defaultOrder = scanKeys()
  currentOrder = computeOrder()
  applyOrder()
  setupDrag()

  // ── Public API ────────────────────────────────────────────────────

  return {
    applyOrder,

    getOrder: () => [...currentOrder],

    resetOrder() {
      localStorage.removeItem(opts.storageKey)
      const keys = new Set(scanKeys())
      currentOrder = defaultOrder.filter(key => keys.has(key))
      applyOrder()
      setupDrag()
      opts.onReorder?.(currentOrder)
    },

    refreshColumns() {
      defaultOrder = [...new Set([...defaultOrder, ...scanKeys()])]
      currentOrder = computeOrder()
      applyOrder()
      setupDrag()
    },

    destroy() {
      cleanupFns.forEach(fn => fn())
      cleanupFns = []
    },
  }
}
