/**
 * Massenabgleich „Mit FilaMan-DB abgleichen“ (Hersteller- und Filamentliste):
 * unverknüpfte Objekte prüfen, Treffer wählen, Auswahl nacheinander übernehmen.
 * Gegenstück: POST /filamentdb/contributions/bulk-candidates und bulk-check (filamentdb_contributions.py);
 * geprüft wird in Paketen à BULK_BATCH_SIZE, die nacheinander abgerufen werden.
 */

import { ApiError, api } from './api'
import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { t } from './i18n'
import { progressBarHtml, updateProgressBar } from './progress-bar'
import { contribErrorMessage, createDialog, matchScoreBadge, type ContribMatch } from './filamentdb-contrib'

export type BulkMatchType = 'manufacturer' | 'filament'
export type BulkCategory = 'linked' | 'suggested' | 'none' | 'blocked'

export interface BulkMatchItem {
  local_id: number
  label: string
  category: BulkCategory
  matches: ContribMatch[]
  blockers: { code: string; message: string }[]
  linked_remote_id?: number
}

export interface BulkCheckResponse {
  type: BulkMatchType
  items: BulkMatchItem[]
  counts: Record<BulkCategory, number>
  total: number
}

export interface BulkCandidatesResponse {
  type: BulkMatchType
  ids: number[]
  total: number
}

export const BULK_BATCH_SIZE = 20

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export function emptyResponse(type: BulkMatchType): BulkCheckResponse {
  return { type, items: [], counts: { linked: 0, suggested: 0, none: 0, blocked: 0 }, total: 0 }
}

/** Paket-Antwort in die Gesamtantwort einarbeiten (Zähler addieren, Items anhängen). */
export function mergeResponses(into: BulkCheckResponse, part: BulkCheckResponse): BulkCheckResponse {
  const counts = { ...into.counts }
  for (const category of Object.keys(counts) as BulkCategory[]) counts[category] += part.counts[category] ?? 0
  return { type: into.type, items: [...into.items, ...part.items], counts, total: into.total + part.total }
}

export interface BulkRunResult {
  response: BulkCheckResponse
  /** Anzahl bereits abgearbeiteter Kandidaten (auch übersprungene). */
  checked: number
  candidateTotal: number
  /** true, wenn nicht alle Pakete geprüft wurden (Abbruch oder Fehler). */
  incomplete: boolean
  cancelled: boolean
  error?: unknown
}

function isTokenError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'filamentdb_token_invalid'
}

/**
 * Kandidaten holen, in Pakete teilen und nacheinander prüfen.
 * Ein fehlgeschlagenes Paket wird einmal wiederholt, danach bricht der Lauf mit den bisherigen
 * Ergebnissen ab; Token-Fehler brechen sofort ab. ``isCancelled`` wird vor jedem Paket geprüft.
 * Ein Fehler beim Holen der Kandidaten wird geworfen (noch nichts geprüft).
 */
