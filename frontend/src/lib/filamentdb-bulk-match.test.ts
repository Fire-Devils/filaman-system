import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './api'
import {
  defaultSelection,
  groupItems,
  planApply,
  renderResult,
  renderDetails,
  runApply,
  sortMatches,
  chunk,
  mergeResponses,
  runBulkCheck,
  type BulkCheckResponse,
  type BulkMatchItem,
} from './filamentdb-bulk-match'

const post = vi.hoisted(() => vi.fn())
vi.mock('./api', async importOriginal => {
  const original = await importOriginal<typeof import('./api')>()
  return { ...original, api: { ...original.api, post } }
})

const items: BulkMatchItem[] = [
  { local_id: 1, label: 'Acme <b>', category: 'linked', matches: [{ type: 'manufacturer', id: 5, label: 'Acme', score: 1 }], blockers: [], linked_remote_id: 5 },
  {
    local_id: 2, label: 'Prusa', category: 'suggested', blockers: [],
    matches: [{ type: 'manufacturer', id: 7, label: 'Prusa Low', score: 0.7 }, { type: 'manufacturer', id: 8, label: 'Prusa', score: 0.93 }],
  },
  { local_id: 3, label: 'Neu', category: 'none', matches: [], blockers: [] },
  { local_id: 4, label: 'Kaputt', category: 'blocked', matches: [], blockers: [{ code: 'x', message: 'kaputt' }] },
]

