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
import { bindColorCleanup } from './color-library-cleanup'
import { bindColorPickerPopup } from './color-picker-wheel'
import { hasPermission } from './auth'
import { colorUsageHtml } from './color-library-links'
import * as inventoryScroll from './inventory-scroll'
import * as filters from './table-column-filters'
import * as locationTypes from './location-types'
import * as driverLocations from './driver-managed-locations'
import { api } from './api'
import { createExtraFieldDefinitionDialog } from './extra-field-definition-dialog'
import { copyText } from './clipboard'
import { initColumnLocks } from './column-locks'

// Canvas rendering is covered by the Chrome color-library check.
vi.mock('./color-wheel', async importOriginal => ({
  ...await importOriginal<typeof import('./color-wheel')>(),
  neutralWheelPalette: vi.fn(() => ({ background: 'none' })),
}))

const calls: { path: string; init?: RequestInit }[] = []
let failSave = false
type ColorHookOptions = Parameters<typeof import('./color-plugin-hooks').mountColorPluginHooks>[2]
let capturedColorHooks: ColorHookOptions | undefined
let fixtureUser: {is_superadmin: boolean; permissions: string[]} = {is_superadmin: true, permissions: []}
let fixtureColorHex = '#12345680'
let intercept: ((path: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined
const settings = { login_disabled: false, currency: 'EUR', rfid_protocol: 'openspool', rfid_extended_data_enabled: false, rfid_display_colons: true, default_spool_core_weight_g: 0, bambu_unmatched_profile_fallback: 'generic', filament_lookup_source: 'filamandb' }
const printer = { id: 4, name: 'Example printer', driver_key: 'moonraker', driver_config: { url: 'http://printer.local', enabled: true, targets: [{ slot: 1 }] } }
const dependencies = {
  ...dialog, ...state, ...driver, ...i18n, ...abort, ...scanner, ...escape, ...actions, ...colors, ...filters, ...inventoryScroll, ...locationTypes, ...driverLocations, api, createExtraFieldDefinitionDialog, copyText, initColumnLocks, colorUsageHtml,
  mountColorPluginHooks: (_host: HTMLElement, _workspace: HTMLDialogElement, options: ColorHookOptions) => { capturedColorHooks = options; return {close() {}, refresh: async () => [], updateEligibility() {}} },
  mountPluginUiLaunchers: () => ({refresh: async () => [], updateEligibility() {}}),
  hasPermission, getMe: async () => fixtureUser,
  bindColorCleanup, bindColorPickerPopup,
  fetchAllPages: async () => ({ items: [{ id: 2, name: 'Translucent blue', hex_code: fixtureColorHex, usage_count: 1 }] }),
  initI18n: async () => {}, initCurrency: async () => {}, initMaterialPresets: () => {}, initColumnPicker: () => {}, initColumnResize: () => {},
  invalidateCachePrefix: () => {}, CACHE_KEYS: { LOCATIONS: 'locations' },
  cachedFetchAllPages: async () => ({ items: [{ id: 3, name: 'Shelf "A" <blue>', identifier: 'UID', location_type: 'Storage', spool_count: 1 }] }),
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
  capturedColorHooks = undefined
  fixtureUser = {is_superadmin: true, permissions: []}
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
    if (path === '/auth/me') return Response.json(fixtureUser)
    if (path === '/api/v1/me') return Response.json({ email: 'test@example.com', display_name: 'Test', language: 'en' })
    if (path.includes('app-settings')) return Response.json(settings)
    if (path.includes('/admin/system/plugins')) return Response.json([{ driver_key: 'moonraker', plugin_type: 'printer_driver', is_active: true, config_schema: { properties: { url: { type: 'string' }, enabled: { type: 'boolean' }, targets: { type: 'array' } } } }])
    if (path === '/api/v1/colors/2') return Response.json({id: 2, name: 'Translucent blue', hex_code: fixtureColorHex, usage_count: 1})
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
    default_spool_core_weight_g: 60, default_empty_spool_weight_g: null, bambu_unmatched_profile_fallback: 'generic',
    mcp_enabled: false, mcp_write_enabled: false,
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
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true))
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('printer-name', 'Updated printer')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Updated printer', driver_key: 'moonraker', driver_config: printer.driver_config, nozzle_diameter_mm: null, nozzle_hardened: null })
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
})
it.each([['en', 'Edit'], ['de', 'Bearbeiten']] as const)('retains quoted location names and translated actions (%s)', async (lang, label) => {
  i18n.setLang(lang)
  await boot('locations/index')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector('.btn-edit')!.getAttribute('aria-label')).toBe(label)
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
  expect(document.querySelector<HTMLInputElement>('#location-name')!.value).toBe('Shelf "A" <blue>')
  expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(true)
  expect(document.querySelector<HTMLDialogElement>('#rfid-modal')!.open).toBe(false)
  change('location-name', 'Shelf B')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Shelf B', identifier: 'UID', location_type: 'Storage' })
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('#modal-container')!.open).toBe(false))
  const confirm = vi.fn(async (_message: string, _options?: { isDanger?: boolean }) => false)
  vi.stubGlobal('__fmConfirm', confirm)
  document.querySelector<HTMLButtonElement>('.btn-delete')!.click()
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  expect(confirm.mock.calls[0][0]).toContain('Shelf "A" <blue>')
  expect(confirm.mock.calls[0][1]).toMatchObject({ isDanger: true })
})

