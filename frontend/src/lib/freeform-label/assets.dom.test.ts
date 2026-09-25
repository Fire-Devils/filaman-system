// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'

import { createLabelAssetClient } from './assets'
import { getAbortSignal } from '../abort'

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'csrf_token=; Max-Age=0'
})

it('lists assets and derives authenticated content URLs', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
    id: 'asset-1',
    display_name: 'logo.png',
    sha256: 'abc',
    media_type: 'image/png',
    width: 20,
    height: 10,
    byte_size: 100,
    orphaned_at: null,
    created_at: '2026-09-05T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
  }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)

  const assets = await createLabelAssetClient().list()

  expect(assets[0].content_url).toBe('/api/v1/me/label-assets/asset-1/content')
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/label-assets', expect.objectContaining({ credentials: 'include' }))
})

it('uploads multipart data with CSRF and deletes owned assets', async () => {
  document.cookie = 'csrf_token=test-token'
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'asset-2', display_name: 'new.png', sha256: 'def', media_type: 'image/png',
      width: 40, height: 20, byte_size: 200, orphaned_at: null,
      created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const client = createLabelAssetClient()

  const uploaded = await client.upload(new File(['image'], 'new.png', { type: 'image/png' }))
  await client.delete(uploaded.id)

  const uploadOptions = fetchMock.mock.calls[0][1] as RequestInit
  expect(uploadOptions.body).toBeInstanceOf(FormData)
  expect(uploadOptions.headers).toEqual({ 'X-CSRF-Token': 'test-token' })
  expect(uploadOptions.signal).toBe(getAbortSignal())
  expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/me/label-assets/asset-2')
  expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE')
})

it('preserves actionable asset errors from the server', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    detail: { code: 'asset_quota_exceeded', message: 'Delete an unused image before uploading another.' },
  }), { status: 413 })))

  await expect(createLabelAssetClient().upload(new File(['image'], 'new.png'))).rejects.toMatchObject({
    status: 413,
    code: 'asset_quota_exceeded',
    message: 'Delete an unused image before uploading another.',
  })
})
