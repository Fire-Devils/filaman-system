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
  changed?: boolean
  depends_on?: { entity_type: ContribType; local_id: number; label: string | null; status: string } | null
  remote_entity_id?: number | null
  last_error?: string | null
  last_checked_at?: string | null
  created_by?: number | null
  created_by_name?: string | null
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
  display?: Record<string, string>
  matches: ContribMatch[]
  blockers: { code: string; message: string; field?: string; min?: number; max?: number; profile_id?: number; filament_id?: number; printer_id?: number }[]
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

const STATUS_ICONS = { success: '✓', error: '✕', warning: '…' } as const

/** Statuspille; mit `compact` nur ein Symbol (Text als Tooltip und für Screenreader). */
export function statusBadge(entry: Pick<ContribRef, 'status' | 'depends_on'>, options: { compact?: boolean } = {}): string {
  const tone = ['approved', 'published', 'linked'].includes(entry.status)
    ? 'success'
    : ['rejected', 'error'].includes(entry.status) ? 'error' : 'warning'
  const text = escapeHtml(statusText(entry))
  if (options.compact) {
    return `<span class="fdb-status fdb-status-icon fdb-status-${tone}" data-fdb-status="${escapeHtml(entry.status)}" title="${text}" aria-label="${text}" role="img">${STATUS_ICONS[tone]}</span>`
  }
  return `<span class="fdb-status fdb-status-${tone}" data-fdb-status="${escapeHtml(entry.status)}">${text}</span>`
}

export type FdbFilterValue = 'linked' | 'unlinked' | 'pending' | 'rejected'

/** Werte der FilaMan-DB-Spaltenfilter: Verknüpfung plus (falls vorhanden) Prüf-/Ablehnungsstatus des Beitrags. */
/** Verknüpft = positive filamentdb_id (Zahl oder Zahl als Text, wie auf der Detailseite). */
export function isFdbLinked(customFields: Record<string, unknown> | null | undefined): boolean {
  const id = Number(customFields?.filamentdb_id)
  return Number.isFinite(id) && id > 0
}

export function fdbFilterValues(customFields: Record<string, unknown> | null | undefined, contribStatus?: string | null): FdbFilterValue[] {
  const values: FdbFilterValue[] = [isFdbLinked(customFields) ? 'linked' : 'unlinked']
  if (contribStatus && ['pending', 'waiting'].includes(contribStatus)) values.push('pending')
  if (contribStatus && ['rejected', 'error'].includes(contribStatus)) values.push('rejected')
  return values
}

/** Verknüpfungsspalte der Listen: grünes Häkchen bei positiver filamentdb_id, sonst gedämpfter Strich. */
export function fdbLinkCell(customFields: Record<string, unknown> | null | undefined): string {
  if (isFdbLinked(customFields)) {
    const text = escapeHtml(t('fdbContrib.linkedYes'))
    return `<span class="fdb-status fdb-status-icon fdb-status-success" data-fdb-linked="true" title="${text}" aria-label="${text}" role="img">${STATUS_ICONS.success}</span>`
  }
  const text = escapeHtml(t('fdbContrib.linkedNo'))
  return `<span class="fdb-link-none" data-fdb-linked="false" title="${text}" aria-label="${text}" role="img">–</span>`
}

export type SendButtonMode = 'send' | 'update' | null

/** Welcher Senden-Knopf zu einem Beitrag passt (null: nur die Statuspille). */
export function sendButtonMode(entry?: Pick<ContribRef, 'status' | 'changed'> | null): SendButtonMode {
  if (!entry || ['rejected', 'changes_requested', 'error', 'draft'].includes(entry.status)) return 'send'
  if (['waiting', 'pending', 'approved', 'published', 'linked'].includes(entry.status) && entry.changed) return 'update'
  return null
}

export function sendButtonLabel(mode: Exclude<SendButtonMode, null>): string {
  return t(mode === 'update' ? 'fdbContrib.sendUpdate' : 'fdbContrib.send')
}

