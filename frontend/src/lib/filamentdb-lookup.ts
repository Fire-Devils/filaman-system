/**
 * FilamentDB Lookup — reusable search dropdown for FilaManDB community database.
 *
 * Usage:
 *   import { createFilamentDbLookup } from '../lib/filamentdb-lookup'
 *   const lookup = createFilamentDbLookup({
 *     container: document.getElementById('lookup-container')!,
 *     endpoint: '/filamentdb/manufacturers',
 *     placeholder: t('filamentdbLookup.searchManufacturer'),
 *     renderItem: (item) => `<span>${item.name}</span>`,
 *     onSelect: (item) => { fillForm(item) },
 *   })
 */

import { request } from './api'
import { t } from './i18n'

export interface LookupOptions<T = any> {
  /** Container element to inject the dropdown into */
  container: HTMLElement
  /** API proxy endpoint path (e.g. '/filamentdb/manufacturers') */
  endpoint: string
  /** Placeholder text for the search input */
  placeholder?: string
  /** Render a single result item (return innerHTML) */
  renderItem: (item: T) => string
  /** Called when user selects an item */
  onSelect: (item: T) => void
  /** Extract items from response (default: response.items) */
  extractItems?: (response: any) => T[]
  /** Minimum characters to trigger search (default: 2) */
  minChars?: number
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number
  /** Additional query params */
  extraParams?: Record<string, string | number>
}

export interface LookupInstance {
  /** Destroy the lookup and clean up event listeners */
  destroy: () => void
  /** Reset to initial state */
  reset: () => void
}

export function createFilamentDbLookup<T = any>(opts: LookupOptions<T>): LookupInstance {
  const {
    container,
    endpoint,
    placeholder = '',
    renderItem,
    onSelect,
    extractItems = (r: any) => r.items ?? r ?? [],
    minChars = 2,
    debounceMs = 300,
    extraParams = {},
  } = opts

  // ── Build DOM ──────────────────────────────────────────────────

  const wrapper = document.createElement('div')
  wrapper.className = 'fdb-lookup'
  wrapper.innerHTML = `
    <div class="fdb-lookup-input-wrap">
      <input type="text" class="fm-input fdb-lookup-input" placeholder="${placeholder}" autocomplete="off" />
      <span class="fdb-lookup-spinner" style="display:none"></span>
    </div>
    <div class="fdb-lookup-dropdown" style="display:none">
      <div class="fdb-lookup-results"></div>
    </div>
    <div class="fdb-lookup-hint" style="display:none"></div>
  `
  container.appendChild(wrapper)

  const input = wrapper.querySelector<HTMLInputElement>('.fdb-lookup-input')!
  const spinner = wrapper.querySelector<HTMLElement>('.fdb-lookup-spinner')!
  const dropdown = wrapper.querySelector<HTMLElement>('.fdb-lookup-dropdown')!
  const results = wrapper.querySelector<HTMLElement>('.fdb-lookup-results')!
  const hint = wrapper.querySelector<HTMLElement>('.fdb-lookup-hint')!

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let abortController: AbortController | null = null
  let currentItems: T[] = []

  // ── Search logic ───────────────────────────────────────────────

  async function doSearch(query: string) {
    if (abortController) {
      abortController.abort()
    }
    abortController = new AbortController()

    spinner.style.display = ''
    hint.style.display = 'none'

    const params = new URLSearchParams()
    params.set('search', query)
    params.set('page_size', '20')
    for (const [k, v] of Object.entries(extraParams)) {
      params.set(k, String(v))
    }

    try {
      const data = await request<any>(`${endpoint}?${params.toString()}`)
      currentItems = extractItems(data)

      if (currentItems.length === 0) {
        results.innerHTML = `<div class="fdb-lookup-empty">${t('filamentdbLookup.noResults')}</div>`
      } else {
        results.innerHTML = currentItems
          .map((item, idx) => `<div class="fdb-lookup-item" data-index="${idx}">${renderItem(item)}</div>`)
          .join('')
      }

      dropdown.style.display = ''
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      results.innerHTML = `<div class="fdb-lookup-empty">${t('filamentdbLookup.connectionError')}</div>`
      dropdown.style.display = ''
    } finally {
      spinner.style.display = 'none'
    }
  }

  // ── Event handlers ─────────────────────────────────────────────

  function onInput() {
    const query = input.value.trim()
    if (debounceTimer) clearTimeout(debounceTimer)

    if (query.length < minChars) {
      dropdown.style.display = 'none'
      if (query.length > 0) {
        hint.textContent = t('filamentdbLookup.minChars')
        hint.style.display = ''
      } else {
        hint.style.display = 'none'
      }
      return
    }

    hint.style.display = 'none'
    debounceTimer = setTimeout(() => doSearch(query), debounceMs)
  }

  function onResultClick(e: Event) {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.fdb-lookup-item')
    if (!target) return
    const idx = parseInt(target.dataset.index ?? '-1', 10)
    if (idx >= 0 && idx < currentItems.length) {
      onSelect(currentItems[idx])
      dropdown.style.display = 'none'
      input.value = ''
    }
  }

  function onClickOutside(e: MouseEvent) {
    if (!wrapper.contains(e.target as Node)) {
      dropdown.style.display = 'none'
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      dropdown.style.display = 'none'
      input.blur()
    }
  }

  // ── Bind events ────────────────────────────────────────────────

  input.addEventListener('input', onInput)
  results.addEventListener('click', onResultClick)
  document.addEventListener('click', onClickOutside)
  input.addEventListener('keydown', onKeydown)

  // ── Public API ─────────────────────────────────────────────────

  function destroy() {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (abortController) abortController.abort()
    input.removeEventListener('input', onInput)
    results.removeEventListener('click', onResultClick)
    document.removeEventListener('click', onClickOutside)
    input.removeEventListener('keydown', onKeydown)
    wrapper.remove()
  }

  function reset() {
    input.value = ''
    dropdown.style.display = 'none'
    hint.style.display = 'none'
    currentItems = []
  }

  return { destroy, reset }
}
