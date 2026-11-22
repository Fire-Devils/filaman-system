// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearUser } from './auth'
import { mountSpoolLinkBanner } from './spool-link-banner'

const suggestion = {
  id: 7,
  filament: { id: 1, designation: '<b>Black</b>', manufacturer_name: 'Maker', material_type: 'PLA' },
  printer_name: 'P1S <x>', slot_label: 'AMS A1', created_at: '2026-11-22T10:00:00Z',
  candidates: [
    { id: 11, created_at: '2026-11-01T10:00:00Z', remaining_weight_g: 1000, location_name: 'Shelf', lot_number: 'L1' },
    { id: 12, created_at: '2026-11-10T10:00:00Z', remaining_weight_g: null, location_name: null, lot_number: null },
  ],
}

function stubFetch(permissions: string[], calls: { url: string; init?: RequestInit }[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/me')) return Response.json({ id: 1, is_superadmin: false, permissions, roles: [] })
    if (url.endsWith('/spool-link-suggestions') && init?.method !== 'POST') return Response.json([suggestion])
    return Response.json({ id: 7, status: 'ok' })
  }))
  return calls
}

beforeEach(() => { clearUser(); document.body.innerHTML = '<div id="b"></div>' })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('renders escaped text with the oldest candidate preselected', async () => {
  stubFetch(['spools:update'])
  const el = document.getElementById('b')!
  await mountSpoolLinkBanner(el, new AbortController().signal)
  expect(el.querySelector('b')).toBeNull()
  expect(el.textContent).toContain('<b>Black</b>')
  expect(el.textContent).toContain('P1S <x> / AMS A1')
  expect(el.querySelector<HTMLSelectElement>('select')!.value).toBe('11')
  expect(el.querySelectorAll('option')).toHaveLength(2)
})

it('stays empty without spools:update', async () => {
  const calls = stubFetch([])
  const el = document.getElementById('b')!
  await mountSpoolLinkBanner(el, new AbortController().signal)
  expect(el.innerHTML).toBe('')
  expect(calls.some(call => call.url.includes('spool-link-suggestions'))).toBe(false)
})

it('links the selected spool and reloads the host list', async () => {
  const calls = stubFetch(['spools:update'])
  const changed = vi.fn()
  const el = document.getElementById('b')!
  await mountSpoolLinkBanner(el, new AbortController().signal, changed)
  el.querySelector<HTMLSelectElement>('select')!.value = '12'
  el.querySelector<HTMLButtonElement>('[data-link-action="link"]')!.click()
  await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  const post = calls.find(call => call.init?.method === 'POST')!
  expect(post.url).toContain('/spool-link-suggestions/7/link')
  expect(JSON.parse(String(post.init!.body))).toEqual({ spool_id: 12 })
})

it('dismisses to create a new spool', async () => {
  const calls = stubFetch(['spools:update'])
  const changed = vi.fn()
  const el = document.getElementById('b')!
  await mountSpoolLinkBanner(el, new AbortController().signal, changed)
  el.querySelector<HTMLButtonElement>('[data-link-action="dismiss"]')!.click()
  await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  expect(calls.find(call => call.init?.method === 'POST')!.url).toContain('/spool-link-suggestions/7/dismiss')
})
