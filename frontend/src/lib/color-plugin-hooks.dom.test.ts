// @vitest-environment happy-dom
import {expect, it, vi} from 'vitest'
import type {PluginUiSurfaceAdapter, PluginSession} from './plugin-ui-launchers'
import {mountColorPluginHooks} from './color-plugin-hooks'
const shared = vi.hoisted(() => ({adapter: null as PluginUiSurfaceAdapter | null, close: vi.fn(), refresh: vi.fn(async () => [])}))
vi.mock('./plugin-ui-launchers', () => ({ mountPluginUiLaunchers: (_host: HTMLElement, adapter: PluginUiSurfaceAdapter) => {shared.adapter = adapter; return shared} }))
it('stages validated Name/RGB with preserved alpha and rejects stale/busy drafts', async () => {
  let current = {mode: 'edit' as const, color_id: 1, usage_count: 8, fields: {name: 'Red', hex_code: '#FF000080'}}
  const stage = vi.fn((fields) => { current = {...current, fields} })
  let busy = false
  mountColorPluginHooks(document.createElement('div'), document.createElement('dialog'), {read: () => structuredClone(current), busy: () => busy, stage, openExisting: vi.fn()}, new AbortController().signal)
  const reply = vi.fn(); const session = {reply, isCurrent: () => true} as unknown as PluginSession
  const send = async (type: string, data = {}) => shared.adapter!.onMessage!({type, request_id: 'test', ...data}, session)
  await send('filaman:color-context')
  expect(reply.mock.lastCall![1].capabilities.color_staging).toBe(true)
  expect(reply.mock.lastCall![1].usage_count).toBe(8)
  const expected = {...current.fields}
  await send('filaman:color-stage', {expected, fields: {name: ' Blue ', hex_code: '#0000FFFF'}})
  expect(current.fields).toEqual({name: 'Blue', hex_code: '#0000FF80'})
  expect(reply.mock.lastCall![1].fields).toEqual(current.fields)
  await send('filaman:color-stage', {expected, fields: {name: 'Stale', hex_code: '#000000'}})
  expect(stage).toHaveBeenCalledTimes(1)
  await send('filaman:color-context'); busy = true
  await send('filaman:color-stage', {expected: current.fields, fields: {name: 'Busy', hex_code: '#000000'}})
  expect(stage).toHaveBeenCalledTimes(1)
})


it('answers Open existing with cancellation while a native Save is pending', async () => {
  let busy = false
  const openExisting = vi.fn(async () => false), reply = vi.fn()
  mountColorPluginHooks(document.createElement('div'), document.createElement('dialog'), {
    read: () => ({mode: 'create', color_id: null, usage_count: 0, fields: {name: 'Draft', hex_code: '#FF0000'}}),
    busy: () => busy, stage: vi.fn(), openExisting,
  }, new AbortController().signal)
  const session = {reply, isCurrent: () => true} as unknown as PluginSession
  await shared.adapter!.onMessage!({type: 'filaman:color-context', request_id: 'read'}, session)
  busy = true
  await shared.adapter!.onMessage!({type: 'filaman:color-open', request_id: 'open', color_id: 1}, session)
  expect(openExisting).not.toHaveBeenCalled()
  expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({request_id: 'open'}), {opened: false})
})
