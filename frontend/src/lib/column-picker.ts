/**
 * Shared Column Picker utility
 *
 * Centralises the column-visibility dropdown logic that was previously
 * copy-pasted across spools, filaments and manufacturers pages.
 *
 * Usage:
 *   import { initColumnPicker, type ColumnGroup } from '../../lib/column-picker'
 *
 *   const columns: ColumnGroup[] = [
 *     { heading: t('common.systemFields'), columns: [ { key: 'id', label: t('spools.id') }, ... ] },
 *     { heading: t('common.extraFields'), columns: [ { key: 'cf_myfield', label: 'My Field' }, ... ] },
 *   ]
 *   const picker = initColumnPicker({
 *     storageKey: 'filaman-columns-spools',
 *     defaultVisible: ['id', 'manufacturer', 'material', 'status', 'remaining', 'location'],
 *     groups: columns,
 *     btnId: 'btn-columns',
 *     dropdownId: 'columns-dropdown',
 *     onVisibilityChange: () => renderPage(),   // optional callback after column toggle
 *   })
 *   // Later: picker.updateGroups(newGroups) to add dynamic custom field columns
 *   // picker.isVisible('id')  => boolean
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ColumnDef {
  key: string
  label: string
}

export interface ColumnGroup {
  /** Section heading shown as a small separator label in the dropdown */
  heading?: string
  columns: ColumnDef[]
}

export interface ColumnPickerOptions {
  /** localStorage key, e.g. 'filaman-columns-spools' */
  storageKey: string
  /** Keys that are visible by default (when no saved preference exists) */
  defaultVisible: string[]
  /** Column groups to render */
  groups: ColumnGroup[]
  /** ID of the toggle button */
  btnId: string
  /** ID of the dropdown container */
  dropdownId: string
  /** Optional callback fired after a column is toggled */
  onVisibilityChange?: () => void
  /** Optional: localStorage key for column order (to reset alongside visibility) */
  orderStorageKey?: string
  /** Optional: localStorage key for column widths (to reset alongside visibility) */
  widthsStorageKey?: string
  /** Optional: callback to reset column order (called when reset button is clicked) */
  onReset?: () => void
  /** Optional: callback to reset column widths (called when reset button is clicked) */
  onResetWidths?: () => void
  /** Label for the reset button (i18n). Defaults to 'Reset columns'. */
  resetLabel?: string
}

export interface ColumnPicker {
  /** Check whether a column key is currently visible */
  isVisible: (key: string) => boolean
  /** Replace groups (e.g. after loading custom fields) and re-apply visibility */
  updateGroups: (groups: ColumnGroup[]) => void
  /** Apply CSS rules to hide columns — call after dynamic table re-render */
  applyVisibility: () => void
  /** Return the current set of visible column keys */
  getVisibleKeys: () => Set<string>
}

// ── CSS injection ──────────────────────────────────────────────────

const STYLE_ID = 'col-vis-style'

function ensureGlobalStyles(): void {
  if (document.getElementById('col-picker-global-css')) return
  const s = document.createElement('style')
  s.id = 'col-picker-global-css'
  s.textContent = `
.col-picker-wrap { position: relative; }
.col-picker-dropdown {
  display: none; position: absolute; right: 0; top: calc(100% + 4px);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 8px 0; z-index: 200;
  min-width: 200px; max-height: 400px; overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.col-picker-dropdown label {
  display: flex; align-items: center; gap: 8px; padding: 4px 12px;
  cursor: pointer; font-size: 0.85rem; white-space: nowrap; user-select: none;
}
.col-picker-dropdown label:hover { color: var(--accent); }
.col-picker-section-heading {
  font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--text-muted); padding: 8px 12px 4px;
  border-top: 1px solid var(--border); margin-top: 4px;
}
.col-picker-section-heading:first-child { border-top: none; margin-top: 0; padding-top: 4px; }
`
  document.head.appendChild(s)
}

// ── Init ───────────────────────────────────────────────────────────