it('filters locations by type and bulk deletes only the shown selection', async () => {
  const fixture = dependencies.cachedFetchAllPages
  dependencies.cachedFetchAllPages = async () => ({ items: [
    { id: 3, name: 'Shelf', identifier: null, location_type: 'Storage', spool_count: 0 },
    { id: 4, name: 'AMS A1', identifier: null, location_type: 'AMS', spool_count: 1 },
    { id: 5, name: 'Dry box', identifier: null, location_type: 'Dry Box', spool_count: 0 },
  ] } as never)
  const confirm = vi.fn(async (_message: string) => true)
  vi.stubGlobal('__fmConfirm', confirm)
  vi.stubGlobal('__fmSuccess', vi.fn(async () => true))
  intercept = (path, init) => {
    if (path === '/api/v1/locations/bulk' && init?.method === 'DELETE') {
      return Response.json({ updated: [], deleted: [3], skipped: [], not_found: [] })
    }
  }
  // A remembered filter for a type that no longer exists falls back to all.
  localStorage.setItem('filaman-locations-type-filter', 'Gone')
  try {
    await boot('locations/index')
    await vi.waitFor(() => expect(document.querySelectorAll('#locations-table input[data-location-id]')).toHaveLength(3))
    expect(document.querySelector<HTMLSelectElement>('#type-filter')!.value).toBe('')
    const filterOptions = [...document.querySelectorAll<HTMLOptionElement>('#type-filter option')].map(o => o.textContent)
    expect(filterOptions).toEqual(['All types', 'AMS', 'Storage', 'Dry Box', 'No type'])

    change('type-filter', locationTypes.encodeTypeOption('Storage'))
    const rows = document.querySelectorAll<HTMLInputElement>('#locations-table input[data-location-id]')
    expect([...rows].map(cb => cb.dataset.locationId)).toEqual(['3'])

    change('type-filter', '')
    document.querySelector<HTMLInputElement>('#locations-table input[data-location-id="5"]')!.click()
    change('type-filter', locationTypes.encodeTypeOption('Storage'))
    change('bulk-select-all', true)
    expect(document.getElementById('bulk-action-bar')!.classList.contains('visible')).toBe(true)
    document.querySelector<HTMLButtonElement>('#bulk-btn-delete')!.click()
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toContain('(Shelf)')
    expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ location_ids: [3] })
  } finally {
    dependencies.cachedFetchAllPages = fixture
  }
})

