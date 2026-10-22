// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function renderForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="filament-form">
      <header id="filament-editor-hero">
        <h1 id="filament-editor-title">New Filament</h1>
        <span id="filament-editor-type">—</span>
        <button id="filament-color-launcher" type="button">
          <span id="filament-editor-color-swatch"></span>
          <code id="filament-editor-color-name">Choose color</code>
        </button>
      </header>
      <dialog id="filament-color-dialog">
        <h2 id="filament-color-dialog-title">Edit Colors</h2>
        <span id="filament-color-dialog-preview" hidden></span>
        <button id="filament-color-dialog-close" type="button">Close</button>
        <button id="filament-color-dialog-done" type="button">Done</button>
        <h3 id="color-selection-title">Select Existing Filament Color</h3>
        <span id="color-hint" hidden></span>
        <button id="color-sort-name" type="button" data-direction="none">Name</button>
        <button id="color-sort-hex" type="button" data-direction="none">Hex</button>
        <button id="color-filter-clear" type="button">Clear Filters</button>
        <button id="color-filter-button" type="button" data-filter-sidecar>Visual Color Filter</button>
      </dialog>
      <div data-dirty-key="manufacturer_id">
        <select id="manufacturer_id" name="manufacturer_id" required>
          <option value="">Select</option>
        </select>
        <label><span id="fil-search-scope-hint"></span><input id="fil-search-all-manufacturers" type="checkbox">Search all manufacturers</label>
      </div>
      <div id="fil-fdb-section" style="display:none">
        <div id="fil-lookup-heading"></div>
        <div id="fil-lookup-container"></div>
        <div id="fil-lookup-toast"></div>
      </div>
      <div data-dirty-key="material_type">
        <select id="type" name="type" required><option value="">Select</option></select>
        <div id="custom-type-wrapper" class="hidden">
          <input id="custom_type" name="custom_type">
        </div>
      </div>
      <div data-dirty-key="designation"><label class="fm-label" for="designation">Name</label><input id="designation" name="designation" required></div>
      <div data-dirty-key="diameter_mm"><input id="diameter_mm" name="diameter_mm" type="number" value="1.75"></div>
      <input id="material_subgroup" name="material_subgroup">
      <select id="finish_type" name="finish_type">
        <option value=""></option><option value="matte">Matte</option>
      </select>
      <div data-dirty-key="color_mode">
        <label><input name="color_mode" type="radio" value="single" checked>Single</label>
        <label><input name="color_mode" type="radio" value="multi">Multi</label>
      </div>
      <div id="multi-color-options" hidden data-dirty-key="multi_color_style">
        <select id="multi_color_style" name="multi_color_style" required disabled>
          <option value="striped">Striped</option><option value="gradient">Gradient</option>
        </select>
      </div>
      <div id="existing-color-picker" data-dirty-key="colors">
        <input id="color-search" type="search">
        <label><input id="color-list-toggle" type="checkbox">Color list</label>
        <div id="selected-colors"></div>
        <div id="color-grid"></div>
      </div>
      <input id="manufacturer_color_name" name="manufacturer_color_name">
      <input id="raw_material_weight_g" name="raw_material_weight_g" type="number">
      <input id="density_g_cm3" name="density_g_cm3" type="number">
      <div data-dirty-key="extruder_temp_range_c"><input id="extruder_temp_value" type="number" step="any"><input id="extruder_temp_to" type="number" step="any"></div>
      <div data-dirty-key="bed_temp_range_c"><input id="bed_temp_value" type="number" step="any"><input id="bed_temp_to" type="number" step="any"></div>
      <div data-dirty-key="manufacturer_sku price_currency datasheet_url image_url drying_temp_c drying_time_hours softening_temp_c chamber_temp_c cooling_fan_range_percent max_volumetric_speed_mm3_s flow_ratio pressure_advance_k ams_compatibility build_plate_compatibility">
        <input id="manufacturer_sku" name="manufacturer_sku">
        <input id="price_currency" name="price_currency">
        <input id="datasheet_url" name="datasheet_url">
        <input id="image_url" name="image_url">
        <input id="drying_temp_c" name="drying_temp_c" type="number" step="any">
        <input id="drying_time_hours" name="drying_time_hours" type="number" step="any">
        <input id="softening_temp_c" name="softening_temp_c" type="number" step="any">
        <input id="chamber_temp_c" name="chamber_temp_c" type="number" step="any">
        <input id="cooling_fan_value" type="number" step="any"><input id="cooling_fan_to" type="number" step="any">
        <input id="max_volumetric_speed_mm3_s" name="max_volumetric_speed_mm3_s" type="number" step="any">
        <input id="flow_ratio" name="flow_ratio" type="number" step="any">
        <input id="pressure_advance_k" name="pressure_advance_k" type="number" step="any">
        <input id="ams_compatibility" name="ams_compatibility">
        <input id="build_plate_compatibility" name="build_plate_compatibility">
      </div>
      <label class="filament-form-check" data-dirty-key="is_discontinued"><input id="is_discontinued" name="is_discontinued" type="checkbox"><span>Discontinued</span></label>
      <input id="default_spool_weight_g" name="default_spool_weight_g" type="number">
      <select id="spool_material" name="spool_material">
        <option value=""></option><option value="Cardboard">Cardboard</option>
      </select>
      <input id="spool_outer_diameter_mm" name="spool_outer_diameter_mm" type="number">
      <input id="spool_width_mm" name="spool_width_mm" type="number">
      <input id="price" name="price" type="number">
      <input id="shop_url" name="shop_url">
      <div id="system-fields-container" data-dirty-key="system_fields"><label class="fm-label">System Fields</label><div id="system-fields-grid"></div></div>
      <button id="btn-add-field" type="button">Add field</button>
      <div id="filament-custom-fields-card" data-dirty-key="entity_fields"><label class="fm-label">Filament-specific fields</label><div id="custom-fields-container"></div></div>
      <details id="new-color-disclosure">
        <summary>Add color to library</summary>
        <div id="new-color-form">
          <input id="new-color-picker" type="color" value="#ff0000" disabled>
          <input id="new-color-hex" value="#FF0000" disabled>
          <input id="new-color-name" required disabled>
          <input id="new-color-alpha-enabled" type="checkbox" disabled>
          <div id="new-color-alpha-options"></div>
          <span id="new-color-alpha-preview"></span>
          <input id="new-color-alpha" type="range" value="100" disabled>
          <input id="new-color-alpha-value" value="100" disabled>
          <input id="new-color-alpha-hex" value="FF" disabled>
          <button id="btn-save-new-color" type="button">Save Color</button>
        </div>
      </details>
      <div id="unsaved-changes-status" class="hidden"></div>
      <div id="error-message" class="hidden"></div>
      <button id="submit-btn" type="submit">Create Filament</button>
    </form>
  `
  const dialog = document.querySelector('#filament-color-dialog')!
  for (const selector of ['[data-dirty-key="color_mode"]', '#multi-color-options', '#existing-color-picker', '#manufacturer_color_name', '#new-color-disclosure']) {
    dialog.appendChild(document.querySelector(selector)!)
  }
  return document.querySelector<HTMLFormElement>('#filament-form')!
}

async function createLoadedController(mode: 'create' | 'edit' = 'create', submit = vi.fn(async () => undefined)) {
  const form = renderForm()
  const onSubmit = submit
  const controller = createFilamentFormController({ form, mode, onSubmit })
  await controller.loadReferenceData()
  return { controller, form, onSubmit }
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
    expect(save.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSubmit).not.toHaveBeenCalled()
    designation.value = 'Changed'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(false)
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
    designation.value = 'Basic'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(save.disabled).toBe(true)
    controller.destroy()
  })
  it.each(['create', 'edit'] as const)('keeps the external %s toolbar submit usable after a failed save', async mode => {
    const form = renderForm()
    const button = document.querySelector<HTMLButtonElement>('#submit-btn')!
    button.setAttribute('form', 'filament-form')
    form.before(button)
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

  it('outlines a changed scalar and clears the shared Changed pill when reverted', async () => {
    const { controller } = await createLoadedController('edit')
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
    const wrapper = document.querySelector<HTMLElement>('[data-dirty-key="designation"]')!

    designation.value = 'Hyper'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wrapper.classList.contains('is-dirty')).toBe(true)
    expect(wrapper.querySelector('.filament-dirty-indicator')?.textContent).toBe('Changed')
    expect((wrapper.querySelector('.filament-dirty-indicator') as HTMLElement).hidden).toBe(false)
    expect(document.querySelector('#unsaved-changes-status')?.classList.contains('hidden')).toBe(false)

    designation.value = 'Basic'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wrapper.classList.contains('is-dirty')).toBe(false)
    expect((wrapper.querySelector('.filament-dirty-indicator') as HTMLElement).hidden).toBe(true)
    expect(document.querySelector('#unsaved-changes-status')?.classList.contains('hidden')).toBe(true)
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

  it('does not submit Edit mutations until the form is submitted', async () => {
    const submit = vi.fn(async () => undefined)
    const { controller } = await createLoadedController('edit', submit)
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

    expect(submit).not.toHaveBeenCalled()
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

  it('retains the dirty draft after a save failure', async () => {
    const submit = vi.fn(async () => { throw new Error('Save failed') })
    const { controller, form } = await createLoadedController('edit', submit)
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

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(document.querySelector('#error-message')?.textContent).toBe('Save failed'))

    expect(designation.value).toBe('Hyper')
    expect(document.querySelector('[data-dirty-key="designation"]')?.classList.contains('is-dirty')).toBe(true)
    controller.destroy()
  })
})