export async function runBulkCheck(
  type: BulkMatchType,
  autoLink: boolean,
  options: { isCancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BulkRunResult> {
  const candidates = await api.post<BulkCandidatesResponse>('/filamentdb/contributions/bulk-candidates', { type })
  const total = candidates.ids.length
  let response = emptyResponse(type)
  let checked = 0
  const result = (extra: Partial<BulkRunResult>): BulkRunResult => ({
    response, checked, candidateTotal: total, incomplete: checked < total, cancelled: false, ...extra,
  })
  options.onProgress?.(0, total)
  for (const ids of chunk(candidates.ids, BULK_BATCH_SIZE)) {
    if (options.isCancelled?.()) return result({ cancelled: true })
    let part: BulkCheckResponse | null = null
    let lastError: unknown
    for (let attempt = 0; attempt < 2 && !part; attempt++) {
      try {
        part = await api.post<BulkCheckResponse>('/filamentdb/contributions/bulk-check', { type, auto_link_exact: autoLink, ids })
      } catch (error) {
        lastError = error
        if (isTokenError(error)) break
      }
    }
    if (!part) return result({ error: lastError })
    response = mergeResponses(response, part)
    checked += ids.length
    options.onProgress?.(checked, total)
  }
  return result({ incomplete: false })
}

/** Auswahl je Zeile: eine Treffer-ID oder 'new' (neu einreichen). */
export type BulkChoice = number | 'new'

export interface BulkSelection {
  checked: Set<number>
  choice: Map<number, BulkChoice>
}

export interface BulkAction {
  local_id: number
  action: 'link' | 'submit'
  match_id?: number
  shown_matches: { type?: string; id: number; score?: number }[]
}

export function sortMatches(matches: ContribMatch[]): ContribMatch[] {
  return [...matches].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

export function groupItems(items: BulkMatchItem[]): Record<BulkCategory, BulkMatchItem[]> {
  const groups: Record<BulkCategory, BulkMatchItem[]> = { linked: [], suggested: [], none: [], blocked: [] }
  for (const item of items) groups[item.category].push(item)
  return groups
}

/** Vorschläge sind mit dem besten Treffer vorausgewählt; „nichts gefunden“ muss bewusst angehakt werden. */
export function defaultSelection(items: BulkMatchItem[]): BulkSelection {
  const selection: BulkSelection = { checked: new Set(), choice: new Map() }
  for (const item of items) {
    if (item.category === 'suggested' && item.matches.length) {
      selection.checked.add(item.local_id)
      selection.choice.set(item.local_id, sortMatches(item.matches)[0].id)
    } else if (item.category === 'none') {
      selection.choice.set(item.local_id, 'new')
    }
  }
  return selection
}

/** Auswahl in die Aufrufe von /contributions/submit übersetzen (nur angehakte, nicht blockierte Zeilen). */
export function planApply(items: BulkMatchItem[], selection: BulkSelection): BulkAction[] {
  const actions: BulkAction[] = []
  for (const item of items) {
    if (!selection.checked.has(item.local_id)) continue
    if (item.category !== 'suggested' && item.category !== 'none') continue
    const shown = sortMatches(item.matches).map(m => ({ type: m.type, id: m.id, score: m.score }))
    const choice = selection.choice.get(item.local_id) ?? (item.category === 'none' ? 'new' : undefined)
    if (typeof choice === 'number' && item.matches.some(m => m.id === choice)) {
      actions.push({ local_id: item.local_id, action: 'link', match_id: choice, shown_matches: shown })
    } else if (choice === 'new') {
      actions.push({ local_id: item.local_id, action: 'submit', shown_matches: shown })
    }
  }
  return actions
}

export interface ApplyResult {
  done: number[]
  failed: { local_id: number; message: string }[]
  notSent: number[]
}

/** Nacheinander abarbeiten; Fehler je Zeile sammeln, bei Tageslimit oder ungültigem Token abbrechen. */
export async function runApply(
  type: BulkMatchType,
  actions: BulkAction[],
  onProgress?: (done: number, total: number) => void,
): Promise<ApplyResult> {
  const result: ApplyResult = { done: [], failed: [], notSent: [] }
  let aborted = false
  for (const [index, action] of actions.entries()) {
    if (aborted) { result.notSent.push(action.local_id); continue }
    onProgress?.(index, actions.length)
    try {
      await api.post('/filamentdb/contributions/submit', {
        type,
        local_id: action.local_id,
        action: action.action,
        match_id: action.match_id,
        shown_matches: action.shown_matches,
      })
      result.done.push(action.local_id)
    } catch (error) {
      result.failed.push({ local_id: action.local_id, message: contribErrorMessage(error) })
      if (error instanceof ApiError && (error.code === 'daily_limit_reached' || error.code === 'filamentdb_token_invalid')) aborted = true
    }
  }
  return result
}

const e = escapeHtml

function sectionHeader(category: BulkCategory, count: number, selectable: boolean): string {
  const tools = selectable
    ? `<span class="fdb-bm-tools"><button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-bm-all="${category}">${e(t('fdbContrib.bulkMatchSelectAll'))}</button> <button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-bm-nothing="${category}">${e(t('fdbContrib.bulkMatchSelectNone'))}</button></span>`
    : ''
  return `<div class="fdb-bm-head"><h3>${e(t(`fdbContrib.bulkMatch.${category}`, { count }))}</h3>${tools}</div><p class="fm-field-hint">${e(t(`fdbContrib.bulkMatch.${category}Hint`))}</p>`
}

function renderRow(item: BulkMatchItem, selection: BulkSelection): string {
  const checked = selection.checked.has(item.local_id) ? ' checked' : ''
  const name = `bm-choice-${item.local_id}`
  const current = selection.choice.get(item.local_id)
  const radios = sortMatches(item.matches).map(m => `<label class="fdb-bm-option"><input type="radio" name="${name}" value="${Number(m.id)}" data-bm-choice="${item.local_id}"${current === m.id ? ' checked' : ''}> <span>${e(m.label ?? `#${m.id}`)}</span> ${matchScoreBadge(m.score)}</label>`).join('')
  const newOption = item.category === 'suggested'
    ? `<label class="fdb-bm-option"><input type="radio" name="${name}" value="new" data-bm-choice="${item.local_id}"${current === 'new' ? ' checked' : ''}> <span>${e(t('fdbContrib.bulkMatchNoneOfThese'))}</span></label>`
    : ''
  return `<li class="fdb-bm-row" data-bm-row="${item.local_id}"><label class="fdb-bm-name"><input type="checkbox" data-bm-check="${item.local_id}"${checked}> <strong>${e(item.label)}</strong></label>${radios || newOption ? `<div class="fdb-bm-options">${radios}${newOption}</div>` : ''}</li>`
}

export function renderResult(response: BulkCheckResponse, selection: BulkSelection): string {
  const groups = groupItems(response.items)
  const parts: string[] = []
  if (!response.total) return `<p class="fm-field-hint" role="status">${e(t('fdbContrib.bulkMatchNothing'))}</p>`
  if (groups.linked.length) {
    parts.push(`<section class="fdb-bm-section" data-bm-section="linked">${sectionHeader('linked', groups.linked.length, false)}<ul>${groups.linked.map(i => `<li>${e(i.label)}${i.matches[0]?.label ? ` <span class="fm-field-hint">→ ${e(i.matches[0].label)}</span>` : ''}</li>`).join('')}</ul></section>`)
  }
  for (const category of ['suggested', 'none'] as const) {
    if (!groups[category].length) continue
    parts.push(`<section class="fdb-bm-section" data-bm-section="${category}">${sectionHeader(category, groups[category].length, true)}<ul class="fdb-bm-list">${groups[category].map(i => renderRow(i, selection)).join('')}</ul></section>`)
  }
  if (groups.blocked.length) {
    const rows = groups.blocked.map(i => `<li><strong>${e(i.label)}</strong>: <span class="fm-field-hint">${e(i.blockers.map(b => t(`fdbContrib.blockers.${b.code}`) === `fdbContrib.blockers.${b.code}` ? b.message : t(`fdbContrib.blockers.${b.code}`)).join('; '))}</span></li>`).join('')
    parts.push(`<section class="fdb-bm-section" data-bm-section="blocked">${sectionHeader('blocked', groups.blocked.length, false)}<ul>${rows}</ul></section>`)
  }
  return parts.join('')
}

export interface BulkMatchOptions {
  type: BulkMatchType
  onDone?: () => void
}

export async function openBulkMatchDialog(options: BulkMatchOptions): Promise<void> {
  const dialog = createDialog()
  dialog.classList.add('fdb-bulk-match')
  if (options.type === 'manufacturer') dialog.dataset.handbook = 'manufacturerBulkMatch'
  const body = dialog.querySelector('[data-fdb-body]') as HTMLElement
  const submit = dialog.querySelector('[data-fdb-submit]') as HTMLButtonElement
  const closeButton = dialog.querySelector('[data-dialog-close]') as HTMLButtonElement
  ;(dialog.querySelector('#fdb-contrib-title') as HTMLElement).textContent = `${t('fdbContrib.bulkMatchTitle')}: ${t(`fdbContrib.types.${options.type}`)}`
  closeButton.textContent = t('fdbContrib.close')
  const controller = bindFormDialog(dialog)
  let changed = false
  dialog.addEventListener('close', () => { if (changed) options.onDone?.() })

  body.innerHTML = `<p class="fm-field-hint">${e(t('fdbContrib.bulkMatchIntro'))}</p>
    <label class="fdb-bm-auto"><input type="checkbox" data-bm-auto checked> ${e(t('fdbContrib.bulkMatchAutoLink'))}</label>`
  submit.textContent = t('fdbContrib.bulkMatchStart')
  submit.classList.remove('hidden')
  controller.open()

  let response: BulkCheckResponse | null = null
  let selection: BulkSelection = { checked: new Set(), choice: new Map() }

  function updateApplyButton() {
    const count = response ? planApply(response.items, selection).length : 0
    submit.textContent = t('fdbContrib.bulkMatchApply', { count })
    submit.disabled = count === 0
  }

  function showResult(notes = '') {
    if (!response) return
    body.innerHTML = `${notes}<p role="status"><strong>${e(t('fdbContrib.bulkMatchSummary', { ...response.counts, total: response.total }))}</strong></p>${renderResult(response, selection)}`
    if (response.counts.linked) changed = true
    const actionable = response.counts.suggested + response.counts.none
    submit.classList.toggle('hidden', actionable === 0)
    submit.removeEventListener('click', onStart)
    submit.addEventListener('click', onApply)
    updateApplyButton()
  }

  let cancelRequested = false

  async function onStart() {
    const auto = (body.querySelector('[data-bm-auto]') as HTMLInputElement | null)?.checked ?? false
    submit.classList.add('hidden')
    cancelRequested = false
    const showProgress = (done: number, total: number) => {
      const label = total ? t('fdbContrib.bulkMatch.progress', { done, total }) : t('fdbContrib.bulkMatchRunning')
      if (updateProgressBar(body, done, total, label)) return
      body.innerHTML = `${progressBarHtml(done, total, label)}
        <button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-bm-cancel>${e(t('fdbContrib.bulkMatch.cancel'))}</button>`
    }
    showProgress(0, 0)
    let run: BulkRunResult
    try {
      run = await runBulkCheck(options.type, auto, { isCancelled: () => cancelRequested, onProgress: showProgress })
    } catch (error) {
      body.innerHTML = `<div class="fm-alert-error" role="alert">${e(contribErrorMessage(error))}</div>`
      submit.classList.remove('hidden')
      return
    }
    if (!run.candidateTotal) {
      body.innerHTML = `<p class="fm-field-hint" role="status">${e(t('fdbContrib.bulkMatch.allLinked'))}</p>`
      return
    }
    response = run.response
    selection = defaultSelection(response.items)
    const notes: string[] = []
    if (run.error) notes.push(`<div class="fm-alert-error" role="alert">${e(t('fdbContrib.bulkMatch.failed', { message: contribErrorMessage(run.error) }))}</div>`)
    if (run.incomplete) notes.push(`<div class="fm-alert-info" role="status">${e(t('fdbContrib.bulkMatch.incomplete', { done: run.checked, total: run.candidateTotal }))}</div>`)
    showResult(notes.join(''))
  }

  async function onApply() {
    if (!response) return
    const actions = planApply(response.items, selection)
    if (!actions.length) return
    submit.classList.add('hidden')
    const progress = (done: number, total: number) => {
      const label = t('fdbContrib.bulkMatchProgress', { done, total })
      if (!updateProgressBar(body, done, total, label)) body.innerHTML = progressBarHtml(done, total, label)
    }
    progress(0, actions.length)
    const result = await runApply(options.type, actions, progress)
    if (result.done.length) changed = true
    const labels = new Map(response.items.map(i => [i.local_id, i.label]))
    const name = (id: number) => e(labels.get(id) ?? `#${id}`)
    const lines = (list: string[]) => `<ul>${list.map(x => `<li>${x}</li>`).join('')}</ul>`
    body.innerHTML = `<p role="status"><strong>${e(t('fdbContrib.bulkMatchDone', { done: result.done.length, failed: result.failed.length + result.notSent.length }))}</strong></p>`
      + (result.failed.length ? `<div class="fm-alert-error" role="alert">${lines(result.failed.map(f => `${name(f.local_id)}: ${e(f.message)}`))}</div>` : '')
      + (result.notSent.length ? `<p class="fm-field-hint">${e(t('fdbContrib.bulkNotSent'))}</p>${lines(result.notSent.map(name))}` : '')
  }

  submit.addEventListener('click', onStart)

  body.addEventListener('click', event => {
    const target = event.target as HTMLElement
    if (target.closest('[data-bm-cancel]')) {
      cancelRequested = true
      const cancel = body.querySelector<HTMLButtonElement>('[data-bm-cancel]')
      if (cancel) cancel.disabled = true
      return
    }
    const all = target.closest<HTMLElement>('[data-bm-all]')
    const none = target.closest<HTMLElement>('[data-bm-nothing]')
    const button = all ?? none
    if (!button || !response) return
    const category = (all?.dataset.bmAll ?? none?.dataset.bmNothing) as BulkCategory
    for (const item of response.items.filter(i => i.category === category)) {
      if (all) selection.checked.add(item.local_id)
      else selection.checked.delete(item.local_id)
      const box = body.querySelector<HTMLInputElement>(`[data-bm-check="${item.local_id}"]`)
      if (box) box.checked = Boolean(all)
    }
    updateApplyButton()
  })
  body.addEventListener('change', event => {
    const target = event.target as HTMLInputElement
    if (target.dataset.bmCheck) {
      const id = Number(target.dataset.bmCheck)
      if (target.checked) selection.checked.add(id)
      else selection.checked.delete(id)
    } else if (target.dataset.bmChoice) {
      const id = Number(target.dataset.bmChoice)
      selection.choice.set(id, target.value === 'new' ? 'new' : Number(target.value))
      selection.checked.add(id)
      const box = body.querySelector<HTMLInputElement>(`[data-bm-check="${id}"]`)
      if (box) box.checked = true
    } else return
    updateApplyButton()
  })
}