it('hides driver-managed slots and drops them from the bulk selection', async () => {
  const fixture = dependencies.cachedFetchAllPages
  dependencies.cachedFetchAllPages = async () => ({ items: [
    { id: 3, name: 'Shelf', identifier: null, location_type: 'Storage', spool_count: 0 },
    { id: 4, name: 'AMS A1', identifier: null, location_type: 'AMS', custom_fields: { managed_by: 'bambuddy_plugin' }, spool_count: 1 },
  ] } as never)
  try {
    await boot('locations/index')
    await vi.waitFor(() => expect(document.querySelectorAll('#locations-table input[data-location-id]')).toHaveLength(2))
    const hide = document.querySelector<HTMLInputElement>('#hide-driver-managed')!
    expect(hide.checked).toBe(false)

    document.querySelector<HTMLInputElement>('#locations-table input[data-location-id="4"]')!.click()
    expect(document.getElementById('bulk-action-bar')!.classList.contains('visible')).toBe(true)

    change('hide-driver-managed', true)
    const shown = [...document.querySelectorAll<HTMLInputElement>('#locations-table input[data-location-id]')].map(cb => cb.dataset.locationId)
    expect(shown).toEqual(['3'])
    expect(document.getElementById('bulk-action-bar')!.classList.contains('visible')).toBe(false)
    expect(localStorage.getItem('filaman-locations-hide-driver-managed')).toBe('1')

    change('hide-driver-managed', false)
    expect([...document.querySelectorAll<HTMLInputElement>('#locations-table input[data-location-id]')].map(cb => cb.dataset.locationId)).toEqual(['3', '4'])
  } finally {
    dependencies.cachedFetchAllPages = fixture
  }
})

it('restores Hide Driver Managed from localStorage', async () => {
  const fixture = dependencies.cachedFetchAllPages
  dependencies.cachedFetchAllPages = async () => ({ items: [
    { id: 3, name: 'Shelf', identifier: null, location_type: 'Storage', spool_count: 0 },
    { id: 4, name: 'AMS A1', identifier: null, location_type: 'AMS', custom_fields: { managed_by: 'bambuddy_plugin' }, spool_count: 1 },
  ] } as never)
  localStorage.setItem('filaman-locations-hide-driver-managed', '1')
  try {
    await boot('locations/index')
    await vi.waitFor(() => expect(document.querySelectorAll('#locations-table input[data-location-id]')).toHaveLength(1))
    expect(document.querySelector<HTMLInputElement>('#hide-driver-managed')!.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#locations-table input[data-location-id]')!.dataset.locationId).toBe('3')
  } finally {
    dependencies.cachedFetchAllPages = fixture
  }
})

it('locks AMS on driver-managed slots, resolves non-canonical casing, and rejects blank write-ins', async () => {
  const fixture = dependencies.cachedFetchAllPages
  dependencies.cachedFetchAllPages = async () => ({ items: [
    { id: 3, name: 'Shelf', identifier: null, location_type: 'storage', spool_count: 0 },
    { id: 4, name: 'AMS A1', identifier: null, location_type: 'AMS', custom_fields: { managed_by: 'bambuddy_plugin' }, spool_count: 1 },
  ] } as never)
  try {
    await boot('locations/index')
    await vi.waitFor(() => expect(document.querySelectorAll('.btn-edit')).toHaveLength(2))
    expect(document.querySelector('[data-rfid-location="3"]')).not.toBeNull()
    expect(document.querySelector('[data-rfid-location="4"]')).toBeNull()

    // Non-canonical "storage" resolves to "Storage" instead of falling back to No type.
    document.querySelector<HTMLButtonElement>('.btn-edit[data-id="3"]')!.click()
    expect(document.querySelector<HTMLInputElement>('#location-identifier')!.readOnly).toBe(false)
    expect(document.getElementById('location-type-hint')!.classList.contains('hidden')).toBe(true)
    const singleOptions = [...document.querySelectorAll<HTMLOptionElement>('#location-type option')].map(o => o.textContent)
    expect(singleOptions).toEqual(['No type', 'AMS', 'Storage', 'Other (write in)…'])
    expect(document.querySelector<HTMLSelectElement>('#location-type')!.value).toBe(locationTypes.encodeTypeOption('Storage'))

    expect(document.querySelector('#location-type-custom')!.getAttribute('pattern')).toBe('.*\\S.*')
    expect(document.querySelector('#bulk-type-custom')!.getAttribute('pattern')).toBe('.*\\S.*')

    // Blank/whitespace write-in is rejected by form validity instead of saving null.
    change('location-type', locationTypes.TYPE_WRITE_IN)
    change('location-type-custom', '   ')
    submit('modal-form')
    expect(writes()).toHaveLength(0)

    change('location-type-custom', 'Dry Box')
    submit('modal-form')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Shelf', identifier: null, location_type: 'Dry Box' })

    // Driver-managed slot locks type to AMS in Edit Location.
    document.querySelector<HTMLButtonElement>('.btn-edit[data-id="4"]')!.click()
    const typeSelect = document.querySelector<HTMLSelectElement>('#location-type')!
    expect([...typeSelect.options].map(o => o.textContent)).toEqual(['AMS'])
    expect(typeSelect.value).toBe(locationTypes.encodeTypeOption('AMS'))
    expect(typeSelect.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#location-identifier')!.readOnly).toBe(true)
    expect(document.getElementById('location-identifier-hint')!.textContent).toContain('printer driver')
    expect(document.getElementById('location-type-hint')!.textContent).toContain('cannot be changed')
    expect(document.getElementById('location-type-hint')!.classList.contains('hidden')).toBe(false)
    document.querySelector<HTMLButtonElement>('#modal-cancel')!.click()

    const alert = vi.fn(async (_message: string) => true)
    const success = vi.fn(async () => true)
    vi.stubGlobal('__fmAlert', alert)
    vi.stubGlobal('__fmSuccess', success)

    document.querySelector<HTMLInputElement>('#locations-table input[data-location-id="4"]')!.click()
    document.querySelector<HTMLButtonElement>('#bulk-btn-type')!.click()
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('AMS slots managed by a printer driver cannot change type.'))
    expect(document.querySelector<HTMLDialogElement>('#bulk-type-modal')!.open).toBe(false)

    intercept = (path, init) => {
      if (path === '/api/v1/locations/bulk' && init?.method === 'PATCH') {
        return Response.json({ detail: [{ msg: 'List should have at most 1000 items' }] }, { status: 422 })
      }
    }
    document.querySelector<HTMLInputElement>('#locations-table input[data-location-id="3"]')!.click()
    document.querySelector<HTMLButtonElement>('#bulk-btn-type')!.click()
    expect(document.getElementById('bulk-type-hint')!.textContent).toContain('keep type AMS')
    expect(document.querySelector<HTMLSelectElement>('#bulk-type')!.value).toBe(locationTypes.encodeTypeOption('Storage'))
    expect(document.querySelector<HTMLButtonElement>('#bulk-type-submit')!.disabled).toBe(false)
    submit('bulk-type-form')
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('List should have at most 1000 items'))
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#bulk-type-submit')!.disabled).toBe(false))

    intercept = (path, init) => {
      if (path === '/api/v1/locations/bulk' && init?.method === 'PATCH') {
        return Response.json({ updated: [3], deleted: [], skipped: [4], not_found: [] })
      }
    }
    submit('bulk-type-form')
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Updated the type of 1 location(s).'))
    expect(JSON.parse(String(writes().at(-1)!.init!.body))).toEqual({ location_ids: [3], location_type: 'Storage' })
  } finally {
    dependencies.cachedFetchAllPages = fixture
  }
})

