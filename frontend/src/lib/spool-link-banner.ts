import { api } from './api'
import { getMe, hasPermission } from './auth'
import { escapeHtml } from './extra-fields'
import { t } from './i18n'
import { isAbortError } from './abort'

export interface LinkCandidate {
  id: number
  created_at: string
  remaining_weight_g: number | null
  location_name: string | null
  lot_number: string | null
}

export interface LinkSuggestion {
  id: number
  filament: { id: number; designation: string; manufacturer_name: string | null; material_type: string | null }
  printer_name: string | null
  slot_label: string | null
  created_at: string
  candidates: LinkCandidate[]
}

function candidateLabel(candidate: LinkCandidate): string {
  const parts = [t('spoolLink.spool', { id: candidate.id })]
  const created = new Date(candidate.created_at)
  if (!Number.isNaN(created.getTime())) parts.push(t('spoolLink.created', { date: created.toLocaleDateString() }))
  if (candidate.remaining_weight_g != null) parts.push(t('spoolLink.weight', { weight: Math.round(candidate.remaining_weight_g) }))
  if (candidate.lot_number) parts.push(t('spoolLink.lot', { lot: candidate.lot_number }))
  if (candidate.location_name) parts.push(candidate.location_name)
  return parts.join(' · ')
}

export function renderSpoolLinkBanner(suggestions: LinkSuggestion[]): string {
  return suggestions.map((suggestion) => {
    const filament = [suggestion.filament.manufacturer_name, suggestion.filament.designation].filter(Boolean).join(' ')
    const where = [suggestion.printer_name, suggestion.slot_label].filter(Boolean).join(' / ') || t('spoolLink.unknownPrinter')
    const options = suggestion.candidates
      .map((candidate, index) => `<option value="${candidate.id}"${index === 0 ? ' selected' : ''}>${escapeHtml(candidateLabel(candidate))}</option>`)
      .join('')
    return `<div class="fm-alert-info spool-link-suggestion" data-suggestion-id="${suggestion.id}" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
      <span style="flex:1 1 280px;">${escapeHtml(t('spoolLink.detected', { filament, where }))}</span>
      <select class="fm-select" data-link-select aria-label="${escapeHtml(t('spoolLink.select'))}">${options}</select>
      <button type="button" class="fm-btn fm-btn-primary" data-link-action="link">${escapeHtml(t('spoolLink.link'))}</button>
      <button type="button" class="fm-btn fm-btn-outline" data-link-action="dismiss">${escapeHtml(t('spoolLink.create'))}</button>
    </div>`
  }).join('')
}

/**
 * Show pending link suggestions in `container`. Hidden for users without `spools:update`.
 * `onChanged` runs after a link or dismiss so the host page can reload its list.
 */
export async function mountSpoolLinkBanner(container: HTMLElement, signal: AbortSignal, onChanged: () => void | Promise<void> = () => {}) {
  let canUpdate = false
  try {
    const user = await getMe()
    canUpdate = !!user && hasPermission(user, 'spools:update')
  } catch { /* treated as no permission */ }

  async function refresh(): Promise<void> {
    if (!canUpdate || signal.aborted) {
      container.replaceChildren()
      return
    }
    try {
      const suggestions = await api.get<LinkSuggestion[]>('/spool-link-suggestions', { signal })
      if (signal.aborted) return
      container.innerHTML = renderSpoolLinkBanner(suggestions.filter(item => item.candidates.length > 0))
    } catch (error) {
      if (!isAbortError(error)) console.error('Failed to load link suggestions:', error)
    }
  }

  container.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-link-action]')
    const row = button?.closest<HTMLElement>('[data-suggestion-id]')
    if (!button || !row) return
    button.disabled = true
    const id = row.dataset.suggestionId
    try {
      if (button.dataset.linkAction === 'link') {
        const spoolId = Number(row.querySelector<HTMLSelectElement>('[data-link-select]')!.value)
        await api.post(`/spool-link-suggestions/${id}/link`, { spool_id: spoolId }, { signal })
      } else {
        await api.post(`/spool-link-suggestions/${id}/dismiss`, undefined, { signal })
      }
      await refresh()
      await onChanged()
    } catch (error) {
      if (isAbortError(error)) return
      button.disabled = false
      const dialogs = window as unknown as { __fmAlert?: (message: string) => Promise<unknown> }
      await dialogs.__fmAlert?.(error instanceof Error && error.message ? error.message : t('spoolLink.failed'))
      await refresh()
    }
  }, { signal })

  window.addEventListener('filaman:data-changed', (event: Event) => {
    const name = (event as CustomEvent<{ event?: string }>).detail?.event
    if (name === 'resync' || name === 'spools_changed') void refresh()
  }, { signal })

  await refresh()
  return { refresh }
}
