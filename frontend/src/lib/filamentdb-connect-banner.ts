/**
 * Hinweis-Banner „Mit FilaMan-DB verbinden“ über den Hersteller- und Filamentlisten.
 * Zielseite: pages/filamentdb.astro
 */

import { loadContribContext, type ContribContext } from './filamentdb-contrib'
import { t } from './i18n'

export const BANNER_HIDE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export type ConnectBannerVariant = 'noToken' | 'noPlugin'

/**
 * Banner nur mit Recht filamentdb:contribute und wenn Plugin oder Token fehlen.
 * Der Text richtet sich danach, was fehlt (Plugin aktiv, aber kein Token: „noToken“).
 */
export function connectBannerVariant(context: Pick<ContribContext, 'hasPermission' | 'pluginActive' | 'tokenSaved'>): ConnectBannerVariant | null {
  if (!context.hasPermission) return null
  if (!context.pluginActive) return 'noPlugin'
  return context.tokenSaved ? null : 'noToken'
}

export function bannerStorageKey(userId: number | null): string {
  return `fdbConnectBannerHiddenUntil:${userId ?? 'anon'}`
}

export function isBannerDismissed(userId: number | null, now = Date.now()): boolean {
  try {
    const until = Number(localStorage.getItem(bannerStorageKey(userId)) ?? 0)
    return Number.isFinite(until) && until > now
  } catch { return false }
}

export function dismissBanner(userId: number | null, now = Date.now()): void {
  try { localStorage.setItem(bannerStorageKey(userId), String(now + BANNER_HIDE_DAYS * DAY_MS)) } catch { /* ohne Speicher erscheint das Banner wieder */ }
}

const ICON_ATTRS = 'viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const CHIP_ICONS = {
  match: `<svg ${ICON_ATTRS}><path d="m3 8.5 3.2 3.2L13 4.5"/></svg>`,
  submit: `<svg ${ICON_ATTRS}><path d="M8 13V3M4 7l4-4 4 4"/></svg>`,
  profiles: `<svg ${ICON_ATTRS}><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/></svg>`,
}

const MARK = `<svg class="fdb-banner-mark" viewBox="0 0 56 56" aria-hidden="true">
  <defs><linearGradient id="fdb-banner-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent-2)"/></linearGradient></defs>
  <rect x="1" y="1" width="54" height="54" rx="16" style="fill:var(--bg-elevated)" stroke="url(#fdb-banner-g)" stroke-width="1.5"/>
  <ellipse cx="28" cy="18" rx="14" ry="5" fill="none" stroke="url(#fdb-banner-g)" stroke-width="2.2"/>
  <path d="M14 18v10c0 2.8 6.3 5 14 5s14-2.2 14-5V18" fill="none" stroke="url(#fdb-banner-g)" stroke-width="2.2"/>
  <path d="M14 28v10c0 2.8 6.3 5 14 5s14-2.2 14-5V28" fill="none" stroke="url(#fdb-banner-g)" stroke-width="2.2" opacity=".6"/>
  <circle cx="42" cy="42" r="8" style="fill:var(--accent-3)"/>
  <path d="M38.5 42h7M42 38.5v7" style="stroke:var(--bg)" stroke-width="2.2" stroke-linecap="round"/>
</svg>`

export function connectBannerHtml(variant: ConnectBannerVariant): string {
  const e = (key: string) => t(`fdbConnect.banner.${key}`)
  const chip = (icon: keyof typeof CHIP_ICONS, key: string) => `<span class="fdb-chip">${CHIP_ICONS[icon]}${e(key)}</span>`
  return `<div class="fdb-banner" role="region" aria-label="${e(`title${variant === 'noToken' ? 'NoToken' : 'NoPlugin'}`)}" data-fdb-connect-banner="${variant}">
    ${MARK}
    <div class="fdb-banner-text">
      <span class="fdb-banner-tag">${e(variant === 'noToken' ? 'tagNoToken' : 'tagNoPlugin')}</span>
      <strong>${e(variant === 'noToken' ? 'titleNoToken' : 'titleNoPlugin')}</strong>
      <span class="fdb-banner-desc">${e(variant === 'noToken' ? 'descNoToken' : 'descNoPlugin')}</span>
      <div class="fdb-chips">${chip('match', 'chipMatch')}${chip('submit', 'chipSubmit')}${chip('profiles', 'chipProfiles')}</div>
    </div>
    <a class="fm-btn fm-btn-primary fdb-banner-cta" href="/filamentdb" data-fdb-banner-cta>${e(variant === 'noToken' ? 'ctaNoToken' : 'ctaNoPlugin')}</a>
    <button type="button" class="fdb-banner-close" data-fdb-banner-close title="${t('fdbConnect.dismiss')}" aria-label="${t('fdbConnect.dismiss')}">&#10005;</button>
  </div>`
}

/**
 * Rendert das Banner in `host`, falls es passt und nicht ausgeblendet wurde.
 * Der Host gehört zur Seite und wird bei Client-Navigation ersetzt; der Klick-Listener
 * hängt am Host und wird mit `signal` abgemeldet.
 */
export async function mountConnectBanner(host: HTMLElement | null, signal?: AbortSignal): Promise<void> {
  if (!host) return
  host.innerHTML = ''
  const context = await loadContribContext()
  if (signal?.aborted) return
  const variant = connectBannerVariant(context)
  if (!variant || isBannerDismissed(context.userId)) return
  host.innerHTML = connectBannerHtml(variant)
  host.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest('[data-fdb-banner-close]')) return
    dismissBanner(context.userId)
    host.innerHTML = ''
  }, { signal })
}