it('preserves alpha colors and disables deletion of an in-use color', async () => {
  const alert = vi.fn(async () => true)
  vi.stubGlobal('__fmAlert', alert)
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  expect(document.querySelector<HTMLButtonElement>('.btn-delete')!.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('.btn-delete')!.title).toBe(i18n.t('colors.inUseWarning'))
  document.querySelector<HTMLButtonElement>('.btn-delete')!.click()
  expect(alert).not.toHaveBeenCalled()
  expect(writes()).toHaveLength(0)
  expect(document.querySelector('td[data-column-pin="end"] .btn-edit')).not.toBeNull()
  expect(document.querySelector('td[data-column-pin="end"] .btn-delete use')?.getAttribute('href')).toContain('#icon-trash')
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#color-hex')!.value).toBe('#12345680'))
  expect(document.querySelector('#modal-form .fm-opacity-preview')).toBeNull()
  expect(document.getElementById('color-alpha-preview')).toBe(document.querySelector('[data-color-picker-swatch]'))
  expect(document.getElementById('color-picker')!.closest('form')).toBe(document.getElementById('modal-form'))
  expect(document.querySelector('[data-color-rgb], [role=tablist]')).toBeNull()
  expect(document.querySelector<HTMLButtonElement>('#modal-submit')!.disabled).toBe(true)
  change('color-name', 'Renamed translucent blue')
  const rowBeforeSave = document.querySelector('#colors-table tr')
  submit('modal-form')
  await vi.waitFor(() => expect(writes()).toHaveLength(1))
  expect(JSON.parse(String(writes()[0].init!.body))).toEqual({ name: 'Renamed translucent blue', hex_code: '#12345680' })
  await vi.waitFor(() => expect(document.querySelector('#colors-table tr')).not.toBe(rowBeforeSave))
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
  const rfidButton = document.querySelector<HTMLButtonElement>('#locations-table [data-rfid-location]')!
  rfidButton.click()
  vi.useFakeTimers()
  const rfid = document.querySelector<HTMLDialogElement>('#rfid-modal')!
  expect(rfid.open).toBe(true)
  document.querySelector<HTMLButtonElement>('#rfid-confirm')!.click()
  rfid.dispatchEvent(new Event('cancel', { cancelable: true }))
  resolveWrite(Response.json({ success: true }))
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls.some(call => call.path.includes('write-status'))).toBe(false)
  rfidButton.click()
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
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
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
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
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
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
  const save = document.querySelector<HTMLButtonElement>('#modal-submit')!
  expect(save.disabled).toBe(true)
  change('color-alpha-enabled', true)
  change('color-alpha-value', '50')
  expect(save.disabled).toBe(false)
  change('color-alpha-enabled', false)
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#color-hex')!.value).toBe('#FF0000'))
  expect(save.disabled).toBe(true)
  expect(writes()).toHaveLength(0)
})


