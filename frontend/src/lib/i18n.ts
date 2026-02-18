/**
 * i18n – lightweight client-side translation helper
 *
 * Usage in <script> blocks:
 *   import { t, initI18n } from '../lib/i18n'
 *   await initI18n()          // loads dict based on localStorage 'lang' or /api/v1/me
 *   t('nav.dashboard')        // => "Dashboard" | "Dashboard" (same in de)
 *   t('spools.spoolId', { id: 42 })  // => "Spool #42" | "Spule #42"
 */

import en from '../i18n/en.json'
import de from '../i18n/de.json'

type Dict = Record<string, any>

const dictionaries: Record<string, Dict> = { en, de }
const FALLBACK = 'en'

let currentLang: string = 'en'
let currentDict: Dict = en
let fallbackDict: Dict = en
let _ready = false

/**
 * Resolve a dotted key like "nav.dashboard" from a nested dict.
 */
function resolve(dict: Dict, key: string): string | undefined {
  const parts = key.split('.')
  let node: any = dict
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[p]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * Translate a key, with optional interpolation variables.
 * Variables use {name} syntax: t('spools.spoolId', { id: 5 }) => "Spool #5"
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text = resolve(currentDict, key) ?? resolve(fallbackDict, key) ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}

/**
 * Get the current language code.
 */
export function getLang(): string {
  return currentLang
}

/**
 * Set language and update dict. Does NOT persist – call setLangAndPersist for that.
 */
export function setLang(lang: string): void {
  currentLang = lang
  currentDict = dictionaries[lang] ?? dictionaries[FALLBACK]
  fallbackDict = dictionaries[FALLBACK]
  document.documentElement.setAttribute('lang', lang)
}

/**
 * Initialise i18n. Reads language from:
 * 1. localStorage('lang')  – fast, no network
 * 2. falls back to 'en'
 *
 * The Layout's auth check will call syncLangFromUser() after /api/v1/me
 * to align with the server-stored preference.
 */
export async function initI18n(): Promise<void> {
  if (_ready) return
  const stored = localStorage.getItem('lang')
  const lang = stored || FALLBACK
  setLang(lang)
  translatePage()
  _ready = true
}

/**
 * Scan the DOM for data-i18n attributes and update them.
 */
export function translatePage(): void {
  // Translate text content
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (key) {
      el.textContent = t(key)
    }
  })

  // Translate placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder')
    if (key && el instanceof HTMLInputElement) {
      el.placeholder = t(key)
    }
  })
  
  // Translate titles (tooltips)
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title')
    if (key && el instanceof HTMLElement) {
      el.title = t(key)
    }
  })
}

/**
 * Called after /api/v1/me to sync language from user profile.
 * If different from current, updates localStorage + reloads so
 * all static HTML is re-rendered in the correct language.
 */
export function syncLangFromUser(userLang: string): void {
  const stored = localStorage.getItem('lang')
  if (stored !== userLang) {
    localStorage.setItem('lang', userLang)
    // If the page was already rendered in a different language, reload
    if (_ready && currentLang !== userLang) {
      window.location.reload()
      return
    }
    setLang(userLang)
  }
}
