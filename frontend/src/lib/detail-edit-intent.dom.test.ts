// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { baseFilament, baseSpool, change, clearState, mockHttp, pageFixture } from './detail-page-test-support'
import * as lookup from './filamentdb-lookup'

let page: Awaited<ReturnType<typeof pageFixture>> | undefined
beforeEach(() => {
  clearState()
  window.__fmAlert = vi.fn(async () => {})
})
afterEach(() => {
  page?.dispose()
  page = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const submit = (entity: 'filament' | 'spool') => document.querySelector(`#${entity === 'filament' ? 'filament-form' : 'spool-inline-form'}`)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const manage = (entity: 'filament' | 'spool') => document.getElementById(entity === 'filament' ? 'btn-edit-filament-extra-fields' : 'btn-edit-extra-fields')!.click()

it.each(['filament', 'spool'] as const)('fresh-reads %s on Edit and sends only changed native fields', async entity => {
  const http = mockHttp({ filament: { ...baseFilament, manufacturer_sku: ' \tSKU\r\n🧵 é\u200b ', finish_type: 'Legacy <silk>', spool_material: 'Wood & metal' }, spool: { ...baseSpool, spool_material: 'Wood & metal' } })
  page = await pageFixture(entity)
  if (entity === 'filament') http.setFilament({ ...http.filament, designation: 'Fresh' })
  else http.setSpool({ ...http.spool, lot_number: 'Fresh' })
  await page.enter()
  const name = entity === 'filament' ? 'designation' : 'lot_number'
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value).toBe('Fresh'))
  expect(document.querySelector<HTMLSelectElement>('[name="spool_material"]')!.value).toBe('Wood & metal')
  if (entity === 'filament') expect(document.querySelector<HTMLSelectElement>('[name="finish_type"]')!.value).toBe('Legacy <silk>')
  if (entity === 'filament') http.setFilament({ ...http.filament, drying_temp_c: 65 })
  else http.setSpool({ ...http.spool, purchase_price: 99, rfid_uid: 'DEADBEEF' })
  change(`[name="${name}"]`, 'Renamed')
  submit(entity)
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toEqual({ [name]: 'Renamed' })
  expect(http.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/colors'))).toEqual([])
  if (entity === 'filament') expect(http.filament.manufacturer_sku).toBe(' \tSKU\r\n🧵 é\u200b ')
})

it.each(['filament', 'spool'] as const)('deduplicates %s Manage reads and keeps an open dialog draft', async entity => {
  let resolve!: (value: Response) => void
  let hold = false
  const http = mockHttp({ system: [{ key: 'note', label: 'Note', field_type: 'text' }], intercept: (path, init) => hold && !init?.method && path.startsWith(`/api/v1/${entity}s/${entity === 'filament' ? 16 : 17}`) ? new Promise<Response>(done => { resolve = done }) : undefined })
  page = await pageFixture(entity)
  const before = http.calls.length
  hold = true
  manage(entity)
  manage(entity)
  expect(http.calls.slice(before)).toHaveLength(1)
  resolve(Response.json(entity === 'filament' ? http.filament : http.spool))
  await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open).toBe(true))
  const input = change('.entity-extra-fields-overlay [data-key="note"]', 'Draft')
  manage(entity)
  expect(http.calls.slice(before)).toHaveLength(1)
  expect(input.value).toBe('Draft')
})

it.each(['filament', 'spool'] as const)('invalidates a late %s Manage response when Edit starts', async entity => {
  let resolve!: (value: Response) => void
  let hold = false
  const http = mockHttp({ intercept: (path, init) => {
    if (hold && !init?.method && path.startsWith(`/api/v1/${entity}s/${entity === 'filament' ? 16 : 17}`)) {
      hold = false
      return new Promise<Response>(done => { resolve = done })
    }
  } })
  page = await pageFixture(entity)
  hold = true
  manage(entity)
  await page.enter()
  const name = entity === 'filament' ? 'designation' : 'lot_number'
  await vi.waitFor(() => expect(document.querySelector(`[name="${name}"]`)).not.toBeNull())
  change(`[name="${name}"]`, 'My draft')
  resolve(Response.json(entity === 'filament' ? http.filament : http.spool))
  await new Promise(done => setTimeout(done, 10))
  expect(document.querySelector<HTMLDialogElement>('.entity-extra-fields-overlay')?.open ?? false).toBe(false)
  expect(document.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value).toBe('My draft')
})