it('plugin color-open preserves a create-only draft instead of entering inaccessible edit mode', async () => {
  fixtureUser = {is_superadmin: false, permissions: ['colors:create']}
  await boot('filaments/colors')
  document.querySelector<HTMLButtonElement>('#btn-new')!.click(); change('color-name', 'Unsaved draft')
  const confirm = vi.fn(async () => true); Object.assign(window, {__fmConfirm: confirm})
  expect(await capturedColorHooks!.openExisting(2, () => true, async () => true)).toBe(false)
  expect(document.querySelector<HTMLInputElement>('#color-name')!.value).toBe('Unsaved draft')
  expect(confirm).not.toHaveBeenCalled()
})

it.each(['deleted', 'revoked', 'removed', 'manual', 'updated'])('plugin color-open revalidates a %s target after human confirmation', async outcome => {
  await boot('filaments/colors')
  document.querySelector<HTMLButtonElement>('#btn-new')!.click(); change('color-name', 'Unsaved draft')
  let confirmed = false
  intercept = (path, init) => {
    if (init?.method && init.method !== 'GET') return
    if (path === '/auth/me') return Response.json({is_superadmin: !(confirmed && outcome === 'revoked'), permissions: []})
    if (path === '/api/v1/colors/2') return confirmed && outcome === 'deleted'
      ? Response.json({detail: 'Deleted'}, {status: 404})
      : Response.json({id: 2, name: confirmed ? 'Fresh target' : 'Old target', hex_code: '#AABBCC', usage_count: 9})
  }
  const confirm = vi.fn(async () => { confirmed = true; if (outcome === 'manual') change('color-name', 'New manual draft'); return true })
  Object.assign(window, {__fmConfirm: confirm})
  const opened = await capturedColorHooks!.openExisting(2, () => true, async () => outcome !== 'removed')
  expect(confirm).toHaveBeenCalledWith(expect.any(String), {okLabel: 'Open color', isDanger: false})
  expect(opened).toBe(outcome === 'updated')
  expect(document.querySelector<HTMLInputElement>('#color-name')!.value).toBe(outcome === 'updated' ? 'Fresh target' : outcome === 'manual' ? 'New manual draft' : 'Unsaved draft')
  if (opened) expect(capturedColorHooks!.read().usage_count).toBe(9)
})


it('uses the distinct-filament detail count when entering the native color editor', async () => {
  intercept = path => path === '/api/v1/colors/2'
    ? Response.json({id: 2, name: 'Fresh native', hex_code: '#12345680', usage_count: 2}) : undefined
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  await vi.waitFor(() => expect(document.querySelector('#modal-container')!.hasAttribute('open')).toBe(true))
  await vi.waitFor(() => expect(capturedColorHooks!.read().fields.name).toBe('Fresh native'))
  expect(capturedColorHooks!.read().usage_count).toBe(2)
})


