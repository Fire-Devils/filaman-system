// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { request } from './api'
import { getAbortSignal } from './abort'

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'csrf_token=; Max-Age=0'
})

it('lets the browser supply multipart boundaries while retaining authentication and cancellation', async () => {
  document.cookie = 'csrf_token=test-token'
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const body = new FormData()
  body.append('file', new File(['image'], 'image.png'))

  await request('/me/label-assets', { method: 'POST', body })

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/label-assets', expect.objectContaining({
    body,
    credentials: 'include',
    signal: getAbortSignal(),
    headers: { 'X-CSRF-Token': 'test-token' },
  }))
})

it('retains JSON headers, explicit CSRF, and explicit cancellation for existing callers', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  await request('/me', { method: 'PUT', body: '{}', csrfToken: 'explicit', signal: controller.signal })

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'explicit' },
    signal: controller.signal,
  }))
})

it('keeps the detail object of an error response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    detail: { code: 'label_asset_in_use', message: 'This image is still used by: A', preset_names: ['A'] },
  }), { status: 409 })))

  await expect(request('/me/label-assets/asset-1', { method: 'DELETE' })).rejects.toMatchObject({
    status: 409,
    code: 'label_asset_in_use',
    message: 'This image is still used by: A',
    detail: { preset_names: ['A'] },
  })
})
