// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { baseFilament, baseSpool, change, clearState, mockHttp, pageFixture } from './detail-page-test-support'

let page: Awaited<ReturnType<typeof pageFixture>> | undefined
const printer = { id: 1, name: 'Printer', driver_key: 'generic', is_active: true }
beforeEach(() => { clearState(); window.__fmAlert = vi.fn(async () => {}) })
afterEach(() => {
  page?.dispose()
  page = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['filament', 'spool'] as const)('refreshes physical %s calibration on Edit and treats restoring the old value as a change', async entity => {
  let remoteValue = '0.02'
  mockHttp({ printers: [printer], intercept: (path, init) => {
    if ((!init?.method || init.method === 'GET') && path.startsWith(`/api/v1/${entity}s/${entity === 'filament' ? 16 : 17}/printer-params?`)) {
      return Response.json([{ param_key: 'bambu_k_value', param_value: remoteValue }])
    }
  } })
  page = await pageFixture(entity)
  expect(document.querySelector('[data-parameter="bambu_k_value"]')!.textContent).toContain('0.02')
  remoteValue = '0.03'
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-setup-value="bambu_k_value"]')?.value).toBe('0.03'))
  change('[data-setup-value="bambu_k_value"]', '0.02')
  expect(page.printers.isDirty()).toBe(true)
  expect(document.querySelector<HTMLButtonElement>(entity === 'filament' ? '#submit-btn' : '[form="spool-inline-form"][type="submit"]')!.disabled).toBe(false)
})

it('synchronizes a freshly reassigned spool parent before showing inherited printer controls', async () => {
  const http = mockHttp({ printers: [printer], intercept: (path, init) => {
    if ((!init?.method || init.method === 'GET') && path.startsWith('/api/v1/filaments/16/printer-params?')) return Response.json([{ param_key: 'bambu_k_value', param_value: '0.02' }])
    if ((!init?.method || init.method === 'GET') && path.startsWith('/api/v1/filaments/18/printer-params?')) return Response.json([{ param_key: 'bambu_k_value', param_value: '0.08' }])
  } })
  page = await pageFixture('spool')
  http.setSpool({ ...baseSpool, filament_id: 18, filament: { ...baseFilament, id: 18, designation: 'New parent' } })
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-setup-value="bambu_k_value"]')?.value).toBe('0.08'))
  expect(document.querySelector<HTMLSelectElement>('[name="filament_id"]')!.value).toBe('18')
  expect(document.querySelector('.printer-setup-source a')!.getAttribute('href')).toBe('/filaments/18')
  expect(document.querySelector('.printer-setup-source a')!.getAttribute('title')).toContain('New parent')
})

it.each([7, 99])('reconciles fresh manufacturer %s data when reusing the filament editor', async manufacturerId => {
  const http = mockHttp()
  page = await pageFixture('filament')
  await page.enter()
  await page.cancel()
  http.setFilament({ ...http.filament, manufacturer_id: manufacturerId, manufacturer: { id: manufacturerId, name: 'Fresh manufacturer', empty_spool_weight_g: 333 } })
  await page.enter()
  const select = document.querySelector<HTMLSelectElement>('[name="manufacturer_id"]')!
  expect(select.value).toBe(String(manufacturerId))
  expect(select.validity.valueMissing).toBe(false)
  expect(select.selectedOptions[0].textContent).toBe('Fresh manufacturer')
  change('[name="manufacturer_id"]', '8', 'change')
  change('[name="manufacturer_id"]', String(manufacturerId), 'change')
  expect(document.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value).toBe('333')
  expect(page.controller.collectPayload(false).scalar.manufacturer_id).toBe(manufacturerId)
})

it('retains all freshly assigned colors and refreshed labels during a pattern-only save', async () => {
  const http = mockHttp()
  page = await pageFixture('filament')
  await page.enter()
  await page.cancel()
  http.setFilament({ ...http.filament, color_mode: 'multi', multi_color_style: 'striped', colors: [
    { color_id: 11, position: 1, color: { id: 11, name: 'Renamed red', hex_code: '#DD0000' } },
    { color_id: 99, position: 2, color: { id: 99, name: 'New green', hex_code: '#00FF00' } },
  ] })
  await page.enter()
  expect(page.controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }, { color_id: 99, position: 2 }])
  expect(document.querySelector('#filament-editor-color-name')!.textContent).toBe('Renamed red · New green')
  document.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
  const green = document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="New green "]')!
  expect(green.classList.contains('selected')).toBe(true)
  expect(green.getAttribute('aria-label')).toContain('#00FF00')
  change('[name="multi_color_style"]', 'gradient', 'change')
  document.querySelector('#filament-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(http.calls.some(call => call.path.endsWith('/colors') && call.method === 'PUT')).toBe(true))
  expect(http.calls.find(call => call.path.endsWith('/colors') && call.method === 'PUT')!.body).toEqual({
    color_mode: 'multi', multi_color_style: 'gradient', colors: [{ color_id: 11, position: 1 }, { color_id: 99, position: 2 }],
  })
})