export function noTokenNoticeHtml(): string {
  const link = `<a href="${FILAMENTDB_SITE_URL}" target="_blank" rel="noopener noreferrer">db.filaman.app</a>`
  return `<p class="fm-field-hint fm-db-hint" data-fdb-no-token>${t('fdbContrib.noToken', { link })}</p>`
}

export function contribErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = `fdbContrib.errors.${error.code}`
    const field = error.detail?.field ? fieldLabel(String(error.detail.field)) : ''
    const min = error.detail?.min ?? ''
    const max = error.detail?.max ?? ''
    const range = error.code === 'validation_error' && max !== ''
      ? t('fdbContrib.errors.validation_range', { min: String(min === '' ? 0 : min), max: String(max) })
      : ''
    const text = t(key, { field, min: String(min), max: String(max), range })
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

const REFRESH_KEY = 'fdbContribRefreshAt'
const REFRESH_MIN_INTERVAL_MS = 2 * 60 * 1000
const REFRESH_STATUSES = ['waiting', 'pending', 'changes_requested']

/**
 * Stößt höchstens alle 2 Minuten je Browser-Tab einen Abgleich an, wenn Beiträge
 * auf eine Entscheidung warten. Gibt true zurück, wenn abgeglichen wurde (dann neu laden).
 * Fehler werden still ignoriert; der Zeitstempel wird vorher gesetzt, es gibt keine Wiederholschleife.
 */
export async function refreshContributionsIfStale(entries: Pick<ContribRef, 'status'>[]): Promise<boolean> {
  if (!entries.some(entry => REFRESH_STATUSES.includes(entry.status))) return false
  const now = Date.now()
  try {
    const last = Number(sessionStorage.getItem(REFRESH_KEY) ?? 0)
    if (last && now - last < REFRESH_MIN_INTERVAL_MS) return false
    sessionStorage.setItem(REFRESH_KEY, String(now))
  } catch { /* ohne sessionStorage nicht abgleichen, sonst gäbe es keine Drosselung */ return false }
  try {
    await api.post('/filamentdb/contributions/refresh')
    return true
  } catch {
    return false
  }
}

/** Beiträge laden und bei Bedarf einmal abgleichen und neu laden. */
export async function fetchContributionsFresh(type?: ContribType, localId?: number): Promise<ContribRef[]> {
  const items = await fetchContributions(type, localId)
  if (await refreshContributionsIfStale(items)) {
    try { return await fetchContributions(type, localId) } catch { return items }
  }
  return items
}

