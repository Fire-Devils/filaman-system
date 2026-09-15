import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchAllPages } from './api'

describe('fetchAllPages', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects when a later page fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 1 }], total: 201 })))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAllPages<{ id: number }>('/api/v1/admin/devices'))
      .rejects.toThrow('Failed to fetch /api/v1/admin/devices')
  })
})
