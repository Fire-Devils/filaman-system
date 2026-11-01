// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import FilamentForm from '../components/FilamentForm.astro'
import FilamentFormActions from '../components/FilamentFormActions.astro'
import { setLang } from './i18n'

import { createFilamentFormController } from './filament-form'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installFetchStub() {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v1/filamentdb/spool-profiles?')) return jsonResponse({ items: [{ id: 735, name: 'Cardboard reel', empty_weight_g: 170, spool_material: 'Cardboard', outer_diameter_mm: 200, width_mm: 68, image_file: '735.png' }], total: 1 })
    if (url.endsWith('/api/v1/filamentdb/status')) return jsonResponse({ active: true })
    if (url.endsWith('/api/v1/app-settings/public-info')) {
      return jsonResponse({ filament_lookup_source: 'filamandb' })
    }
    if (url.includes('/api/v1/manufacturers?')) {
      return jsonResponse({
        items: [{
          id: 7,
          name: 'Example Brand',
          empty_spool_weight_g: 210,
          spool_material: 'Cardboard',
          spool_outer_diameter_mm: 200,
          spool_width_mm: 65,
        }],
        total: 1,
      })
    }
    if (url.endsWith('/api/v1/filaments/types')) return jsonResponse(['PLA', 'PETG'])
    if (url.includes('/api/v1/colors?')) {
      return jsonResponse({
        items: [
          { id: 11, name: 'Red', hex_code: '#FF0000' },
          { id: 12, name: 'Blue', hex_code: '#0000FF' },
          { id: 13, name: 'Amber', hex_code: '#FFFFFF' },
        ],
        total: 3,
      })
    }
    if (url.includes('/api/v1/system-extra-fields?')) return jsonResponse([])
    if (url.includes('/api/v1/filamentdb/filaments?')) return jsonResponse({ items: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

const formMarkup = new Map<string, string>()
beforeAll(async () => {
  setLang('en')
  const container = await AstroContainer.create()
  for (const mode of ['create', 'edit'] as const) {
    formMarkup.set(mode, await container.renderToString(FilamentFormActions, { props: { mode, cancelHref: '/filaments' } })
      + '<span id="unsaved-changes-status" class="hidden"></span>'
      + await container.renderToString(FilamentForm, { props: { mode } }))
  }
})

function renderForm(mode: 'create' | 'edit' = 'create'): HTMLFormElement {
  document.body.innerHTML = formMarkup.get(mode)!
  return document.querySelector<HTMLFormElement>('#filament-form')!
}

async function createLoadedController(mode: 'create' | 'edit' = 'create', submit = vi.fn(async (_payload: unknown): Promise<void> => undefined)) {
  const form = renderForm(mode)
  const onSubmit = submit
  const controller = createFilamentFormController({ form, mode, onSubmit })
  await controller.loadReferenceData()
  return { controller, form, onSubmit }
}

async function selectCatalogResult(form: HTMLFormElement) {
  const search = form.querySelector<HTMLInputElement>('.fdb-lookup-input')!
  search.value = 'catalog'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(form.querySelector('.fdb-lookup-item')).not.toBeNull())
  form.querySelector<HTMLElement>('.fdb-lookup-item')!.click()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  installFetchStub()
  Object.assign(window, {
    __fmAlert: vi.fn(async () => true),
    __fmConfirm: vi.fn(async () => true),
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared filament form controller', () => {
  it.each(['single', 'multi'])('retains an inline-created color when reopening a saved %s filament', async colorMode => {
    const { controller, form } = await createLoadedController('edit')
    const data = { manufacturer_id: 7, designation: 'Saved PLA', material_type: 'PLA', diameter_mm: 1.75,
      color_mode: colorMode, multi_color_style: 'striped', colors: [{ color_id: 11, position: 1 }] }
    controller.applyInitialData(data)
    const fetchData = globalThis.fetch
    let created = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const color = { id: 99, name: 'New Purple', hex_code: '#880088' }
      if (url.endsWith('/api/v1/colors') && init?.method === 'POST') { created = true; return jsonResponse(color) }
      const response = await fetchData(input, init)
      if (created && url.includes('/api/v1/colors?')) {
        const body = await response.json()
        return jsonResponse({ ...body, items: [...body.items, color], total: body.total + 1 })
      }
      return response
    })
    const disclosure = form.querySelector<HTMLDetailsElement>('#new-color-disclosure')!
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    form.querySelector<HTMLInputElement>('#new-color-name')!.value = 'New Purple'
    form.querySelector<HTMLInputElement>('#new-color-hex')!.value = '#880088'
    form.querySelector<HTMLButtonElement>('#btn-save-new-color')!.click()
    await vi.waitFor(() => expect(controller.collectPayload().colors.some(color => color.color_id === 99)).toBe(true))
    const colors = controller.collectPayload().colors
    controller.destroy()
    const next = await createLoadedController('edit')
    next.controller.applyInitialData({ ...data, colors })
    expect(next.controller.collectPayload().colors).toEqual(colors)
    next.controller.destroy()
  })

  it.each(['reset', 'destroy', 'close and reopen'])('keeps a pending color creation out of a later draft after %s', async action => {
    const { controller, form } = await createLoadedController('edit')
    const original = { manufacturer_id: 7, designation: 'Original', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }] }
    controller.resetInitialData(original)
    const fetchData = globalThis.fetch
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/api/v1/colors') && init?.method === 'POST'
        ? new Promise<Response>(resolve => { finish = resolve })
        : fetchData(input, init))
    form.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
    const disclosure = form.querySelector<HTMLDetailsElement>('#new-color-disclosure')!
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    const name = form.querySelector<HTMLInputElement>('#new-color-name')!
    name.value = 'New Purple'
    form.querySelector<HTMLInputElement>('#new-color-hex')!.value = '#880088'
    const save = form.querySelector<HTMLButtonElement>('#btn-save-new-color')!
    save.click()
    expect(finish).toBeDefined()
    if (action === 'reset') controller.resetInitialData(original)
    else if (action === 'destroy') controller.destroy()
    else form.querySelector<HTMLButtonElement>('#filament-color-dialog-done')!.click()
    if (action !== 'destroy') {
      form.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
      disclosure.open = true
      disclosure.dispatchEvent(new Event('toggle'))
      name.value = 'Later unsaved color'
    }
    finish(jsonResponse({ id: 99, name: 'New Purple', hex_code: '#880088' }))
    await vi.waitFor(() => expect(save.disabled).toBe(false))
    expect(controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }])
    if (action !== 'destroy') {
      expect(form.querySelector('#color-grid [aria-label="New Purple (#880088)"]')).not.toBeNull()
      expect(disclosure.open).toBe(true)
      expect(name.value).toBe('Later unsaved color')
    }
    controller.destroy()
  })

  it.each(['reset', 'destroy', 'close and reopen'])('keeps a pending manufacturer creation out of a later draft after %s', async action => {
    const { controller, form } = await createLoadedController('edit')
    const original = { manufacturer_id: 7, designation: 'Original', material_type: 'PLA', diameter_mm: 1.75, default_spool_weight_g: 345, colors: [{ color_id: 11, position: 1 }] }
    controller.resetInitialData(original)
    const fetchData = globalThis.fetch
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/api/v1/manufacturers') && init?.method === 'POST'
        ? new Promise<Response>(resolve => { finish = resolve })
        : fetchData(input, init))
    const manufacturer = form.querySelector<HTMLSelectElement>('#manufacturer_id')!
    const open = () => {
      manufacturer.focus()
      manufacturer.value = '__add_manufacturer__'
      manufacturer.dispatchEvent(new Event('change', { bubbles: true }))
    }
    open()
    const dialogForm = document.querySelector<HTMLFormElement>('[data-manufacturer-form]')!
    const dialog = dialogForm.closest('dialog')!
    const name = document.querySelector<HTMLInputElement>('[data-manufacturer-name]')!
    name.value = 'New Brand'
    dialogForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(finish).toBeDefined()
    if (action === 'reset') controller.resetInitialData(original)
    else if (action === 'destroy') controller.destroy()
    else document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    if (action !== 'destroy') {
      open()
      name.value = 'Later unsaved brand'
    }
    finish(jsonResponse({ id: 8, name: 'New Brand', empty_spool_weight_g: 250, spool_material: 'Plastic', spool_outer_diameter_mm: 200, spool_width_mm: 65 }))
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-manufacturer-submit]')!.disabled).toBe(false))
    expect(controller.collectPayload().scalar).toEqual(expect.objectContaining({ manufacturer_id: 7, default_spool_weight_g: 345 }))
    if (action !== 'destroy') {
      expect(manufacturer.querySelector('option[value="8"]')?.textContent).toBe('New Brand')
      expect(dialog.open).toBe(true)
      expect(name.value).toBe('Later unsaved brand')
    }
    controller.destroy()
  })

  it.each(['reset', 'destroy', 'newer selection', 'disabled lookup'])('discards a pending catalog prefill after %s', async action => {
    const { controller, form } = await createLoadedController('edit')
    const data = { manufacturer_id: 7, designation: 'Original', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }] }
    controller.resetInitialData(data)
    const fetchData = globalThis.fetch
    const pending: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/filamentdb/filaments?')) return Promise.resolve(jsonResponse({ items: [{ id: 'catalog', name: 'Catalog PLA', material: { key: 'PLA' }, colors: [] }] }))
      if (url.endsWith('/filamentdb/prepare-filament')) return new Promise<Response>(resolve => { pending.push(resolve) })
      return fetchData(input, init)
    })
    await selectCatalogResult(form)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    if (action === 'newer selection') {
      await selectCatalogResult(form)
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1](jsonResponse({ colors_created: 0, prefilled: { designation: 'Fresh draft' } }))
      await vi.waitFor(() => expect(form.querySelector<HTMLInputElement>('#designation')!.value).toBe('Fresh draft'))
    } else {
      if (action === 'reset') { controller.resetInitialData(data); controller.captureBaseline() }
      else if (action === 'destroy') controller.destroy()
      else {
        const manufacturer = form.querySelector<HTMLSelectElement>('#manufacturer_id')!
        manufacturer.value = ''
        manufacturer.dispatchEvent(new Event('change'))
      }
      form.querySelector<HTMLInputElement>('#designation')!.value = 'Fresh draft'
    }
    const stale = jsonResponse({ colors_created: 1, prefilled: { designation: 'Stale catalog', material_type: 'PETG' } })
    const parsed = vi.spyOn(stale, 'json')
    pending[0](stale)
    await vi.waitFor(() => expect(parsed).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(form.querySelector<HTMLInputElement>('#designation')!.value).toBe('Fresh draft')
    expect(form.querySelector<HTMLSelectElement>('#type')!.value).toBe('PLA')
    controller.destroy()
  })

  it('reloads colors when a later catalog selection reuses colors created by a canceled request', async () => {
    const { controller, form } = await createLoadedController('edit')
    const original = { manufacturer_id: 7, designation: 'Original', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }] }
    controller.resetInitialData(original)
    const fetchData = globalThis.fetch
    let finish!: (response: Response) => void
    let prepared = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/filamentdb/filaments?')) return jsonResponse({ items: [{ id: 'catalog', name: 'Catalog PLA', material: { key: 'PLA' }, colors: [] }] })
      if (url.endsWith('/filamentdb/prepare-filament')) {
        if (!prepared) { prepared = true; return new Promise<Response>(resolve => { finish = resolve }) }
        return jsonResponse({ colors_created: 0, prefilled: { designation: 'Catalog PLA', color_ids: [99] } })
      }
      if (url.includes('/api/v1/colors?')) return jsonResponse({ items: [{ id: 11, name: 'Red', hex_code: '#FF0000' }, { id: 99, name: 'New Purple', hex_code: '#880088' }], total: 2 })
      return fetchData(input, init)
    })
    await selectCatalogResult(form)
    await vi.waitFor(() => expect(finish).toBeDefined())
    controller.resetInitialData(original)
    finish(jsonResponse({ colors_created: 1, prefilled: { designation: 'Canceled', color_ids: [99] } }))
    await selectCatalogResult(form)
    await vi.waitFor(() => expect(form.querySelector<HTMLInputElement>('#designation')!.value).toBe('Catalog PLA'))
    expect(controller.collectPayload().colors).toEqual([{ color_id: 99, position: 1 }])
    controller.destroy()
  })

  it('opens the editor without waiting for the optional spool catalog', async () => {
    const fetchReferences = globalThis.fetch
    let finishCatalog!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/api/v1/filamentdb/spool-profiles?')
        ? new Promise<Response>(resolve => { finishCatalog = resolve })
        : fetchReferences(input, init))
    const form = renderForm('edit')
    const controller = createFilamentFormController({ form, mode: 'edit', onSubmit: async () => {} })
    let ready = false
    const loading = controller.loadReferenceData().then(() => { ready = true })
    try {
      await vi.waitFor(() => expect(ready).toBe(true))
      controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', filamentdb_spool_profile_id: 735, filamentdb_spool_image_file: '735.png' })
      expect(form.querySelector('#filament-spool-profile img')?.getAttribute('src')).toContain('735.png')
    } finally {
      finishCatalog(jsonResponse({ items: [], total: 0 }))
      await loading
      controller.destroy()
    }
  })

  it('retries failed reference loads without duplicating choices or manufacturer dialogs', async () => {
    const fetchReferences = globalThis.fetch
    let unavailable = true
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/api/v1/system-extra-fields?') && unavailable
        ? Promise.resolve(jsonResponse({}, 503))
        : fetchReferences(input, init))
    const form = renderForm('edit')
    const controller = createFilamentFormController({ form, mode: 'edit', onSubmit: async () => {} })
    await expect(controller.loadReferenceData()).rejects.toThrow()
    unavailable = false
    await controller.loadReferenceData()
    expect(form.querySelectorAll('#manufacturer_id option[value="7"]')).toHaveLength(1)
    expect(form.querySelectorAll('#manufacturer_id option[value="__add_manufacturer__"]')).toHaveLength(1)
    expect(form.querySelectorAll('#type option[value="PLA"]')).toHaveLength(1)
    expect(document.querySelectorAll('#manufacturer-dialog-title')).toHaveLength(1)
    controller.destroy()
  })

  it('resets discarded edit controls and metadata on re-entry without creating a second controller', async () => {
    const { controller } = await createLoadedController('edit')
    const data = { manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', colors: [{ color_id: 11, position: 1 }] }
    controller.applyInitialData(data)
    controller.captureBaseline()
    document.querySelector<HTMLInputElement>('#flow_ratio')!.value = '0.92'
    controller.resetInitialData(data)
    controller.captureBaseline()
    expect(document.querySelector<HTMLInputElement>('#flow_ratio')!.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
    expect(controller.collectPayload().scalar.flow_ratio).toBeNull()
    controller.destroy()
  })
  it('enables page Save for printer-only edits and keeps retry available after failure', async () => {
    const form = renderForm('edit')
    let printerDirty = false
    const onSubmit = vi.fn(async () => { throw new Error('Printer save failed') })
    const controller = createFilamentFormController({ form, mode: 'edit', onSubmit, hasExternalChanges: () => printerDirty })
    await controller.loadReferenceData()
    controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', colors: [{ color_id: 11, position: 1 }] })
    controller.captureBaseline()
    const save = document.querySelector<HTMLButtonElement>('#submit-btn')!
    expect(save.disabled).toBe(true)
    printerDirty = true
    controller.updateDirtyState()
    expect(save.disabled).toBe(false)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('#error-message')?.textContent).toContain('Printer save failed'))
    expect(save.disabled).toBe(false)
    printerDirty = false
    controller.updateDirtyState()
    expect(save.disabled).toBe(true)
    controller.destroy()
  })
  it('tracks metadata-only extra-field changes and their reversal', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', colors: [{ color_id: 11, position: 1 }], custom_fields: { sample: 5 }, custom_field_definitions: { sample: { label: 'Sample', field_type: 'number', config: { unit: 'g' } } } })
    controller.captureBaseline()
    const save = document.querySelector<HTMLButtonElement>('#submit-btn')!
    expect(save.disabled).toBe(true)
    for (const [unit, disabled] of [['kg', false], ['g', true]] as const) {
      document.querySelector<HTMLButtonElement>('.entity-extra-edit')!.click()
      document.querySelector<HTMLInputElement>('.extra-field-dialog-unit')!.value = unit
      document.querySelector<HTMLFormElement>('.extra-field-dialog-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await vi.waitFor(() => expect(save.disabled).toBe(disabled))
    }
    controller.destroy()
  })
  it('keeps Edit saves disabled until a change, including undo and edits during a pending save', async () => {
    let rejectSave!: (error: Error) => void
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => { rejectSave = reject }))
    const { controller } = await createLoadedController('edit', onSubmit)
    controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', colors: [{ color_id: 11, position: 1 }] })
    controller.captureBaseline()
    const form = document.querySelector<HTMLFormElement>('#filament-form')!
    const save = document.querySelector<HTMLButtonElement>('#submit-btn')!
    const designation = document.querySelector<HTMLInputElement>('#designation')!
    const wrapper = designation.closest<HTMLElement>('[data-dirty-key]')!
    const changed = document.querySelector('#unsaved-changes-status')!
    expect(save.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSubmit).not.toHaveBeenCalled()
    designation.value = 'Changed'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(wrapper.classList.contains('is-dirty')).toBe(true)
    expect(wrapper.querySelector('.filament-dirty-indicator')!.textContent).toBe('Changed')
    expect(wrapper.querySelector<HTMLElement>('.filament-dirty-indicator')!.hidden).toBe(false)
    expect(changed.classList.contains('hidden')).toBe(false)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    designation.value = 'Basic'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(true)
    designation.value = 'Changed again'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    rejectSave(new Error('Save failed'))
    await vi.waitFor(() => expect(save.disabled).toBe(false))
    expect(document.querySelector('#error-message')!.textContent).toBe('Save failed')
    expect(designation.value).toBe('Changed again')
    expect(wrapper.classList.contains('is-dirty')).toBe(true)
    designation.value = 'Basic'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(true)
    expect(wrapper.classList.contains('is-dirty')).toBe(false)
    expect(wrapper.querySelector<HTMLElement>('.filament-dirty-indicator')!.hidden).toBe(true)
    expect(changed.classList.contains('hidden')).toBe(true)
    controller.destroy()
  })
  it('preserves the catalog spool image through weight edits and clears it for a new imageless catalog selection', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({ manufacturer_id: 7, designation: 'PLA', material_type: 'PLA', colors: [{ color_id: 11, position: 1 }], default_spool_weight_g: 170, filamentdb_spool_image_file: '735.png' })
    document.querySelector<HTMLInputElement>('#default_spool_weight_g')!.value = '164'
    expect(controller.collectPayload().scalar.filamentdb_spool_image_file).toBe('735.png')
    controller.applyInitialData({ filamentdb_spool_image_file: null }, 'catalog')
    expect(controller.collectPayload().scalar.filamentdb_spool_image_file).toBeNull()
    expect(document.querySelector<HTMLInputElement>('#default_spool_weight_g')!.value).toBe('164')
    controller.destroy()
  })
  it.each(['create', 'edit'] as const)('keeps the external %s toolbar submit usable after a failed save', async mode => {
    const form = renderForm(mode)
    const button = document.querySelector<HTMLButtonElement>('#submit-btn')!
    expect(button.form).toBe(form)
    let rejectSave!: (error: Error) => void
    const controller = createFilamentFormController({
      form,
      mode,
      onSubmit: () => new Promise<void>((_, reject) => { rejectSave = reject }),
    })
    await controller.loadReferenceData()
    controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }] })
    if (mode === 'edit') {
      controller.captureBaseline()
      const diameter = document.querySelector<HTMLInputElement>('#diameter_mm')!
      diameter.value = '2.85'
      diameter.dispatchEvent(new Event('input', { bubbles: true }))
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(button.disabled).toBe(true))
    rejectSave(new Error('Save failed'))
    await vi.waitFor(() => expect(document.querySelector('#error-message')?.textContent).toBe('Save failed'))
    expect(button.disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('#designation')!.value).toBe('Basic')
    controller.destroy()
  })

  it('preserves draft packaging when Add Manufacturer is canceled', async () => {
    const { controller } = await createLoadedController()
    controller.applyInitialData({ manufacturer_id: 7, default_spool_weight_g: 237, spool_material: 'Cardboard', spool_outer_diameter_mm: 203, spool_width_mm: 69 })
    const manufacturer = document.querySelector<HTMLSelectElement>('#manufacturer_id')!
    manufacturer.focus()
    manufacturer.value = '__add_manufacturer__'
    manufacturer.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-manufacturer-cancel]')!.click()
    expect(manufacturer.value).toBe('7')
    expect(['default_spool_weight_g', 'spool_material', 'spool_outer_diameter_mm', 'spool_width_mm'].map(id => document.querySelector<HTMLInputElement>(`#${id}`)!.value)).toEqual(['237', 'Cardboard', '203', '69'])
    controller.destroy()
  })

  it('closes and disables an incomplete inline editor with Color Selection', async () => {
    const { controller } = await createLoadedController()
    document.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
    const disclosure = document.querySelector<HTMLDetailsElement>('#new-color-disclosure')!
    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    expect(document.querySelector<HTMLInputElement>('#new-color-name')!.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('#filament-color-dialog-done')!.click()
    expect(disclosure.open).toBe(false)
    expect(document.querySelector<HTMLInputElement>('#new-color-name')!.disabled).toBe(true)
    controller.destroy()
  })

  it('retains the valid striped default for a nullable multicolor pattern', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({ color_mode: 'multi', multi_color_style: null })
    const style = document.querySelector<HTMLSelectElement>('#multi_color_style')!
    expect(style.value).toBe('striped')
    expect(style.checkValidity()).toBe(true)
    controller.destroy()
  })
  it('loads the shared manufacturer, material, and color references', async () => {
    const { controller } = await createLoadedController()

    expect(document.querySelector<HTMLSelectElement>('#manufacturer_id')!.value).toBe('')
    expect(document.querySelector('#manufacturer_id option[value="7"]')?.textContent).toBe('Example Brand')
    expect(document.querySelector('#type option[value="PLA"]')).not.toBeNull()
    expect(document.querySelectorAll('#color-grid .fm-color-swatch')).toHaveLength(3)

    controller.destroy()
  })

  it('keeps the editor hero in sync with the filament draft', async () => {
    const { controller } = await createLoadedController('edit')

    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Duo Orange Blue',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'multi',
      multi_color_style: 'striped',
      colors: [{ color_id: 13, position: 1 }, { color_id: 12, position: 2 }],
    })

    expect(document.querySelector('#filament-editor-title')?.textContent).toBe('Duo Orange Blue')
    expect(document.querySelector<HTMLSelectElement>('#manufacturer_id')!.selectedOptions[0].textContent).toBe('Example Brand')
    expect(document.querySelector('#filament-editor-type')?.textContent).toBe('PLA')
    expect(document.querySelector('#filament-editor-color-name')?.textContent).toBe('Amber · Blue')
    expect(document.querySelector<HTMLElement>('#filament-editor-color-swatch')?.style.backgroundImage).toContain('linear-gradient')
    expect(document.querySelector<HTMLElement>('#filament-editor-hero')?.getAttribute('style')).toContain('rgba')

    const designation = document.querySelector<HTMLInputElement>('#designation')!
    designation.value = 'Renamed Duo'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('#filament-editor-title')?.textContent).toBe('Renamed Duo')

    controller.destroy()
  })

  it('keeps the create-page title stable while the product name changes', async () => {
    const { controller } = await createLoadedController('create')
    const title = document.querySelector('#filament-editor-title')!

    controller.applyInitialData({ designation: 'Test Name' })

    expect(title.textContent).toBe('Create New Filament')
    controller.destroy()
  })

  it('opens and closes the focused color editor from the hero', async () => {
    const { controller } = await createLoadedController()
    const dialog = document.querySelector<HTMLDialogElement>('#filament-color-dialog')!
    const launcher = document.querySelector<HTMLButtonElement>('#filament-color-launcher')!

    launcher.focus()
    launcher.click()
    expect(dialog.open).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('#filament-color-dialog-close'))

    document.querySelector<HTMLButtonElement>('#filament-color-dialog-done')!.click()
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(launcher)

    controller.destroy()
  })

  it('closes the color editor with Escape', async () => {
    const { controller } = await createLoadedController()
    const dialog = document.querySelector<HTMLDialogElement>('#filament-color-dialog')!

    document.querySelector<HTMLButtonElement>('#filament-color-launcher')!.click()
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))

    expect(dialog.open).toBe(false)
    controller.destroy()
  })

  it('marks a selected color removal as changed', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Duo',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'multi',
      colors: [{ color_id: 11, position: 1 }, { color_id: 12, position: 2 }],
    })
    controller.captureBaseline()

    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()

    expect(document.querySelector('[data-dirty-key="colors"]')?.classList.contains('is-dirty')).toBe(true)
    expect(document.querySelector('#filament-color-launcher')?.classList.contains('is-dirty')).toBe(true)
    expect(document.querySelector('#unsaved-changes-status')?.classList.contains('hidden')).toBe(false)
    controller.destroy()
  })

  it('shows multicolor selection order on each selected swatch', async () => {
    const { controller } = await createLoadedController()
    const multi = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="multi"]')!
    multi.checked = true
    multi.dispatchEvent(new Event('change', { bubbles: true }))

    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()
    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Blue (#0000FF)"]')!.click()

    expect(document.querySelector('#color-grid [aria-label="Red (#FF0000)"]')?.getAttribute('data-order')).toBe('1')
    expect(document.querySelector('#color-grid [aria-label="Blue (#0000FF)"]')?.getAttribute('data-order')).toBe('2')
    controller.destroy()
  })

  it('disables existing colors while adding one in single-color mode only', async () => {
    const { controller } = await createLoadedController()
    const disclosure = document.querySelector<HTMLDetailsElement>('#new-color-disclosure')!
    const existing = document.querySelector<HTMLElement>('#existing-color-picker')!

    disclosure.open = true
    disclosure.dispatchEvent(new Event('toggle'))
    expect(existing.inert).toBe(true)
    expect(existing.getAttribute('aria-disabled')).toBe('true')

    const multi = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="multi"]')!
    multi.checked = true
    multi.dispatchEvent(new Event('change', { bubbles: true }))
    expect(existing.inert).toBe(false)
    expect(existing.hasAttribute('aria-disabled')).toBe(false)
    controller.destroy()
  })

  it('shows the configured catalog search immediately after selecting a manufacturer', async () => {
    const { controller } = await createLoadedController()
    const manufacturer = document.querySelector<HTMLSelectElement>('#manufacturer_id')!

    manufacturer.value = '7'
    manufacturer.dispatchEvent(new Event('change', { bubbles: true }))

    expect(document.querySelector<HTMLElement>('#fil-fdb-section')!.style.display).toBe('')
    expect(document.querySelector<HTMLInputElement>('.fdb-lookup-input')).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('.fdb-lookup-input')!.placeholder).not.toBe('')

    controller.destroy()
  })

  it('binds the color filter to the shared color grid', async () => {
    const { controller } = await createLoadedController()

    document.querySelector<HTMLButtonElement>('#color-filter-button')!.click()

    const panel = document.querySelector<HTMLElement>('.fm-header-filter-panel.open')!
    expect(panel).not.toBeNull()
    expect(panel.parentElement).toBe(document.querySelector('#filament-color-dialog'))
    controller.destroy()
  })

  it('clears color search filters from the shared toolbar', async () => {
    const { controller } = await createLoadedController()
    const search = document.querySelector<HTMLInputElement>('#color-search')!

    search.value = 'red'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelectorAll('#color-grid button')).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('#color-filter-clear')!.click()

    expect(search.value).toBe('')
    expect(document.querySelectorAll('#color-grid button')).toHaveLength(3)
    controller.destroy()
  })

  it('searches selectable colors by name', async () => {
    const { controller } = await createLoadedController()
    const search = document.querySelector<HTMLInputElement>('#color-search')!

    search.value = 'red'
    search.dispatchEvent(new Event('input', { bubbles: true }))

    const swatches = [...document.querySelectorAll<HTMLButtonElement>('#color-grid .fm-color-swatch')]
    expect(swatches).toHaveLength(1)
    expect(swatches[0].getAttribute('aria-label')).toBe('Red (#FF0000)')
    controller.destroy()
  })

  it('renders list mode as compact name and hex choices', async () => {
    const { controller } = await createLoadedController()
    const toggle = document.querySelector<HTMLInputElement>('#color-list-toggle')!

    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()

    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))

    const choices = [...document.querySelectorAll<HTMLButtonElement>('#color-grid .fm-color-choice')]
    expect(document.querySelector('#color-grid')?.classList.contains('fm-color-list')).toBe(true)
    expect(choices).toHaveLength(3)
    expect(choices[0].querySelector('.fm-color-choice-name')?.textContent).toBe('Red')
    expect(choices[0].querySelector('.fm-color-choice-hex')?.textContent).toBe('#FF0000')

    toggle.checked = false
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    controller.destroy()
  })

  it('cycles Name and Hex sorting independently and clears the other sort', async () => {
    const { controller } = await createLoadedController()
    const nameSort = document.querySelector<HTMLButtonElement>('#color-sort-name')!
    const hexSort = document.querySelector<HTMLButtonElement>('#color-sort-hex')!
    const names = () => [...document.querySelectorAll<HTMLButtonElement>('#color-grid button')]
      .map((button) => button.getAttribute('aria-label')?.split(' (')[0])

    expect(names()).toEqual(['Red', 'Blue', 'Amber'])
    nameSort.click()
    expect(nameSort.dataset.direction).toBe('asc')
    expect(names()).toEqual(['Amber', 'Blue', 'Red'])
    nameSort.click()
    expect(nameSort.dataset.direction).toBe('desc')
    expect(names()).toEqual(['Red', 'Blue', 'Amber'])
    nameSort.click()
    expect(nameSort.dataset.direction).toBe('none')

    hexSort.click()
    expect(hexSort.dataset.direction).toBe('asc')
    expect(nameSort.dataset.direction).toBe('none')
    expect(names()).toEqual(['Blue', 'Red', 'Amber'])
    controller.destroy()
  })

  it('restores saved color view and sort preferences', async () => {
    localStorage.setItem('filaman-filament-color-view', 'list')
    localStorage.setItem('filaman-filament-color-sort', 'hex:desc')

    const { controller } = await createLoadedController()

    expect(document.querySelector<HTMLInputElement>('#color-list-toggle')!.checked).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('#color-sort-hex')!.dataset.direction).toBe('desc')
    expect(document.querySelector('#color-grid')?.classList.contains('fm-color-list')).toBe(true)
    controller.destroy()
  })

  it('saves color view and sort preferences', async () => {
    const { controller } = await createLoadedController()
    const toggle = document.querySelector<HTMLInputElement>('#color-list-toggle')!
    const sort = document.querySelector<HTMLButtonElement>('#color-sort-hex')!

    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    sort.click()

    expect(localStorage.getItem('filaman-filament-color-view')).toBe('list')
    expect(localStorage.getItem('filaman-filament-color-sort')).toBe('hex:asc')
    controller.destroy()
  })

  it('updates the dialog heading, order hint, and header preview for selected colors', async () => {
    const { controller } = await createLoadedController('edit')
    const preview = document.querySelector<HTMLElement>('#filament-color-dialog-preview')!
    const title = document.querySelector('#color-selection-title')!
    const hint = document.querySelector<HTMLElement>('#color-hint')!

    expect(preview.hidden).toBe(true)
    document.querySelector<HTMLButtonElement>('#color-grid .fm-color-swatch')!.click()
    expect(preview.hidden).toBe(false)
    expect(preview.style.backgroundImage).not.toBe('')
    expect(title.textContent).toBe('Select Existing Filament Color')
    expect(hint.hidden).toBe(true)

    const multi = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="multi"]')!
    multi.checked = true
    multi.dispatchEvent(new Event('change', { bubbles: true }))
    expect(title.textContent).toBe('Select Existing Filament Colors')
    expect(hint.hidden).toBe(false)
    expect(hint.textContent).toBe('Click in selection order')
    controller.destroy()
  })

  it('shows the multi-color pattern only in multi-color mode', async () => {
    const { controller } = await createLoadedController()
    const options = document.querySelector<HTMLElement>('#multi-color-options')!
    const pattern = document.querySelector<HTMLSelectElement>('#multi_color_style')!

    expect(options.hidden).toBe(true)
    expect(pattern.disabled).toBe(true)

    const multi = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="multi"]')!
    multi.checked = true
    multi.dispatchEvent(new Event('change', { bubbles: true }))

    expect(options.hidden).toBe(false)
    expect(pattern.disabled).toBe(false)

    const single = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="single"]')!
    single.checked = true
    single.dispatchEvent(new Event('change', { bubbles: true }))
    expect(options.hidden).toBe(true)
    expect(pattern.disabled).toBe(true)
    controller.destroy()
  })

  it('shows and hides an immediate grid tooltip', async () => {
    const { controller } = await createLoadedController()
    const swatch = document.querySelector<HTMLButtonElement>('#color-grid .fm-color-swatch')!

    swatch.dispatchEvent(new Event('pointerenter'))
    const tooltip = document.querySelector<HTMLElement>('.fm-color-tooltip')!
    expect(tooltip.hidden).toBe(false)
    expect(tooltip.textContent).toBe('Red (#FF0000)')
    expect(tooltip.closest('dialog')?.id).toBe('filament-color-dialog')

    swatch.dispatchEvent(new Event('pointerleave'))
    expect(tooltip.hidden).toBe(true)
    controller.destroy()
  })

  it('collects the normalized Create payload with ordered colors', async () => {
    const { controller } = await createLoadedController()
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Hyper',
      material_type: 'PLA',
      diameter_mm: 1.75,
      material_subgroup: 'CF',
      finish_type: 'matte',
      color_mode: 'multi',
      multi_color_style: 'gradient',
      colors: [
        { color_id: 12, position: 1 },
        { color_id: 11, position: 2 },
      ],
      price: 24.99,
    })

    expect(controller.collectPayload()).toEqual({
      scalar: expect.objectContaining({
        manufacturer_id: 7,
        designation: 'Hyper',
        material_type: 'PLA',
        diameter_mm: 1.75,
        material_subgroup: 'CF',
        finish_type: 'matte',
        color_mode: 'multi',
        multi_color_style: 'gradient',
        price: 24.99,
      }),
      colors: [
        { color_id: 12, position: 1 },
        { color_id: 11, position: 2 },
      ],
    })

    controller.destroy()
  })

  it('round-trips standard catalog fields through the shared form', async () => {
    const { controller } = await createLoadedController()
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Technical PLA',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
      extruder_temp_range_c: { min: 195, max: 220 },
      bed_temp_range_c: 60,
      cooling_fan_range_percent: { min: 40, max: 80 },
      manufacturer_sku: 'PLA-42',
      price_currency: 'eur',
      drying_temp_c: 55,
      ams_compatibility: ['AMS', 'AMS 2 Pro'],
      build_plate_compatibility: ['Textured PEI'],
      is_discontinued: true,
    })

    expect(controller.collectPayload().scalar).toEqual(expect.objectContaining({
      extruder_temp_range_c: { min: 195, max: 220 },
      bed_temp_range_c: 60,
      cooling_fan_range_percent: { min: 40, max: 80 },
      manufacturer_sku: 'PLA-42',
      price_currency: 'EUR',
      drying_temp_c: 55,
      ams_compatibility: ['AMS', 'AMS 2 Pro'],
      build_plate_compatibility: ['Textured PEI'],
      is_discontinued: true,
    }))
    controller.destroy()
  })

  it('preserves one-sided ranges when Edit saves an unrelated change', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Technical PLA',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
      extruder_temp_range_c: { min: 190, max: null },
      bed_temp_range_c: { min: null, max: 70 },
      cooling_fan_range_percent: { min: 20, max: null },
    })
    controller.captureBaseline()
    document.querySelector<HTMLInputElement>('#designation')!.value = 'Technical PLA V2'
    document.querySelector<HTMLInputElement>('#designation')!.dispatchEvent(new Event('input', { bubbles: true }))

    expect(document.querySelector<HTMLInputElement>('#bed_temp_value')!.value).toBe('')
    expect(document.querySelector<HTMLInputElement>('#bed_temp_to')!.value).toBe('70')
    expect(controller.collectPayload().scalar).toEqual(expect.objectContaining({
      extruder_temp_range_c: { min: 190, max: null },
      bed_temp_range_c: { min: null, max: 70 },
      cooling_fan_range_percent: { min: 20, max: null },
    }))
    controller.destroy()
  })

  it('applies duplicate data after references are loaded', async () => {
    const { controller } = await createLoadedController()

    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Tough+',
      material_type: 'PA12-CF',
      diameter_mm: 2.85,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
      custom_fields: { drying: { temperature: 70 } },
    })

    expect(document.querySelector<HTMLSelectElement>('#manufacturer_id')!.value).toBe('7')
    expect(document.querySelector<HTMLInputElement>('#designation')!.value).toBe('Tough+')
    expect(document.querySelector<HTMLSelectElement>('#type')!.value).toBe('__custom__')
    expect(document.querySelector<HTMLInputElement>('#custom_type')!.value).toBe('PA12-CF')
    expect(document.querySelector<HTMLInputElement>('#diameter_mm')!.value).toBe('2.85')
    expect(controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }])

    controller.destroy()
  })


  it('marks system and filament-specific extra fields independently', async () => {
    const fallbackFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes('/api/v1/system-extra-fields?')
        ? jsonResponse([{ id: 1, key: 'storage_note', label: 'Storage note', field_type: 'text' }])
        : fallbackFetch(input, init))
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Basic',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
      custom_fields: { storage_note: 'Keep dry', batch_note: 'First batch' },
      custom_field_definitions: { batch_note: { label: 'Batch note', field_type: 'text' } },
    })
    controller.captureBaseline()
    const systemCard = document.querySelector<HTMLElement>('#system-fields-container')!
    const specificCard = document.querySelector<HTMLElement>('#filament-custom-fields-card')!
    const storageNote = document.querySelector<HTMLInputElement>('.system-field-input')!

    storageNote.value = 'Keep very dry'
    storageNote.dispatchEvent(new Event('input', { bubbles: true }))
    expect(systemCard.classList.contains('is-dirty')).toBe(true)
    expect(specificCard.classList.contains('is-dirty')).toBe(false)

    storageNote.value = 'Keep dry'
    storageNote.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('.entity-extra-remove')!.click()
    await vi.waitFor(() => expect(specificCard.classList.contains('is-dirty')).toBe(true))
    expect(systemCard.classList.contains('is-dirty')).toBe(false)
    controller.destroy()
  })

  it('keeps the Discontinued marker beside its label text', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({ manufacturer_id: 7, designation: 'Basic', material_type: 'PLA', color_mode: 'single' })
    controller.captureBaseline()
    const checkbox = document.querySelector<HTMLInputElement>('#is_discontinued')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))

    const label = document.querySelector<HTMLElement>('.filament-form-check')!
    const marker = label.querySelector<HTMLElement>('.filament-dirty-indicator')!
    expect(marker.parentElement?.textContent).toContain('Discontinued')
    expect(marker.parentElement).not.toBe(label)
    expect(marker.hidden).toBe(false)
    controller.destroy()
  })

  it('labels the manufacturer catalog search with the configured database', async () => {
    const { controller } = await createLoadedController()

    expect(document.querySelector('#fil-lookup-heading')?.textContent)
      .toBe('Search FilaManDB for existing filament')

    controller.destroy()
  })

  it.each(['disabled', 'ofd'])('does not bind catalog search for inactive source %s', async (source) => {
    const fallbackFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).endsWith('/api/v1/app-settings/public-info')
        ? jsonResponse({ filament_lookup_source: source })
        : fallbackFetch(input, init))
    const { controller } = await createLoadedController()

    expect(document.querySelector('.fdb-lookup-input')).toBeNull()
    expect(document.querySelector<HTMLElement>('#fil-fdb-section')!.style.display).toBe('none')
    expect(document.querySelector('#fil-lookup-heading')?.textContent).toBe('')
    controller.destroy()
  })

  it('searches without a manufacturer and adopts the selected result manufacturer', async () => {
    const { controller } = await createLoadedController()
    for (const [id, value] of [
      ['default_spool_weight_g', '333'],
      ['spool_outer_diameter_mm', '205'],
      ['spool_width_mm', '72'],
    ]) document.querySelector<HTMLInputElement>(`#${id}`)!.value = value
    document.querySelector<HTMLSelectElement>('#spool_material')!.value = 'Cardboard'
    const fetchStub = vi.mocked(fetch)
    fetchStub.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/filamentdb/filaments?')) {
        return jsonResponse({
          items: [{
            id: 'all-brand-result',
            name: 'Sunset PLA',
            manufacturer: { name: 'New Brand' },
            material: { key: 'PLA', name: 'PLA' },
            colors: [],
            traits: {},
          }],
        })
      }
      if (url.endsWith('/api/v1/filamentdb/prepare-filament')) {
        return jsonResponse({
          manufacturer_id: 9,
          manufacturer_created: true,
          colors_created: 0,
          prefilled: {
            manufacturer_id: 9,
            designation: 'Sunset PLA',
            material_type: 'PLA',
            diameter_mm: 1.75,
            color_ids: [],
          },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const searchAll = document.querySelector<HTMLInputElement>('#fil-search-all-manufacturers')!
    searchAll.checked = true
    searchAll.dispatchEvent(new Event('change', { bubbles: true }))
    const search = document.querySelector<HTMLInputElement>('.fdb-lookup-input')!
    search.value = 'sunset'
    search.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => expect(document.querySelector('.fdb-lookup-item')).not.toBeNull())
    const lookupRequest = fetchStub.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes('/api/v1/filamentdb/filaments?'))!
    expect(new URL(lookupRequest, 'http://localhost').searchParams.has('manufacturer_name')).toBe(false)
    expect(document.querySelector('.fdb-lookup-item')?.textContent).toContain('New Brand')

    document.querySelector<HTMLElement>('.fdb-lookup-item')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('#manufacturer_id')!.value).toBe('9'))
    expect(document.querySelector<HTMLSelectElement>('#manufacturer_id')!.selectedOptions[0].textContent).toBe('New Brand')
    expect(document.querySelector<HTMLInputElement>('#default_spool_weight_g')!.value).toBe('333')
    expect(document.querySelector<HTMLInputElement>('#spool_outer_diameter_mm')!.value).toBe('205')
    expect(document.querySelector<HTMLInputElement>('#spool_width_mm')!.value).toBe('72')
    expect(document.querySelector<HTMLSelectElement>('#spool_material')!.value).toBe('Cardboard')
    expect(searchAll.checked).toBe(false)
    expect(searchAll.disabled).toBe(true)
    controller.destroy()
  })

  it('normalizes equivalent numeric display values', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Basic',
      material_type: 'PLA',
      diameter_mm: 1,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
    })
    controller.captureBaseline()
    const diameter = document.querySelector<HTMLInputElement>('#diameter_mm')!
    diameter.value = '1.00'
    diameter.dispatchEvent(new Event('input', { bubbles: true }))

    expect(document.querySelector('[data-dirty-key="diameter_mm"]')?.classList.contains('is-dirty')).toBe(false)
    controller.destroy()
  })

  it('does not mark values loaded before the baseline is captured', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Loaded later',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
    })

    expect(document.querySelector('.is-dirty')).toBeNull()
    controller.captureBaseline()
    expect(document.querySelector('.is-dirty')).toBeNull()
    controller.destroy()
  })

  it('tracks color order, mode, and pattern and clears them when restored', async () => {
    const { controller } = await createLoadedController('edit')
    const initial = {
      manufacturer_id: 7,
      designation: 'Duo',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'multi',
      multi_color_style: 'gradient',
      colors: [{ color_id: 11, position: 1 }, { color_id: 12, position: 2 }],
    }
    controller.applyInitialData(initial)
    controller.captureBaseline()

    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()
    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()
    expect(document.querySelector('[data-dirty-key="colors"]')?.classList.contains('is-dirty')).toBe(true)

    controller.applyInitialData(initial)
    expect(document.querySelector('[data-dirty-key="colors"]')?.classList.contains('is-dirty')).toBe(false)

    const single = document.querySelector<HTMLInputElement>('input[name="color_mode"][value="single"]')!
    single.checked = true
    single.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector('[data-dirty-key="color_mode"]')?.classList.contains('is-dirty')).toBe(true)

    controller.applyInitialData(initial)
    const pattern = document.querySelector<HTMLSelectElement>('#multi_color_style')!
    pattern.value = 'striped'
    pattern.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector('[data-dirty-key="multi_color_style"]')?.classList.contains('is-dirty')).toBe(true)

    controller.applyInitialData(initial)
    expect(document.querySelector('.is-dirty')).toBeNull()
    controller.destroy()
  })

  it('preserves draft values when a catalog result omits them', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Basic',
      material_type: 'PLA',
      diameter_mm: 1.75,
      material_subgroup: 'CF',
      finish_type: 'matte',
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
      shop_url: 'https://example.test/product',
    })
    controller.captureBaseline()

    controller.applyInitialData({ designation: 'Hyper', finish_type: null, colors: [] }, 'catalog')

    expect(document.querySelector<HTMLInputElement>('#designation')!.value).toBe('Hyper')
    expect(document.querySelector<HTMLInputElement>('#material_subgroup')!.value).toBe('CF')
    expect(document.querySelector<HTMLSelectElement>('#finish_type')!.value).toBe('matte')
    expect(document.querySelector<HTMLInputElement>('#shop_url')!.value).toBe('https://example.test/product')
    expect(controller.collectPayload().colors).toEqual([{ color_id: 11, position: 1 }])
    controller.destroy()
  })

  it('preserves spool, diameter, mode, and colors through a sparse catalog selection', async () => {
    const { controller } = await createLoadedController('edit')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Duo',
      material_type: 'PLA',
      diameter_mm: 2.85,
      color_mode: 'multi',
      multi_color_style: 'gradient',
      colors: [{ color_id: 11, position: 1 }, { color_id: 12, position: 2 }],
      default_spool_weight_g: 333,
      spool_material: 'Cardboard',
      spool_outer_diameter_mm: 205,
      spool_width_mm: 72,
    })
    controller.captureBaseline()
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/api/v1/filamentdb/filaments?')) {
        return jsonResponse({
          items: [{
            id: 'sparse',
            name: 'Hyper',
            material: { key: 'PLA', name: 'PLA' },
            colors: [],
            diameter_mm: null,
            traits: {},
          }],
        })
      }
      if (url.endsWith('/api/v1/filamentdb/prepare-filament')) {
        return jsonResponse({
          colors_created: 0,
          prefilled: {
            manufacturer_id: 7,
            designation: 'Hyper',
            material_type: 'PLA',
            diameter_mm: 1.75,
            color_mode: 'single',
            multi_color_style: null,
            default_spool_weight_g: null,
            spool_outer_diameter_mm: null,
            spool_width_mm: null,
            spool_material: null,
            color_ids: [],
          },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const search = document.querySelector<HTMLInputElement>('.fdb-lookup-input')!
    search.value = 'hyper'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('.fdb-lookup-item')).not.toBeNull())
    document.querySelector<HTMLElement>('.fdb-lookup-item')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#designation')!.value).toBe('Hyper'))

    expect(document.querySelector<HTMLInputElement>('#diameter_mm')!.value).toBe('2.85')
    expect(document.querySelector<HTMLInputElement>('#default_spool_weight_g')!.value).toBe('333')
    expect(document.querySelector<HTMLInputElement>('input[name="color_mode"][value="multi"]')!.checked).toBe(true)
    expect(controller.collectPayload().colors).toEqual([
      { color_id: 11, position: 1 },
      { color_id: 12, position: 2 },
    ])
    controller.destroy()
  })


  it('never shows dirty markers in Create mode', async () => {
    const { controller } = await createLoadedController('create')
    controller.applyInitialData({
      manufacturer_id: 7,
      designation: 'Basic',
      material_type: 'PLA',
      diameter_mm: 1.75,
      color_mode: 'single',
      colors: [{ color_id: 11, position: 1 }],
    })
    controller.captureBaseline()
    const designation = document.querySelector<HTMLInputElement>('#designation')!
    designation.value = 'Hyper'
    designation.dispatchEvent(new Event('input', { bubbles: true }))

    expect(document.querySelector('.is-dirty')).toBeNull()
    expect(document.querySelector('.filament-dirty-indicator')).toBeNull()
    controller.destroy()
  })

})