it('preserves explicit native clears, zero and false and performs intentional color PUTs', async () => {
  const http = mockHttp({ filament: { ...baseFilament, manufacturer_sku: 'SKU', drying_temp_c: 55, is_discontinued: true } })
  page = await pageFixture('filament', true)
  change('[name="manufacturer_sku"]', '')
  change('[name="drying_temp_c"]', '0')
  change('[name="is_discontinued"]', false)
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Blue "]')!.click()
  submit('filament')
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PUT')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toEqual({ manufacturer_sku: null, drying_temp_c: 0, is_discontinued: false })
  expect(http.calls.find(call => call.method === 'PUT')!.body).toEqual({ color_mode: 'single', multi_color_style: null, colors: [{ color_id: 12, position: 1 }] })
})

it('treats catalog prefill as native intent, including zero, false and unknown options', async () => {
  const http = mockHttp({ filament: { ...baseFilament, drying_temp_c: 55, is_discontinued: true } })
  page = await pageFixture('filament', true)
  page.controller.applyInitialData({ drying_temp_c: 0, is_discontinued: false, finish_type: 'Silk & <metal>', spool_material: 'Wood' }, 'catalog')
  submit('filament')
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toMatchObject({ drying_temp_c: 0, is_discontinued: false, finish_type: 'Silk & <metal>', spool_material: 'Wood' })
  expect(document.querySelector<HTMLSelectElement>('[name="finish_type"]')!.selectedOptions[0].textContent).toBe('Silk & <metal>')
})

it('omits normalized ordered colors, mode and style on a printer-only Save', async () => {
  const http = mockHttp({ filament: { ...baseFilament, color_mode: 'multi', colors: [{ color_id: 12, position: 8 }, { color_id: 11, position: 3 }] }, printers: [{ id: 1, name: 'Printer', driver_key: 'generic', is_active: true }] })
  page = await pageFixture('filament', true)
  change('[data-setup-value="bambu_k_value"]', '0.025')
  submit('filament')
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toEqual({})
  expect(http.calls.filter(call => call.path.endsWith('/colors'))).toEqual([])
})

it('keeps an edited color draft available after a failed color PUT and retries it', async () => {
  let failColors = true
  const http = mockHttp({ intercept: (path, init) => path.endsWith('/colors') && init?.method === 'PUT' && failColors ? Response.json({ message: 'Colors failed' }, { status: 500 }) : undefined })
  page = await pageFixture('filament', true)
  change('[name="designation"]', 'Saved scalar')
  change('[name="color_mode"][value="multi"]', true, 'change')
  change('[name="multi_color_style"]', 'gradient', 'change')
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Blue "]')!.click()
  submit('filament')
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toBe('Colors failed'))
  expect(http.filament.designation).toBe('Saved scalar')
  expect(page.controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }, { color_id: 12, position: 2 }])
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  failColors = false
  submit('filament')
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PUT')).toHaveLength(2))
  expect(http.filament.colors).toEqual([{ color_id: 11, position: 1 }, { color_id: 12, position: 2 }])
})

it.each([false, true])('saves a native revert after a color failure, including a newer draft during PATCH: %s', async duringPatch => {
  let failColors = true
  let finishPatch!: () => void
  const http = mockHttp({ intercept: (path, init) => {
    if (path.endsWith('/colors') && init?.method === 'PUT' && failColors) return Response.json({ message: 'Colors failed' }, { status: 500 })
    if (init?.method === 'PATCH' && duringPatch && !finishPatch) {
      http.setFilament({ ...http.filament, ...JSON.parse(String(init.body)) })
      return new Promise<Response>(resolve => { finishPatch = () => resolve(Response.json(http.filament)) })
    }
  } })
  page = await pageFixture('filament', true)
  change('[name="designation"]', 'Accepted B')
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Blue "]')!.click()
  submit('filament')
  if (duringPatch) {
    await vi.waitFor(() => expect(finishPatch).toBeDefined())
    change('[name="designation"]', baseFilament.designation)
    finishPatch()
  }
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toBe('Colors failed'))
  if (!duringPatch) change('[name="designation"]', baseFilament.designation)
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Red "]')!.click()
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  failColors = false
  submit('filament')
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PATCH')).toHaveLength(2))
  expect(http.calls.filter(call => call.method === 'PATCH')[1].body).toEqual({ designation: baseFilament.designation })
  expect(http.filament.designation).toBe(baseFilament.designation)
})

