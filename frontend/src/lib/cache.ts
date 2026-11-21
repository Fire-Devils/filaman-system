/**
 * Frontend-Cache für API-Daten mit localStorage + TTL
 * 
 * Features:
 * - TTL-basiertes Caching (Standard: 5 Minuten)
 * - Automatische Invalidierung bei Page Refresh
 * - Manuelle Invalidierung nach Create/Update/Delete
 * - Sequential Fetching für SQLite-Umgebungen
 */

import { isAbortError } from './abort'

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 Minuten
const CACHE_PREFIX = 'filaman-cache:'
const SESSION_KEY = 'filaman-cache-session'
const pendingReads = new Map<string, Promise<unknown>>()

interface CacheEntry<T> {
  data: T
  timestamp: number
  sessionId: string
}

// Generiere eine Session-ID pro Page Load
// Bei F5/Refresh wird eine neue Session-ID generiert → Cache wird ignoriert
function getSessionId(): string {
  // sessionStorage wird bei Page Refresh NICHT gelöscht, aber bei Tab-Schließung schon
  // Wir nutzen eine Kombination: sessionStorage + performance.now für Refresh-Detection
  let sessionId = sessionStorage.getItem(SESSION_KEY)
  
  // Prüfe ob die Seite frisch geladen wurde (nicht nur Navigation)
  const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const isReload = navEntry?.type === 'reload'
  
  if (!sessionId || isReload) {
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(SESSION_KEY, sessionId)
  }
  
  return sessionId
}

let currentSessionId: string
try {
  currentSessionId = getSessionId()
} catch {
  currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Holt Daten aus dem Cache oder führt den Fetch aus
 */
export async function cachedFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  const cacheKey = CACHE_PREFIX + key
  
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      const entry: CacheEntry<T> = JSON.parse(cached)
      const age = Date.now() - entry.timestamp
      
      // Cache ist gültig wenn:
      // 1. Gleiche Session (kein Page Refresh)
      // 2. Innerhalb des TTL
      if (entry.sessionId === currentSessionId && age < ttlMs) {
        return entry.data
      }
    }
  } catch {
    // Cache-Read fehlgeschlagen, ignorieren
  }
  
  const pending = pendingReads.get(key)
  if (pending) {
    try {
      return await pending as T
    } catch (error) {
      if (!isAbortError(error)) throw error
      // Navigation may cancel the previous panel's shared request.
      return cachedFetch(key, fetchFn, ttlMs)
    }
  }

  const read = Promise.resolve().then(async () => {
    try {
      let data: T
      try {
        data = await fetchFn()
      } catch (error) {
        if (pendingReads.get(key) !== read) return cachedFetch(key, fetchFn, ttlMs)
        throw error
      }
      // Invalidated reads must neither refill storage nor return obsolete data to callers.
      if (pendingReads.get(key) !== read) return cachedFetch(key, fetchFn, ttlMs)
      try {
        const entry: CacheEntry<T> = { data, timestamp: Date.now(), sessionId: currentSessionId }
        localStorage.setItem(cacheKey, JSON.stringify(entry))
      } catch {
        // Cache-Write fehlgeschlagen (z.B. localStorage voll), ignorieren
      }
      return data
    } finally {
      if (pendingReads.get(key) === read) pendingReads.delete(key)
    }
  })
  pendingReads.set(key, read)
  return read
}

/**
 * Invalidiert einen spezifischen Cache-Eintrag
 */
export function invalidateCache(key: string): void {
  pendingReads.delete(key)
  try {
    localStorage.removeItem(CACHE_PREFIX + key)
  } catch {
    // Ignorieren
  }
}

/**
 * Invalidiert alle Cache-Einträge für einen Prefix
 * z.B. invalidateCachePrefix('filaments') löscht 'filaments', 'filaments-list', etc.
 */
export function invalidateCachePrefix(prefix: string): void {
  for (const key of pendingReads.keys()) {
    if (key.startsWith(prefix)) pendingReads.delete(key)
  }
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(CACHE_PREFIX + prefix)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key))
  } catch {
    // Ignorieren
  }
}

/**
 * Invalidiert den gesamten FilaMan-Cache
 */
export function invalidateAllCaches(): void {
  pendingReads.clear()
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key))
  } catch {
    // Ignorieren
  }
}

// ============================================================================
// Vordefinierte Cache-Keys für häufig genutzte Daten
// ============================================================================

export const CACHE_KEYS = {
  FILAMENTS: 'filaments',
  LOCATIONS: 'locations',
  COLORS: 'colors',
  MANUFACTURERS: 'manufacturers',
  STATUSES: 'statuses',
  FILAMENT_TYPES: 'filament-types',
  FILAMENT_FILTER_OPTIONS: 'filament-filter-options-v2',
  SPOOL_FILTER_OPTIONS: 'spool-filter-options-v3',
} as const

// ============================================================================
// Sequential Fetching für SQLite-Umgebungen
// ============================================================================

/**
 * Führt mehrere Fetch-Operationen sequentiell aus (nicht parallel)
 * Reduziert DB-Lock-Konflikte bei SQLite
 */
export async function fetchSequential<T extends readonly (() => Promise<unknown>)[]>(
  fetchFns: T
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = []
  
  for (const fn of fetchFns) {
    results.push(await fn())
  }
  
  return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> }
}

/**
 * Wrapper für fetchAllPages mit Caching
 */
export async function cachedFetchAllPages<T = unknown>(
  cacheKey: string,
  baseUrl: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<{ items: T[], total: number }> {
  return cachedFetch(
    cacheKey,
    async () => {
      const { fetchAllPages } = await import('./api')
      return fetchAllPages<T>(baseUrl)
    },
    ttlMs
  )
}
