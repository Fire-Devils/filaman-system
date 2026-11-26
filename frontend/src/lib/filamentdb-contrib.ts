/**
 * Beiträge an die FilaMan-DB: Status, Vorschau-Dialog, Fehlertexte.
 * Gegenstück: backend/app/api/v1/filamentdb_contributions.py
 */

import { ApiError, api } from './api'
import { getMe, hasPermission } from './auth'
import { escapeHtml } from './extra-fields'
import { FILAMENTDB_SITE_URL } from './filamentdb-lookup'
import { bindFormDialog } from './form-dialog'
import { t } from './i18n'

export type ContribType = 'manufacturer' | 'filament' | 'printer_model' | 'print_profile'

export interface ContribRef {
  id: number
  entity_type: ContribType
  local_id: number
  label: string | null
  status: string
  depends_on?: { entity_type: ContribType; local_id: number; label: string | null; status: string } | null
  remote_entity_id?: number | null
  last_error?: string | null
  last_checked_at?: string | null
}

export interface ContribMatch {
  type: string
  id: number
  label?: string
  score?: number
}

export interface ContribPreview {
  type: ContribType
  local_id: number
  mode: 'create' | 'edit' | 'update'
  payload: Record<string, unknown>
  matches: ContribMatch[]
  blockers: { code: string; message: string; field?: string; min?: number; max?: number }[]
  dependencies: { type: ContribType; local_id: number; label: string }[]
}

export interface ContribContext {
  /** Plugin aktiv, Token gespeichert und Recht filamentdb:contribute. */
  canContribute: boolean
  pluginActive: boolean
  tokenSaved: boolean
  /** Recht ist da, aber es fehlt ein Token: Hinweisbox mit Registrierungs-Link zeigen. */
  needsToken: boolean
}

let contextPromise: Promise<ContribContext> | null = null

export function resetContribContext() {
  contextPromise = null
}

export function loadContribContext(): Promise<ContribContext> {
  contextPromise ??= (async () => {
    const none: ContribContext = { canContribute: false, pluginActive: false, tokenSaved: false, needsToken: false }
    try {
      const user = await getMe()
      if (!user || !hasPermission(user, 'filamentdb:contribute')) return none
      const status = await api.get<{ plugin_active: boolean; token_saved: boolean }>('/filamentdb/contributions/status')
      return {
        pluginActive: status.plugin_active,
        tokenSaved: status.token_saved,
        canContribute: status.plugin_active && status.token_saved,
        needsToken: status.plugin_active && !status.token_saved,
      }
    } catch {
      return none
    }
  })()
  return contextPromise
}

export function statusText(entry: Pick<ContribRef, 'status' | 'depends_on'>): string {
  if (entry.status === 'waiting') {
    const type = entry.depends_on?.entity_type
    return t(`fdbContrib.waitingFor.${type ?? 'generic'}`)
  }
  return t(`fdbContrib.status.${entry.status}`)
}

export function statusBadge(entry: Pick<ContribRef, 'status' | 'depends_on'>): string {
  const tone = ['approved', 'published', 'linked'].includes(entry.status)
    ? 'success'
    : ['rejected', 'error'].includes(entry.status) ? 'error' : 'warning'
  return `<span class="fdb-status fdb-status-${tone}" data-fdb-status="${escapeHtml(entry.status)}">${escapeHtml(statusText(entry))}</span>`
}

export function noTokenNoticeHtml(): string {
  const link = `<a href="${FILAMENTDB_SITE_URL}" target="_blank" rel="noopener noreferrer">db.filaman.app</a>`
  return `<p class="fm-field-hint fm-db-hint" data-fdb-no-token>${t('fdbContrib.noToken', { link })}</p>`
}

export function contribErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = `fdbContrib.errors.${error.code}`
    const text = t(key, {
      field: String(error.detail?.field ?? ''),
      min: String(error.detail?.min ?? ''),
      max: String(error.detail?.max ?? ''),
    })
    if (text !== key) return text
    const blocker = `fdbContrib.blockers.${error.code}`
    const blockerText = t(blocker)
    if (blockerText !== blocker) return blockerText
    if (error.message) return error.message
  }
  return error instanceof Error && error.message ? error.message : t('fdbContrib.errors.generic')
}