it('keeps an initially inferred spool-type link saveable until it is persisted', async () => {
  installFetchStub()
  const form = renderForm('edit')
  const controller = createFilamentFormController({ form, mode: 'edit', onSubmit: async () => {} })
  await controller.loadReferenceData()
  controller.applyInitialData({ manufacturer_id: 7, designation: 'Manual PLA', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }], default_spool_weight_g: 170, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 68 })
  controller.captureBaseline()
  await vi.waitFor(() => expect(controller.collectPayload().scalar.filamentdb_spool_profile_id).toBe(735))
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  controller.applyInitialData({ filamentdb_spool_profile_id: 735, filamentdb_spool_image_file: '735.png' })
  controller.captureBaseline()
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  controller.destroy()
})


it('rebases an actual edit draft without replaying old profile metadata or normalized legacy values', async () => {
  const { controller } = await createLoadedController('edit')
  const initial = { manufacturer_id: 7, material_type: 'PLA', designation: 'Before', colors: [{ color_id: 11, position: 1 }], custom_fields: { note: 'Dry', bambu_profile_base_name: 'Generic PLA', legacy_count: 42 } }
  controller.resetInitialData(initial)
  controller.captureBaseline()
  expect(await controller.prepareExtraFieldUpdate('/filaments/16', controller.collectPayload().scalar)).toEqual({})
  controller.applyInitialData({ custom_fields: { ...initial.custom_fields, note: 'Wet' } })
  const fetchData = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input) === '/api/v1/filaments/16'
    ? Promise.resolve(Response.json({ custom_fields: { note: 'Dry', bambu_profile_base_name: 'Matte PLA', legacy_count: 42, plugin_added: true } }))
    : fetchData(input, init))
  expect(await controller.prepareExtraFieldUpdate('/filaments/16', controller.collectPayload().scalar)).toEqual({
    custom_fields: { note: 'Wet', bambu_profile_base_name: 'Matte PLA', legacy_count: 42, plugin_added: true },
  })
  controller.destroy()
})

