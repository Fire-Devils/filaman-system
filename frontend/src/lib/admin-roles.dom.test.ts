// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
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
let createdRole: typeof roles[number] | undefined
const allRoles = () => createdRole ? [...roles, createdRole] : roles
let failWrite = false
let permissionsOnlyFailure = false
let deferWrite: (() => Promise<Response>) | undefined
let deferDetails: ((id: number) => Response | Promise<Response> | undefined) | undefined
const calls: { path: string; init?: RequestInit }[] = []
async function boot() {
  const dependencies = { ...api, ...abort, ...actions, ...escape, ...i18n, ...dialog, ...state, initI18n: async () => {} }
  await bootAstroPage('admin/roles', dependencies)
  await vi.waitFor(() => expect(document.querySelectorAll('[data-role-id]')).toHaveLength(2))
}
const pencil = (id: number) => document.querySelector<HTMLButtonElement>(`[data-role-id="${id}"]`)!
async function selectRole(id = 1) {
  pencil(id).click()
  await vi.waitFor(() => expect(document.querySelectorAll('.perm-checkbox')).toHaveLength(3))
}
function togglePermission() {
  const input = document.querySelector<HTMLInputElement>('[value="spools:update"]')!
  input.checked = !input.checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
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
  createdRole = undefined
  failWrite = permissionsOnlyFailure = false
  deferWrite = undefined
  deferDetails = undefined
  i18n.setLang('en')
  Object.assign(window, { __fmConfirm: vi.fn(async () => true) })
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    if (init?.method && init.method !== 'GET') {
      if (deferWrite) return deferWrite()
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (failWrite && (!permissionsOnlyFailure || path.endsWith('/permissions'))) return Response.json({ detail: 'Save denied' }, { status: 403 })
      if (path.endsWith('/permissions')) return Response.json({ permissions: JSON.parse(String(init.body)) })
      if (init.method === 'POST') {
        createdRole = { ...JSON.parse(String(init.body)), id: 3, is_system: false }
        return Response.json(createdRole)
      }
      return Response.json({ ...allRoles().find(role => path.endsWith(`/${role.id}`)), ...JSON.parse(String(init.body)) })
    }
    if (path.endsWith('/permissions')) return Response.json(permissions)
    if (path.endsWith('/roles')) return Response.json(allRoles())
    const id = Number(path.split('/').pop())
    return deferDetails?.(id) || Response.json({ ...allRoles().find(role => role.id === id), permissions: id === 1 ? permissions.map(p => p.key) : ['spools:read'] })
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
it('opens accessible role and permission editors without scrolling and Cancel discards their drafts', async () => {
  await boot()
  const actions = document.getElementById('role-edit-actions')!
  expect(document.getElementById('role-edit-form')!.hidden).toBe(true)
  expect(actions.inert).toBe(true)
  expect(getComputedStyle(actions).visibility).toBe('hidden')
  expect(pencil(2).getAttribute('aria-label')).toContain('Operator')
  const focus = vi.spyOn(document.getElementById('role-edit-name')!, 'focus')
  await selectRole()
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  expect(pencil(1).getAttribute('aria-expanded')).toBe('true')
  expect(getComputedStyle(document.getElementById('role-edit-actions')!).visibility).not.toBe('hidden')
  expect(document.getElementById('role-edit-actions')!.inert).toBe(false)
  expect([...document.querySelectorAll('#permissions-checkboxes legend')].map(legend => legend.textContent)).toEqual(['inventory', 'admin'])
  expect([...document.querySelectorAll<HTMLInputElement>('.perm-checkbox')].every(input => input.checked && !input.disabled)).toBe(true)
  expect(document.querySelector<HTMLElement>('#role-delete')!.hidden).toBe(true)
  edit('role-edit-name', 'Discarded'); togglePermission()
  document.getElementById('role-cancel')!.click()
  expect(document.querySelector<HTMLElement>('#role-edit-form')!.hidden).toBe(true)
  expect(document.activeElement).toBe(pencil(1))
  await selectRole()
  expect(document.querySelector<HTMLInputElement>('#role-edit-name')!.value).toBe('Administrator')
  expect(document.querySelector<HTMLInputElement>('[value="spools:update"]')!.checked).toBe(true)
  expect(writes()).toHaveLength(0)
})
it('tracks metadata and permission changes/reverts together and saves only changed sections', async () => {
  await boot(); await selectRole()
  const save = document.querySelector<HTMLButtonElement>('#role-save')!
  expect(save.disabled).toBe(true)
  edit('role-edit-name', 'New name'); expect(save.disabled).toBe(false)
  edit('role-edit-name', 'Administrator'); expect(save.disabled).toBe(true)
  togglePermission(); expect(save.disabled).toBe(false)
  togglePermission(); expect(save.disabled).toBe(true)
  edit('role-edit-description', 'Changed')
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#role-edit-form')!.hidden).toBe(true))
  expect(document.activeElement).toBe(pencil(1))
  expect(writes()).toHaveLength(1)
  expect(writes()[0].path).toBe('/api/v1/admin/roles/1')
  expect(writes()[0].init!.method).toBe('PATCH')
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Administrator', description: 'Changed' })
})
it('preserves partial-save drafts and retries permissions without repeating saved metadata', async () => {
  await boot(); await selectRole()
  edit('role-edit-name', 'Renamed'); togglePermission()
  failWrite = permissionsOnlyFailure = true
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector('#role-error')!.textContent).toContain('Save denied'))
  expect(document.querySelector('#role-error')!.textContent).toContain(i18n.t('admin.roleSavePartial'))
  expect(document.getElementById('permissions-header')!.textContent).toContain('Renamed')
  expect(document.querySelector<HTMLInputElement>('#role-edit-name')!.value).toBe('Renamed')
  expect(document.querySelector<HTMLInputElement>('[value="spools:update"]')!.checked).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('#role-save')!.disabled).toBe(false)
  expect(pencil(1).getAttribute('aria-expanded')).toBe('true')
  failWrite = false
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#role-edit-form')!.hidden).toBe(true))
  expect(writes().map(call => call.init!.method)).toEqual(['PATCH', 'PUT', 'PUT'])
  expect(JSON.parse(String(writes()[2].init!.body))).toEqual(['spools:read', 'admin:users_manage'])
  expect(pencil(1).closest('article')!.textContent).toContain('Renamed')
})
it('retains a failed metadata draft and disables Save after reverting it', async () => {
  await boot(); await selectRole()
  edit('role-edit-name', 'Draft')
  failWrite = true
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector('#role-error')!.textContent).toContain('Save denied'))
  expect(writes()).toHaveLength(1)
  expect(document.querySelector<HTMLInputElement>('#role-edit-name')!.value).toBe('Draft')
  edit('role-edit-name', 'Administrator')
  expect(document.querySelector<HTMLButtonElement>('#role-save')!.disabled).toBe(true)
})
it('blocks Cancel, role switching, creation and competing submissions while saving', async () => {
  let finish!: (response: Response) => void
  deferWrite = () => new Promise(resolve => { finish = resolve })
  await boot(); await selectRole()
  edit('role-edit-name', 'Pending')
  submit('role-edit-form'); submit('role-edit-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(document.querySelector<HTMLElement>('#role-edit-form')!.inert).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#role-cancel')!.disabled).toBe(true)
  expect(pencil(2).disabled).toBe(true)
  document.getElementById('role-cancel')!.click(); pencil(2).click(); document.getElementById('btn-new-role')!.click()
  expect(document.querySelector('dialog[open]')).toBeNull()
  expect(pencil(1).getAttribute('aria-expanded')).toBe('true')
  finish(Response.json({ ...roles[0], name: 'Pending' }))
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#role-edit-form')!.hidden).toBe(true))
})
it('ignores stale permissions after cancelling a load and editing another role', async () => {
  let finish!: (response: Response) => void
  deferDetails = id => id === 1 ? new Promise(resolve => { finish = resolve }) : undefined
  await boot()
  pencil(1).click()
  document.getElementById('role-cancel')!.click()
  await selectRole(2)
  finish(Response.json({ ...roles[0], permissions: permissions.map(p => p.key) }))
  // Drain the released mock response before checking that it was ignored.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(document.querySelector<HTMLInputElement>('#role-edit-name')!.value).toBe('Operator')
  expect(document.querySelector<HTMLInputElement>('[value="admin:users_manage"]')!.checked).toBe(false)
  expect(pencil(2).getAttribute('aria-expanded')).toBe('true')
})
it('keeps custom-role deletion and system-role protection in the shared editor', async () => {
  await boot(); await selectRole()
  document.getElementById('role-delete')!.click()
  expect(writes()).toHaveLength(0)
  document.getElementById('role-cancel')!.click()
  await selectRole(2)
  expect(document.querySelector<HTMLElement>('#role-delete')!.hidden).toBe(false)
  document.getElementById('role-delete')!.click()
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(writes()[0].path).toBe('/api/v1/admin/roles/2')
  expect(writes()[0].init!.method).toBe('DELETE')
})

it('shows the delete action only for custom roles with the shared stylesheet applied', async () => {
  await boot()
  const style = document.createElement('style')
  style.textContent = readFileSync('src/styles/global.css', 'utf8')
  document.body.append(style)
  const remove = document.getElementById('role-delete')!
  await selectRole(2)
  expect(getComputedStyle(remove).display).toBe('inline-flex')
  document.getElementById('role-cancel')!.click()
  await selectRole(1)
  expect(getComputedStyle(remove).display).toBe('none')
  document.getElementById('role-cancel')!.click()
  await selectRole(2)
  expect(getComputedStyle(remove).display).toBe('inline-flex')
})

it('preserves permissions unseen in a stale catalogue across metadata and checkbox edits', async () => {
  deferDetails = id => Response.json({ ...roles.find(role => role.id === id), permissions: ['spools:read', 'plugin:new_permission'] })
  await boot(); await selectRole()
  edit('role-edit-name', 'Metadata only')
  submit('role-edit-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#role-edit-form')!.hidden).toBe(true))
  expect(writes().map(call => call.init!.method)).toEqual(['PATCH'])
  await selectRole()
  togglePermission()
  submit('role-edit-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(2))
  expect(JSON.parse(String(writes()[1].init!.body))).toEqual(['spools:read', 'spools:update', 'plugin:new_permission'])
})

it('keeps fields disabled after a failed permission load and permits retry from the active pencil', async () => {
  deferDetails = () => Response.json({ detail: 'Load denied' }, { status: 403 })
  await boot()
  pencil(1).click()
  await vi.waitFor(() => expect(document.querySelector('#role-error')!.textContent).toContain('Load denied'))
  expect((document.getElementById('role-edit-name')!.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#role-save')!.disabled).toBe(true)
  expect(pencil(1).disabled).toBe(false)
  deferDetails = undefined
  await selectRole()
  expect((document.getElementById('role-edit-name')!.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false)
})
it('creates through the existing dialog and opens the new role editor', async () => {
  await boot()
  document.getElementById('btn-new-role')!.click()
  edit('role-key', 'editor')
  edit('role-name-input', 'Editor')
  submit('role-modal-form')
  await vi.waitFor(() => expect(pencil(3)?.getAttribute('aria-expanded')).toBe('true'))
  expect(document.querySelector('dialog[open]')).toBeNull()
  expect(writes()[0].path).toBe('/api/v1/admin/roles')
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ key: 'editor', name: 'Editor', description: null })
})