it.each(['filament', 'spool'] as const)('cancels %s entry while printer discovery is pending', async entity => {
  let hold = false
  let complete!: (value: Response) => void
  mockHttp({ printers: [printer], intercept: path => {
    if (hold && path.startsWith('/api/v1/printers?')) return new Promise<Response>(done => { complete = done })
  } })
  page = await pageFixture(entity)
  hold = true
  const entering = page.enter()
  await vi.waitFor(() => expect(complete).toBeDefined())
  document.getElementById(entity === 'filament' ? 'filament-form-cancel' : 'btn-cancel-edit')!.click()
  const isEditing = () => entity === 'filament'
    ? !document.getElementById('filament-editor')!.classList.contains('hidden')
    : !!document.getElementById('btn-cancel-edit')
  const focus = document.createElement('button')
  document.body.append(focus)
  try {
    await vi.waitFor(() => expect(isEditing()).toBe(false))
    await vi.waitFor(() => expect(document.activeElement?.id).toBe(entity === 'filament' ? 'btn-enter-filament-edit' : 'btn-edit-spool'))
    focus.focus()
  } finally {
    hold = false
    complete(Response.json({ items: [printer], total: 1 }))
    await entering
  }
  await vi.waitFor(() => expect(document.querySelector('[data-setup-value="bambu_k_value"]')).toBeNull())
  expect(isEditing()).toBe(false)
  expect(location.search).toBe('')
  expect(document.activeElement).toBe(focus)
})

it('refreshes unselected manufacturer and color choices after cache expiry without duplicating options', async () => {
  let fresh = false
  mockHttp({ intercept: path => {
    if (fresh && path.startsWith('/api/v1/manufacturers?')) return Response.json({ items: [
      { id: 7, name: 'Brand' }, { id: 8, name: 'Second renamed', empty_spool_weight_g: 333 }, { id: 99, name: 'Third' },
    ], total: 3 })
    if (fresh && path.startsWith('/api/v1/colors?')) return Response.json({ items: [
      { id: 11, name: 'Red', hex_code: '#FF0000' }, { id: 99, name: 'Green', hex_code: '#00FF00' },
    ], total: 2 })
  } })
  page = await pageFixture('filament')
  await page.enter()
  await page.cancel()
  fresh = true
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 360000)
  await page.enter()
  change('[name="manufacturer_id"]', '8', 'change')
  expect(document.querySelector<HTMLInputElement>('[name="default_spool_weight_g"]')!.value).toBe('333')
  expect(document.querySelector<HTMLSelectElement>('[name="manufacturer_id"]')!.selectedOptions[0].textContent).toBe('Second renamed')
  document.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
  expect(document.querySelector('#color-grid button[aria-label^="Green "]')).not.toBeNull()
  expect(document.querySelectorAll('[name="manufacturer_id"] option[value="8"]')).toHaveLength(1)
  expect(document.querySelectorAll('#type option[value="PLA"]')).toHaveLength(1)
})

