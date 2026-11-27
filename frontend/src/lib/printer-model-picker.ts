/**
 * Druckermodell-Auswahl: Liste der FilaMan-DB, Suche und Fuzzy-Vorschläge
 * ("Meinten Sie …?") für Freitext-Eingaben.
 */

import { request } from './api'
import { fuzzyTokenScore } from './filamentdb-lookup'

export interface PrinterModelItem {
  id: number
  manufacturer: string
  model: string
  default_nozzle_mm?: number | null
}

export interface PrinterModelList {
  available: boolean
  items: PrinterModelItem[]
}

export const PRINTER_MODEL_SUGGEST_THRESHOLD = 0.6

export function printerModelLabel(item: { manufacturer?: string | null; model?: string | null }): string {
  return [item.manufacturer, item.model].filter(Boolean).join(' ').trim()
}

/** Lädt die Modellliste; ohne Plugin oder bei Fehlern kommt eine leere Liste. */
export async function fetchPrinterModels(): Promise<PrinterModelList> {
  try {
    const data = await request<PrinterModelList>('/filamentdb/printer-models')
    if (!data || data.available !== true || !Array.isArray(data.items)) return { available: false, items: [] }
    return { available: data.items.length > 0, items: data.items }
  } catch {
    return { available: false, items: [] }
  }
}

/** Einfache Teilstring-Suche über Hersteller + Modell (alle Wörter müssen vorkommen). */
export function filterPrinterModels(items: PrinterModelItem[], query: string, limit = 12): PrinterModelItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return items.slice(0, limit)
  return items
    .filter(item => {
      const label = printerModelLabel(item).toLowerCase()
      return words.every(word => label.includes(word))
    })
    .slice(0, limit)
}

/**
 * Vorschläge für frei getippte Hersteller/Modell-Angaben, beste zuerst.
 * Leere Eingabe liefert nichts.
 */
export function suggestPrinterModels(
  items: PrinterModelItem[],
  manufacturer: string,
  model: string,
  limit = 3,
  threshold = PRINTER_MODEL_SUGGEST_THRESHOLD,
): PrinterModelItem[] {
  const typed = [manufacturer, model].join(' ').trim()
  if (!model.trim() && !manufacturer.trim()) return []
  return items
    .map(item => ({ item, score: fuzzyTokenScore(typed, printerModelLabel(item)) }))
    .filter(entry => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.item)
}

export interface PrinterModelValue {
  id: number | null
  manufacturer: string
  model: string
}

export interface PrinterModelPickerElements {
  idInput: HTMLInputElement
  searchWrap: HTMLElement
  searchInput: HTMLInputElement
  results: HTMLElement
  manufacturer: HTMLInputElement
  model: HTMLInputElement
  suggest: HTMLElement
}

export interface PrinterModelPickerDeps {
  t: (key: string) => string
  escapeHtml: (text: string) => string
  /** Wird nach asynchronem Laden und in Timern geprüft (z. B. Panel-Abbruch). */
  isAborted?: () => boolean
  loadModels?: () => Promise<PrinterModelList>
  /** Nach jeder Änderung des Werts (Auswahl, Tippen, setValue). */
  onChange?: (value: PrinterModelValue) => void
}

export interface PrinterModelPicker {
  setValue: (value: Partial<PrinterModelValue> | null | undefined) => void
  getValue: () => PrinterModelValue
  ensureModels: () => Promise<void>
}

/** Markup für Suche, Freitextfelder und Vorschläge; IDs beginnen mit `prefix`. */
export function renderPrinterModelFields(
  prefix: string,
  deps: { t: (key: string) => string; escapeHtml: (text: string) => string },
): string {
  const e = (key: string) => deps.escapeHtml(deps.t(key))
  return `<div class="printer-model-field">
    <input type="hidden" id="${prefix}-model-id" />
    <div id="${prefix}-model-search-wrap" class="hidden">
      <label for="${prefix}-model-search" class="fm-label">${e('printers.modelSearch')}</label>
      <input type="search" id="${prefix}-model-search" class="fm-input" autocomplete="off" placeholder="${e('printers.modelSearchPlaceholder')}" />
      <ul id="${prefix}-model-results" class="printer-model-results hidden" role="listbox"></ul>
      <p class="printer-model-hint">${e('printers.modelNotListedHint')}</p>
    </div>
    <div class="printer-model-row">
      <div><label for="${prefix}-manufacturer" class="fm-label">${e('printers.printerManufacturer')} *</label>
        <input type="text" id="${prefix}-manufacturer" class="fm-input" maxlength="255" autocomplete="off" /></div>
      <div><label for="${prefix}-model" class="fm-label">${e('printers.printerModel')} *</label>
        <input type="text" id="${prefix}-model" class="fm-input" maxlength="255" autocomplete="off" /></div>
    </div>
    <div id="${prefix}-model-suggest" class="printer-model-suggest hidden" role="status"></div>
  </div>`
}