describe('bulk match logic', () => {
  beforeEach(() => { post.mockReset() })

  it('sorts matches by score descending and groups by category', () => {
    expect(sortMatches(items[1].matches).map(m => m.id)).toEqual([8, 7])
    const groups = groupItems(items)
    expect(groups.linked).toHaveLength(1)
    expect(groups.suggested).toHaveLength(1)
    expect(groups.none).toHaveLength(1)
    expect(groups.blocked).toHaveLength(1)
  })

  it('preselects the best match for suggestions and leaves "none" unchecked', () => {
    const selection = defaultSelection(items)
    expect([...selection.checked]).toEqual([2])
    expect(selection.choice.get(2)).toBe(8)
    expect(selection.choice.get(3)).toBe('new')
  })

  it('plans link, submit-new and skips blocked/linked rows', () => {
    const selection = defaultSelection(items)
    selection.checked.add(3)
    selection.checked.add(4)
    selection.checked.add(1)
    const plan = planApply(items, selection)
    expect(plan.map(a => [a.local_id, a.action, a.match_id])).toEqual([[2, 'link', 8], [3, 'submit', undefined]])
    expect(plan[0].shown_matches.map(m => m.id)).toEqual([8, 7])
  })

  it('submits as new when "none of these" is chosen and ignores unchecked rows', () => {
    const selection = defaultSelection(items)
    selection.choice.set(2, 'new')
    expect(planApply(items, selection)[0]).toMatchObject({ local_id: 2, action: 'submit' })
    selection.checked.delete(2)
    expect(planApply(items, selection)).toEqual([])
  })

  it('rejects a choice that is not among the shown matches', () => {
    const selection = defaultSelection(items)
    selection.choice.set(2, 999)
    expect(planApply(items, selection)).toEqual([])
  })

  it('runs sequentially, collects errors per row and stops at the daily limit', async () => {
    post
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ApiError(409, 'material_unknown', 'x'))
      .mockRejectedValueOnce(new ApiError(429, 'daily_limit_reached', 'limit'))
    const actions = [1, 2, 3, 4].map(id => ({ local_id: id, action: 'submit' as const, shown_matches: [] }))
    const progress = vi.fn()
    const result = await runApply('manufacturer', actions, progress)
    expect(result.done).toEqual([1])
    expect(result.failed.map(f => f.local_id)).toEqual([2, 3])
    expect(result.notSent).toEqual([4])
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[0][1]).toMatchObject({ type: 'manufacturer', local_id: 1, action: 'submit' })
    expect(progress).toHaveBeenCalledTimes(3)
  })

  it('renders sections, escapes labels and offers a "none of these" option', () => {
    const response: BulkCheckResponse = {
      type: 'manufacturer', items, total: 4,
      counts: { linked: 1, suggested: 1, none: 1, blocked: 1 },
    }
    const html = renderResult(response, defaultSelection(items))
    expect(html).toContain('data-bm-section="linked"')
    expect(html).toContain('data-bm-section="suggested"')
    expect(html).toContain('data-bm-section="none"')
    expect(html).toContain('data-bm-section="blocked"')
    expect(html).not.toContain('<b>')
    expect(html).toContain('value="new"')
    expect(html.indexOf('value="8"')).toBeLessThan(html.indexOf('value="7"'))
    expect(html).toContain('data-bm-all="suggested"')
    expect(html).not.toContain('data-bm-all="blocked"')
  })

  it('offers unlink on linked rows, reject on suggestions, and details under each match', () => {
    const response: BulkCheckResponse = {
      type: 'manufacturer', items, total: 4,
      counts: { linked: 1, suggested: 1, none: 1, blocked: 1 },
    }
    const html = renderResult(response, defaultSelection(items))
    expect(html).toContain('data-bm-unlink="1"')
    expect(html).toContain('data-bm-dismiss="2"')
    expect(html).toContain('data-bm-details="1:5"')
    expect(html).toContain('data-bm-details="2:8"')
    expect(html).toContain('data-bm-details="2:7"')
    const hidden = renderResult(response, defaultSelection(items), new Set([2]))
    expect(hidden).not.toContain('data-bm-row="2"')
  })

  it('ignores dismissed rows when planning', () => {
    const selection = defaultSelection(items)
    expect(planApply(items, selection, new Set([2]))).toEqual([])
  })

  it('renders a comparison table with escaped values', () => {
    const filament: BulkMatchItem = {
      local_id: 9, label: 'F', category: 'suggested', blockers: [],
      local: { manufacturer: 'Bambu <i>Lab</i>', material: 'PLA', color_name: 'Red', color_hex: '#FF0000', diameter_mm: 1.75 },
      matches: [{ type: 'filament', id: 4, label: 'X', score: 0.5, details: { manufacturer: '<script>x</script>', material: 'PLA Silk' } }],
    }
    const html = renderDetails('filament', filament, filament.matches[0], { color_name: { name: 'Blue' } })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<i>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('PLA Silk')
    expect(html).toContain('Blue')
    expect(html).toContain('1.75')
    expect(html).toContain('50 %')
  })

  it('shows an empty note when nothing is left to match', () => {
    const html = renderResult({ type: 'filament', items: [], total: 0, counts: { linked: 0, suggested: 0, none: 0, blocked: 0 } }, defaultSelection([]))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('data-bm-section')
  })

  describe('batched check', () => {
    const part = (ids: number[]): BulkCheckResponse => ({
      type: 'manufacturer',
      items: ids.map(id => ({ local_id: id, label: `M${id}`, category: 'none' as const, matches: [], blockers: [] })),
      counts: { linked: 0, suggested: 0, none: ids.length, blocked: 0 },
      total: ids.length,
    })
    const candidates = (n: number) => ({ type: 'manufacturer', ids: Array.from({ length: n }, (_, i) => i + 1), total: n })
    const serverError = () => new ApiError(502, 'bad_gateway', 'gateway')

    it('splits into chunks of 20', () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
      expect(chunk([], 20)).toEqual([])
    })

    it('merges counts and items', () => {
      const merged = mergeResponses(mergeResponses({ ...part([]) }, part([1, 2])), part([3]))
      expect(merged.total).toBe(3)
      expect(merged.counts.none).toBe(3)
      expect(merged.items.map(i => i.local_id)).toEqual([1, 2, 3])
    })

    it('runs all batches sequentially and reports progress', async () => {
      post.mockImplementation(async (path: string, body: { ids?: number[] }) =>
        path.endsWith('bulk-candidates') ? candidates(45) : part(body.ids ?? []))
      const progress = vi.fn()
      const run = await runBulkCheck('manufacturer', true, { onProgress: progress })
      expect(post).toHaveBeenCalledTimes(4)
      expect(post.mock.calls[1][1].ids).toHaveLength(20)
      expect(post.mock.calls[3][1].ids).toHaveLength(5)
      expect(post.mock.calls[1][1].auto_link_exact).toBe(true)
      expect(run.response.total).toBe(45)
      expect(run.incomplete).toBe(false)
      expect(progress).toHaveBeenLastCalledWith(45, 45)
    })

    it('returns immediately when there are no candidates', async () => {
      post.mockResolvedValueOnce(candidates(0))
      const run = await runBulkCheck('manufacturer', false)
      expect(post).toHaveBeenCalledTimes(1)
      expect(run.candidateTotal).toBe(0)
    })

    it('keeps results so far when cancelled', async () => {
      let cancelled = false
      post.mockImplementation(async (path: string, body: { ids?: number[] }) => {
        if (path.endsWith('bulk-candidates')) return candidates(45)
        cancelled = true
        return part(body.ids ?? [])
      })
      const run = await runBulkCheck('manufacturer', false, { isCancelled: () => cancelled })
      expect(post).toHaveBeenCalledTimes(2)
      expect(run.cancelled).toBe(true)
      expect(run.incomplete).toBe(true)
      expect(run.checked).toBe(20)
      expect(run.response.total).toBe(20)
    })

    it('retries a failed batch once and then continues', async () => {
      let calls = 0
      post.mockImplementation(async (path: string, body: { ids?: number[] }) => {
        if (path.endsWith('bulk-candidates')) return candidates(25)
        if (++calls === 1) throw serverError()
        return part(body.ids ?? [])
      })
      const run = await runBulkCheck('manufacturer', false)
      expect(run.error).toBeUndefined()
      expect(run.response.total).toBe(25)
      expect(post).toHaveBeenCalledTimes(4)
    })

    it('aborts with partial results after a second failure', async () => {
      let calls = 0
      post.mockImplementation(async (path: string, body: { ids?: number[] }) => {
        if (path.endsWith('bulk-candidates')) return candidates(45)
        if (++calls <= 1) return part(body.ids ?? [])
        throw serverError()
      })
      const run = await runBulkCheck('manufacturer', false)
      expect(run.error).toBeInstanceOf(ApiError)
      expect(run.incomplete).toBe(true)
      expect(run.response.total).toBe(20)
      expect(post).toHaveBeenCalledTimes(4)
    })

    it('does not retry token errors', async () => {
      post.mockImplementation(async (path: string) => {
        if (path.endsWith('bulk-candidates')) return candidates(5)
        throw new ApiError(400, 'filamentdb_token_invalid', 'token')
      })
      const run = await runBulkCheck('manufacturer', false)
      expect(post).toHaveBeenCalledTimes(2)
      expect(run.error).toBeInstanceOf(ApiError)
      expect(run.response.total).toBe(0)
    })
  })
})
