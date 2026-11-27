/**
 * Sammelversand an die FilaMan-DB (Filamentliste): Vorschau je Objekt, Auswahl
 * der sendbaren Objekte, Senden nacheinander mit Fortschritt und Zusammenfassung.
 */

import { ApiError, api } from './api'
import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { t } from './i18n'
import {
  blockerText,
  contribErrorMessage,
  createDialog,
  fetchContributions,
  sendButtonMode,
  type ContribPreview,
  type ContribRef,
  type ContribType,
} from './filamentdb-contrib'

export interface BulkCandidate {
  id: number
  entry?: Pick<ContribRef, 'status' | 'changed'> | null
  preview?: ContribPreview | null
  /** Fehler beim Laden der Vorschau */
  error?: string | null
}

export type BulkReason = 'unchanged' | 'blocked' | 'duplicate' | 'error' | null
export interface BulkDecision { id: number; action: 'send' | 'skip' | 'duplicate'; reason: BulkReason }

/** Reine Auswahl-Logik: was gesendet, übersprungen oder als mögliche Dublette markiert wird. */
export function planBulkSend(items: BulkCandidate[]): BulkDecision[] {
  return items.map((item): BulkDecision => {
    if (sendButtonMode(item.entry) === null) return { id: item.id, action: 'skip', reason: 'unchanged' }
    if (item.error || !item.preview) return { id: item.id, action: 'skip', reason: 'error' }
    if (item.preview.blockers.length) return { id: item.id, action: 'skip', reason: 'blocked' }
    if (item.preview.matches.length) return { id: item.id, action: 'duplicate', reason: 'duplicate' }
    return { id: item.id, action: 'send', reason: null }
  })
}

export interface BulkSendOptions {
  type: ContribType
  ids: number[]
  label: (id: number) => string
  link?: (id: number) => string
  onDone?: () => void
}

export async function openBulkSendDialog(options: BulkSendOptions): Promise<void> {
  const dialog = createDialog()
  const body = dialog.querySelector('[data-fdb-body]') as HTMLElement
  const submit = dialog.querySelector('[data-fdb-submit]') as HTMLButtonElement
  const closeButton = dialog.querySelector('[data-dialog-close]') as HTMLButtonElement
  ;(dialog.querySelector('#fdb-contrib-title') as HTMLElement).textContent = t('fdbContrib.bulkSend')
  closeButton.textContent = t('fdbContrib.close')
  submit.classList.add('hidden')
  const controller = bindFormDialog(dialog)
  controller.open()
  const e = escapeHtml
  let sentAny = false
  dialog.addEventListener('close', () => { if (sentAny) options.onDone?.() })

  const total = options.ids.length
  const progress = (done: number, key: string) => {
    body.innerHTML = `<p class="fm-field-hint" role="status">${e(t(key, { done, total }))}</p>`
  }
  progress(0, 'fdbContrib.bulkChecking')

  let entries = new Map<number, ContribRef>()
  try { entries = new Map((await fetchContributions(options.type)).map(x => [x.local_id, x])) } catch { /* Status ist optional */ }

  const candidates: BulkCandidate[] = []
  const messages = new Map<number, string>()
  for (const [index, id] of options.ids.entries()) {
    progress(index, 'fdbContrib.bulkChecking')
    const entry = entries.get(id)
    if (sendButtonMode(entry) === null) { candidates.push({ id, entry }); continue }
    try {
      const preview = await api.post<ContribPreview>('/filamentdb/contributions/preview', { type: options.type, local_id: id })
      candidates.push({ id, entry, preview })
      if (preview.blockers.length) messages.set(id, preview.blockers.map(blockerText).join('; '))
    } catch (error) {
      candidates.push({ id, entry, error: contribErrorMessage(error) })
      messages.set(id, contribErrorMessage(error))
    }
  }
  const plan = planBulkSend(candidates)
  const previews = new Map(candidates.map(c => [c.id, c.preview]))
  const toSend = plan.filter(d => d.action === 'send')

  const reasonText = (d: BulkDecision): string => {
    if (d.reason === 'unchanged') return t('fdbContrib.bulkUnchanged')
    if (d.reason === 'duplicate') return t('fdbContrib.bulkDuplicate')
    return messages.get(d.id) ?? ''
  }
  const nameHtml = (id: number) => {
    const href = options.link?.(id)
    return href ? `<a href="${e(href)}">${e(options.label(id))}</a>` : e(options.label(id))
  }
  body.innerHTML = `<p class="fm-field-hint">${e(t('fdbContrib.bulkIntro', { send: toSend.length, total }))}</p><ul class="fdb-bulk-list">${
    plan.map(d => `<li data-bulk-id="${d.id}"><strong>${nameHtml(d.id)}</strong> <span class="fm-field-hint">${
      d.action === 'send' ? e(t('fdbContrib.bulkWillSend')) : e(reasonText(d))}</span></li>`).join('')}</ul>`
  if (!toSend.length) return
  submit.textContent = t('fdbContrib.bulkSubmit', { count: toSend.length })
  submit.classList.remove('hidden')
  submit.addEventListener('click', () => void run())

  async function run() {
    submit.classList.add('hidden')
    const sent: number[] = []
    const failed: { id: number; message: string }[] = []
    const notSent: number[] = []
    let aborted = false
    for (const [index, d] of toSend.entries()) {
      if (aborted) { notSent.push(d.id); continue }
      progress(index, 'fdbContrib.bulkProgress')
      const preview = previews.get(d.id)
      try {
        await api.post('/filamentdb/contributions/submit', {
          type: options.type,
          local_id: d.id,
          action: 'submit',
          shown_matches: (preview?.matches ?? []).map(m => ({ type: m.type, id: m.id, score: m.score })),
        })
        sent.push(d.id)
        sentAny = true
      } catch (error) {
        failed.push({ id: d.id, message: contribErrorMessage(error) })
        if (error instanceof ApiError && error.code === 'daily_limit_reached') aborted = true
      }
    }
    const skipped = plan.filter(d => d.action !== 'send')
    const lines = (items: string[]) => `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`
    body.innerHTML = `<p role="status"><strong>${e(t('fdbContrib.bulkSummary', { sent: sent.length, skipped: skipped.length, failed: failed.length + notSent.length }))}</strong></p>`
      + (failed.length ? lines(failed.map(f => `${nameHtml(f.id)}: ${e(f.message)}`)) : '')
      + (notSent.length ? `<p class="fm-field-hint">${e(t('fdbContrib.bulkNotSent'))}</p>${lines(notSent.map(nameHtml))}` : '')
      + (skipped.length ? lines(skipped.map(d => `${nameHtml(d.id)}: ${e(reasonText(d))}`)) : '')
  }
}