it('preserves imported comma-bearing compatibility arrays through display, unrelated save, explicit edit and reopen', async () => {
  const { controller, form, onSubmit } = await createLoadedController('edit')
  const initial = {
    manufacturer_id: 7, material_type: 'PLA', designation: 'Imported', diameter_mm: 1.75,
    colors: [{ color_id: 11, position: 1 }],
    ams_compatibility: ['AMS, AMS Lite', '[manual]'],
    build_plate_compatibility: ['Smooth PEI, "high-temp"', 'Textured PEI'],
  }
  controller.resetInitialData(initial)
  controller.captureBaseline()
  const plates = form.querySelector<HTMLInputElement>('#build_plate_compatibility')!
  expect(plates.value).toBe('["Smooth PEI, \\"high-temp\\"","Textured PEI"]')
  form.querySelector<HTMLInputElement>('#designation')!.value = 'Unrelated edit'
  form.dispatchEvent(new Event('input', { bubbles: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
  const saved = onSubmit.mock.lastCall![0] as ReturnType<typeof controller.collectPayload>
  expect(saved.scalar).toMatchObject({
    ams_compatibility: ['AMS, AMS Lite', '[manual]'],
    build_plate_compatibility: ['Smooth PEI, "high-temp"', 'Textured PEI'],
  })
  controller.resetInitialData({ ...saved.scalar, colors: saved.colors })
  controller.captureBaseline()
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  plates.value = '["Smooth PEI, revised", "Textured PEI"]'
  plates.dispatchEvent(new Event('input', { bubbles: true }))
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(false)
  plates.value = '["Smooth PEI, \\"high-temp\\"", "Textured PEI"]'
  plates.dispatchEvent(new Event('input', { bubbles: true }))
  expect(document.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true)
  plates.value = '["Smooth PEI, revised", "Textured PEI"]'
  plates.dispatchEvent(new Event('input', { bubbles: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  const edited = onSubmit.mock.lastCall![0] as ReturnType<typeof controller.collectPayload>
  expect(edited.scalar.build_plate_compatibility).toEqual(['Smooth PEI, revised', 'Textured PEI'])
  controller.resetInitialData({ ...edited.scalar, colors: edited.colors })
  expect(controller.collectPayload().scalar.build_plate_compatibility).toEqual(['Smooth PEI, revised', 'Textured PEI'])
  controller.destroy()
})

it('preserves empty versus null native lists and accepts legacy simple CSV edits', async () => {
  const { controller, form, onSubmit } = await createLoadedController('edit')
  controller.resetInitialData({
    manufacturer_id: 7, material_type: 'PLA', designation: 'Imported', diameter_mm: 1.75,
    colors: [{ color_id: 11, position: 1 }], ams_compatibility: null, build_plate_compatibility: [],
  })
  controller.captureBaseline()
  form.querySelector<HTMLInputElement>('#designation')!.value = 'Unrelated edit'
  form.dispatchEvent(new Event('input', { bubbles: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
  expect((onSubmit.mock.lastCall![0] as ReturnType<typeof controller.collectPayload>).scalar).toMatchObject({ ams_compatibility: null, build_plate_compatibility: [] })
  const plates = form.querySelector<HTMLInputElement>('#build_plate_compatibility')!
  plates.value = ' Textured PEI, Smooth PEI, '
  expect(controller.collectPayload().scalar.build_plate_compatibility).toEqual(['Textured PEI', 'Smooth PEI'])
  controller.destroy()
})

it.each([false, true])('rematches manufacturer defaults while preserving an explicitly pinned reel (%s)', async pinned => {
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/v1/manufacturers?')) return Promise.resolve(jsonResponse({ items: [
      { id: 7, name: 'Cardboard brand', empty_spool_weight_g: 170, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 68 },
      { id: 8, name: 'Plastic brand', empty_spool_weight_g: 250, spool_material: 'Plastic', spool_outer_diameter_mm: 210, spool_width_mm: 70 },
    ], total: 2 }))
    if (url.includes('/api/v1/filamentdb/spool-profiles?')) return Promise.resolve(jsonResponse({ items: [
      { id: 735, name: 'Cardboard reel', empty_weight_g: 170, spool_material: 'Cardboard', outer_diameter_mm: 200, width_mm: 68, image_file: '735.png' },
      { id: 736, name: 'Plastic reel', empty_weight_g: 250, spool_material: 'Plastic', outer_diameter_mm: 210, width_mm: 70, image_file: '736.png' },
    ], total: 2 }))
    return originalFetch(input, init)
  })
  const { controller, form, onSubmit } = await createLoadedController('edit')
  controller.resetInitialData({
    manufacturer_id: 7, designation: 'Manual', material_type: 'PLA', diameter_mm: 1.75, colors: [{ color_id: 11, position: 1 }],
    default_spool_weight_g: 170, spool_material: 'Cardboard', spool_outer_diameter_mm: 200, spool_width_mm: 68,
    ...(pinned ? { filamentdb_spool_profile_id: 735, filamentdb_spool_image_file: '735.png' } : {}),
  })
  controller.captureBaseline()
  await vi.waitFor(() => expect(controller.collectPayload().scalar.filamentdb_spool_profile_id).toBe(735))
  const manufacturer = form.querySelector<HTMLSelectElement>('#manufacturer_id')!
  manufacturer.value = '8'
  manufacturer.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(controller.collectPayload().scalar.filamentdb_spool_profile_id).toBe(pinned ? 735 : 736))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
  expect((onSubmit.mock.lastCall![0] as ReturnType<typeof controller.collectPayload>).scalar).toMatchObject({
    manufacturer_id: 8, default_spool_weight_g: 250, spool_material: 'Plastic', spool_outer_diameter_mm: 210, spool_width_mm: 70,
    filamentdb_spool_profile_id: pinned ? 735 : 736, filamentdb_spool_image_file: pinned ? '735.png' : '736.png',
  })
  controller.destroy()
})

it('preserves catalog price and refill tare zero through prepare, save and reopen', async () => {
  const originalFetch = globalThis.fetch
  let prepare: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/v1/filamentdb/filaments?')) return Promise.resolve(jsonResponse({ items: [{
      id: 'zero', name: 'Free refill', manufacturer: { name: 'Example Brand' }, material: { key: 'PLA' }, price: 0,
      colors: [{ hex_code: '#FF0000', color_name: 'Red' }], spool_profile: { id: 999, empty_weight_g: 0 },
    }] }))
    if (url.endsWith('/api/v1/filamentdb/prepare-filament')) {
      prepare = JSON.parse(String(init?.body))
      return Promise.resolve(jsonResponse({ manufacturer_id: 7, colors_created: 0, prefilled: {
        designation: 'Free refill', price: prepare!.price, default_spool_weight_g: prepare!.spool_profile_empty_weight_g,
        color_ids: [11], filamentdb_spool_profile_id: 999,
      } }))
    }
    return originalFetch(input, init)
  })
  const { controller, form, onSubmit } = await createLoadedController('edit')
  controller.resetInitialData({
    manufacturer_id: 7, designation: 'Before', material_type: 'PLA', diameter_mm: 1.75,
    colors: [{ color_id: 11, position: 1 }], price: 17.5, default_spool_weight_g: 210,
  })
  controller.captureBaseline()
  await selectCatalogResult(form)
  await vi.waitFor(() => expect(form.querySelector<HTMLInputElement>('#designation')!.value).toBe('Free refill'))
  expect(prepare).toMatchObject({ price: 0, spool_profile_empty_weight_g: 0 })
  expect(form.querySelector<HTMLInputElement>('#price')!.value).toBe('0')
  expect(form.querySelector<HTMLInputElement>('#default_spool_weight_g')!.value).toBe('0')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
  const saved = onSubmit.mock.lastCall![0] as ReturnType<typeof controller.collectPayload>
  expect(saved.scalar).toMatchObject({ price: 0, default_spool_weight_g: 0 })
  controller.resetInitialData({ ...saved.scalar, colors: saved.colors })
  expect(controller.collectPayload().scalar).toMatchObject({ price: 0, default_spool_weight_g: 0 })
  controller.destroy()
})