it.each(['filament', 'spool'] as const)('refreshes System definitions before applying a fresh %s Edit baseline', async entity => {
  let definition = { id: 1, target_type: entity, key: 'grade', label: 'Old number', field_type: 'number' }
  const http = mockHttp({ filament: { ...baseFilament, custom_fields: { grade: 42 } }, spool: { ...baseSpool, custom_fields: { grade: 42 } }, intercept: path => {
    if (path.startsWith('/api/v1/system-extra-fields')) return Response.json(path.includes('target_type=' + entity) ? [definition] : [])
  } })
  page = await pageFixture(entity)
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.system-field-input[data-key="grade"]')?.type).toBe('number'))
  if (entity === 'spool') await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#btn-edit-spool')!.disabled).toBe(false))
  await page.cancel()
  if (entity === 'spool') await vi.waitFor(() => expect(document.querySelector('#btn-cancel-edit')).toBeNull())
  definition = { ...definition, label: 'Current serial', field_type: 'text' }
  if (entity === 'filament') http.setFilament({ ...http.filament, custom_fields: { grade: 'Lot A' } })
  else http.setSpool({ ...http.spool, custom_fields: { grade: 'Lot A' } })
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.system-field-input[data-key="grade"]')?.type).toBe('text'))
  expect(document.querySelector<HTMLInputElement>('.system-field-input[data-key="grade"]')!.value).toBe('Lot A')
  expect(document.querySelector<HTMLButtonElement>(entity === 'filament' ? '#submit-btn' : '[form="spool-inline-form"][type="submit"]')!.disabled).toBe(true)
  if (entity === 'spool') await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#btn-edit-spool')!.disabled).toBe(false))
  await page.cancel()
  await vi.waitFor(() => expect(document.querySelector(entity === 'filament' ? '#filament-content' : '#spool-content')!.textContent).toContain('Current serial'))
  expect(document.querySelector(entity === 'filament' ? '#filament-content' : '#spool-content')!.textContent).not.toContain('Old number')
})

it.each(['filament', 'spool'] as const)('refreshes System definitions each time %s Manage fields opens', async entity => {
  let label = 'Original grade'
  mockHttp({ intercept: path => {
    if (path.startsWith('/api/v1/system-extra-fields')) return Response.json(path.includes('target_type=' + entity) ? [{ key: 'grade', label, field_type: 'text' }] : [])
  } })
  page = await pageFixture(entity)
  document.getElementById(entity === 'filament' ? 'btn-edit-filament-extra-fields' : 'btn-edit-extra-fields')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open).toBe(true))
  document.querySelector<HTMLButtonElement>('[data-extra-fields-cancel]')!.click()
  label = 'Current grade'
  document.getElementById(entity === 'filament' ? 'btn-edit-filament-extra-fields' : 'btn-edit-extra-fields')!.click()
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open).toBe(true))
  expect(document.querySelector('.entity-extra-fields-system-grid')!.textContent).toContain('Current grade')
})

it.each([false, true])('uses the acknowledged spool parent for printer conflicts while preserving a newer parent draft: %s', async newerDraft => {
  let complete!: (value: Response) => void
  let own = '0.03'
  const http = mockHttp({ printers: [printer], intercept: (path, init) => {
    const method = init?.method || 'GET', url = new URL(path, 'http://localhost')
    if (url.pathname === '/api/v1/spools/17' && method === 'PATCH') return new Promise<Response>(done => { complete = done })
    if (url.pathname === '/api/v1/spools/17/printer-params') return Response.json(own ? [{ param_key: 'bambu_k_value', param_value: own }] : [])
    if (url.pathname === '/api/v1/filaments/16/printer-params') return Response.json([{ param_key: 'bambu_k_value', param_value: '0.02' }])
    if (url.pathname === '/api/v1/filaments/18/printer-params') return Response.json([{ param_key: 'bambu_k_value', param_value: '0.08' }])
    if (url.pathname === '/api/v1/spools/17/printer-params/1' && method === 'DELETE') { own = ''; return new Response(null, { status: 204 }) }
  } })
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  page = await pageFixture('spool', true)
  document.querySelector<HTMLButtonElement>('[data-setup-action="reset"][data-key="bambu_k_value"]')!.click()
  change('[name="lot_number"]', 'Saved lot')
  document.querySelector('#spool-inline-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(complete).toBeDefined())
  const select = document.querySelector<HTMLSelectElement>('[name="filament_id"]')!
  if (newerDraft) {
    select.add(new Option('Later draft', '19'))
    change('[name="filament_id"]', '19', 'change')
  }
  const saved = { ...http.spool, lot_number: 'Saved lot', filament_id: 18, filament: { ...baseFilament, id: 18, designation: 'New parent' } }
  http.setSpool(saved)
  complete(Response.json(saved))
  await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.classList.contains('hidden')).toBe(false))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toEqual({ lot_number: 'Saved lot' })
  expect(own).toBe('0.03')
  expect(reload).not.toHaveBeenCalled()
  expect(http.calls.some(call => call.path.includes('/filaments/18/printer-params'))).toBe(true)
  expect(document.querySelector('.printer-setup-source a')!.getAttribute('href')).toBe('/filaments/18')
  expect(select.value).toBe(newerDraft ? '19' : '18')
})


