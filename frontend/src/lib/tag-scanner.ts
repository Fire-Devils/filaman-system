/**
 * Following a tag reader to the spool it just scanned.
 *
 * A reader posts every scan to /api/v1/tag/scan, which records it on the
 * reader's row in tag_readers, and the browser polls /api/v1/tag/last-scan for it.
 * The database is the hand-off on purpose: FilaMan runs several Gunicorn
 * workers and its event bus is per-worker, so an event would only reach the
 * browsers that happen to hang off the same one.
 *
 * The preference is per browser and off by default. A page that navigates
 * itself unasked is hostile, and the kiosk on the wall and the laptop in the
 * workshop want opposite things from the same account.
 */

const ENABLED_KEY = 'tag-scanner-auto-open'
const READER_KEY = 'tag-scanner-reader-id'

/** localStorage throws in a private window and when site data is blocked. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A preference that cannot be stored is not worth failing over.
  }
}

export function isAutoOpenEnabled(): boolean {
  return read(ENABLED_KEY) === 'true'
}

export function setAutoOpenEnabled(enabled: boolean): void {
  write(ENABLED_KEY, enabled ? 'true' : 'false')
}

/**
 * Which reader this browser follows, or null for whichever scanned last.
 *
 * A reader id, not a device id: a reader may be a registered scale, an app on
 * an API key or anything else that can hold a credential, and only the scale
 * has a row in the device registry.
 */
export function getBoundReaderId(): string | null {
  return read(READER_KEY) || null
}

export function setBoundReaderId(readerId: string | null): void {
  write(READER_KEY, readerId)
}

/**
 * Why the page you are suddenly looking at changed.
 *
 * The jump is a real navigation, so a note put up before it dies with the old
 * page. The reason is handed to the new one instead, through sessionStorage
 * because it belongs to this tab and to this navigation only - localStorage
 * would show the note in every other tab as well.
 *
 * It is taken rather than read: the note explains one arrival, and a reload an
 * hour later should not repeat it. The age check covers the same thing for a
 * navigation that never completed.
 */
const LANDED_KEY = 'tag-scanner-landed'

export interface JumpMemo {
  uid: string
  spoolId: number
  at: number
}

export function rememberJump(memo: JumpMemo): void {
  try {
    sessionStorage.setItem(LANDED_KEY, JSON.stringify(memo))
  } catch {
    // Without it the page still opens, it just does not say why.
  }
}

export function takeRememberedJump(now = Date.now(), maxAgeMs = 15000): JumpMemo | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(LANDED_KEY)
    sessionStorage.removeItem(LANDED_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const memo = JSON.parse(raw) as JumpMemo
    if (typeof memo?.at !== 'number' || now - memo.at > maxAgeMs) return null
    return memo
  } catch {
    return null
  }
}

export function lastScanUrl(readerId: string | null): string {
  return readerId === null
    ? '/api/v1/tag/last-scan'
    : `/api/v1/tag/last-scan?reader_id=${encodeURIComponent(readerId)}`
}

/**
 * Pages a scan may navigate away from.
 *
 * An allowlist, not a denylist, and that is the whole point. Plugins bring
 * their own pages at runtime through /api/v1/plugin-nav, so no list written
 * here can know them; under a denylist every plugin installed tomorrow would
 * default to having the page pulled out from under it. Under an allowlist the
 * worst a new page gets is an offer.
 *
 * What is on it: the places where a scan continues the thought you were
 * already having. You are looking at stock, you put a spool on the scale, you
 * want that spool. Everywhere else the scan is an interruption and gets
 * offered rather than obeyed. /spools/4/edit is deliberately not matched -
 * half-typed work must not vanish because somebody weighed something.
 */
const JUMP_ROUTES = [/^\/$/, /^\/(spools|filaments)(\/\d+)?\/?$/]

export function isJumpRoute(pathname: string): boolean {
  return JUMP_ROUTES.some((pattern) => pattern.test(pathname))
}

function isTypingTarget(element: Element | null): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (element as HTMLElement).isContentEditable === true
}

/**
 * Whether a scan may move this page right now, as opposed to being offered.
 *
 * Deliberately conservative: the cost of not jumping is one click on a note
 * that names the spool, the cost of jumping at the wrong moment is lost work.
 */
export function mayNavigate(doc: Document, pathname: string): boolean {
  if (!isJumpRoute(pathname)) return false
  if (isTypingTarget(doc.activeElement)) return false
  if (doc.querySelector('dialog[open]')) return false
  return true
}
