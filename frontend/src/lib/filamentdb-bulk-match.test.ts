import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './api'
import {
  defaultSelection,
  groupItems,
  planApply,
  renderResult,
  runApply,
  sortMatches,
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
  beforeEach(() => post.mockReset())

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
      type: 'manufacturer', items, total: 4, truncated: true,
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

  it('shows an empty note when nothing is left to match', () => {
    const html = renderResult({ type: 'filament', items: [], total: 0, truncated: false, counts: { linked: 0, suggested: 0, none: 0, blocked: 0 } }, defaultSelection([]))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('data-bm-section')
  })
})
