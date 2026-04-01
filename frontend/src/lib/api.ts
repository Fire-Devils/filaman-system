const API_BASE = '/api/v1'
const AUTH_BASE = '/auth'

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : null
}

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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let url: string
  if (path.startsWith('/auth')) {
    url = AUTH_BASE + path.slice(5)
  } else {
    url = API_BASE + path
  }

  const isFormDataBody = options.body instanceof FormData
  const headers: Record<string, string> = {
    ...options.headers as Record<string, string>,
  }

  if (!isFormDataBody && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const csrfToken = getCsrfToken()
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  })

  if (!response.ok) {
    const errorData: ApiErrorResponse = await response.json().catch(() => ({
      code: 'unknown_error',
      message: `HTTP ${response.status}`,
    }))
    throw new ApiError(response.status, errorData.code, errorData.message)
  }

  if (response.status === 204) {
    return {} as T
  }

  return response.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    }),
  postFormData: <T>(path: string, body: FormData) =>
    request<T>(path, {
      method: 'POST',
      body,
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/**
 * Fetches all pages of a paginated API endpoint.
 * Handles endpoints returning { items: T[], total: number }.
 */
export async function fetchAllPages<T = any>(baseUrl: string): Promise<{ items: T[], total: number }> {
  const separator = baseUrl.includes('?') ? '&' : '?'
  const firstUrl = `${baseUrl}${separator}page=1&page_size=200`
  const response = await fetch(firstUrl, { credentials: 'include' })
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
        fetch(pageUrl, { credentials: 'include' })
          .then(res => res.ok ? res.json() : null)
          .then(d => d ? d.items : [])
      )
    }
    const additionalPages = await Promise.all(pagePromises)
    additionalPages.forEach(pageItems => { items = items.concat(pageItems) })
  }

  return { items, total }
}
