/**
 * Preise aus der FilaMan-DB (Karte auf der Filament-Detailseite).
 * Nur für Filamente, die mit der FilaMan-DB verknüpft sind. Die DB nimmt Preise nur mit
 * Shop-Link an; ohne Link lässt sich der Preis nur lokal am Filament speichern.
 */

import { api } from './api'
import { getMe, hasPermission } from './auth'
import { contribErrorMessage, loadContribContext, noTokenNoticeHtml } from './filamentdb-contrib'
import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { getCurrency } from './format'
import { t } from './i18n'

export interface FdbOfferPrice {
  price: number
  reported_at?: string | null
}

export interface FdbOffer {
  id: number
  url: string
  shop_name?: string | null
  currency?: string | null
  status?: string | null
  current_price?: number | null
  last_reported_at?: string | null
  report_count?: number | null
  prices?: FdbOfferPrice[]
}

export type OfferReason = 'dead_link' | 'wrong_price' | 'unavailable'
export const OFFER_REASONS: OfferReason[] = ['dead_link', 'wrong_price', 'unavailable']

/** Nur http(s)-Links bis 1000 Zeichen; die DB lehnt alles andere ab. */
export function isValidShopUrl(value: string | null | undefined): boolean {
  const text = (value ?? '').trim()
  if (!text || text.length > 1000 || /\s/.test(text)) return false
  try {
    const url = new URL(text)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

export function isValidCurrency(value: string | null | undefined): boolean {
  return /^[A-Za-z]{3}$/.test((value ?? '').trim())
}

export function parsePrice(value: string | number | null | undefined): number | null {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim().replace(',', '.'))
  return Number.isFinite(number) && number > 0 && number <= 100000 ? number : null
}

export interface OfferDraft {
  url: string
  price: string | number
  currency: string
}

/** "An FilaMan-DB senden" ist nur mit gültigem Shop-Link, Preis und Währung aktiv. */
export function canSendOffer(draft: OfferDraft): boolean {
  return isValidShopUrl(draft.url) && parsePrice(draft.price) !== null && isValidCurrency(draft.currency)
}

/** "Nur lokal speichern" braucht nur einen Preis; ein angegebener Link muss gültig sein. */
export function canSaveLocally(draft: OfferDraft): boolean {
  return parsePrice(draft.price) !== null && isValidCurrency(draft.currency) && (!draft.url.trim() || isValidShopUrl(draft.url))
}

export function isActiveOffer(offer: Pick<FdbOffer, 'status'>): boolean {
  const status = (offer.status ?? 'active').toLowerCase()
  return status === 'active'
}

function formatMoney(value: number, currency: string | null | undefined): string {
  const code = (currency ?? '').toUpperCase()
  try {
    if (code) return new Intl.NumberFormat(localStorage.getItem('lang') === 'de' ? 'de-DE' : undefined, { style: 'currency', currency: code }).format(value)
  } catch { /* unbekannte Währung: als Zahl */ }
  return `${value.toFixed(2)} ${code}`.trim()
}

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

/** Shop-Name oder, wenn die DB keinen nennt, der Host des Links. */
export function offerShopName(offer: FdbOffer): string {
  if (offer.shop_name) return offer.shop_name
  try { return new URL(offer.url).hostname } catch { return t('fdbOffers.unknownShop') }
}

/** "19,90 € · 18,50 € · 21,00 €": die letzten Preise, neueste zuerst. */
export function offerHistoryText(offer: FdbOffer, limit = 4): string {
  const prices = (offer.prices ?? []).filter(p => typeof p.price === 'number')
  if (prices.length < 2) return ''
  return prices.slice(0, limit).map(p => formatMoney(p.price, offer.currency)).join(' · ')
}

export function renderOffer(offer: FdbOffer, options: { canReport: boolean }): string {
  const e = escapeHtml
  const active = isActiveOffer(offer)
  const safeUrl = isValidShopUrl(offer.url) ? offer.url : ''
  const name = e(offerShopName(offer))
  const shop = safeUrl ? `<a href="${e(safeUrl)}" target="_blank" rel="noopener noreferrer">${name}</a>` : name
  const price = typeof offer.current_price === 'number' ? e(formatMoney(offer.current_price, offer.currency)) : '–'
  const date = formatDate(offer.last_reported_at)
  const history = offerHistoryText(offer)
  const badge = active ? '' : ` <span class="fdb-status fdb-status-error" data-offer-inactive>${e(t('fdbOffers.inactive'))}</span>`
  const report = options.canReport && active
    ? `<button type="button" class="fm-btn fm-btn-fdb fm-btn-sm" data-offer-report="${Number(offer.id)}">${e(t('fdbOffers.report'))}</button>`
    : ''
  return `<article class="fm-card pp-card${active ? '' : ' fdb-offer-inactive'}" data-offer-card="${Number(offer.id)}">
    <header><h3>${shop}${badge}</h3><strong>${price}</strong></header>
    <p class="pp-muted">${date ? e(t('fdbOffers.lastReported', { date })) : ''}</p>
    ${history ? `<p class="pp-muted" data-offer-history>${e(t('fdbOffers.history', { prices: history }))}</p>` : ''}
    <div class="pp-card-actions">${report}</div>
    <p class="pp-muted" data-offer-message role="status"></p></article>`
}

export interface FdbOffersOptions {
  mount: HTMLElement
  filamentId: number
  filamentdbId: number
  price?: number | null
  priceCurrency?: string | null
  shopUrl?: string | null
}

export async function initFilamentDbOffers(options: FdbOffersOptions): Promise<void> {
  const { mount, filamentdbId } = options
  const user = await getMe()
  const status = await api.get<{ plugin_active: boolean }>('/filamentdb/contributions/status').catch(() => null)
  if (!status?.plugin_active || !user) return
  mount.classList.remove('hidden')
  const details = mount.querySelector('[data-fo-details]') as HTMLDetailsElement | null
  let loaded = false
  const open = () => {
    if (loaded) return
    loaded = true
    void loadOffers(options, user)
  }
  if (details) details.addEventListener('toggle', () => { if (details.open) open() })
  else open()
  void filamentdbId
}

function openReportDialog(offerId: number): Promise<{ reason: OfferReason; comment: string } | null> {
  const e = escapeHtml
  document.getElementById('fdb-offer-report-dialog')?.remove()
  const dialog = document.createElement('dialog')
  dialog.id = 'fdb-offer-report-dialog'
  dialog.className = 'fm-form-dialog'
  dialog.setAttribute('aria-labelledby', 'fdb-offer-report-title')
  const reasons = OFFER_REASONS.map((reason, index) =>
    `<label class="fm-checkbox-label"><input type="radio" name="offer-reason" value="${reason}"${index === 0 ? ' checked' : ''} /> ${e(t(`fdbOffers.reasons.${reason}`))}</label>`).join('<br>')
  dialog.innerHTML = `
    <header class="fm-section-header fm-form-dialog-header"><h2 id="fdb-offer-report-title">${e(t('fdbOffers.reportTitle'))}</h2></header>
    <div class="fm-section-body">
      <div class="pp-field"><span class="fm-label">${e(t('fdbOffers.reasonLabel'))}</span><br>${reasons}</div>
      <div class="pp-field"><label for="offer-comment" class="fm-label">${e(t('fdbOffers.comment'))}</label>
        <textarea id="offer-comment" class="fm-input" rows="3" maxlength="500" data-offer-comment></textarea></div>
      <div class="fdb-actions">
        <button type="button" class="fm-btn fm-btn-outline" data-dialog-close>${e(t('common.cancel'))}</button>
        <button type="button" class="fm-btn fm-btn-fdb" data-offer-report-send>${e(t('fdbOffers.reportSend'))}</button>
      </div>
    </div>`
  document.body.appendChild(dialog)
  void offerId
  return new Promise(resolve => {
    let result: { reason: OfferReason; comment: string } | null = null
    const controller = bindFormDialog(dialog, {
      onClose: () => { dialog.remove(); resolve(result) },
    })
    dialog.querySelector('[data-offer-report-send]')!.addEventListener('click', () => {
      const reason = (dialog.querySelector('input[name="offer-reason"]:checked') as HTMLInputElement | null)?.value as OfferReason | undefined
      if (!reason) return
      result = { reason, comment: (dialog.querySelector('[data-offer-comment]') as HTMLTextAreaElement).value.trim() }
      controller.close()
    })
    controller.open()
  })
}

async function loadOffers(options: FdbOffersOptions, user: NonNullable<Awaited<ReturnType<typeof getMe>>>): Promise<void> {
  const { mount, filamentId, filamentdbId } = options
  const e = escapeHtml
  const context = await loadContribContext()
  const list = mount.querySelector('[data-fo-list]') as HTMLElement
  const formBox = mount.querySelector('[data-fo-form]') as HTMLElement
  const canReport = context.canContribute
  const canLocal = hasPermission(user, 'filaments:update')

  const load = async () => {
    list.innerHTML = `<p class="pp-muted">${e(t('common.loading'))}</p>`
    try {
      const offers = await api.get<FdbOffer[]>(`/filamentdb/filaments/${filamentdbId}/offers`)
      const rows = Array.isArray(offers) ? offers : []
      list.innerHTML = rows.length
        ? rows.map(offer => renderOffer(offer, { canReport })).join('')
        : `<p class="pp-muted">${e(t('fdbOffers.empty'))}</p>`
    } catch (error) {
      list.innerHTML = `<p class="fm-alert-error" role="alert">${e(contribErrorMessage(error))}</p>`
    }
  }

  list.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest('[data-offer-report]') as HTMLButtonElement | null
    if (!button) return
    const card = button.closest('[data-offer-card]') as HTMLElement
    const message = card.querySelector('[data-offer-message]') as HTMLElement
    const picked = await openReportDialog(Number(button.dataset.offerReport))
    if (!picked) return
    button.disabled = true
    try {
      await api.post(`/filamentdb/offers/${button.dataset.offerReport}/report`, {
        reason: picked.reason,
        ...(picked.comment ? { comment: picked.comment } : {}),
      })
      message.textContent = t('fdbOffers.reported')
    } catch (error) {
      message.textContent = contribErrorMessage(error)
      button.disabled = false
    }
  })

  // Formular "Preis melden"
  const currency = (options.priceCurrency || getCurrency() || 'EUR').toUpperCase()
  const showSend = canReport
  const noToken = context.needsToken ? noTokenNoticeHtml() : ''
  if (!showSend && !canLocal) {
    formBox.innerHTML = noToken
  } else {
    formBox.innerHTML = `
      <h3 style="margin: 12px 0 4px;">${e(t('fdbOffers.formTitle'))}</h3>
      ${noToken}
      <div class="pp-field"><label for="fo-url" class="fm-label">${e(t('fdbOffers.shopUrl'))}</label>
        <input type="url" id="fo-url" class="fm-input" maxlength="1000" placeholder="https://" data-fo-url /></div>
      <div class="pp-field"><label for="fo-price" class="fm-label">${e(t('fdbOffers.price'))}</label>
        <input type="number" id="fo-price" class="fm-input" step="0.01" min="0.01" max="100000" data-fo-price /></div>
      <div class="pp-field"><label for="fo-currency" class="fm-label">${e(t('fdbOffers.currency'))}</label>
        <input type="text" id="fo-currency" class="fm-input" maxlength="3" data-fo-currency /></div>
      <p class="pp-muted hidden" data-fo-nolink>${e(t('fdbOffers.noLinkHint'))}</p>
      <div class="pp-card-actions">
        ${showSend ? `<button type="button" class="fm-btn fm-btn-fdb" data-fo-send disabled>${e(t('fdbOffers.send'))}</button>` : ''}
        ${canLocal ? `<button type="button" class="fm-btn fm-btn-outline" data-fo-local disabled>${e(t('fdbOffers.saveLocal'))}</button>` : ''}
      </div>
      <p class="pp-muted" data-fo-message role="status"></p>`
    const urlInput = formBox.querySelector('[data-fo-url]') as HTMLInputElement
    const priceInput = formBox.querySelector('[data-fo-price]') as HTMLInputElement
    const currencyInput = formBox.querySelector('[data-fo-currency]') as HTMLInputElement
    const sendButton = formBox.querySelector('[data-fo-send]') as HTMLButtonElement | null
    const localButton = formBox.querySelector('[data-fo-local]') as HTMLButtonElement | null
    const hint = formBox.querySelector('[data-fo-nolink]') as HTMLElement
    const message = formBox.querySelector('[data-fo-message]') as HTMLElement
    urlInput.value = options.shopUrl ?? ''
    priceInput.value = options.price != null ? String(options.price) : ''
    currencyInput.value = currency
    const draft = (): OfferDraft => ({ url: urlInput.value, price: priceInput.value, currency: currencyInput.value })
    const refresh = () => {
      const d = draft()
      if (sendButton) sendButton.disabled = !canSendOffer(d)
      if (localButton) localButton.disabled = !canSaveLocally(d)
      hint.classList.toggle('hidden', isValidShopUrl(d.url) || !canLocal)
    }
    for (const input of [urlInput, priceInput, currencyInput]) input.addEventListener('input', refresh)
    refresh()

    sendButton?.addEventListener('click', async () => {
      const d = draft()
      if (!canSendOffer(d)) return
      sendButton.disabled = true
      message.textContent = ''
      try {
        await api.post(`/filamentdb/filaments/${filamentdbId}/offers`, {
          url: d.url.trim(), price: parsePrice(d.price), currency: d.currency.trim().toUpperCase(),
        })
        message.textContent = t('fdbOffers.sent')
        await load()
      } catch (error) {
        message.textContent = contribErrorMessage(error)
      } finally {
        refresh()
      }
    })
    localButton?.addEventListener('click', async () => {
      const d = draft()
      if (!canSaveLocally(d)) return
      localButton.disabled = true
      message.textContent = ''
      try {
        await api.patch(`/filaments/${filamentId}`, {
          price: parsePrice(d.price),
          price_currency: d.currency.trim().toUpperCase(),
          ...(d.url.trim() ? { shop_url: d.url.trim() } : {}),
        })
        message.textContent = t('fdbOffers.savedLocal')
      } catch (error) {
        message.textContent = contribErrorMessage(error)
      } finally {
        refresh()
      }
    })
  }
  await load()
}
