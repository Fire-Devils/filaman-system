/**
 * Community-Druckprofile aus der FilaMan-DB (Abschnitt auf der Filament-Detailseite).
 * Nur für Filamente, die mit der FilaMan-DB verknüpft sind.
 */

import { api } from './api'
import { getMe, hasPermission } from './auth'
import { contribErrorMessage, loadContribContext } from './filamentdb-contrib'
import { escapeHtml } from './extra-fields'
import { t } from './i18n'
import { profileCoreSummary, type PrintProfile } from './print-profiles'

export interface CommunityProfile {
  id: number
  author_display_name?: string | null
  is_own?: boolean
  rating_avg?: number | null
  rating_count?: number | null
  my_rating?: number | null
  [key: string]: unknown
}

interface CommunityPrinter {
  id: number
  name: string
  nozzle_diameter_mm?: number | null
  printer_manufacturer?: string | null
  printer_model?: string | null
  filamentdb_printer_model_id?: number | null
}

export function starsText(avg: number | null | undefined): string {
  const filled = Math.max(0, Math.min(5, Math.round(avg ?? 0)))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

export function renderCommunityCard(profile: CommunityProfile, options: { canRate: boolean; canAdopt: boolean }): string {
  const e = escapeHtml
  const author = profile.author_display_name ? t('fdbContrib.community.by', { author: profile.author_display_name }) : t('fdbContrib.community.by', { author: t('fdbContrib.community.anonymous') })
  const count = profile.rating_count ?? 0
  const rating = count > 0
    ? `<span class="fdb-stars" aria-label="${e(t('fdbContrib.community.stars', { n: (profile.rating_avg ?? 0).toFixed(1) }))}">${starsText(profile.rating_avg)}</span> <span class="pp-muted">${e(t('fdbContrib.community.ratings', { count }))}</span>`
    : `<span class="pp-muted">${e(t('fdbContrib.community.noRatings'))}</span>`
  const rows = profileCoreSummary(profile as unknown as PrintProfile)
    .map(row => `<div><dt>${e(row.label)}</dt><dd>${e(row.value)}</dd></div>`).join('')
  const own = profile.is_own ? `<span class="fdb-status fdb-status-success">${e(t('fdbContrib.community.own'))}</span>` : ''
  let actions = ''
  if (options.canAdopt) actions += `<button type="button" class="fm-btn fm-btn-primary fm-btn-sm" data-cp-adopt="${profile.id}">${e(t('fdbContrib.community.adopt'))}</button> `
  if (options.canRate && !profile.is_own) {
    const stars = [1, 2, 3, 4, 5].map(n => `<button type="button" class="fdb-star${profile.my_rating && n <= profile.my_rating ? ' fdb-star-on' : ''}" data-cp-rate="${profile.id}" data-stars="${n}" aria-label="${e(t('fdbContrib.community.stars', { n }))}">★</button>`).join('')
    actions += `<span class="fdb-rate" role="group" aria-label="${e(t('fdbContrib.community.rate'))}">${stars}</span> `
    actions += `<button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-cp-report="${profile.id}">${e(t('fdbContrib.community.report'))}</button>`
  }
  return `<article class="fm-card pp-card" data-cp-card="${profile.id}">
    <header><h3>${rating} ${own}</h3><span class="pp-muted">${e(author)}</span></header>
    <dl>${rows || `<p class="pp-muted">${e(t('printProfiles.noCore'))}</p>`}</dl>
    <div class="pp-card-actions">${actions}</div>
    <p class="pp-muted" data-cp-message role="status"></p></article>`
}

export interface CommunityProfilesOptions {
  mount: HTMLElement
  filamentId: number
  filamentdbId: number
  onAdopted?: () => void
}

export async function initCommunityProfiles(options: CommunityProfilesOptions): Promise<void> {
  const { mount, filamentId, filamentdbId } = options
  const context = await loadContribContext()
  const user = await getMe()
  const list = mount.querySelector('[data-cp-list]') as HTMLElement
  // Das Plugin muss aktiv sein; Lesen geht auch ohne Token.
  const status = await api.get<{ plugin_active: boolean }>('/filamentdb/contributions/status').catch(() => null)
  if (!status?.plugin_active || !user) return
  mount.classList.remove('hidden')
  const canAdopt = hasPermission(user, 'filaments:update')
  const canRate = context.canContribute
  const profilesById = new Map<number, CommunityProfile>()
  const printersById = new Map<number, CommunityPrinter>()

  let printers: CommunityPrinter[] = []
  try {
    printers = (await api.get<{ items: CommunityPrinter[] }>('/printers?page_size=200')).items
      .filter(p => p.filamentdb_printer_model_id)
  } catch {
    list.innerHTML = `<p class="pp-muted">${escapeHtml(t('fdbContrib.community.loadFailed'))}</p>`
    return
  }
  if (!printers.length) {
    list.innerHTML = `<p class="pp-muted">${escapeHtml(t('fdbContrib.community.noPrinters'))}</p>`
    return
  }

  const sections: string[] = []
  for (const printer of printers) {
    printersById.set(printer.id, printer)
    const params = new URLSearchParams({ filament_id: String(filamentdbId), printer_model_id: String(printer.filamentdb_printer_model_id) })
    if (printer.nozzle_diameter_mm) params.set('nozzle_diameter_mm', String(printer.nozzle_diameter_mm))
    let items: CommunityProfile[] = []
    try {
      items = (await api.get<{ items: CommunityProfile[] }>(`/filamentdb/print-profiles?${params}`)).items
    } catch (error) {
      sections.push(`<section class="cp-printer"><h3>${escapeHtml(t('fdbContrib.community.forPrinter', { printer: printer.name }))}</h3><p class="fm-alert-error" role="alert">${escapeHtml(contribErrorMessage(error))}</p></section>`)
      continue
    }
    items.forEach(item => profilesById.set(item.id, item))
    const cards = items.map(item => renderCommunityCard(item, { canRate, canAdopt })).join('')
    sections.push(`<section class="cp-printer" data-cp-printer="${printer.id}"><h3>${escapeHtml(t('fdbContrib.community.forPrinter', { printer: printer.name }))}</h3>
      <div class="pp-cards">${cards || `<p class="pp-muted">${escapeHtml(t('fdbContrib.community.empty'))}</p>`}</div></section>`)
  }
  list.innerHTML = sections.join('')

  function message(card: HTMLElement | null, text: string, isError = false) {
    const el = card?.querySelector('[data-cp-message]')
    if (el) {
      el.textContent = text
      el.classList.toggle('fm-alert-error', isError)
    }
  }

  list.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement
    const card = target.closest('[data-cp-card]') as HTMLElement | null
    const adopt = target.closest('[data-cp-adopt]') as HTMLElement | null
    const rate = target.closest('[data-cp-rate]') as HTMLElement | null
    const report = target.closest('[data-cp-report]') as HTMLElement | null
    try {
      if (adopt) {
        const printerId = Number((adopt.closest('[data-cp-printer]') as HTMLElement).dataset.cpPrinter)
        await api.post(`/filamentdb/print-profiles/${adopt.dataset.cpAdopt}/import`, { filament_id: filamentId, printer_id: printerId })
        message(card, t('fdbContrib.community.adopted'))
        options.onAdopted?.()
      } else if (rate) {
        const result = await api.put<{ rating_avg: number; rating_count: number; my_rating: number }>(
          `/filamentdb/print-profiles/${rate.dataset.cpRate}/rating`, { stars: Number(rate.dataset.stars) })
        card?.querySelectorAll<HTMLElement>('[data-cp-rate]').forEach(star => star.classList.toggle('fdb-star-on', Number(star.dataset.stars) <= result.my_rating))
        const heading = card?.querySelector('h3 .fdb-stars')
        if (heading) heading.textContent = starsText(result.rating_avg)
        message(card, t('fdbContrib.community.rated'))
      } else if (report) {
        const reason = window.prompt(t('fdbContrib.community.reportPrompt'))?.trim()
        if (!reason) return
        await api.post(`/filamentdb/print-profiles/${report.dataset.cpReport}/report`, { reason: reason.slice(0, 500) })
        message(card, t('fdbContrib.community.reportSent'))
      }
    } catch (error) {
      message(card, contribErrorMessage(error), true)
    }
  })
}
