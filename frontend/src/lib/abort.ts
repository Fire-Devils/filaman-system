/**
 * Global AbortController für Navigation-Cleanup.
 * 
 * Bei Page-Unload (Navigation) werden alle laufenden Fetch-Requests abgebrochen,
 * damit sie die HTTP/2-Connection nicht blockieren.
 * 
 * Problem: Chrome hält Requests von der vorherigen Seite offen und diese
 * blockieren die Connection für die neue Seite → Hänger von 30-50+ Sekunden.
 * 
 * Lösung: Alle Requests bekommen ein AbortSignal. Bei Navigation wird
 * abort() aufgerufen und die Requests werden sofort beendet.
 * 
 * Usage:
 *   import { getAbortSignal } from '../lib/abort'
 *   
 *   fetch('/api/...', { signal: getAbortSignal() })
 */

let controller = new AbortController()

/**
 * Gibt das aktuelle AbortSignal zurück (für fetch-Optionen).
 * Alle Requests sollten dieses Signal nutzen.
 */
export function getAbortSignal(): AbortSignal {
  return controller.signal
}

/**
 * Bricht alle laufenden Requests ab und erstellt einen neuen Controller.
 * Wird bei Navigation automatisch aufgerufen.
 */
export function abortAllRequests(): void {
  controller.abort()
  controller = new AbortController()
}

/**
 * Prüft ob ein Error ein AbortError ist (Request wurde abgebrochen).
 * Nützlich für catch-Blöcke um abgebrochene Requests zu ignorieren.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

// Bei Navigation alle Requests abbrechen
if (typeof window !== 'undefined') {
  // pagehide ist der moderne Event (funktioniert auch mit bfcache)
  window.addEventListener('pagehide', () => abortAllRequests())
  
  // beforeunload als Fallback für ältere Browser
  window.addEventListener('beforeunload', () => abortAllRequests())
}
