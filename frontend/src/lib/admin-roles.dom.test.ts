// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as dialog from './form-dialog'
import * as state from './form-state'
import * as api from './api'
import * as abort from './abort'
import * as actions from './table-actions'
import * as escape from './extra-fields'
import * as i18n from './i18n'

const roles = [
  { id: 1, key: 'admin', name: 'Administrator', description: 'All access', is_system: true },
  { id: 2, key: 'operator', name: 'Operator', description: 'Inventory', is_system: false },
]
const permissions = [
  { key: 'spools:read', description: 'View spools', category: 'inventory' },
  { key: 'spools:update', description: 'Edit spools', category: 'inventory' },
  { key: 'admin:users_manage', description: 'Manage users', category: 'admin' },
]
let failWrite = false
let deferDetails: ((id: number) => Promise<Response> | undefined) | undefined
const calls: { path: string; init?: RequestInit }[] = []
async function boot() {
  const dependencies = { ...api, ...abort, ...actions, ...escape, ...i18n, ...dialog, ...state, initI18n: async () => {} }
  await bootAstroPage('admin/roles', dependencies)
  await vi.waitFor(() => expect(document.querySelectorAll('#role-select option')).toHaveLength(2))
}
function selectRole(id: number) {
  const select = document.querySelector<HTMLSelectElement>('#role-select')!
  select.value = String(id)
  select.dispatchEvent(new Event('change'))
}
function edit(id: string, value: string | boolean) {
  const input = document.getElementById(id) as HTMLInputElement
  if (typeof value === 'boolean') input.checked = value
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function submit(id: string) { document.getElementById(id)!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) }
function writes() { return calls.filter(call => call.init?.method && call.init.method !== 'GET') }
beforeEach(() => {
  calls.length = 0
  failWrite = false
  deferDetails = undefined
  i18n.setLang('en')
  Object.assign(window, { __fmConfirm: vi.fn(async () => true) })
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    if (init?.method && init.method !== 'GET') {
      if (failWrite) return Response.json({ detail: 'Save denied' }, { status: 403 })
      if (path.endsWith('/permissions')) return Response.json({ permissions: JSON.parse(String(init.body)) })
      return Response.json({ ...roles.find(role => path.endsWith(`/${role.id}`)), ...JSON.parse(String(init.body)) })
    }
    if (path.endsWith('/permissions')) return Response.json(permissions)
    if (path.endsWith('/roles')) return Response.json(roles)
    const id = Number(path.split('/').pop())
    return deferDetails?.(id) || Response.json({ ...roles.find(role => role.id === id), permissions: id === 1 ? permissions.map(p => p.key) : ['spools:read'] })
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('selects the first role and displays grouped permissions without an empty-selection hint', async () => {
  await boot()
  await vi.waitFor(() => expect(document.querySelectorAll('.perm-checkbox')).toHaveLength(3))
  expect(document.querySelector<HTMLSelectElement>('#role-select')!.value).toBe('1')
  expect(document.querySelectorAll('#permissions-checkboxes fieldset')).toHaveLength(2)
  expect([...document.querySelectorAll<HTMLInputElement>('.perm-checkbox')].every(input => input.checked && input.disabled)).toBe(true)
  expect(document.querySelector('#role-delete')!.classList.contains('hidden')).toBe(true)
  expect(document.querySelector('#perm-modal')).toBeNull()
})
it('does not show a previous role response after quickly selecting another role', async () => {
  let finishFirst!: (response: Response) => void
  deferDetails = id => id === 1 ? new Promise(resolve => { finishFirst = resolve }) : undefined
  await boot()
  selectRole(2)
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[value="spools:read"]')?.checked).toBe(true))
  finishFirst(Response.json({ ...roles[0], permissions: permissions.map(p => p.key) }))
  await Promise.resolve()
  await Promise.resolve()
  expect(document.querySelector<HTMLSelectElement>('#role-select')!.value).toBe('2')
  expect(document.querySelector<HTMLInputElement>('[value="admin:users_manage"]')!.checked).toBe(false)
  expect(document.querySelector('#permissions-header')!.textContent).toContain('Operator')
})
it('edits metadata in place with dirty/revert Save and retains a failed draft for retry', async () => {
  await boot()
  document.querySelector<HTMLButtonElement>('#edit-role')!.click()
  expect(document.querySelector('dialog[open]')).toBeNull()
  const save = document.querySelector<HTMLButtonElement>('#role-save')!
  expect(save.disabled).toBe(true)
  edit('role-edit-name', 'New name')
  expect(save.disabled).toBe(false)
  edit('role-edit-name', 'Administrator')
  expect(save.disabled).toBe(true)
  edit('role-edit-name', 'New name')
  failWrite = true
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector('#role-error')!.textContent).toBe('Save denied'))
  expect(save.disabled).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#role-edit-name')!.value).toBe('New name')
  failWrite = false
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector('#role-edit-form')!.classList.contains('hidden')).toBe(true))
  expect(JSON.parse(String(writes()[1].init!.body))).toEqual({ name: 'New name', description: 'All access' })
  expect(writes()[1].init!.method).toBe('PATCH')
  expect(writes()[1].path).toBe('/api/v1/admin/roles/1')
})
it('edits grouped permissions in place and preserves failed selections and system-role deletion protection', async () => {
  await boot()
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#edit-permissions')!.disabled).toBe(false))
  document.querySelector<HTMLButtonElement>('#edit-permissions')!.click()
  const save = document.querySelector<HTMLButtonElement>('#permissions-save')!
  expect(save.disabled).toBe(true)
  const input = document.querySelector<HTMLInputElement>('[value="spools:update"]')!
  input.checked = false
  input.dispatchEvent(new Event('change', { bubbles: true }))
  expect(save.disabled).toBe(false)
  failWrite = true
  submit('permissions-form')
  await vi.waitFor(() => expect(document.querySelector('#permissions-error')!.textContent).toBe('Save denied'))
  expect(input.checked).toBe(false)
  expect(save.disabled).toBe(false)
  failWrite = false
  submit('permissions-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#edit-permissions')!.classList.contains('hidden')).toBe(false))
  expect(JSON.parse(String(writes()[1].init!.body))).toEqual(['spools:read', 'admin:users_manage'])
  expect(writes()[1].init!.method).toBe('PUT')
  expect(document.querySelector('#role-delete')!.classList.contains('hidden')).toBe(true)
})
