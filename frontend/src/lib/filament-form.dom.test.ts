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
      <div data-dirty-key="designation"><input id="designation" name="designation" required></div>
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
        <select id="multi_color_style" name="multi_color_style" disabled>
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
      <div data-dirty-key="extruder_temp_range_c"><input id="extruder_temp_value" type="number"><input id="extruder_temp_to" type="number"></div>
      <div data-dirty-key="bed_temp_range_c"><input id="bed_temp_value" type="number"><input id="bed_temp_to" type="number"></div>
      <div data-dirty-key="manufacturer_sku price_currency datasheet_url image_url drying_temp_c drying_time_hours softening_temp_c chamber_temp_c cooling_fan_range_percent max_volumetric_speed_mm3_s flow_ratio pressure_advance_k ams_compatibility build_plate_compatibility is_discontinued">
        <input id="manufacturer_sku" name="manufacturer_sku">
        <input id="price_currency" name="price_currency">
        <input id="datasheet_url" name="datasheet_url">
        <input id="image_url" name="image_url">
        <input id="drying_temp_c" name="drying_temp_c" type="number">
        <input id="drying_time_hours" name="drying_time_hours" type="number">
        <input id="softening_temp_c" name="softening_temp_c" type="number">
        <input id="chamber_temp_c" name="chamber_temp_c" type="number">
        <input id="cooling_fan_value" type="number"><input id="cooling_fan_to" type="number">
        <input id="max_volumetric_speed_mm3_s" name="max_volumetric_speed_mm3_s" type="number">
        <input id="flow_ratio" name="flow_ratio" type="number">
        <input id="pressure_advance_k" name="pressure_advance_k" type="number">
        <input id="ams_compatibility" name="ams_compatibility">
        <input id="build_plate_compatibility" name="build_plate_compatibility">
        <input id="is_discontinued" name="is_discontinued" type="checkbox">
      </div>
      <input id="default_spool_weight_g" name="default_spool_weight_g" type="number">
      <select id="spool_material" name="spool_material">
        <option value=""></option><option value="Cardboard">Cardboard</option>
      </select>
      <input id="spool_outer_diameter_mm" name="spool_outer_diameter_mm" type="number">
      <input id="spool_width_mm" name="spool_width_mm" type="number">
      <input id="price" name="price" type="number">
      <input id="shop_url" name="shop_url">
      <div id="system-fields-container"><div id="system-fields-grid"></div></div>
      <button id="btn-add-field" type="button">Add field</button>
      <div id="custom-fields-container"></div>
      <details id="new-color-disclosure">
        <summary>Add color to library</summary>
        <div id="new-color-form">
          <input id="new-color-picker" type="color" value="#ff0000" disabled>
          <input id="new-color-hex" value="#FF0000" disabled>
          <input id="new-color-name" disabled>
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

    document.querySelector<HTMLButtonElement>('#selected-colors button')!.click()

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
    const selected = document.querySelector<HTMLElement>('#selected-colors')!

    document.querySelector<HTMLButtonElement>('#color-grid [aria-label="Red (#FF0000)"]')!.click()

    expect(selected.hidden).toBe(true)

    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))

    const choices = [...document.querySelectorAll<HTMLButtonElement>('#color-grid .fm-color-choice')]
    expect(document.querySelector('#color-grid')?.classList.contains('fm-color-list')).toBe(true)
    expect(choices).toHaveLength(3)
    expect(choices[0].querySelector('.fm-color-choice-name')?.textContent).toBe('Red')
    expect(choices[0].querySelector('.fm-color-choice-hex')?.textContent).toBe('#FF0000')
    expect(selected.hidden).toBe(true)

    toggle.checked = false
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    expect(selected.hidden).toBe(true)
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
    expect(wrapper.querySelector('.filament-dirty-indicator')).toBeNull()
    expect(document.querySelector('#unsaved-changes-status')?.classList.contains('hidden')).toBe(false)

    designation.value = 'Basic'
    designation.dispatchEvent(new Event('input', { bubbles: true }))
    expect(wrapper.classList.contains('is-dirty')).toBe(false)
    expect(document.querySelector('#unsaved-changes-status')?.classList.contains('hidden')).toBe(true)
    controller.destroy()
  })

  it('labels the manufacturer catalog search with the configured database', async () => {
    const { controller } = await createLoadedController()

    expect(document.querySelector('#fil-lookup-heading')?.textContent)
      .toBe('Search FilaManDB for existing filament')

    controller.destroy()
  })

  it('searches without a manufacturer and adopts the selected result manufacturer', async () => {
    const { controller } = await createLoadedController()
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
