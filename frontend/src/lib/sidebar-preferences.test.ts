import { describe, expect, it } from 'vitest'
import { mergeSidebarOrder, readLegacySidebarPreferences } from './sidebar-preferences'

describe('legacy sidebar preferences', () => {
  it('keeps a hidden Color Library within the API navigation limit', () => {
    const values = new Map([
      ['sidebar-preferences', JSON.stringify({ navigation: Array.from({ length: 128 }, (_, index) => ({ id: '/item-' + index, shown: true })) })],
      ['sidebar-color-library', 'false'],
    ])
    const result = readLegacySidebarPreferences({ getItem: key => values.get(key) ?? null } as Storage)
    expect(result?.navigation).toHaveLength(128)
    expect(result?.navigation.at(-1)).toEqual({ id: '/filaments/colors', shown: false })
  })
})

describe('sidebar order within the API limits', () => {
  it.each([128, 512])('keeps every current row ahead of unavailable rows at the %i-row limit', limit => {
    const saved = Array.from({ length: limit }, (_, index) => ({ id: '/old-' + index, shown: true }))
    const current = [{ id: '/new', shown: true }, { id: '/old-1', shown: false }, { id: '/other', shown: true }]
    const merged = mergeSidebarOrder(saved, current, limit)
    expect(merged).toHaveLength(limit)
    expect(merged.filter(row => current.some(item => item.id === row.id))).toEqual(current)
    expect(merged[0]).toEqual(saved[0])
  })
})
