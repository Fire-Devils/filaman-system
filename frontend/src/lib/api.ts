import { getAbortSignal } from './abort'
import type { ColumnFilterValue } from './table-column-filters'

const API_BASE = '/api/v1'
const AUTH_BASE = '/auth'

export function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : null
}

type ApiRequestOptions = RequestInit & { csrfToken?: string | null }

export class ApiError extends Error {
  status: number
  code: string
  /** The `detail` object of the response, for codes that send extra fields (e.g. `preset_names`). */
  detail?: Record<string, unknown>

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

interface ApiErrorResponse {
  code?: string
  message?: string
  detail?: string | { code?: string; message?: string }
}

export async function request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let url: string
  if (path.startsWith('/auth')) {
    url = AUTH_BASE + path.slice(5)
  } else {
    url = API_BASE + path
  }

  const { csrfToken: csrfOverride, ...fetchOptions } = options

  const headers: Record<string, string> = {
    ...(fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...fetchOptions.headers as Record<string, string>,
  }

  const csrfToken = csrfOverride ?? getCsrfToken()
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
    credentials: 'include',
    signal: fetchOptions.signal ?? getAbortSignal(),
  })

  if (!response.ok) {
    const errorBody: ApiErrorResponse = await response.json().catch(() => ({}))
    const detail = errorBody?.detail
    const code =
      (typeof detail === 'object' && detail?.code) ||
      errorBody?.code ||
      'unknown_error'
    const message =
      (typeof detail === 'object' && detail?.message) ||
      (typeof detail === 'string' ? detail : '') ||
      errorBody?.message ||
      `HTTP ${response.status}`
    throw new ApiError(response.status, code, message, typeof detail === 'object' && detail ? detail : undefined)
  }

  if (response.status === 204) {
    return {} as T
  }

  return response.json()
}

export const api = {
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'method'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    request<T>(path, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method' | 'body'>) =>
    request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string, options?: Omit<ApiRequestOptions, 'method'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
}

export function colorFilterParams(filter: ColumnFilterValue | undefined, baseParams = new URLSearchParams(), path = ''): URLSearchParams | null {
  const params = new URLSearchParams()
  if (!filter) return params
  if (filter.type !== 'multi') return null
  for (const name of filter.values) {
    if (name === '') params.set('color_unassigned', 'true')
    else params.append('color_name', name)
  }
  const combined = new URLSearchParams(baseParams)
  params.forEach((value, key) => combined.append(key, value))
  combined.set('page', String(Number.MAX_SAFE_INTEGER))
  combined.set('page_size', '200')
  // shortcut: oversized selections stay client-side; use a POST query if these become common.
  return path.length + 1 + combined.toString().length <= 2000 && filter.values.length <= 200
    && filter.values.every(name => name.length <= 100) ? params : null
}

/** Fetch all pages with bounded concurrency and navigation cleanup. */
export async function fetchAllPages<T = unknown>(baseUrl: string): Promise<{ items: T[], total: number }> {
  const signal = getAbortSignal()
  const separator = baseUrl.includes('?') ? '&' : '?'
  const firstUrl = `${baseUrl}${separator}page=1&page_size=200`
  const response = await fetch(firstUrl, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`Failed to fetch ${baseUrl}`)
  const data = await response.json()
  const items: T[] = data.items
  const total: number = data.total

  if (total > 200) {
    const totalPages = Math.ceil(total / 200)
    for (let p = 2; p <= totalPages; p += 2) {
      signal.throwIfAborted()
      const additionalPages = await Promise.all(Array.from({ length: Math.min(2, totalPages - p + 1) }, (_, index) => {
        const pageUrl = `${baseUrl}${separator}page=${p + index}&page_size=200`
        return fetch(pageUrl, { credentials: 'include', signal })
          .then(res => {
            if (!res.ok) throw new Error(`Failed to fetch ${baseUrl}`)
            return res.json()
          })
          .then(d => d.items as T[])
      }))
      additionalPages.forEach(pageItems => { items.push(...pageItems) })
    }
  }

  return { items, total }
}
