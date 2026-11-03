// @vitest-environment happy-dom
import { bootAstroPage } from '../../tests/helpers/astro-page'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as dialog from './form-dialog'
import * as state from './form-state'
import * as driver from './driver-config-form'
import * as i18n from './i18n'
import * as abort from './abort'
import * as scanner from './tag-scanner'
import * as escape from './extra-fields'
import * as actions from './table-actions'
import * as colors from './colors'
import * as filters from './table-column-filters'
import { api } from './api'
import { createExtraFieldDefinitionDialog } from './extra-field-definition-dialog'
import { copyText } from './clipboard'

const calls: { path: string; init?: RequestInit }[] = []
let failSave = false
let fixtureColorHex = '#12345680'
let intercept: ((path: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined
const settings = { login_disabled: false, currency: 'EUR', rfid_protocol: 'openspool', rfid_extended_data_enabled: false, rfid_display_colons: true, default_spool_core_weight_g: 0, bambu_unmatched_profile_fallback: 'generic', filament_lookup_source: 'filamandb' }
const printer = { id: 4, name: 'Example printer', driver_key: 'moonraker', driver_config: { url: 'http://printer.local', enabled: true, targets: [{ slot: 1 }] } }
const dependencies = {
  ...dialog, ...state, ...driver, ...i18n, ...abort, ...scanner, ...escape, ...actions, ...colors, ...filters, api, createExtraFieldDefinitionDialog, copyText,
  fetchAllPages: async () => ({ items: [{ id: 2, name: 'Translucent blue', hex_code: fixtureColorHex, usage_count: 1 }] }),
  initI18n: async () => {}, initCurrency: async () => {}, initColumnPicker: () => {}, initColumnResize: () => {},
  invalidateCachePrefix: () => {}, CACHE_KEYS: { LOCATIONS: 'locations' },
  cachedFetchAllPages: async () => ({ items: [{ id: 3, name: 'Shelf "A" <blue>', identifier: 'UID', spool_count: 1 }] }),
}
const boot = (path: string) => bootAstroPage(path, dependencies)
function change(id: string, value: string | boolean) {
  const input = document.getElementById(id) as HTMLInputElement
  if (typeof value === 'boolean') input.checked = value
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function submit(id: string) { document.getElementById(id)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
function writes() { return calls.filter(call => call.init?.method && call.init.method !== 'GET') }
beforeEach(() => {
  calls.length = 0
  failSave = false
  fixtureColorHex = '#12345680'
  intercept = undefined
  localStorage.clear()
  localStorage.setItem('lang', 'en')
  i18n.setLang('en')
  vi.stubGlobal('fetch', vi.fn(async (input, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, init })
    const overridden = intercept?.(path, init)
    if (overridden) return overridden
    if (init?.method && init.method !== 'GET') return failSave ? Response.json({ message: 'Save failed' }, { status: 400 }) : Response.json({ success: true })
    if (path === '/api/v1/me') return Response.json({ email: 'test@example.com', display_name: 'Test', language: 'en' })
    if (path.includes('app-settings')) return Response.json(settings)
    if (path.includes('/admin/system/plugins')) return Response.json([{ driver_key: 'moonraker', plugin_type: 'printer_driver', is_active: true, config_schema: { properties: { url: { type: 'string' }, enabled: { type: 'boolean' }, targets: { type: 'array' } } } }])
    if (path === '/api/v1/printers') return Response.json({ items: [printer] })
    if (path === '/api/v1/printers/4') return Response.json(printer)
    return Response.json([])
  }))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('retains failed profile drafts and keeps profile, password and scanner saves separate', async () => {
  await boot('settings')
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#display_name')!.value).toBe('Test'))
  const save = document.querySelector<HTMLButtonElement>('#profile-btn')!
  expect(save.disabled).toBe(true)
  change('display_name', 'Updated')
  expect(save.disabled).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('#password-btn')!.disabled).toBe(true)
  failSave = true
  submit('profile-form')
  await vi.waitFor(() => expect(document.querySelector('#profile-error')!.textContent).toBe('Save failed'))
  expect(save.disabled).toBe(false)
  expect(writes()[0].path).toBe('/api/v1/me')
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ display_name: 'Updated', language: 'en' })
  failSave = false
  submit('profile-form')
  await vi.waitFor(() => expect(document.querySelector('#profile-success')!.classList.contains('hidden')).toBe(false))
  expect(save.disabled).toBe(true)
  const count = writes().length
  change('scanner-auto-open', true)
  expect(writes()).toHaveLength(count)
  expect(scanner.isAutoOpenEnabled()).toBe(true)
})
it('saves visible app settings without resetting the hidden lookup preference', async () => {
  intercept = (path, init) => path.includes('/app-settings') && !init?.method
    ? Response.json({ ...settings, filament_lookup_source: 'disabled' }) : undefined
  await boot('admin/app-settings')
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#rfid-display-colons')!.checked).toBe(true))
  const save = document.querySelector<HTMLButtonElement>('#save-btn')!
  expect(save.disabled).toBe(true)
  change('currency', 'USD')
  expect(save.disabled).toBe(false)
  change('currency', 'EUR')
  expect(save.disabled).toBe(true)
  change('default-spool-core-weight', '60')
  submit('app-settings-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({
    login_disabled: false, currency: 'EUR', rfid_protocol: 'openspool',
    rfid_extended_data_enabled: false, rfid_display_colons: true,
    default_spool_core_weight_g: 60, bambu_unmatched_profile_fallback: 'generic',
  })
  await vi.waitFor(() => expect(save.disabled).toBe(true))
  expect(document.querySelector('#form-message')!.classList.contains('fm-settings-wide')).toBe(true)
})
it('links API Keys back to Settings and reveals a new token only in its disclosure panel', async () => {
  intercept = (path, init) => path === '/api/v1/me/api-keys'
    ? Response.json(init?.method === 'POST' ? { token: 'new-test-token' } : [{ id: 1, name: 'Integration <test>', created_at: null, last_used_at: null }]) : undefined
  const QrCode = Object.assign(vi.fn(), { CorrectLevel: { M: 0 } })
  await bootAstroPage('settings/api-keys', { ...dependencies, ensureQrCodeLoaded: async () => {}, getQrCodeConstructor: () => QrCode })
  await vi.waitFor(() => expect(document.querySelector('#keys-tbody')!.textContent).toContain('Integration <test>'))
  const back = document.querySelector('[data-i18n="apiKeys.backToSettings"]')!.closest('a')!
  expect(back?.getAttribute('href')).toBe('/settings')
  expect(document.querySelector('#new-token-container')!.classList.contains('hidden')).toBe(true)
  change('key_name', 'New integration')
  submit('create-key-form')
  await vi.waitFor(() => expect(document.querySelector('#new-token-container')!.classList.contains('hidden')).toBe(false))
  expect(document.querySelector<HTMLInputElement>('#new-token-input')!.value).toBe('new-test-token')
  expect(document.querySelector('#keys-tbody')!.textContent).not.toContain('new-test-token')
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'New integration' })
})
it('retains structured driver config when editing through the printer dialog', async () => {
  await boot('printers/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true))
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('printer-name', 'Updated printer')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Updated printer', driver_key: 'moonraker', driver_config: printer.driver_config })
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
})
it.each([['en', 'Edit'], ['de', 'Bearbeiten']] as const)('retains quoted location names and translated actions (%s)', async (lang, label) => {
  i18n.setLang(lang)
  await boot('locations/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector('.btn-edit')!.getAttribute('aria-label')).toBe(label)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector<HTMLInputElement>('#location-name')!.value).toBe('Shelf "A" <blue>')
  expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true)
  expect(document.querySelector<HTMLDialogElement>('#rfid-modal')!.open).toBe(false)
  change('location-name', 'Shelf B')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Shelf B', identifier: 'UID' })
})

it('preserves alpha colors and keeps in-use Delete unavailable', async () => {
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector<HTMLButtonElement>('.btn-delete')!.disabled).toBe(true)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  expect(document.querySelector<HTMLInputElement>('#color-hex')!.value).toBe('#12345680')
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('color-name', 'Renamed translucent blue')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Renamed translucent blue', hex_code: '#12345680' })
})