export async function fetchContributions(type?: ContribType, localId?: number): Promise<ContribRef[]> {
  const params = new URLSearchParams()
  if (type) params.set('entity_type', type)
  if (localId) params.set('local_id', String(localId))
  const query = params.toString()
  const data = await api.get<{ items: ContribRef[] }>(`/filamentdb/contributions${query ? `?${query}` : ''}`)
  return data.items
}

export function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return t(value ? 'fdbContrib.yes' : 'fdbContrib.no')
  if (Array.isArray(value)) {
    return value.map(item => (item && typeof item === 'object'
      ? [(item as Record<string, unknown>).color_name, (item as Record<string, unknown>).hex_code].filter(Boolean).join(' ')
      : String(item))).join(', ')
  }
  return String(value)
}

function fieldLabel(key: string): string {
  for (const candidate of [`fdbContrib.fields.${key}`, `printProfiles.fields.${key}`]) {
    const text = t(candidate)
    if (text !== candidate) return text
  }
  return key
}

export function renderPreviewBody(preview: ContribPreview): string {
  const e = escapeHtml
  const parts: string[] = [`<p class="fm-field-hint">${e(t('fdbContrib.previewIntro'))}</p>`]
  if (preview.mode === 'edit') parts.push(`<p class="fm-field-hint">${e(t('fdbContrib.noteEdit'))}</p>`)
  if (preview.mode === 'update') parts.push(`<p class="fm-field-hint">${e(t('fdbContrib.noteUpdate'))}</p>`)

  if (preview.blockers.length) {
    const items = preview.blockers.map(b => {
      const key = `fdbContrib.blockers.${b.code}`
      let text = t(key) === key ? b.message : t(key)
      if (b.code === 'implausible_value') text = `${text}: ${fieldLabel(String(b.field ?? ''))} (${b.min} – ${b.max})`
      return `<li>${e(text)}</li>`
    }).join('')
    parts.push(`<div class="fm-alert-error" role="alert"><strong>${e(t('fdbContrib.blockersTitle'))}</strong><ul>${items}</ul></div>`)
  }

  if (preview.dependencies.length) {
    const items = preview.dependencies.map(d => `<li>${e(t(`fdbContrib.types.${d.type}`))}: ${e(d.label)}</li>`).join('')
    parts.push(`<div class="fdb-deps"><strong>${e(t('fdbContrib.dependenciesTitle'))}</strong><ul>${items}</ul><p class="fm-field-hint">${e(t('fdbContrib.dependenciesHint'))}</p></div>`)
  }

  if (preview.matches.length) {
    const items = preview.matches.map(m => `<li class="fdb-match"><span>${e(m.label ?? `#${m.id}`)}${m.score != null ? ` <small>${e(t('fdbContrib.matchScore', { score: Math.round(m.score * 100) }))}</small>` : ''}</span>
      <button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-fdb-link="${m.id}">${e(t('fdbContrib.thisIsIt'))}</button></li>`).join('')
    parts.push(`<div class="fdb-matches"><strong>${e(t('fdbContrib.matchesTitle'))}</strong><p class="fm-field-hint">${e(t('fdbContrib.matchesHint'))}</p><ul>${items}</ul></div>`)
  }

  const rows = Object.entries(preview.payload)
    .map(([key, value]) => `<div><dt>${e(fieldLabel(key))}</dt><dd>${e(formatPayloadValue(value))}</dd></div>`).join('')
  parts.push(rows ? `<dl class="fdb-payload">${rows}</dl>` : `<p class="fm-field-hint">${e(t('fdbContrib.noPayload'))}</p>`)
  return parts.join('')
}

/** Jedes Öffnen baut den Dialog neu auf, damit keine Klick-Handler doppelt hängen. */
function createDialog(): HTMLDialogElement {
  document.getElementById('fdb-contrib-dialog')?.remove()
  const dialog = document.createElement('dialog')
  dialog.id = 'fdb-contrib-dialog'
  dialog.className = 'fm-form-dialog fm-form-dialog-wide'
  dialog.setAttribute('aria-labelledby', 'fdb-contrib-title')
  dialog.innerHTML = `
    <header class="fm-section-header fm-form-dialog-header"><h2 id="fdb-contrib-title"></h2></header>
    <div class="fm-section-body">
      <div data-fdb-body></div>
      <div class="fdb-actions">
        <button type="button" class="fm-btn fm-btn-outline" data-dialog-close></button>
        <button type="button" class="fm-btn fm-btn-primary hidden" data-fdb-submit></button>
      </div>
    </div>`
  document.body.appendChild(dialog)
  return dialog
}

export interface ContributeDialogOptions {
  type: ContribType
  localId: number
  onDone?: (entry: ContribRef) => void
}

/** Vorschau öffnen, Treffer zum Verknüpfen zeigen und das Einreichen auslösen. */
export async function openContributeDialog(options: ContributeDialogOptions): Promise<void> {
  const dialog = createDialog()
  const body = dialog.querySelector('[data-fdb-body]') as HTMLElement
  const submitButton = dialog.querySelector('[data-fdb-submit]') as HTMLButtonElement
  const closeButton = dialog.querySelector('[data-dialog-close]') as HTMLButtonElement
  const heading = dialog.querySelector('#fdb-contrib-title') as HTMLElement
  const controller = bindFormDialog(dialog)
  heading.textContent = `${t('fdbContrib.title')}: ${t(`fdbContrib.types.${options.type}`)}`
  closeButton.textContent = t('fdbContrib.close')
  submitButton.classList.add('hidden')
  body.innerHTML = `<p class="fm-field-hint">${escapeHtml(t('fdbContrib.loading'))}</p>`
  controller.open()

  const submit = submitButton

  let preview: ContribPreview
  try {
    preview = await api.post<ContribPreview>('/filamentdb/contributions/preview', { type: options.type, local_id: options.localId })
  } catch (error) {
    body.innerHTML = `<div class="fm-alert-error" role="alert">${escapeHtml(contribErrorMessage(error))}</div>`
    return
  }
  body.innerHTML = renderPreviewBody(preview)
  submit.textContent = t(preview.matches.length ? 'fdbContrib.submitAnyway' : 'fdbContrib.submit')
  submit.classList.toggle('hidden', preview.blockers.length > 0)

  async function send(action: 'submit' | 'link', matchId?: number) {
    submit.disabled = true
    body.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true })
    try {
      const entry = await api.post<ContribRef>('/filamentdb/contributions/submit', {
        type: options.type,
        local_id: options.localId,
        action,
        match_id: matchId,
        shown_matches: preview.matches.map(m => ({ type: m.type, id: m.id, score: m.score })),
      })
      const key = entry.status === 'waiting' ? 'waiting' : entry.status === 'linked' ? 'linked' : entry.status === 'published' ? 'published' : 'pending'
      body.innerHTML = `<p role="status">${escapeHtml(t(`fdbContrib.result.${key}`))}</p><p>${statusBadge(entry)}</p>`
      submit.classList.add('hidden')
      options.onDone?.(entry)
    } catch (error) {
      body.insertAdjacentHTML('afterbegin', `<div class="fm-alert-error" role="alert">${escapeHtml(contribErrorMessage(error))}</div>`)
      submit.disabled = false
      body.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = false })
    }
  }

  submit.addEventListener('click', () => void send('submit'))
  body.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest('[data-fdb-link]') as HTMLElement | null
    if (link) void send('link', Number(link.dataset.fdbLink))
  })
}

/**
 * Knopf + Status an einem Objekt. Der Knopf erscheint nur, wenn Plugin, Token
 * und Recht passen; fehlt nur der Token, kommt die Hinweisbox.
 */
export async function mountContributeControl(host: HTMLElement, type: ContribType, localId: number, options: { showNotice?: boolean } = {}): Promise<void> {
  const context = await loadContribContext()
  host.innerHTML = ''
  if (context.needsToken && options.showNotice) {
    host.innerHTML = noTokenNoticeHtml()
    return
  }
  if (!context.canContribute) return
  let entries: ContribRef[] = []
  try { entries = await fetchContributions(type, localId) } catch { /* Status ist optional */ }
  const entry = entries[0]
  host.innerHTML = `${entry ? statusBadge(entry) : ''}<button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-fdb-send>${escapeHtml(t('fdbContrib.send'))}</button>`
  host.querySelector('[data-fdb-send]')!.addEventListener('click', () => {
    void openContributeDialog({ type, localId, onDone: () => void mountContributeControl(host, type, localId, options) })
  })
}