it('does not write a printer reset when the acknowledged parent cannot be refreshed', async () => {
  let own = '0.03'
  let failDiscovery = false
  const http = mockHttp({ printers: [printer], intercept: (path, init) => {
    const method = init?.method || 'GET', url = new URL(path, 'http://localhost')
    if (failDiscovery && url.pathname === '/api/v1/printers') return Response.json({}, { status: 503 })
    if (url.pathname === '/api/v1/spools/17' && method === 'PATCH') {
      failDiscovery = true
      const saved = { ...http.spool, ...JSON.parse(String(init?.body)), filament_id: 18, filament: { ...baseFilament, id: 18 } }
      http.setSpool(saved)
      return Response.json(saved)
    }
    if (url.pathname === '/api/v1/spools/17/printer-params') return Response.json([{ param_key: 'bambu_k_value', param_value: own }])
    if (url.pathname === '/api/v1/filaments/16/printer-params') return Response.json([{ param_key: 'bambu_k_value', param_value: '0.02' }])
    if (url.pathname === '/api/v1/filaments/18/printer-params') return Response.json({}, { status: 503 })
    if (url.pathname === '/api/v1/spools/17/printer-params/1' && method === 'DELETE') { own = ''; return new Response(null, { status: 204 }) }
  } })
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  page = await pageFixture('spool', true)
  document.querySelector<HTMLButtonElement>('[data-setup-action="reset"][data-key="bambu_k_value"]')!.click()
  change('[name="lot_number"]', 'Saved lot')
  document.querySelector('#spool-inline-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.classList.contains('hidden')).toBe(false))
  expect(own).toBe('0.03')
  expect(reload).not.toHaveBeenCalled()
})

it.each(['filament', 'spool'] as const)('keeps %s Edit closed after a schema read fails and retries safely', async entity => {
  let fail = false
  let fresh = false
  const http = mockHttp({ intercept: path => {
    if (path.startsWith('/api/v1/system-extra-fields') && fail) return Response.json({}, { status: 503 })
    if (path.startsWith('/api/v1/system-extra-fields')) return Response.json([{ key: 'grade', label: fresh ? 'New grade' : 'Old grade', field_type: 'text' }])
  } })
  page = await pageFixture(entity)
  fail = true
  fresh = true
  if (entity === 'filament') http.setFilament({ ...http.filament, designation: 'Fresh' })
  else http.setSpool({ ...http.spool, lot_number: 'Fresh' })
  await page.enter()
  await vi.waitFor(() => entity === 'filament'
    ? expect(window.__fmAlert).toHaveBeenCalledOnce()
    : expect(document.getElementById('spool-edit-error')!.classList.contains('hidden')).toBe(false))
  expect(document.getElementById(entity === 'filament' ? 'filament-form-actions' : 'btn-cancel-edit')?.classList.contains('hidden') ?? true).toBe(true)
  fail = false
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector('.system-field-input[data-key="grade"]')).not.toBeNull())
  expect(document.querySelector(entity === 'filament' ? '#system-fields-grid' : '#spool-system-fields-editor')?.textContent).toContain('New grade')
  expect(document.querySelector<HTMLInputElement>(entity === 'filament' ? '[name="designation"]' : '[name="lot_number"]')!.value).toBe('Fresh')
})


it.each(['filament', 'spool'] as const)('ignores late %s Manage schema after Edit starts', async entity => {
  let hold = false
  let complete!: (value: Response) => void
  mockHttp({ intercept: path => {
    if (hold && path.startsWith('/api/v1/system-extra-fields')) {
      hold = false
      return new Promise<Response>(done => { complete = done })
    }
  } })
  page = await pageFixture(entity)
  hold = true
  document.getElementById(entity === 'filament' ? 'btn-edit-filament-extra-fields' : 'btn-edit-extra-fields')!.click()
  await vi.waitFor(() => expect(complete).toBeDefined())
  await page.enter()
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(entity === 'filament' ? '[name="designation"]' : '[name="lot_number"]')).not.toBeNull())
  change(entity === 'filament' ? '[name="designation"]' : '[name="lot_number"]', 'Later draft')
  complete(Response.json([{ key: 'obsolete', label: 'Old schema', field_type: 'text' }]))
  await new Promise(done => setTimeout(done, 10))
  expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open ?? false).toBe(false)
  expect(document.querySelector<HTMLInputElement>(entity === 'filament' ? '[name="designation"]' : '[name="lot_number"]')!.value).toBe('Later draft')
})
