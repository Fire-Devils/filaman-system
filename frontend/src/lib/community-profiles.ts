/**
 * Community-Druckprofile aus der FilaMan-DB (Abschnitt auf der Filament-Detailseite).
 * Nur für Filamente, die mit der FilaMan-DB verknüpft sind.
 */

import { api } from './api'
import { getMe, hasPermission } from './auth'
import { contribErrorMessage, loadContribContext } from './filamentdb-contrib'
import { escapeHtml } from './extra-fields'
import { t } from './i18n'
import { bindFormDialog } from './form-dialog'
import { printerOptionLabel, profileCoreSummary, type PrintProfile } from './print-profiles'

export interface CommunityProfile {
  id: number
  author_display_name?: string | null
  is_own?: boolean
  imported_printer_ids?: Array<number | null>
  printer_model_id?: number | null
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

export type ModelMismatch = 'unlinked' | 'mismatch' | null

/**
 * Passt das Druckermodell des Community-Profils zum Zieldrucker?
 * 'unlinked': Drucker hat kein FilaMan-DB-Modell, 'mismatch': anderes Modell,
 * null: passt oder das Profil nennt kein Modell (dann gibt es nichts zu warnen).
 */
export function profileModelMismatch(
  profile: Pick<CommunityProfile, 'printer_model_id'>,
  printer: { filamentdb_printer_model_id?: number | null } | undefined,
): ModelMismatch {
  const profileModel = Number(profile.printer_model_id) || 0
  if (!profileModel || !printer) return null
  const printerModel = Number(printer.filamentdb_printer_model_id) || 0
  if (!printerModel) return 'unlinked'
  return printerModel === profileModel ? null : 'mismatch'
}

/** "Hersteller Modell" aus dem Profil (flache Felder oder verschachteltes Modellobjekt). */
export function profileModelLabel(profile: CommunityProfile): string {
  const nested = profile.printer_model
  if (nested && typeof nested === 'object') {
    const ref = nested as { manufacturer?: unknown; model?: unknown }
    return [ref.manufacturer, ref.model].filter(part => typeof part === 'string' && part).join(' ')
  }
  return [profile.printer_manufacturer, nested].filter(part => typeof part === 'string' && part).join(' ')
}

/** "Erstellt für Bambu Lab X1C, Düse 0.4 mm"; leer, wenn das Profil nichts davon nennt. */
export function profileOriginText(profile: CommunityProfile): string {
  const model = profileModelLabel(profile)
  const nozzle = Number(profile.nozzle_diameter_mm)
  if (model && nozzle > 0) return t('fdbContrib.community.createdForNozzle', { model, nozzle: String(nozzle) })
  if (model) return t('fdbContrib.community.createdFor', { model })
  if (nozzle > 0) return t('fdbContrib.community.createdForNozzleOnly', { nozzle: String(nozzle) })
  return ''
}

export function starsText(avg: number | null | undefined): string {
  const filled = Math.max(0, Math.min(5, Math.round(avg ?? 0)))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

export function renderCommunityCard(profile: CommunityProfile, options: { canRate: boolean; canAdopt: boolean; showOrigin?: boolean; duplicate?: boolean }): string {
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
  if (options.canAdopt) {
    const dup = Boolean(profile.is_own || options.duplicate)
    actions += `<button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-cp-adopt="${Number(profile.id)}" data-cp-duplicate="${dup ? '1' : '0'}" title="${e(t(dup ? 'fdbContrib.community.duplicateHint' : 'fdbContrib.community.adoptHint'))}">${e(t(dup ? 'fdbContrib.community.duplicate' : 'fdbContrib.community.adopt'))}</button> `
  }
  if (options.canRate && !profile.is_own) {
    const stars = [1, 2, 3, 4, 5].map(n => `<button type="button" class="fdb-star${profile.my_rating && n <= profile.my_rating ? ' fdb-star-on' : ''}" data-cp-rate="${Number(profile.id)}" data-stars="${n}" aria-label="${e(t('fdbContrib.community.stars', { n }))}">★</button>`).join('')
    actions += `<span class="fdb-rate" role="group" aria-label="${e(t('fdbContrib.community.rate'))}">${stars}</span> `
    actions += `<button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-cp-report="${Number(profile.id)}">${e(t('fdbContrib.community.report'))}</button>`
  }
  const origin = options.showOrigin ? profileOriginText(profile) : ''
  return `<article class="fm-card pp-card" data-cp-card="${Number(profile.id)}">
    <header><h3>${rating} ${own}</h3><span class="pp-muted">${e(author)}</span>${origin ? `<span class="pp-muted" data-cp-origin>${e(origin)}</span>` : ''}</header>
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

/** Anzeige "(3)" hinter der Überschrift; bei null (Fehler) nichts. */
export function countSuffix(count: number | null | undefined): string {
  return typeof count === 'number' && count >= 0 ? ` (${count})` : ''
}

export async function initCommunityProfiles(options: CommunityProfilesOptions): Promise<void> {
  const { mount, filamentdbId } = options
  const user = await getMe()
  // Das Plugin muss aktiv sein; Lesen geht auch ohne Token.
  const status = await api.get<{ plugin_active: boolean }>('/filamentdb/contributions/status').catch(() => null)
  if (!status?.plugin_active || !user) return
  mount.classList.remove('hidden')
  const details = mount.querySelector('[data-cp-details]') as HTMLDetailsElement | null
  const countEl = mount.querySelector('[data-cp-count]')
  let loadedOnce = false
  const open = () => {
    if (loadedOnce) return
    loadedOnce = true
    void loadCommunitySection(options, user)
  }
  if (details) details.addEventListener('toggle', () => { if (details.open) open() })
  else open()
  try {
    const data = await api.get<{ count: number | null }>(`/filamentdb/print-profiles/count?filament_id=${filamentdbId}`)
    if (countEl) countEl.textContent = countSuffix(data.count)
  } catch { /* ohne Zahl weiter */ }
}

async function loadCommunitySection(options: CommunityProfilesOptions, user: NonNullable<Awaited<ReturnType<typeof getMe>>>): Promise<void> {
  const { mount, filamentId, filamentdbId } = options
  const context = await loadContribContext()
  const list = mount.querySelector('[data-cp-list]') as HTMLElement
  const canAdopt = hasPermission(user, 'filaments:update')
  const canRate = context.canContribute
  const profilesById = new Map<number, CommunityProfile>()
  const printersById = new Map<number, CommunityPrinter>()

  let allPrinters: CommunityPrinter[] = []
  let printers: CommunityPrinter[] = []
  try {
    allPrinters = (await api.get<{ items: CommunityPrinter[] }>('/printers?page_size=200')).items
    printers = allPrinters.filter(p => p.filamentdb_printer_model_id)
  } catch {
    list.innerHTML = `<p class="pp-muted">${escapeHtml(t('fdbContrib.community.loadFailed'))}</p>`
    return
  }
  setupCommunitySearch({ mount, filamentId, filamentdbId, printers: allPrinters, canAdopt, onAdopted: options.onAdopted })
  if (!printers.length) {
    list.innerHTML = `<p class="pp-muted">${escapeHtml(t('fdbContrib.community.noPrinters'))}</p>`
    return
  }

  const sections: string[] = []
  for (const printer of printers) {
    printersById.set(printer.id, printer)
    const params = new URLSearchParams({ filament_id: String(filamentdbId), printer_model_id: String(printer.filamentdb_printer_model_id), local_filament_id: String(filamentId) })
    if (printer.nozzle_diameter_mm) params.set('nozzle_diameter_mm', String(printer.nozzle_diameter_mm))
    let items: CommunityProfile[] = []
    try {
      items = (await api.get<{ items: CommunityProfile[] }>(`/filamentdb/print-profiles?${params}`)).items
    } catch (error) {
      sections.push(`<section class="cp-printer"><h3>${escapeHtml(t('fdbContrib.community.forPrinter', { printer: printer.name }))}</h3><p class="fm-alert-error" role="alert">${escapeHtml(contribErrorMessage(error))}</p></section>`)
      continue
    }
    items.forEach(item => profilesById.set(item.id, item))
    const cards = items.map(item => renderCommunityCard(item, { canRate, canAdopt, duplicate: item.imported_printer_ids?.includes(printer.id) })).join('')
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
        const duplicate = adopt.dataset.cpDuplicate === '1'
        await api.post(`/filamentdb/print-profiles/${adopt.dataset.cpAdopt}/import`, { filament_id: filamentId, printer_id: printerId, duplicate })
        message(card, t('fdbContrib.community.adopted'))
        adopt.dataset.cpDuplicate = '1'
        adopt.textContent = t('fdbContrib.community.duplicate')
        adopt.title = t('fdbContrib.community.duplicateHint')
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

export const SEARCH_PAGE_SIZE = 20
export const SEARCH_MAX_RESULTS = 200

interface SearchPage {
  items: CommunityProfile[]
  total?: number
}

interface PrinterModelOption {
  id: number
  manufacturer?: string | null
  model?: string | null
}

interface SearchSetup {
  mount: HTMLElement
  filamentId: number
  filamentdbId: number
  printers: CommunityPrinter[]
  canAdopt: boolean
  onAdopted?: () => void
}

/** Kann noch eine Seite nachgeladen werden? Gedeckelt, damit die Liste nicht ausufert. */
export function hasMoreResults(loaded: number, total: number | undefined): boolean {
  return loaded < SEARCH_MAX_RESULTS && typeof total === 'number' && loaded < total
}

function renderSearchDialog(models: PrinterModelOption[]): string {
  const e = escapeHtml
  const options = [`<option value="">${e(t('fdbContrib.community.allModels'))}</option>`]
    .concat(models
      .map(m => ({ id: m.id, label: [m.manufacturer, m.model].filter(Boolean).join(' ') }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(m => `<option value="${Number(m.id)}">${e(m.label)}</option>`)).join('')
  return `<p class="pp-muted" style="margin: 0 0 8px;">${e(t('fdbContrib.community.searchHint'))}</p>
    <form class="cp-search-form" data-cs-form>
      <div class="pp-field"><label for="cs-model" class="fm-label">${e(t('fdbContrib.community.searchModel'))}</label>
        <select id="cs-model" class="fm-select" data-cs-model>${options}</select></div>
      <div class="pp-field"><label for="cs-nozzle" class="fm-label">${e(t('fdbContrib.community.searchNozzle'))} <span class="pp-unit">mm</span></label>
        <input type="number" id="cs-nozzle" class="fm-input" step="0.05" min="0.1" max="2" data-cs-nozzle /></div>
      <div class="pp-field cp-search-submit"><button type="submit" class="fm-btn fm-btn-fdb">${e(t('fdbContrib.community.searchRun'))}</button></div>
    </form>
    <div class="pp-cards" data-cs-results></div>
    <p class="pp-muted" data-cs-status role="status"></p>
    <div class="cp-search-more hidden" data-cs-more><button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-cs-load-more>${e(t('fdbContrib.community.loadMore'))}</button></div>
    <div class="cp-adopt-panel hidden" data-cs-adopt></div>`
}

/** Dialog "Weitere Profile suchen": beliebiges Druckermodell, Übernahme mit Modellwarnung. */
function setupCommunitySearch(setup: SearchSetup): void {
  const { mount, filamentId, filamentdbId, printers } = setup
  const button = mount.querySelector('[data-cp-search-open]') as HTMLElement | null
  const dialog = document.getElementById('community-search-dialog') as HTMLDialogElement | null
  const body = dialog?.querySelector('[data-cs-body]') as HTMLElement | null
  if (!button || !dialog || !body) return
  button.classList.remove('hidden')
  const controller = bindFormDialog(dialog)
  const found = new Map<number, CommunityProfile>()
  let page = 0
  let total: number | undefined
  let loaded = 0
  let built = false

  async function open() {
    if (!built) {
      built = true
      let models: PrinterModelOption[] = []
      try {
        models = (await api.get<{ items: PrinterModelOption[] }>('/filamentdb/printer-models')).items
      } catch { /* Suche geht auch ohne Modellliste */ }
      body!.innerHTML = renderSearchDialog(models)
      wire()
    }
    controller.open()
  }
  button.addEventListener('click', () => void open())

  function wire() {
    const form = body!.querySelector('[data-cs-form]') as HTMLFormElement
    const results = body!.querySelector('[data-cs-results]') as HTMLElement
    const statusEl = body!.querySelector('[data-cs-status]') as HTMLElement
    const more = body!.querySelector('[data-cs-more]') as HTMLElement
    const panel = body!.querySelector('[data-cs-adopt]') as HTMLElement

    async function fetchPage(reset: boolean) {
      const modelId = Number((body!.querySelector('[data-cs-model]') as HTMLSelectElement).value)
      const nozzle = Number((body!.querySelector('[data-cs-nozzle]') as HTMLInputElement).value)
      if (reset) {
        page = 0
        loaded = 0
        total = undefined
        found.clear()
        results.innerHTML = ''
        panel.classList.add('hidden')
      }
      const params = new URLSearchParams({ filament_id: String(filamentdbId), page: String(page + 1), page_size: String(SEARCH_PAGE_SIZE), local_filament_id: String(filamentId) })
      if (modelId > 0) params.set('printer_model_id', String(modelId))
      if (nozzle > 0) params.set('nozzle_diameter_mm', String(nozzle))
      statusEl.classList.remove('fm-alert-error')
      statusEl.textContent = t('fdbContrib.community.searching')
      try {
        const data = await api.get<SearchPage>(`/filamentdb/print-profiles?${params}`)
        page += 1
        data.items.forEach(item => found.set(item.id, item))
        loaded += data.items.length
        total = data.total
        results.insertAdjacentHTML('beforeend', data.items.map(item => renderCommunityCard(item, { canRate: false, canAdopt: setup.canAdopt, showOrigin: true })).join(''))
        statusEl.textContent = loaded
          ? t('fdbContrib.community.resultCount', { shown: String(loaded), total: String(total ?? loaded) })
          : t('fdbContrib.community.searchEmpty')
        more.classList.toggle('hidden', data.items.length < SEARCH_PAGE_SIZE || !hasMoreResults(loaded, total))
      } catch (error) {
        statusEl.textContent = contribErrorMessage(error)
        statusEl.classList.add('fm-alert-error')
        more.classList.add('hidden')
      }
    }

    form.addEventListener('submit', (event) => { event.preventDefault(); void fetchPage(true) })
    body!.querySelector('[data-cs-load-more]')?.addEventListener('click', () => void fetchPage(false))

    function openAdopt(profile: CommunityProfile) {
      const e = escapeHtml
      const preferred = printers.find(p => profileModelMismatch(profile, p) === null) ?? printers[0]
      const options = printers.map(p => `<option value="${p.id}"${p.id === preferred?.id ? ' selected' : ''}>${e(printerOptionLabel(p))}</option>`).join('')
      panel.innerHTML = `<h3>${e(t('fdbContrib.community.adoptTitle'))}</h3>
        <p class="pp-muted">${e(profileOriginText(profile))}</p>
        <div class="pp-field"><label for="cs-printer" class="fm-label">${e(t('fdbContrib.community.adoptPrinter'))}</label>
          <select id="cs-printer" class="fm-select" data-cs-printer>${options}</select></div>
        <div class="fm-alert-error hidden" data-cs-warning role="alert"></div>
        <p class="fm-alert-error hidden" data-cs-adopt-error role="alert"></p>
        <p class="pp-muted" data-cs-adopt-ok role="status"></p>
        <div class="pp-actions"><button type="button" class="fm-btn fm-btn-outline" data-cs-adopt-cancel>${e(t('common.cancel'))}</button>
          <button type="button" class="fm-btn fm-btn-fdb" data-cs-adopt-confirm>${e(t(profile.is_own ? 'fdbContrib.community.duplicate' : 'fdbContrib.community.adopt'))}</button></div>`
      panel.classList.remove('hidden')
      const select = panel.querySelector('[data-cs-printer]') as HTMLSelectElement
      const warning = panel.querySelector('[data-cs-warning]') as HTMLElement
      const errorBox = panel.querySelector('[data-cs-adopt-error]') as HTMLElement
      const ok = panel.querySelector('[data-cs-adopt-ok]') as HTMLElement
      const confirm = panel.querySelector('[data-cs-adopt-confirm]') as HTMLButtonElement
      const selected = () => printers.find(p => String(p.id) === select.value)
      const refresh = () => {
        const mismatch = profileModelMismatch(profile, selected())
        const text = mismatch ? t(`fdbContrib.community.warn_${mismatch}`, { model: profileModelLabel(profile) }) : ''
        warning.textContent = text
        warning.classList.toggle('hidden', !text)
      }
      select.addEventListener('change', refresh)
      refresh()
      panel.querySelector('[data-cs-adopt-cancel]')?.addEventListener('click', () => panel.classList.add('hidden'))
      confirm.addEventListener('click', async () => {
        const printer = selected()
        if (!printer) return
        confirm.disabled = true
        errorBox.classList.add('hidden')
        try {
          await api.post(`/filamentdb/print-profiles/${profile.id}/import`, { filament_id: filamentId, printer_id: printer.id, duplicate: Boolean(profile.is_own || profile.imported_printer_ids?.includes(printer.id)) })
          ok.textContent = t('fdbContrib.community.adopted')
          setup.onAdopted?.()
        } catch (error) {
          errorBox.textContent = contribErrorMessage(error)
          errorBox.classList.remove('hidden')
          confirm.disabled = false
        }
      })
    }

    body!.addEventListener('click', (event) => {
      const adopt = (event.target as HTMLElement).closest('[data-cp-adopt]') as HTMLElement | null
      if (!adopt) return
      const profile = found.get(Number(adopt.dataset.cpAdopt))
      if (profile) openAdopt(profile)
    })
  }
}