it.each(['native', 'extra'] as const)('saves a reverted accepted spool %s value after printer failure', async field => {
  let failPrinter = true
  const http = mockHttp({ printers: [{ id: 1, name: 'Printer', driver_key: 'generic', is_active: true }], system: [{ key: 'note', label: 'Note', field_type: 'text' }], intercept: (path, init) => path.includes('/printer-params/') && init?.method === 'PUT' && failPrinter ? Response.json({ message: 'Printer failed' }, { status: 500 }) : undefined })
  page = await pageFixture('spool', true)
  const selector = field === 'native' ? '[name="lot_number"]' : '#spool-system-fields-editor [data-key="note"]'
  const original = field === 'native' ? baseSpool.lot_number : 'Dry'
  change(selector, field === 'native' ? 'Accepted B' : 'Wet')
  change('[data-setup-value="bambu_k_value"]', '0.025')
  submit('spool')
  await vi.waitFor(() => expect(document.getElementById('spool-edit-error')!.textContent).toContain('Printer failed'))
  change(selector, original)
  // Reverting the failed printer draft leaves only the accepted entity revert dirty.
  change('[data-setup-value="bambu_k_value"]', '')
  expect(document.querySelector<HTMLButtonElement>('[form="spool-inline-form"][type="submit"]')!.disabled).toBe(false)
  failPrinter = false
  submit('spool')
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PATCH')).toHaveLength(2))
  const body = http.calls.filter(call => call.method === 'PATCH')[1].body
  if (field === 'native') expect(body.lot_number).toBe(original)
  else expect(body.custom_fields.note).toBe('Dry')
})

it.each(['colors', 'extra'] as const)('saves reverted accepted filament %s after printer failure', async field => {
  let failPrinter = true
  const http = mockHttp({ printers: [{ id: 1, name: 'Printer', driver_key: 'generic', is_active: true }], system: [{ key: 'note', label: 'Note', field_type: 'text' }], intercept: (path, init) => path.includes('/printer-params/') && init?.method === 'PUT' && failPrinter ? Response.json({ message: 'Printer failed' }, { status: 500 }) : undefined })
  page = await pageFixture('filament', true)
  if (field === 'colors') document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Blue "]')!.click()
  else change('#system-fields-grid [data-key="note"]', 'Wet')
  change('[data-setup-value="bambu_k_value"]', '0.025')
  submit('filament')
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toContain('Printer failed'))
  if (field === 'colors') document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Red "]')!.click()
  else change('#system-fields-grid [data-key="note"]', 'Dry')
  change('[data-setup-value="bambu_k_value"]', '')
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  failPrinter = false
  submit('filament')
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PATCH')).toHaveLength(2))
  if (field === 'colors') {
    expect(http.calls.filter(call => call.path.endsWith('/colors') && call.method === 'PUT')).toHaveLength(2)
    expect(http.filament.colors).toEqual([{ color_id: 11, position: 1 }])
  } else expect(http.calls.filter(call => call.method === 'PATCH')[1].body.custom_fields.note).toBe('Dry')
})

it.each([
  ['color_mode', 'retry'], ['color_mode', 'revert'],
  ['multi_color_style', 'retry'], ['multi_color_style', 'revert'],
] as const)('keeps %s native and color intent independent on %s after color failure', async (key, action) => {
  const original = key === 'color_mode' ? 'single' : 'striped'
  const next = key === 'color_mode' ? 'multi' : 'gradient'
  let failColors = true
  const http = mockHttp({ filament: { ...baseFilament, color_mode: key === 'color_mode' ? 'single' : 'multi', multi_color_style: 'striped' }, intercept: (path, init) => path.endsWith('/colors') && init?.method === 'PUT' && failColors ? Response.json({ message: 'Colors failed' }, { status: 500 }) : undefined })
  page = await pageFixture('filament', true)
  const edit = (value: string) => key === 'color_mode' ? change(`[name="color_mode"][value="${value}"]`, true, 'change') : change('[name="multi_color_style"]', value, 'change')
  edit(next)
  submit('filament')
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toBe('Colors failed'))
  if (action === 'revert') edit(original)
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  failColors = false
  submit('filament')
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PATCH')).toHaveLength(2))
  const patch = http.calls.filter(call => call.method === 'PATCH')[1].body
  if (action === 'revert') expect(patch[key]).toBe(original)
  else {
    expect(patch).toEqual({})
    expect(http.calls.filter(call => call.path.endsWith('/colors') && call.method === 'PUT')).toHaveLength(2)
  }
  expect(http.filament[key]).toBe(action === 'revert' ? original : next)
})