it('ignores a late RFID write response after Escape and reopening the dialog', async () => {
  let resolveWrite!: (response: Response) => void
  const pendingWrite = new Promise<Response>(resolve => { resolveWrite = resolve })
  intercept = (path, init) => {
    if (path === '/api/v1/devices/active') return Response.json([{ id: 9, name: 'Test device' }])
    if (init?.method === 'POST' && path.includes('write-tag')) return pendingWrite
  }
  await boot('locations/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  const openRfid = (window as unknown as { openRfidModal: (id: number) => void }).openRfidModal
  openRfid(3)
  vi.useFakeTimers()
  document.querySelector<HTMLButtonElement>('#rfid-confirm')!.click()
  const rfid = document.querySelector<HTMLDialogElement>('#rfid-modal')!
  rfid.dispatchEvent(new Event('cancel', { cancelable: true }))
  resolveWrite(Response.json({ success: true }))
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls.some(call => call.path.includes('write-status'))).toBe(false)
  openRfid(3)
  expect(rfid.open).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#rfid-confirm')!.disabled).toBe(false)
  expect(document.querySelector('#rfid-status')!.classList.contains('hidden')).toBe(true)
  document.querySelector<HTMLButtonElement>('#rfid-cancel')!.click()
})

it('keeps user management usable when the role catalog is forbidden, without changing roles', async () => {
  const user = { id: 7, email: 'editor@example.com', display_name: 'Editor', roles: ['operator'], is_superadmin: false, is_active: true }
  intercept = (path, init) => {
    if (path === '/api/v1/admin/roles') return Response.json({ detail: 'Role management required' }, { status: 403 })
    if (path === '/api/v1/admin/users' && init?.method === 'GET') return Response.json({ items: [user] })
    if (path === '/api/v1/admin/users/7' && init?.method === 'GET') return Response.json(user)
    if (path === '/api/v1/me') return Response.json({ id: 1, email: 'admin@example.com', display_name: 'Admin', is_active: true, is_superadmin: false, roles: ['user_admin'] })
  }
  await boot('admin/users')
  await vi.waitFor(() => expect(document.querySelector('#users-table')!.textContent).toContain(user.email))
  expect(document.querySelector('#users-table')!.textContent).toContain('operator')
  expect(document.querySelector('.btn-delete')).not.toBeNull()
  document.querySelector<HTMLButtonElement>('.btn-reset')!.click()
  change('reset-password', 'example-password')
  submit('reset-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#password-modal')!.open).toBe(false))
  expect(writes()[0].path).toBe('/api/v1/admin/users/7/reset-password')
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#user-id')!.value).toBe('7'))
  expect(document.querySelector('#roles-checkboxes')!.textContent).toBe(i18n.t('admin.rolesUnavailable'))
  change('user-display-name', 'Updated editor')
  submit('modal-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
  expect(JSON.parse(String(writes()[1].init!.body))).toEqual({ email: user.email, display_name: 'Updated editor', is_superadmin: false })
  expect(writes().some(call => call.path.endsWith('/roles'))).toBe(false)
})

