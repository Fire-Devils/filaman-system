/**
 * Frontend-Cache für API-Daten mit localStorage + TTL
 * 
 * Features:
 * - TTL-basiertes Caching (Standard: 5 Minuten)
 * - Automatische Invalidierung bei Page Refresh
 * - Manuelle Invalidierung nach Create/Update/Delete
 * - Sequential Fetching für SQLite-Umgebungen
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 Minuten
const CACHE_PREFIX = 'filaman-cache:'
const SESSION_KEY = 'filaman-cache-session'

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

const currentSessionId = getSessionId()

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
  
  // Fetch ausführen
  const data = await fetchFn()
  
  // In Cache speichern
  try {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      sessionId: currentSessionId
    }
    localStorage.setItem(cacheKey, JSON.stringify(entry))
  } catch {
    // Cache-Write fehlgeschlagen (z.B. localStorage voll), ignorieren
  }
  
  return data
}

/**
 * Invalidiert einen spezifischen Cache-Eintrag
 */
export function invalidateCache(key: string): void {
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
