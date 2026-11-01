import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { parameterChanges, reconcileParameterDraft, resolveParameter, writeParameterChanges } from './printer-setup'

vi.mock('./api', () => ({ api: { put: vi.fn(), delete: vi.fn() } }))
afterEach(() => vi.clearAllMocks())

describe('printer parameter ownership', () => {
  it('keeps explicit zero, false and matching values owned by the spool', () => {
    for (const value of ['0', 'false', '205']) {
      expect(resolveParameter('test', { test: value }, { test: value }, {})).toEqual({ value, source: 'own' })
      expect(resolveParameter('test', {}, { test: value }, {})).toEqual({ value, source: 'filament' })
    }
  })
  it('preserves legacy blank records until explicitly reset', () => {
    for (const value of ['', null]) {
      expect(resolveParameter('test', { test: value }, { test: '205' }, {})).toEqual({ value, source: 'blank' })
      expect(resolveParameter('test', { test: value }, { test: '205' }, { test: null })).toEqual({ value: '205', source: 'filament' })
    }
    expect(resolveParameter('test', {}, {}, {})).toEqual({ value: null, source: 'unset' })
  })
  it('never materializes inherited values or loses hidden profile IDs', () => {
    expect(parameterChanges({ a: '1', hidden: 'PFUS1', legacy: null }, { a: '1', missing: null })).toEqual({ updates: [], deletes: [] })
    expect(parameterChanges({ a: '1', hidden: 'PFUS1' }, { a: null, b: 'false' })).toEqual({ updates: [{ param_key: 'b', param_value: 'false' }], deletes: ['a'] })
    expect(parameterChanges({}, { same: '0' })).toEqual({ updates: [{ param_key: 'same', param_value: '0' }], deletes: [] })
  })
})

describe('refreshing a parameter draft', () => {
  it('preserves unrelated edits, flags overlapping remote imports, and recognizes already applied changes', () => {
    expect(reconcileParameterDraft({ a: '1', b: '2' }, { a: '3', b: '2', profile: 'PFUS2' }, { a: '4', b: '5' }))
      .toEqual({ draft: { a: '4', b: '5' }, conflicts: ['a'] })
    expect(reconcileParameterDraft({ a: '1', b: '2' }, { a: '4' }, { a: '4', b: null }))
      .toEqual({ draft: {}, conflicts: [] })
  })
})

describe('parameter persistence', () => {
  it('upserts only changed keys and deletes each cleared key separately', async () => {
    await writeParameterChanges('/spools/17/printer-params/1', { clear: '1', profile: 'PFUS1' }, { clear: null, zero: '0' }, { csrfToken: 'csrf' })
    expect(api.put).toHaveBeenCalledWith('/spools/17/printer-params/1', { params: [{ param_key: 'zero', param_value: '0' }] }, { csrfToken: 'csrf' })
    expect(api.delete).toHaveBeenCalledWith('/spools/17/printer-params/1?param_key=clear', { csrfToken: 'csrf' })
  })
  it('does not report success after a failed deletion and leaves retry decisions to the retained draft', async () => {
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('HTTP 403'))
    await expect(writeParameterChanges('/filaments/3/printer-params/1', { key: '1' }, { key: null }, {})).rejects.toThrow('403')
    expect(api.delete).toHaveBeenCalledTimes(1)
  })
})