it('keeps the user draft open when role assignment fails, then retries without creating another user', async () => {
  let rejectRoles = true
  const user = { id: 7, email: 'editor@example.com', display_name: 'Editor', roles: ['editor'], is_superadmin: false, is_active: true }
  intercept = (path, init) => {
    if (path === '/api/v1/admin/roles') return Response.json([{ key: 'editor', name: 'Editor' }])
    if (path === '/api/v1/admin/users' && (!init?.method || init.method === 'GET')) return Response.json({ items: [user] })
    if (path === '/api/v1/admin/users/7' && (!init?.method || init.method === 'GET')) return Response.json(user)
    if (path === '/api/v1/admin/users/7/roles' && init?.method === 'PUT') return rejectRoles
      ? Response.json({ detail: { message: 'Role update denied' } }, { status: 403 }) : Response.json({ success: true })
  }
  await boot('admin/users')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#user-email')!.value).toBe(user.email))
  change('user-display-name', 'Updated editor')
  submit('modal-form')
  await vi.waitFor(() => expect(document.querySelector('#modal-error')!.textContent).toBe('Role update denied'))
  expect(document.querySelector<HTMLInputElement>('#user-display-name')!.value).toBe('Updated editor')
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(false)
  rejectRoles = false
  submit('modal-form')
  await vi.waitFor(() => expect(writes().filter(call => call.path.endsWith('/roles'))).toHaveLength(2))
  expect(writes().some(call => call.init?.method === 'POST')).toBe(false)
})

