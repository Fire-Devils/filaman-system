import { getAbortSignal } from './abort'

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

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface ApiResponse<T> {
  data: T
}

interface ApiErrorResponse {
  code: string
  message: string
  detail?: Record<string, string[]>
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
    'Content-Type': 'application/json',
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
    const errorBody: any = await response.json().catch(() => ({}))
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
    throw new ApiError(response.status, code, message)
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

/**
 * Fetches all pages of a paginated API endpoint.
 * Handles endpoints returning { items: T[], total: number }.
 * Uses AbortSignal for navigation cleanup.
 */
export async function fetchAllPages<T = any>(baseUrl: string): Promise<{ items: T[], total: number }> {
  const signal = getAbortSignal()
  const separator = baseUrl.includes('?') ? '&' : '?'
  const firstUrl = `${baseUrl}${separator}page=1&page_size=200`
  const response = await fetch(firstUrl, { credentials: 'include', signal })
  if (!response.ok) throw new Error(`Failed to fetch ${baseUrl}`)
  const data = await response.json()
  let items: T[] = data.items
  const total: number = data.total

  if (total > 200) {
    const totalPages = Math.ceil(total / 200)
    const pagePromises: Promise<T[]>[] = []
    for (let p = 2; p <= totalPages; p++) {
      const pageUrl = `${baseUrl}${separator}page=${p}&page_size=200`
      pagePromises.push(
        fetch(pageUrl, { credentials: 'include', signal })
          .then(res => res.ok ? res.json() : null)
          .then(d => d ? d.items : [])
      )
    }
    const additionalPages = await Promise.all(pagePromises)
    additionalPages.forEach(pageItems => { items = items.concat(pageItems) })
  }

  return { items, total }
}