/** Sucht die Elemente zu `renderPrinterModelFields(prefix)` unterhalb von `root`. */
export function findPrinterModelElements(root: ParentNode, prefix: string): PrinterModelPickerElements | null {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${prefix}-${id}`)
  const idInput = get<HTMLInputElement>('model-id')
  const searchWrap = get('model-search-wrap')
  const searchInput = get<HTMLInputElement>('model-search')
  const results = get('model-results')
  const manufacturer = get<HTMLInputElement>('manufacturer')
  const model = get<HTMLInputElement>('model')
  const suggest = get('model-suggest')
  if (!idInput || !searchWrap || !searchInput || !results || !manufacturer || !model || !suggest) return null
  return { idInput, searchWrap, searchInput, results, manufacturer, model, suggest }
}

/** Verdrahtet Suche, Freitext und "Meinten Sie …?" auf bestehenden Elementen. */
export function createPrinterModelPicker(
  els: PrinterModelPickerElements,
  deps: PrinterModelPickerDeps,
): PrinterModelPicker {
  let models: PrinterModelItem[] = []
  let loaded = false
  const aborted = () => deps.isAborted?.() ?? false

  const getValue = (): PrinterModelValue => ({
    id: els.idInput.value ? Number(els.idInput.value) : null,
    manufacturer: els.manufacturer.value.trim(),
    model: els.model.value.trim(),
  })
  const changed = () => deps.onChange?.(getValue())

  async function ensureModels() {
    if (loaded) return
    loaded = true
    const list = await (deps.loadModels ?? fetchPrinterModels)()
    if (aborted()) return
    models = list.items
    els.searchWrap.classList.toggle('hidden', !list.available)
  }

  function apply(item: PrinterModelItem) {
    els.idInput.value = String(item.id)
    els.manufacturer.value = item.manufacturer
    els.model.value = item.model
    els.searchInput.value = ''
    els.results.classList.add('hidden')
    els.suggest.classList.add('hidden')
    changed()
  }

  function renderResults() {
    const matches = filterPrinterModels(models, els.searchInput.value)
    els.results.innerHTML = matches
      .map(item => `<li role="option" tabindex="0" data-model-id="${item.id}">${deps.escapeHtml(printerModelLabel(item))}</li>`)
      .join('')
    els.results.classList.toggle('hidden', matches.length === 0)
  }

  function pick(event: Event) {
    const li = (event.target as HTMLElement).closest('li[data-model-id]') as HTMLElement | null
    const item = li ? models.find(entry => String(entry.id) === li.dataset.modelId) : undefined
    if (item) apply(item)
  }

  function showSuggestions() {
    if (aborted() || els.idInput.value) return
    const suggestions = suggestPrinterModels(models, els.manufacturer.value, els.model.value)
    if (suggestions.length === 0) { els.suggest.classList.add('hidden'); return }
    els.suggest.innerHTML = `<span>${deps.escapeHtml(deps.t('printers.modelDidYouMean'))}</span> ` + suggestions
      .map(item => `<button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-model-id="${item.id}">${deps.escapeHtml(printerModelLabel(item))}</button>`)
      .join(' ')
    els.suggest.classList.remove('hidden')
  }

  els.searchInput.addEventListener('input', renderResults)
  els.searchInput.addEventListener('focus', renderResults)
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault()
  })
  els.results.addEventListener('click', pick)
  els.results.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); pick(event) }
  })

  // Freitext: Verknüpfung zur Listen-ID lösen, sobald von Hand geändert wird.
  for (const input of [els.manufacturer, els.model]) {
    input.addEventListener('input', () => {
      els.idInput.value = ''
      els.suggest.classList.add('hidden')
      changed()
    })
    // Kurz warten, damit ein Klick auf einen Vorschlag nicht verloren geht.
    input.addEventListener('blur', () => { window.setTimeout(showSuggestions, 150) })
  }

  els.suggest.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button[data-model-id]') as HTMLElement | null
    const item = button ? models.find(entry => String(entry.id) === button.dataset.modelId) : undefined
    if (item) apply(item)
  })

  function setValue(value: Partial<PrinterModelValue> | null | undefined) {
    els.idInput.value = value?.id != null ? String(value.id) : ''
    els.manufacturer.value = value?.manufacturer ?? ''
    els.model.value = value?.model ?? ''
    els.searchInput.value = ''
    els.results.classList.add('hidden')
    els.suggest.classList.add('hidden')
    void ensureModels()
    changed()
  }

  return { setValue, getValue, ensureModels }
}
