import { afterEach, describe, expect, it, vi } from 'vitest'

import { colorFilterParams, fetchAllPages } from './api'

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

  it('bounds in-flight pages and preserves page order when responses finish out of order', async () => {
    let active = 0, peak = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page'))
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, page % 2 ? 1 : 5))
      active--
      return new Response(JSON.stringify({ items: [page], total: 1200 }))
    }))
    expect((await fetchAllPages<number>('/items')).items).toEqual([1, 2, 3, 4, 5, 6])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('pages by exact catalog IDs alongside ordinary names and unassigned colors', () => {
    const params = colorFilterParams({
      type: 'multi', values: ['Silk', 'Blue', ''], colorStopIds: [['Silk', [21, 22]]],
    })!
    expect(params.getAll('color_id')).toEqual(['21', '22'])
    expect(params.getAll('color_name')).toEqual(['Blue'])
    expect(params.get('color_unassigned')).toBe('true')
    expect(colorFilterParams({
      type: 'multi', values: ['Silk'], colorStopIds: [['Silk', Array.from({ length: 201 }, (_, i) => i + 1)]],
    })).toBeNull()
  })

  it('serializes exact color names and blank matches, falling back for oversized URLs', () => {
    const params = colorFilterParams({ type: 'multi', values: ['Red, Silk', '', 'Blue'] })!
    expect(params.getAll('color_name')).toEqual(['Red, Silk', 'Blue'])
    expect(params.get('color_unassigned')).toBe('true')
    expect(colorFilterParams({ type: 'multi', values: Array.from({ length: 250 }, (_, i) => `Color ${i}`) })).toBeNull()
    expect(colorFilterParams(undefined)?.toString()).toBe('')
    const longSelection = { type: 'multi' as const, values: Array.from({ length: 16 }, (_, i) => `${i}${'a'.repeat(98)}`) }
    expect(colorFilterParams(longSelection)).not.toBeNull()
    expect(colorFilterParams(longSelection, new URLSearchParams({ search: 'x'.repeat(200) }), '/api/v1/spools')).toBeNull()
  })
})
