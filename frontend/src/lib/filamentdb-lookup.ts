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

// ── Plugin status check (cached) ────────────────────────────────────

let _pluginActiveCache: boolean | null = null
let _pluginActivePromise: Promise<boolean> | null = null

/**
 * Check whether the FilamentDB plugin is active.
 * Result is cached for the lifetime of the page.
 */
export async function checkFilamentDbActive(): Promise<boolean> {
  if (_pluginActiveCache !== null) return _pluginActiveCache
  if (_pluginActivePromise) return _pluginActivePromise

  _pluginActivePromise = (async () => {
    try {
      const data = await request<{ active: boolean }>('/filamentdb/status')
      _pluginActiveCache = data.active
      return _pluginActiveCache
    } catch {
      _pluginActiveCache = false
      return false
    }
  })()

  return _pluginActivePromise
}

// ── Fuzzy token matching ────────────────────────────────────────────

const _SYNONYMS: Record<string, string> = { '+': 'plus' }

function _normalize(name: string): string {
  let s = name.toLowerCase().trim()
  s = s.replace(/[()[\]{}<>]/g, ' ')
  s = s.replace(/[_,\-/]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function _tokenize(name: string): Set<string> {
  const tokens = new Set<string>()
  for (const tok of _normalize(name).split(' ')) {
    if (tok) tokens.add(_SYNONYMS[tok] ?? tok)
  }
  return tokens
}

/**
 * Compute a fuzzy token-overlap score between two strings.
 * Uses the same algorithm as the backend import service:
 * normalize → tokenize → symmetric max(|A∩B|/|A|, |A∩B|/|B|).
 *
 * Returns a value between 0.0 (no overlap) and 1.0 (perfect match).
 */
export function fuzzyTokenScore(a: string, b: string): number {
  const tokensA = _tokenize(a)
  const tokensB = _tokenize(b)
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let overlap = 0
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++
  }
  return Math.max(overlap / tokensA.size, overlap / tokensB.size)
}

// ── Lookup component ────────────────────────────────────────────────

export interface LookupOptions<T = unknown> {
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
  extractItems?: (response: unknown) => T[]
  /** Minimum characters to trigger search (default: 2) */
  minChars?: number
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number
  /** Additional query params */
  extraParams?: Record<string, string | number>
  /** Initial search query — triggers a search immediately after creation */
  initialQuery?: string
  /**
   * Fuzzy scoring function. When provided, results are sorted by score
   * (descending) and the best match (score >= 0.75) is visually highlighted.
   */
  fuzzyScore?: (item: T) => number
}

export interface LookupInstance {
  /** Destroy the lookup and clean up event listeners */
  destroy: () => void
  /** Reset to initial state */
  reset: () => void
  /** Programmatically trigger a search */
  search: (query: string) => void
}

export function createFilamentDbLookup<T = unknown>(opts: LookupOptions<T>): LookupInstance {
  const {
    container,
    endpoint,
    placeholder = '',
    renderItem,
    onSelect,
    extractItems = (r: unknown) => {
      if (r && typeof r === 'object' && 'items' in r) {
        const withItems = r as { items?: T[] }
        return withItems.items ?? []
      }
      return Array.isArray(r) ? (r as T[]) : []
    },
    minChars = 2,
    debounceMs = 300,
    extraParams = {},
    initialQuery,
    fuzzyScore,
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
  const resultsEl = wrapper.querySelector<HTMLElement>('.fdb-lookup-results')!
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
    if (query) {
      params.set('search', query)
    }
    params.set('page_size', '20')
    for (const [k, v] of Object.entries(extraParams)) {
      params.set(k, String(v))
    }

    try {
      const data = await request<unknown>(`${endpoint}?${params.toString()}`)
      let items = extractItems(data)

      // Sort by fuzzy score if a scoring function is provided
      if (fuzzyScore && items.length > 0) {
        const scored = items.map(item => ({ item, score: fuzzyScore(item) }))
        scored.sort((a, b) => b.score - a.score)
        items = scored.map((s: { item: T; score: number }) => s.item)
        currentItems = items

        // Find best match index (score >= 0.75)
        const bestScore = scored[0].score
        const bestIdx = bestScore >= 0.75 ? 0 : -1

        resultsEl.innerHTML = items
          .map((item: T, idx: number) => {
            const cls = idx === bestIdx ? 'fdb-lookup-item fdb-lookup-item--best-match' : 'fdb-lookup-item'
            return `<div class="${cls}" data-index="${idx}">${renderItem(item)}</div>`
          })
          .join('')
      } else {
        currentItems = items

        if (items.length === 0) {
          resultsEl.innerHTML = `<div class="fdb-lookup-empty">${t('filamentdbLookup.noResults')}</div>`
        } else {
          resultsEl.innerHTML = items
            .map((item: T, idx: number) => `<div class="fdb-lookup-item" data-index="${idx}">${renderItem(item)}</div>`)
            .join('')
        }
      }

      dropdown.style.display = ''
    } catch (err: unknown) {
      const maybeAbortError = err as { name?: string }
      if (maybeAbortError?.name === 'AbortError') return
      resultsEl.innerHTML = `<div class="fdb-lookup-empty">${t('filamentdbLookup.connectionError')}</div>`
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

  function onFocus() {
    // When minChars is 0 and dropdown is not visible, auto-load results on focus
    if (minChars === 0 && dropdown.style.display === 'none' && currentItems.length === 0) {
      doSearch(input.value.trim())
    }
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
  input.addEventListener('focus', onFocus)
  resultsEl.addEventListener('click', onResultClick)
  document.addEventListener('click', onClickOutside)
  input.addEventListener('keydown', onKeydown)

  // ── Initial search ─────────────────────────────────────────────

  if (initialQuery) {
    input.value = initialQuery
    // Small delay to let the DOM settle
    setTimeout(() => doSearch(initialQuery), 50)
  }

  // ── Public API ─────────────────────────────────────────────────

  function destroy() {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (abortController) abortController.abort()
    input.removeEventListener('input', onInput)
    input.removeEventListener('focus', onFocus)
    resultsEl.removeEventListener('click', onResultClick)
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

  function search(query: string) {
    input.value = query
    doSearch(query)
  }

  return { destroy, reset, search }
}