it.each(['filament', 'spool'] as const)('preserves newer %s native and extra drafts while PATCH is pending', async entity => {
  let finishPatch!: () => void
  let failPrinter = true
  const http = mockHttp({ printers: [{ id: 1, name: 'Printer', driver_key: 'generic', is_active: true }], system: [{ key: 'note', label: 'Note', field_type: 'text' }], intercept: (path, init) => {
    if (path.includes('/printer-params/') && init?.method === 'PUT' && failPrinter) return Response.json({ message: 'Printer failed' }, { status: 500 })
    if (init?.method === 'PATCH' && !finishPatch) {
      const saved = { ...(entity === 'filament' ? http.filament : http.spool), ...JSON.parse(String(init.body)) }
      if (entity === 'filament') http.setFilament(saved)
      else http.setSpool(saved)
      return new Promise<Response>(resolve => { finishPatch = () => resolve(Response.json(saved)) })
    }
  } })
  page = await pageFixture(entity, true)
  const name = entity === 'filament' ? 'designation' : 'lot_number'
  const original = entity === 'filament' ? baseFilament.designation : baseSpool.lot_number
  const note = entity === 'filament' ? '#system-fields-grid [data-key="note"]' : '#spool-system-fields-editor [data-key="note"]'
  change(`[name="${name}"]`, 'Accepted B')
  change(note, 'Wet')
  change('[data-setup-value="bambu_k_value"]', '0.025')
  submit(entity)
  await vi.waitFor(() => expect(finishPatch).toBeDefined())
  change(`[name="${name}"]`, original)
  change(note, 'Dry')
  finishPatch()
  await vi.waitFor(() => expect(document.getElementById(entity === 'filament' ? 'error-message' : 'spool-edit-error')!.textContent).toContain('Printer failed'))
  expect(document.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value).toBe(original)
  expect(document.querySelector<HTMLInputElement>(note)!.value).toBe('Dry')
  change('[data-setup-value="bambu_k_value"]', '')
  failPrinter = false
  submit(entity)
  await vi.waitFor(() => expect(http.calls.filter(call => call.method === 'PATCH')).toHaveLength(2))
  expect(http.calls.filter(call => call.method === 'PATCH')[1].body).toMatchObject({ [name]: original, custom_fields: { note: 'Dry' } })
})

it('preserves a newer color draft while its prior color PUT is pending', async () => {
  let finishColors!: () => void
  let failPrinter = true
  const http = mockHttp({ printers: [{ id: 1, name: 'Printer', driver_key: 'generic', is_active: true }], intercept: (path, init) => {
    if (path.includes('/printer-params/') && init?.method === 'PUT' && failPrinter) return Response.json({ message: 'Printer failed' }, { status: 500 })
    if (path.endsWith('/colors') && init?.method === 'PUT' && !finishColors) {
      http.setFilament({ ...http.filament, ...JSON.parse(String(init.body)) })
      return new Promise<Response>(resolve => { finishColors = () => resolve(Response.json(http.filament)) })
    }
  } })
  page = await pageFixture('filament', true)
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Blue "]')!.click()
  change('[data-setup-value="bambu_k_value"]', '0.025')
  submit('filament')
  await vi.waitFor(() => expect(finishColors).toBeDefined())
  document.querySelector<HTMLButtonElement>('#color-grid button[aria-label^="Red "]')!.click()
  finishColors()
  await vi.waitFor(() => expect(document.getElementById('error-message')!.textContent).toContain('Printer failed'))
  expect(page.controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }])
  change('[data-setup-value="bambu_k_value"]', '')
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  failPrinter = false
  submit('filament')
  await vi.waitFor(() => expect(http.calls.filter(call => call.path.endsWith('/colors') && call.method === 'PUT')).toHaveLength(2))
  expect(http.filament.colors).toEqual([{ color_id: 11, position: 1 }])
})

it('sends the cleared parent reel link while explicit Match is still pending', async () => {
  vi.spyOn(lookup, 'checkFilamentDbActive').mockResolvedValue(true)
  let complete!: (response: Response) => void
  const http = mockHttp({ filament: { ...baseFilament, filamentdb_spool_profile_id: 735, filamentdb_spool_image_file: '735.png' }, intercept: path => {
    if (path.endsWith('/filamentdb/status')) return Response.json({ active: true })
    if (path.includes('/filamentdb/spool-profiles?')) return new Promise<Response>(resolve => { complete = resolve })
  } })
  page = await pageFixture('filament', true)
  change('[name="default_spool_weight_g"]', '164')
  document.querySelector<HTMLButtonElement>('.spool-profile-clear')!.click()
  submit('filament')
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toEqual({ default_spool_weight_g: 164, filamentdb_spool_profile_id: null, filamentdb_spool_image_file: null })
  complete(Response.json({ items: [], total: 0 }))
})

it('allows entering Edit to repair an invalid legacy extra-field range, but validates Save', async () => {
  const http = mockHttp({ filament: { ...baseFilament, custom_fields: { temperature: { min: 30, max: 20 } } }, system: [{ key: 'temperature', label: 'Temperature', field_type: 'range' }] })
  page = await pageFixture('filament', true)
  expect(document.getElementById('filament-editor')!.classList.contains('hidden')).toBe(false)
  change('[name="designation"]', 'Rename')
  submit('filament')
  expect(http.calls.some(call => call.method === 'PATCH')).toBe(false)
  change('#system-fields-grid [data-key="temperature.min"]', '10')
  submit('filament')
  await vi.waitFor(() => expect(http.calls.some(call => call.method === 'PATCH')).toBe(true))
  expect(http.calls.find(call => call.method === 'PATCH')!.body).toMatchObject({ designation: 'Rename', custom_fields: { temperature: { min: 10, max: 20 } } })
})
