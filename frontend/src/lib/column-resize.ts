/**
 * Shared Column Resize utility
 *
 * Adds a small drag handle on the right edge of every `<th>` that carries a
 * `col-{key}` CSS class. Dragging the handle resizes the column; the new width
 * is persisted per-page in localStorage and applied via an injected stylesheet
 * so pagination / filter / reorder re-renders keep the width without extra
 * per-cell work.
 *
 * Usage:
 *   import { initColumnResize } from '../../lib/column-resize'
 *
 *   const resize = initColumnResize({
 *     tableSelector: '.fm-table',
 *     storageKey: 'filaman-column-widths-spools',
 *   })
 *
 *   // After dynamic columns are added (e.g. extra fields):
 *   resize.refreshColumns()
 *
 *   // Reset all widths (e.g. from column-picker popover):
 *   resize.resetWidths()
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ColumnResizeOptions {
  /** CSS selector for the table element */
  tableSelector: string
  /** localStorage key for persisting widths, e.g. 'filaman-column-widths-spools' */
  storageKey: string
  /** Minimum width in pixels (default 60) */
  minWidth?: number
  /** Optional callback fired after a column is resized */
  onResize?: (widths: Record<string, number>) => void
}

export interface ColumnResize {
  /** Re-scan header for new columns and re-attach handles. Call after dynamic columns added. */
  refreshColumns: () => void
  /** Current widths as a key → pixel map */
  getWidths: () => Record<string, number>
  /** Reset to default widths (removes saved preference) */
  resetWidths: () => void
  /** Remove all event listeners and injected styles */
  destroy: () => void
}

// ── Global CSS (handles, positioning) ──────────────────────────────

const GLOBAL_STYLE_ID = 'col-resize-global-css'

function ensureGlobalStyles(): void {
  if (document.getElementById(GLOBAL_STYLE_ID)) return
  const s = document.createElement('style')
  s.id = GLOBAL_STYLE_ID
  s.textContent = `
.fm-table th.col-resizable { position: relative; }
.fm-table th .col-resize-handle {
  position: absolute;
  top: 20%;
  right: -1px;
  bottom: 20%;
  width: 7px;
  cursor: col-resize;
  user-select: none;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* Sichtbare Griff-Linie in der Mitte des Handles */
.fm-table th .col-resize-handle::before {
  content: '';
  display: block;
  width: 2px;
  height: 100%;
  background: var(--border);
  border-radius: 1px;
  transition: background-color 0.15s ease, width 0.15s ease;
}
.fm-table th .col-resize-handle:hover::before,
.fm-table th .col-resize-handle.col-resize-active::before {
  background: var(--accent);
  width: 3px;
}
body.col-resize-dragging,
body.col-resize-dragging * { cursor: col-resize !important; user-select: none !important; }
`
  document.head.appendChild(s)
}

// ── Helpers ────────────────────────────────────────────────────────

function getColKey(el: Element): string | null {
  for (const cls of el.classList) {
    if (cls.startsWith('col-') && cls !== 'col-resizable') return cls.substring(4)
  }
  return null
}

function loadWidths(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
        }
        return out
      }
    }
  } catch { /* ignore */ }
  return {}
}

function saveWidths(storageKey: string, widths: Record<string, number>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths))
  } catch { /* ignore */ }
}

// ── Init ───────────────────────────────────────────────────────────

export function initColumnResize(opts: ColumnResizeOptions): ColumnResize {
  ensureGlobalStyles()

  const table = document.querySelector(opts.tableSelector) as HTMLTableElement | null
  if (!table) {
    return {
      refreshColumns() {},
      getWidths: () => ({}),
      resetWidths() {},
      destroy() {},
    }
  }

  const minWidth = Math.max(20, opts.minWidth ?? 60)
  let widths: Record<string, number> = loadWidths(opts.storageKey)
  let cleanupFns: (() => void)[] = []

  // Per-table style element that holds the width rules
  const styleEl = document.createElement('style')
  styleEl.dataset.colResizeFor = opts.storageKey
  document.head.appendChild(styleEl)

  function applyStylesheet(): void {
    const rules: string[] = []
    for (const [key, width] of Object.entries(widths)) {
      const safe = CSS.escape(key)
      rules.push(
        `${opts.tableSelector} th.col-${safe}, ${opts.tableSelector} td.col-${safe} { ` +
        `width: ${width}px; min-width: ${width}px; max-width: ${width}px; }`,
      )
    }
    styleEl.textContent = rules.join('\n')
  }

  function attachHandles(): void {
    // Clean up previous handles + listeners
    cleanupFns.forEach(fn => fn())
    cleanupFns = []

    const headerRow = table!.querySelector('thead tr')
    if (!headerRow) return

    const ths = Array.from(headerRow.querySelectorAll('th')) as HTMLElement[]

    ths.forEach(th => {
      const key = getColKey(th)
      if (!key) return

      th.classList.add('col-resizable')

      // Remove any stale handle
      th.querySelectorAll('.col-resize-handle').forEach(h => h.remove())

      const handle = document.createElement('div')
      handle.className = 'col-resize-handle'
      handle.setAttribute('aria-hidden', 'true')
      th.appendChild(handle)

      let startX = 0
      let startWidth = 0
      let active = false
      let prevDraggable = false

      const onMouseMove = (e: MouseEvent) => {
        if (!active) return
        const delta = e.clientX - startX
        const newWidth = Math.max(minWidth, Math.round(startWidth + delta))
        widths[key] = newWidth
        applyStylesheet()
      }

      const onMouseUp = () => {
        if (!active) return
        active = false
        handle.classList.remove('col-resize-active')
        document.body.classList.remove('col-resize-dragging')
        // Restore draggable state (used by column-reorder)
        th.draggable = prevDraggable
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        saveWidths(opts.storageKey, widths)
        opts.onResize?.({ ...widths })
      }

      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        active = true
        startX = e.clientX
        startWidth = widths[key] ?? th.getBoundingClientRect().width
        prevDraggable = th.draggable
        th.draggable = false
        handle.classList.add('col-resize-active')
        document.body.classList.add('col-resize-dragging')
        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
      }

      const onDblClick = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (widths[key] !== undefined) {
          delete widths[key]
          applyStylesheet()
          saveWidths(opts.storageKey, widths)
          opts.onResize?.({ ...widths })
        }
      }

      // Prevent drag-start (from column-reorder) being initiated from the handle
      const onDragStart = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }

      handle.addEventListener('mousedown', onMouseDown)
      handle.addEventListener('dblclick', onDblClick)
      handle.addEventListener('dragstart', onDragStart)
      // Block click too, to avoid accidental header-sort toggles on some pages
      handle.addEventListener('click', e => e.stopPropagation())

      cleanupFns.push(() => {
        handle.removeEventListener('mousedown', onMouseDown)
        handle.removeEventListener('dblclick', onDblClick)
        handle.removeEventListener('dragstart', onDragStart)
        handle.remove()
        th.classList.remove('col-resizable')
      })
    })
  }

  // ── Initialize ────────────────────────────────────────────────────

  applyStylesheet()
  attachHandles()

  // ── Public API ────────────────────────────────────────────────────

  return {
    refreshColumns() {
      applyStylesheet()
      attachHandles()
    },
    getWidths: () => ({ ...widths }),
    resetWidths() {
      widths = {}
      try { localStorage.removeItem(opts.storageKey) } catch { /* ignore */ }
      applyStylesheet()
      opts.onResize?.({})
    },
    destroy() {
      cleanupFns.forEach(fn => fn())
      cleanupFns = []
      styleEl.remove()
    },
  }
}
