/** Same-origin path to return to after login, or null when unsafe. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  if (/[\u0000-\u001f]/.test(raw)) return null
  const path = raw.split(/[?#]/)[0]
  if (path === '/login' || path.startsWith('/login/')) return null
  return raw
}

/** `/login` URL that carries the current page as `next`. */
export function loginUrlWithNext(location: { pathname: string; search: string; hash?: string }): string {
  const next = safeNextPath(location.pathname + location.search + (location.hash || ''))
  if (!next || next === '/') return '/login'
  return `/login?next=${encodeURIComponent(next)}`
}

/** Target after a successful login, read from the login page's query string. */
export function postLoginTarget(search: string): string {
  return safeNextPath(new URLSearchParams(search).get('next')) || '/'
}