export function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return t(value ? 'fdbContrib.yes' : 'fdbContrib.no')
  if (Array.isArray(value)) {
    return value.map(item => {
      if (!item || typeof item !== 'object') return String(item)
      const { color_name: name, hex_code: hex } = item as Record<string, unknown>
      const bare = (v: unknown) => String(v ?? '').replace(/^#/, '').toLowerCase()
      const showName = name && bare(name) !== bare(hex)
      return [showName ? name : null, hex].filter(Boolean).join(' ')
    }).join(', ')
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

export function blockerText(b: ContribPreview['blockers'][number]): string {
  const key = `fdbContrib.blockers.${b.code}`
  let text = t(key) === key ? b.message : t(key)
  if (b.code === 'implausible_value') text = `${text}: ${fieldLabel(String(b.field ?? ''))} (${b.min} – ${b.max})`
  return text
}

/** Links zur Stelle, an der ein Blocker behoben wird (Profil bzw. Drucker bearbeiten). */
export function blockerLinks(b: ContribPreview['blockers'][number]): { href: string; labelKey: string }[] {
  if (b.code !== 'printer_model_missing') return []
  const links: { href: string; labelKey: string }[] = []
  if (b.profile_id && b.filament_id) links.push({ href: `/filaments/${b.filament_id}#print-profiles`, labelKey: 'fdbContrib.blockerLinks.editProfile' })
  if (b.printer_id) links.push({ href: `/printers?edit=${b.printer_id}`, labelKey: 'fdbContrib.blockerLinks.editPrinter' })
  return links
}

export function renderPreviewBody(preview: ContribPreview): string {
  const e = escapeHtml
  const parts: string[] = [`<p class="fm-field-hint">${e(t('fdbContrib.previewIntro'))}</p>`]
  if (preview.mode === 'edit') parts.push(`<p class="fm-field-hint">${e(t('fdbContrib.noteEdit'))}</p>`)
  if (preview.mode === 'update') parts.push(`<p class="fm-field-hint">${e(t('fdbContrib.noteUpdate'))}</p>`)

  // "Schon verknüpft" ist kein Fehler, sondern ein Hinweis: nichts zu senden.
  const alreadyLinked = preview.blockers.some(b => b.code === 'already_linked')
  const realBlockers = preview.blockers.filter(b => b.code !== 'already_linked')
  if (alreadyLinked) parts.push(`<div class="fm-alert-info" role="status">${e(t('fdbContrib.alreadyLinkedInfo'))}</div>`)
  if (realBlockers.length) {
    const items = realBlockers.map(b => {
      const links = blockerLinks(b).map(l => `<a href="${e(l.href)}">${e(t(l.labelKey))}</a>`).join(' · ')
      return `<li>${e(blockerText(b))}${links ? ` ${links}` : ''}</li>`
    }).join('')
    parts.push(`<div class="fm-alert-error" role="alert"><strong>${e(t('fdbContrib.blockersTitle'))}</strong><ul>${items}</ul></div>`)
  }

  if (preview.dependencies.length) {
    const items = preview.dependencies.map(d => `<li>${e(t(`fdbContrib.types.${d.type}`))}: ${e(d.label)}</li>`).join('')
    parts.push(`<div class="fdb-deps"><strong>${e(t('fdbContrib.dependenciesTitle'))}</strong><ul>${items}</ul><p class="fm-field-hint">${e(t('fdbContrib.dependenciesHint'))}</p></div>`)
  }

  if (preview.matches.length) {
    const items = preview.matches.map(m => `<li class="fdb-match"><span>${e(m.label ?? `#${m.id}`)}${m.score != null ? ` <small>${e(t('fdbContrib.matchScore', { score: Math.round(m.score * 100) }))}</small>` : ''}</span>
      <button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-fdb-link="${Number(m.id)}">${e(t('fdbContrib.thisIsIt'))}</button></li>`).join('')
    parts.push(`<div class="fdb-matches"><strong>${e(t('fdbContrib.matchesTitle'))}</strong><p class="fm-field-hint">${e(t('fdbContrib.matchesHint'))}</p><ul>${items}</ul></div>`)
  }

  const rows = Object.entries(preview.payload)
    .map(([key, value]) => {
      const name = preview.display?.[key]
      const label = name && t(`fdbContrib.displayFields.${key}`) !== `fdbContrib.displayFields.${key}` ? t(`fdbContrib.displayFields.${key}`) : fieldLabel(key)
      const shown = name ? name : formatPayloadValue(value)
      return `<div><dt>${e(label)}</dt><dd>${e(shown)}</dd></div>`
    }).join('')
  parts.push(rows ? `<dl class="fdb-payload">${rows}</dl>` : `<p class="fm-field-hint">${e(t('fdbContrib.noPayload'))}</p>`)
  return parts.join('')
}

/** Jedes Öffnen baut den Dialog neu auf, damit keine Klick-Handler doppelt hängen. */
export function createDialog(): HTMLDialogElement {
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
  try { entries = await fetchContributionsFresh(type, localId) } catch { /* Status ist optional */ }
  const entry = entries[0]
  const mode = sendButtonMode(entry)
  host.innerHTML = `${entry ? statusBadge(entry) : ''}${mode ? `<button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-fdb-send>${escapeHtml(sendButtonLabel(mode))}</button>` : ''}`
  host.querySelector('[data-fdb-send]')?.addEventListener('click', () => {
    void openContributeDialog({ type, localId, onDone: () => void mountContributeControl(host, type, localId, options) })
  })
}