it('does not show a superseded color-detail error over a newer native draft', async () => {
  let release!: (value: Response) => void
  intercept = path => path === '/api/v1/colors/2' ? new Promise(resolve => {release = resolve}) : undefined
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('.btn-edit')).not.toBeNull())
  const alert = vi.fn(); Object.assign(window, {__fmAlert: alert})
  document.querySelector<HTMLButtonElement>('.btn-edit')!.click()
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('color-name', 'New draft')
  release(Response.json({message: 'Deleted'}, {status: 404}))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(alert).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('#color-name')!.value).toBe('New draft')
})


it('does not bind an obsolete color page after delayed initialization', async () => {
  let release!: () => void, started!: () => void
  const reading = new Promise<void>(resolve => {started = resolve})
  const initialized = new Promise<void>(resolve => {release = resolve})
  const lifecycle = new AbortController()
  const pending = bootAstroPage('filaments/colors', {...dependencies, initI18n: () => {started(); return initialized}}, lifecycle.signal)
  await reading
  lifecycle.abort()
  document.body.innerHTML = '<main>Another panel</main>'
  release()
  await expect(pending).resolves.toBeUndefined()
  expect(document.body.textContent).toBe('Another panel')
})


it.each(['failed lookup', 'later grant'])('color-open checks current authorization after a %s snapshot', async initial => {
  fixtureUser = {is_superadmin: false, permissions: ['colors:create']}
  await bootAstroPage('filaments/colors', {...dependencies, getMe: async () => initial === 'failed lookup' ? null : fixtureUser})
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('color-name', 'Unsaved draft')
  intercept = path => path === '/auth/me' ? Response.json({is_superadmin: true, permissions: []}) : undefined
  Object.assign(window, {__fmConfirm: vi.fn(async () => true)})
  expect(await capturedColorHooks!.openExisting(2, () => true, async () => true)).toBe(true)
  expect(calls.filter(call => call.path === '/auth/me')).toHaveLength(2)
  expect(document.querySelector<HTMLInputElement>('#color-id')!.value).toBe('2')
})


it('switches the wheel from a neutral mode when a plugin stages a chromatic color', async () => {
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('[data-color-select]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  expect(document.querySelector('[data-color-neutral="black"]')!.getAttribute('aria-pressed')).toBe('true')
  capturedColorHooks!.stage({name: 'Plugin red', hex_code: '#FF0000'})
  expect(document.querySelector('[data-wheel-color]')!.getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('[data-color-neutral="black"]')!.getAttribute('aria-pressed')).toBe('false')
  expect(document.querySelector<HTMLInputElement>('[data-wheel-hex]')!.value).toBe('#FF0000')
})

it('clears the loaded-row header after filtering selected colors to no rows', async () => {
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('[data-color-select]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('#color-select-matching')!.click()
  document.querySelector<HTMLButtonElement>('.col-hex .fm-header-filter-trigger')!.click()
  const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel.open')!
  const value = panel.querySelector<HTMLInputElement>('.fm-header-filter-value')!
  value.value = 'no-match'
  value.dispatchEvent(new Event('input', {bubbles: true}))
  Array.from(panel.querySelectorAll('button')).find(button => button.textContent === i18n.t('filters.apply'))!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-color-select]')).toBeNull())
  const header = document.querySelector<HTMLInputElement>('#color-select-loaded')!
  expect(header.disabled).toBe(true)
  expect(header.checked).toBe(false)
  expect(header.indeterminate).toBe(false)
})


it('clears the loaded-row header when a successful save cannot reload colors', async () => {
  vi.spyOn(dependencies, 'fetchAllPages')
    .mockResolvedValueOnce({items: [{id: 2, name: 'Blue', hex_code: fixtureColorHex, usage_count: 1}]})
    .mockRejectedValueOnce(new Error('Reload offline'))
  await boot('filaments/colors')
  await vi.waitFor(() => expect(document.querySelector('[data-color-select]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('#color-select-matching')!.click()
  document.querySelector<HTMLButtonElement>('#btn-new')!.click()
  change('color-name', 'New color')
  submit('modal-form')
  await vi.waitFor(() => expect(document.querySelector('#colors-table')!.textContent).toContain(i18n.t('colors.failedLoad')))
  expect(document.querySelector<HTMLButtonElement>('#color-select-matching')!.disabled).toBe(true)
  const header = document.querySelector<HTMLInputElement>('#color-select-loaded')!
  expect(header.disabled).toBe(true)
  expect(header.checked).toBe(false)
})
