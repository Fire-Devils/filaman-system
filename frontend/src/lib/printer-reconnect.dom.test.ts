// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, expect, it, vi } from 'vitest'
import * as abort from './abort'
import { api } from './api'
import * as driverConfig from './driver-config-form'
import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { bindFormState } from './form-state'
import { setLang, t } from './i18n'
import { tableAction } from './table-actions'

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'csrf_token=; Max-Age=0'
  document.body.replaceChildren()
})

it.each([
  ['success', () => Response.json({ results: { 1: 'reconnected', 2: 'started' } }), true],
  ['no eligible printers', () => Response.json({ results: {} }), false],
  ['HTTP rejection', () => Response.json({ code: 'csrf_failed' }, { status: 403 }), false],
  ['printer failure', () => Response.json({ results: { 1: 'reconnected', 2: 'start_failed' } }), false],
] as const)('handles %s from Check All Printers', async (_label, response, succeeds) => {
  setLang('en')
  document.cookie = 'csrf_token=printer-test-token'
  const success = vi.fn(async () => true)
  const alert = vi.fn(async () => true)
  Object.assign(window, { __fmSuccess: success, __fmAlert: alert })
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path === '/api/v1/printers/1/driver/health') return Response.json({ running: true, connected: true })
    if (path === '/api/v1/printers/reconnect-all') return response()
    if (path === '/api/v1/printers') return Response.json({ items: [{ id: 1, name: 'Fixture printer', is_active: true, driver_key: 'fixture' }] })
    return Response.json([])
  })
  vi.stubGlobal('fetch', fetchMock)
  await bootAstroPage('printers/index', {
    ...abort, ...driverConfig, api, bindFormDialog, bindFormState, escapeHtml, initI18n: async () => {}, t, tableAction,
  })

  const button = document.querySelector<HTMLButtonElement>('#btn-check-all')!
  await vi.waitFor(() => expect(document.getElementById('online-badge-1')?.textContent).toBe(t('common.online')))
  fetchMock.mockClear()
  button.click()
  expect(button.disabled).toBe(true)
  await vi.waitFor(() => expect(button.disabled).toBe(false))

  expect(fetchMock).toHaveBeenCalledWith('/api/v1/printers/reconnect-all', expect.objectContaining({
    method: 'POST',
    credentials: 'include',
    headers: expect.objectContaining({ 'X-CSRF-Token': 'printer-test-token' }),
  }))
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/printers/reconnect-all', '/api/v1/printers/1/driver/health',
  ])
  expect(document.getElementById('online-badge-1')?.textContent).toBe(t('common.online'))
  expect(success).toHaveBeenCalledTimes(succeeds ? 1 : 0)
  expect(alert).toHaveBeenCalledTimes(succeeds ? 0 : 1)
  expect(button.textContent).toBe(t('printers.checkAll'))
})