it('keeps a newly created user identity after failed role assignment so retry cannot create a duplicate', async () => {
  let rejectRoles = true
  let created = false
  intercept = (path, init) => {
    if (path === '/api/v1/admin/users' && init?.method === 'POST') { created = true; return Response.json({ id: 7 }) }
    if (path === '/api/v1/admin/users' && (!init?.method || init.method === 'GET')) return Response.json({ items: created ? [{ id: 7, email: 'new@example.com', is_active: true }] : [] })
    if (path === '/api/v1/admin/roles') return Response.json([])
    if (path.endsWith('/users/7/roles') && init?.method === 'PUT') return rejectRoles
      ? Response.json({ detail: 'Could not assign roles' }, { status: 503 }) : Response.json({ success: true })
  }
  await boot('admin/users')
  await vi.waitFor(() => expect(document.querySelector('#users-table')!.textContent).toContain(i18n.t('admin.noUsers')))
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('user-email', 'new@example.com')
  change('user-password', 'example-password')
  submit('modal-form')
  await vi.waitFor(() => expect(document.querySelector('#modal-error')!.textContent).toBe('Could not assign roles'))
  await vi.waitFor(() => expect(document.querySelector('#users-table')!.textContent).toContain('new@example.com'))
  expect(document.querySelector<HTMLInputElement>('#user-id')!.value).toBe('7')
  expect(document.querySelector<HTMLInputElement>('#user-password')!.value).toBe('')
  rejectRoles = false
  submit('modal-form')
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
  expect(writes().filter(call => call.path === '/api/v1/admin/users' && call.init?.method === 'POST')).toHaveLength(1)
})
it('keeps plugin definitions separate and protected while searching and sorting all definitions', async () => {
  intercept = path => path === '/api/v1/system-extra-fields' ? Response.json([
    { id: 1, target_type: 'spool', key: 'inspection', label: 'Inspection', field_type: 'text', default_value: null, source: null },
    { id: 2, target_type: 'filament', key: 'bambuddy.flow', label: 'Flow', field_type: 'number', default_value: '0.98', source: 'bambuddy' },
  ]) : undefined
  await boot('admin/extra-fields')
  expect(document.querySelector('#fields-table')!.textContent).toContain('Inspection')
  expect(document.querySelector('#fields-table')!.textContent).not.toContain('bambuddy')
  expect(document.querySelector('#managed-fields-table .btn-edit')).toBeNull()
  expect(document.querySelector<HTMLAnchorElement>('#managed-fields-table a')!.getAttribute('href')).toBe('/admin/system')
  change('fields-search', 'bambuddy')
  expect(document.querySelector('#fields-table')!.textContent).not.toContain('Inspection')
  expect(document.querySelector('#managed-fields-table')!.textContent).toContain('Flow')
  change('fields-search', '')
  const applyDefaultFilter = (operator: string) => {
    document.querySelector<HTMLButtonElement>('#fields-list .col-default_value .fm-header-filter-trigger')!.click()
    const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel.open')!
    const select = panel.querySelector<HTMLSelectElement>('.fm-header-filter-operator')!
    select.value = operator
    select.dispatchEvent(new Event('change'))
    Array.from(panel.querySelectorAll('button')).find(button => button.textContent === i18n.t('filters.apply'))!.click()
  }
  applyDefaultFilter('isEmpty')
  expect(document.querySelector('#fields-table')!.textContent).toContain('Inspection')
  expect(document.querySelector('#managed-fields-table')!.textContent).not.toContain('Flow')
  applyDefaultFilter('isNotEmpty')
  expect(document.querySelector('#fields-table')!.textContent).not.toContain('Inspection')
  expect(document.querySelector('#managed-fields-table')!.textContent).toContain('Flow')
  expect(writes()).toHaveLength(0)
})
it('keeps the OIDC secret when saving other settings and resets Save after success', async () => {
  intercept = (path, init) => path.includes('/oidc-settings/') ? Response.json(init?.method === 'PUT'
    ? { has_client_secret: true } : { enabled: false, issuer_url: 'https://identity.example', client_id: 'app', scopes: 'openid email profile', button_text: 'Sign in', has_client_secret: true }) : undefined
  await boot('admin/oidc')
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#client-id')!.value).toBe('app'))
  expect([...document.querySelector<HTMLInputElement>('#oidc-enabled')!.labels!].some(label => label.textContent?.includes('Enabled'))).toBe(true)
  for (const id of ['issuer-url', 'client-secret', 'scopes', 'button-text', 'callback-url']) {
    const input = document.getElementById(id)!
    for (const hint of input.getAttribute('aria-describedby')!.split(' ')) {
      expect(input.closest('.oidc-control')!.contains(document.getElementById(hint))).toBe(true)
    }
  }
  expect(document.querySelector<HTMLButtonElement>('#save-btn')!.form).toBe(document.getElementById('oidc-form'))
  expect(document.querySelector<HTMLButtonElement>('#save-btn')!.disabled).toBe(true)
  change('button-text', 'Sign in with SSO')
  submit('oidc-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).not.toHaveProperty('client_secret')
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#save-btn')!.disabled).toBe(true))
})

it('mutes Save after reverting an opaque color through the opacity controls', async () => {
  fixtureColorHex = '#FF0000'
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  const save = document.querySelector<HTMLButtonElement>('#modal-submit')!
  expect(save.disabled).toBe(true)
  change('color-alpha-enabled', true)
  change('color-alpha-value', '50')
  expect(save.disabled).toBe(false)
  change('color-alpha-enabled', false)
  expect(document.querySelector<HTMLInputElement>('#color-hex')!.value).toBe('#FF0000')
  expect(save.disabled).toBe(true)
  expect(writes()).toHaveLength(0)
})