export function initColumnPicker(opts: ColumnPickerOptions): ColumnPicker {
  ensureGlobalStyles()

  let groups = opts.groups
  let allColKeys: string[] = flatKeys(groups)

  // Load saved preference or use defaults
  let visibleCols: Set<string> = loadSaved(opts.storageKey, allColKeys, opts.defaultVisible)

  // ── Apply visibility CSS ─────────────────────────────────────────
  function applyVisibility() {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = allColKeys
      .filter(k => !visibleCols.has(k))
      .map(k => `.fm-table .col-${CSS.escape(k)} { display: none; }`)
      .join('\n')
  }

  // ── Render dropdown ──────────────────────────────────────────────
  function renderDropdown() {
    const dropdown = document.getElementById(opts.dropdownId)
    if (!dropdown) return
    const frag = document.createDocumentFragment()

    groups.forEach(group => {
      if (group.heading && group.columns.length > 0) {
        const heading = document.createElement('div')
        heading.className = 'col-picker-section-heading'
        heading.textContent = group.heading
        frag.appendChild(heading)
      }
      group.columns.forEach(c => {
        const lbl = document.createElement('label')
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.className = 'fm-checkbox'
        cb.dataset.col = c.key
        cb.checked = visibleCols.has(c.key)
        cb.addEventListener('change', () => {
          if (cb.checked) visibleCols.add(c.key)
          else visibleCols.delete(c.key)
          persist()
          applyVisibility()
          opts.onVisibilityChange?.()
        })
        lbl.appendChild(cb)
        lbl.append(' ' + c.label)
        frag.appendChild(lbl)
      })
    })

    // Reset button — resets visibility and optionally column order
    const resetDiv = document.createElement('div')
    resetDiv.style.cssText = 'border-top: 1px solid var(--border); margin-top: 6px; padding: 6px 12px 2px;'
    const resetBtn = document.createElement('button')
    resetBtn.className = 'fm-btn fm-btn-outline'
    resetBtn.style.cssText = 'width: 100%; font-size: 0.8rem; padding: 4px 8px;'
    resetBtn.textContent = opts.resetLabel || 'Reset columns'
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Reset visibility
      localStorage.removeItem(opts.storageKey)
      visibleCols = new Set(opts.defaultVisible)
      applyVisibility()
      // Reset column order
      if (opts.orderStorageKey) {
        localStorage.removeItem(opts.orderStorageKey)
      }
      // Reset column widths
      if (opts.widthsStorageKey) {
        localStorage.removeItem(opts.widthsStorageKey)
      }
      opts.onReset?.()
      opts.onResetWidths?.()
      opts.onVisibilityChange?.()
      renderDropdown() // re-render checkboxes
    })
    resetDiv.appendChild(resetBtn)
    frag.appendChild(resetDiv)

    dropdown.textContent = ''
    dropdown.appendChild(frag)
  }

  // ── Persist ──────────────────────────────────────────────────────
  function persist() {
    localStorage.setItem(opts.storageKey, JSON.stringify([...visibleCols]))
  }

  // ── Wire up button & click-outside ───────────────────────────────
  const btn = document.getElementById(opts.btnId)
  const dropdown = document.getElementById(opts.dropdownId)

  btn?.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!dropdown) return
    if (dropdown.style.display === 'block') {
      dropdown.style.display = 'none'
    } else {
      renderDropdown()
      dropdown.style.display = 'block'
    }
  })

  document.addEventListener('click', () => {
    if (dropdown) dropdown.style.display = 'none'
  })

  dropdown?.addEventListener('click', e => e.stopPropagation())

  // Apply on init
  applyVisibility()

  // ── Public API ───────────────────────────────────────────────────
  return {
    isVisible: (key: string) => visibleCols.has(key),
    updateGroups: (newGroups: ColumnGroup[]) => {
      groups = newGroups
      allColKeys = flatKeys(groups)
      // Reload saved; new keys that weren't in the old save stay hidden (opt-in)
      visibleCols = loadSaved(opts.storageKey, allColKeys, opts.defaultVisible)
      applyVisibility()
    },
    applyVisibility,
    getVisibleKeys: () => new Set(visibleCols),
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function flatKeys(groups: ColumnGroup[]): string[] {
  return groups.flatMap(g => g.columns.map(c => c.key))
}

/**
 * Load saved column visibility from localStorage.
 * - If a saved value exists, use it.
 * - Otherwise use defaultVisible.
 */
function loadSaved(storageKey: string, _allKeys: string[], defaultVisible: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) return new Set(parsed)
    }
  } catch { /* ignore */ }
  return new Set(defaultVisible)
}
