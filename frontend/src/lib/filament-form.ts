import { getAbortSignal, isAbortError } from './abort'
import { CACHE_KEYS, cachedFetchAllPages, invalidateCachePrefix } from './cache'
import { toColorSwatchBackground } from './colors'
import {
  collectExtraFieldPayload,
  createEntityExtraFieldEditor,
  getExtraFieldValue,
} from './entity-extra-fields'
import { escapeHtml, parseNumericRangeInputs, renderFieldInput } from './extra-fields'
import {
  bindFilamentDbLookupToManufacturer,
  checkFilamentDbActive,
  createFilamentDbLookup,
  resolveFilamentLookupSource,
  type FilamentLookupSource,
} from './filamentdb-lookup'
import { buildFilamentHeroStyle, buildFilamentSwatchStyle } from './filament-detail'
import { t } from './i18n'
import { bindInlineColorEditor } from './inline-color-editor'
import {
  bindManufacturerCreateOption,
  createManufacturerDialog,
  type Manufacturer,
  type ManufacturerDialog,
} from './manufacturer-dialog'
import {
  bindColorFilterButton,
  isColumnFilterActive,
  matchesColumnFilter,
  type ColorFilterValue,
} from './table-column-filters'

const CUSTOM_TYPE_VALUE = '__custom__'
const DEFAULT_DENSITIES: Record<string, number> = {
  PLA: 1.24,
  ABS: 1.07,
  ASA: 1.06,
  PETG: 1.27,
  NYLON: 1.08,
  PA: 1.08,
  PC: 1.22,
  TPU: 1.22,
  PP: 0.9,
  HIPS: 1.04,
  PVA: 1.22,
}

type FormMode = 'create' | 'edit'
type Color = { id: number; name: string; hex_code: string }
type InitialData = Record<string, any>
type FormSnapshot = Record<string, string>

interface FilamentFormPayload {
  scalar: Record<string, unknown>
  colors: Array<{ color_id: number; position: number }>
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function flattenObject(value: Record<string, unknown>, prefix = '', result: Record<string, unknown> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenObject(child as Record<string, unknown>, path, result)
    } else {
      result[path] = child
    }
  }
  return result
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  )
}

function serialize(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function createFilamentFormController(options: {
  form: HTMLFormElement
  mode: FormMode
  onSubmit(payload: FilamentFormPayload): Promise<void>
}) {
  const { form, mode, onSubmit } = options
  const byId = <T extends HTMLElement>(id: string): T => {
    const element = form.querySelector<T>(`#${id}`)
    if (!element) throw new Error(`Missing filament form element #${id}`)
    return element
  }
  const input = (id: string) => byId<HTMLInputElement>(id)
  const select = (id: string) => byId<HTMLSelectElement>(id)
  const manufacturerSelect = select('manufacturer_id')
  const typeSelect = select('type')
  const customTypeWrapper = byId<HTMLDivElement>('custom-type-wrapper')
  const customTypeInput = input('custom_type')
  const colorSearch = input('color-search')
  const colorSortName = byId<HTMLButtonElement>('color-sort-name')
  const colorSortHex = byId<HTMLButtonElement>('color-sort-hex')
  const colorFilterClear = byId<HTMLButtonElement>('color-filter-clear')
  const colorListToggle = input('color-list-toggle')
  const colorGrid = byId<HTMLDivElement>('color-grid')
  colorListToggle.checked = localStorage.getItem('filaman-filament-color-view') === 'list'
  const savedColorSort = localStorage.getItem('filaman-filament-color-sort') || ''
  let colorSortKey: 'name' | 'hex' | null = savedColorSort.startsWith('name')
    ? 'name'
    : savedColorSort.startsWith('hex') ? 'hex' : null
  let colorSortDirection: 'asc' | 'desc' | null = colorSortKey
    ? savedColorSort.endsWith(':desc') ? 'desc' : 'asc'
    : null
  const colorTooltip = document.createElement('div')
  colorTooltip.className = 'fm-color-tooltip'
  colorTooltip.setAttribute('role', 'tooltip')
  colorTooltip.hidden = true
  document.body.appendChild(colorTooltip)
  const selectedColorsContainer = byId<HTMLDivElement>('selected-colors')
  const colorHint = byId<HTMLSpanElement>('color-hint')
  const colorSelectionTitle = byId<HTMLElement>('color-selection-title')
  const colorDialogPreview = byId<HTMLElement>('filament-color-dialog-preview')
  const colorLauncher = byId<HTMLButtonElement>('filament-color-launcher')
  const existingColorPicker = byId<HTMLElement>('existing-color-picker')
  const errorMessage = byId<HTMLDivElement>('error-message')
  const submitButton = byId<HTMLButtonElement>('submit-btn')
  const systemFieldsContainer = byId<HTMLDivElement>('system-fields-container')
  const systemFieldsGrid = byId<HTMLDivElement>('system-fields-grid')
  const lookupSection = byId<HTMLDivElement>('fil-fdb-section')
  const lookupHeading = byId<HTMLDivElement>('fil-lookup-heading')
  const lookupContainer = byId<HTMLDivElement>('fil-lookup-container')
  const lookupToast = byId<HTMLDivElement>('fil-lookup-toast')
  const lookupScopeHint = byId<HTMLSpanElement>('fil-search-scope-hint')
  const lookupSearchAll = byId<HTMLInputElement>('fil-search-all-manufacturers')
  const customFieldsContainer = byId<HTMLDivElement>('custom-fields-container')
  const colorModeRadios = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="color_mode"]'))
  const hero = byId<HTMLElement>('filament-editor-hero')
  const heroTitle = byId<HTMLElement>('filament-editor-title')
  const heroType = byId<HTMLElement>('filament-editor-type')
  const heroColorSwatch = byId<HTMLElement>('filament-editor-color-swatch')
  const heroColorName = byId<HTMLElement>('filament-editor-color-name')
  const colorDialog = byId<HTMLDialogElement>('filament-color-dialog')
  let colorDialogInvoker: HTMLElement | null = null

  let allColors: Color[] = []
  let selectedColorIds: number[] = []
  let colorFilter: ColorFilterValue | null = null
  let allManufacturers: Manufacturer[] = []
  let systemFields: any[] = []
  let addManufacturerOption: HTMLOptionElement | null = null
  let manufacturerDialog: ManufacturerDialog | null = null
  let lookupBound = false
  let newColorEditorOpen = false
  let destroyed = false
  let baseline: FormSnapshot | null = null

  const entityExtraFields = createEntityExtraFieldEditor({
    container: customFieldsContainer,
    addButton: byId('btn-add-field'),
    emptyText: t('filaments.noSpecificExtraFields'),
  })

  const dirtyWrappers = mode === 'edit'
    ? Array.from(form.querySelectorAll<HTMLElement>('[data-dirty-key]'))
    : []
  const unsavedStatus = form.ownerDocument.getElementById('unsaved-changes-status')
  const clearColorFilter = bindColorFilterButton(byId('color-filter-button'), (value) => {
    colorFilter = value
    renderColorGrid()
  })

  bindInlineColorEditor({
    getAbortSignal,
    getCsrfToken: csrfToken,
    isAbortError,
    translate: t,
    onOpenChange(open) {
      newColorEditorOpen = open
      syncExistingColorPickerAvailability()
    },
    onCreated(newColor) {
      allColors.push(newColor)
      toggleColor(newColor.id)
    },
  })

  function getColorMode(): string {
    return colorModeRadios.find((radio) => radio.checked)?.value || 'single'
  }

  function syncExistingColorPickerAvailability(): void {
    const inactive = newColorEditorOpen && getColorMode() !== 'multi'
    existingColorPicker.inert = inactive
    existingColorPicker.classList.toggle('is-inactive', inactive)
    if (inactive) existingColorPicker.setAttribute('aria-disabled', 'true')
    else existingColorPicker.removeAttribute('aria-disabled')
  }

  function syncHeroPreview(): void {
    const colors = selectedColorIds
      .map((id) => allColors.find((color) => color.id === id))
      .filter((color): color is Color => !!color)
    const preview = {
      colors: colors.map((color) => ({ color: { hex_code: color.hex_code } })),
      multi_color_style: select('multi_color_style').value,
    }
    const materialType = typeSelect.value === CUSTOM_TYPE_VALUE
      ? customTypeInput.value.trim().toUpperCase()
      : typeSelect.value
    heroTitle.textContent = mode === 'create'
      ? t('filaments.newFilament')
      : input('designation').value.trim() || t('filaments.editFilament')
    heroType.textContent = materialType || '—'
    heroColorName.textContent = colors.map((color) => color.name).join(' · ')
      || t('filaments.chooseColors')
    heroColorSwatch.style.cssText = buildFilamentSwatchStyle(preview)
    hero.style.cssText = buildFilamentHeroStyle(preview)
    colorDialogPreview.hidden = colors.length === 0
    colorDialogPreview.style.cssText = colors.length ? buildFilamentSwatchStyle(preview) : ''
  }

  function openColorDialog(): void {
    if (colorDialog.open) return
    colorDialogInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    colorDialog.showModal()
    colorDialog.classList.add('open')
    byId<HTMLButtonElement>('filament-color-dialog-close').focus()
  }

  function closeColorDialog(): void {
    if (!colorDialog.open) return
    colorDialog.close()
    colorDialog.classList.remove('open')
    colorDialogInvoker?.focus()
    colorDialogInvoker = null
  }

  function handleColorDialogClick(event: MouseEvent): void {
    if (event.target === colorDialog) closeColorDialog()
  }

  function numberValue(id: string): number | null {
    const value = input(id).value
    if (!value) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function rangeValue(prefix: string): number | { min: number; max: number } | null {
    return parseNumericRangeInputs(input(`${prefix}_value`).value, input(`${prefix}_to`).value)
  }

  function readSnapshot(): FormSnapshot {
    const extraFields = collectExtraFieldPayload(systemFieldsGrid, entityExtraFields)
    const fallbackExtraFields = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        '#system-fields-grid input, #system-fields-grid select, #system-fields-grid textarea',
      ),
    ).map((field) => [field.name || field.id, field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value])
    const materialType = typeSelect.value === CUSTOM_TYPE_VALUE
      ? customTypeInput.value.trim().toUpperCase()
      : typeSelect.value
    return {
      manufacturer_id: serialize(manufacturerSelect.value ? Number(manufacturerSelect.value) : null),
      material_type: serialize(materialType),
      diameter_mm: serialize(numberValue('diameter_mm')),
      material_subgroup: serialize(input('material_subgroup').value.trim()),
      finish_type: serialize(select('finish_type').value),
      designation: serialize(input('designation').value),
      color_mode: serialize(getColorMode()),
      multi_color_style: serialize(select('multi_color_style').value),
      colors: serialize(selectedColorIds.map((colorId, index) => ({ color_id: colorId, position: index + 1 }))),
      manufacturer_color_name: serialize(input('manufacturer_color_name').value.trim()),
      raw_material_weight_g: serialize(numberValue('raw_material_weight_g')),
      density_g_cm3: serialize(numberValue('density_g_cm3')),
      extruder_temp_range_c: serialize(rangeValue('extruder_temp')),
      bed_temp_range_c: serialize(rangeValue('bed_temp')),
      manufacturer_sku: serialize(input('manufacturer_sku').value.trim()),
      price_currency: serialize(input('price_currency').value.trim().toUpperCase()),
      datasheet_url: serialize(input('datasheet_url').value.trim()),
      image_url: serialize(input('image_url').value.trim()),
      drying_temp_c: serialize(numberValue('drying_temp_c')),
      drying_time_hours: serialize(numberValue('drying_time_hours')),
      softening_temp_c: serialize(numberValue('softening_temp_c')),
      chamber_temp_c: serialize(numberValue('chamber_temp_c')),
      cooling_fan_range_percent: serialize(rangeValue('cooling_fan')),
      max_volumetric_speed_mm3_s: serialize(numberValue('max_volumetric_speed_mm3_s')),
      flow_ratio: serialize(numberValue('flow_ratio')),
      pressure_advance_k: serialize(numberValue('pressure_advance_k')),
      ams_compatibility: serialize(input('ams_compatibility').value.split(',').map((value) => value.trim()).filter(Boolean)),
      build_plate_compatibility: serialize(input('build_plate_compatibility').value.split(',').map((value) => value.trim()).filter(Boolean)),
      is_discontinued: serialize(input('is_discontinued').checked),
      default_spool_weight_g: serialize(numberValue('default_spool_weight_g')),
      spool_material: serialize(select('spool_material').value),
      spool_outer_diameter_mm: serialize(numberValue('spool_outer_diameter_mm')),
      spool_width_mm: serialize(numberValue('spool_width_mm')),
      price: serialize(numberValue('price')),
      shop_url: serialize(input('shop_url').value.trim()),
      custom_fields: serialize(extraFields || {
        fields: fallbackExtraFields,
        editor: customFieldsContainer.textContent,
      }),
    }
  }

  function updateDirtyState(): void {
    if (!baseline || mode !== 'edit') return
    const current = readSnapshot()
    let anyDirty = false
    for (const wrapper of dirtyWrappers) {
      const keys = (wrapper.dataset.dirtyKey || '').split(/\s+/).filter(Boolean)
      const dirty = keys.some((key) => baseline?.[key] !== current[key])
      wrapper.classList.toggle('is-dirty', dirty)
      anyDirty ||= dirty
    }
    colorLauncher.classList.toggle('is-dirty', [
      'manufacturer_color_name',
      'color_mode',
      'multi_color_style',
      'colors',
    ].some((key) => baseline?.[key] !== current[key]))
    unsavedStatus?.classList.toggle('hidden', !anyDirty)
  }

  function syncColorSortButtons(): void {
    for (const [key, button] of [['name', colorSortName], ['hex', colorSortHex]] as const) {
      const direction = colorSortKey === key ? colorSortDirection : null
      button.dataset.direction = direction || 'none'
      button.setAttribute('aria-pressed', String(!!direction))
    }
  }

  function cycleColorSort(key: 'name' | 'hex'): void {
    if (colorSortKey !== key) {
      colorSortKey = key
      colorSortDirection = 'asc'
    } else if (colorSortDirection === 'asc') colorSortDirection = 'desc'
    else if (colorSortDirection === 'desc') {
      colorSortKey = null
      colorSortDirection = null
    } else colorSortDirection = 'asc'
    if (colorSortKey && colorSortDirection) {
      localStorage.setItem('filaman-filament-color-sort', `${colorSortKey}:${colorSortDirection}`)
    } else localStorage.removeItem('filaman-filament-color-sort')
    syncColorSortButtons()
    renderColorGrid()
  }

  function renderColorGrid(): void {
    colorTooltip.hidden = true
    colorFilterClear.disabled = !colorSearch.value.trim() && (!colorFilter || !isColumnFilterActive(colorFilter))
    if (!allColors.length) {
      colorGrid.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">${t('filaments.noColorsAvailable')}</p>`
      return
    }
    const query = colorSearch.value.trim().toLocaleLowerCase()
    const visible = allColors.filter((color) =>
      (!query || color.name.toLocaleLowerCase().includes(query))
      && matchesColumnFilter(color.hex_code, colorFilter))
    if (colorSortKey && colorSortDirection) {
      const direction = colorSortDirection === 'asc' ? 1 : -1
      visible.sort((left, right) => direction * (colorSortKey === 'hex'
        ? left.hex_code.localeCompare(right.hex_code) || left.name.localeCompare(right.name)
        : left.name.localeCompare(right.name) || left.hex_code.localeCompare(right.hex_code)))
    }
    if (!visible.length) {
      colorGrid.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">${t('filters.noMatchingOptions')}</p>`
      return
    }
    colorGrid.replaceChildren()
    colorGrid.classList.toggle('fm-color-list', colorListToggle.checked)
    for (const color of visible) {
      const swatch = document.createElement('button')
      swatch.type = 'button'
      const selected = selectedColorIds.includes(color.id) ? 'selected' : ''
      const order = getColorMode() === 'multi' ? selectedColorIds.indexOf(color.id) + 1 : 0
      swatch.className = colorListToggle.checked ? `fm-color-choice ${selected}` : `fm-color-swatch ${selected}`
      if (colorListToggle.checked) {
        swatch.innerHTML = `
          <span class="fm-color-swatch ${selected}"${order ? ` data-order="${order}"` : ''} style="background:${toColorSwatchBackground(color.hex_code)}"></span>
          <span class="fm-color-choice-name">${escapeHtml(color.name)}</span>
          <span class="fm-color-choice-hex">${escapeHtml(color.hex_code)}</span>
        `
      } else {
        swatch.style.background = toColorSwatchBackground(color.hex_code)
        if (order) swatch.dataset.order = String(order)
      }
      const label = `${color.name} (${color.hex_code})`
      swatch.setAttribute('aria-label', label)
      if (!colorListToggle.checked) {
        const showTooltip = () => {
          const rect = swatch.getBoundingClientRect()
          colorTooltip.textContent = label
          colorTooltip.style.left = `${rect.left + rect.width / 2}px`
          colorTooltip.style.top = `${rect.top - 6}px`
          colorTooltip.hidden = false
        }
        swatch.addEventListener('pointerenter', showTooltip)
        swatch.addEventListener('pointerleave', () => { colorTooltip.hidden = true })
        swatch.addEventListener('focus', showTooltip)
        swatch.addEventListener('blur', () => { colorTooltip.hidden = true })
      }
      swatch.addEventListener('click', () => toggleColor(color.id))
      colorGrid.appendChild(swatch)
    }
  }

  function renderSelectedColors(): void {
    selectedColorsContainer.hidden = true
    selectedColorsContainer.replaceChildren()
    selectedColorIds.forEach((colorId, index) => {
      const color = allColors.find(({ id }) => id === colorId)
      if (!color) return
      const entry = document.createElement('div')
      entry.className = 'fm-color-entry'
      entry.innerHTML = `
        <span class="fm-color-swatch-lg"${getColorMode() === 'multi' ? ` data-order="${index + 1}"` : ''} style="background:${toColorSwatchBackground(color.hex_code)}"></span>
        <span style="font-size:0.85rem;color:var(--text)">${escapeHtml(color.name)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(color.hex_code)}</span>
        ${getColorMode() === 'multi' ? `<span style="font-size:0.75rem;color:var(--text-muted)">#${index + 1}</span>` : ''}
        <button type="button" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.1rem;padding:0 4px" aria-label="${escapeHtml(t('common.delete'))}">&times;</button>
      `
      entry.querySelector('button')!.addEventListener('click', () => toggleColor(colorId))
      selectedColorsContainer.appendChild(entry)
    })
  }

  function toggleColor(colorId: number): void {
    const index = selectedColorIds.indexOf(colorId)
    const shouldClearFilter = index < 0 && isColumnFilterActive(colorFilter)
    if (index >= 0) selectedColorIds.splice(index, 1)
    else if (getColorMode() === 'single') selectedColorIds = [colorId]
    else selectedColorIds.push(colorId)
    renderSelectedColors()
    if (shouldClearFilter) clearColorFilter()
    else renderColorGrid()
    syncHeroPreview()
    updateDirtyState()
  }

  function syncColorMode(): void {
    const multiColorStyle = select('multi_color_style')
    byId('multi-color-options').hidden = getColorMode() !== 'multi'
    if (getColorMode() === 'multi') {
      multiColorStyle.disabled = false
      colorSelectionTitle.textContent = t('filaments.selectExistingFilamentColors')
      colorHint.textContent = t('filaments.clickSelectionOrder')
      colorHint.hidden = false
    } else {
      multiColorStyle.disabled = true
      colorSelectionTitle.textContent = t('filaments.selectExistingFilamentColor')
      colorHint.hidden = true
      if (selectedColorIds.length > 1) selectedColorIds = selectedColorIds.slice(-1)
    }
    syncExistingColorPickerAvailability()
    renderSelectedColors()
    renderColorGrid()
    syncHeroPreview()
    updateDirtyState()
  }

  function syncType(fillDensity: boolean): void {
    if (typeSelect.value === CUSTOM_TYPE_VALUE) {
      customTypeWrapper.classList.remove('hidden')
      customTypeInput.required = true
      return
    }
    customTypeWrapper.classList.add('hidden')
    customTypeInput.required = false
    customTypeInput.value = ''
    const density = DEFAULT_DENSITIES[typeSelect.value.toUpperCase()]
    if (fillDensity && density != null) input('density_g_cm3').value = String(density)
  }

  function applyManufacturerDefaults(): void {
    const manufacturer = allManufacturers.find(({ id }) => id === Number(manufacturerSelect.value))
    const values: Array<[string, unknown]> = [
      ['default_spool_weight_g', manufacturer?.empty_spool_weight_g],
      ['spool_material', manufacturer?.spool_material],
      ['spool_outer_diameter_mm', manufacturer?.spool_outer_diameter_mm],
      ['spool_width_mm', manufacturer?.spool_width_mm],
    ]
    for (const [id, value] of values) {
      const field = byId<HTMLInputElement | HTMLSelectElement>(id)
      field.value = value == null ? '' : String(value)
    }
  }

  colorModeRadios.forEach((radio) => radio.addEventListener('change', syncColorMode))
  colorSearch.addEventListener('input', renderColorGrid)
  colorSortName.addEventListener('click', () => cycleColorSort('name'))
  colorSortHex.addEventListener('click', () => cycleColorSort('hex'))
  colorFilterClear.addEventListener('click', () => {
    colorSearch.value = ''
    clearColorFilter()
  })
  syncColorSortButtons()
  colorListToggle.addEventListener('change', () => {
    localStorage.setItem('filaman-filament-color-view', colorListToggle.checked ? 'list' : 'grid')
    renderSelectedColors()
    renderColorGrid()
  })
  typeSelect.addEventListener('change', () => syncType(true))
  customTypeInput.addEventListener('input', () => {
    customTypeInput.value = customTypeInput.value.toUpperCase()
  })
  manufacturerSelect.addEventListener('change', applyManufacturerDefaults)
  colorLauncher.addEventListener('click', openColorDialog)
  byId<HTMLButtonElement>('filament-color-dialog-close').addEventListener('click', closeColorDialog)
  byId<HTMLButtonElement>('filament-color-dialog-done').addEventListener('click', closeColorDialog)
  colorDialog.addEventListener('click', handleColorDialogClick)
  colorDialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeColorDialog()
  })
  const handleDraftChange = () => {
    syncHeroPreview()
    updateDirtyState()
  }
  form.addEventListener('input', handleDraftChange)
  form.addEventListener('change', handleDraftChange)
  const extraFieldObserver = new MutationObserver(handleDraftChange)
  extraFieldObserver.observe(customFieldsContainer, { childList: true, subtree: true })

  function renderSystemFields(values: Record<string, unknown> = {}, raw?: Record<string, unknown>): void {
    if (!systemFields.length) {
      systemFieldsContainer.style.display = 'none'
      systemFieldsGrid.replaceChildren()
      return
    }
    systemFieldsContainer.style.display = 'block'
    systemFieldsGrid.replaceChildren()
    for (const field of systemFields) {
      const wrapper = document.createElement('div')
      const rawValue = raw ? getExtraFieldValue(raw, field.key) : null
      const control = renderFieldInput(field, rawValue, values)
      wrapper.innerHTML = field.field_type === 'checkbox'
        ? control
        : `<label class="fm-label">${escapeHtml(field.label)}</label>${control}`
      systemFieldsGrid.appendChild(wrapper)
    }
  }

  function showLookupToast(message: string, variant: 'success' | 'error' = 'success'): void {
    lookupToast.className = `fdb-toast fdb-toast-${variant}`
    lookupToast.textContent = message
    lookupToast.style.display = ''
  }

  function selectedManufacturerName(): string {
    return allManufacturers.find(({ id }) => id === Number(manufacturerSelect.value))?.name || ''
  }

  function bindCatalogLookup(config: { endpoint: string; labelKey: string }, source: FilamentLookupSource): void {
    if (lookupBound) return
    lookupBound = true
    lookupHeading.textContent = t('filamentdbLookup.searchExistingFilament', { database: t(config.labelKey) })
    lookupScopeHint.textContent = t('filamentdbLookup.selectManufacturerToSearch', { database: t(config.labelKey) })
    bindFilamentDbLookupToManufacturer(manufacturerSelect, lookupSearchAll, lookupSection, (scopedToManufacturer) => {
      lookupToast.style.display = 'none'
      return createFilamentDbLookup<any>({
        container: lookupContainer,
        endpoint: config.endpoint,
        placeholder: t('filamentdbLookup.searchFilament'),
        extraParams: scopedToManufacturer ? { manufacturer_name: selectedManufacturerName() } : {},
        renderItem(item) {
          const colors = (item.colors || [])
            .map((color: any) => `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${toColorSwatchBackground(color.hex_code)};border:1px solid var(--border);vertical-align:middle"></span>`)
            .join(' ')
          const traits = Object.entries(item.traits || {})
            .filter(([, enabled]) => enabled)
            .map(([trait]) => trait.replaceAll('_', ' '))
          const details = [
            scopedToManufacturer ? '' : item.manufacturer?.name,
            item.material?.key,
            item.nominal_weight_g ? `${item.nominal_weight_g}g` : '',
            ...traits,
          ]
            .filter(Boolean)
            .map((value) => escapeHtml(String(value)))
            .join(' · ')
          const spool = source === 'filamandb' ? '<span style="font-size:1.2rem;flex-shrink:0">&#x1F9F5;</span>' : ''
          return `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:0"><div class="fdb-lookup-item-name">${escapeHtml(item.name || item.designation || '?')}</div><div class="fdb-lookup-item-sub">${details} ${colors}</div></div>${spool}</div>`
        },
        async onSelect(item) {
          try {
            const response = await fetch('/api/v1/filamentdb/prepare-filament', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
              credentials: 'include',
              body: JSON.stringify({
                manufacturer_name: item.manufacturer?.name || selectedManufacturerName(),
                manufacturer_website: item.manufacturer?.website || null,
                manufacturer_slug: item.manufacturer?.slug || null,
                manufacturer_has_web_logo: item.manufacturer?.has_web_logo || false,
                manufacturer_has_label_logo: item.manufacturer?.has_label_logo || false,
                designation: item.name || item.designation || '',
                material_key: item.material?.key || null,
                material_name: item.material?.name || null,
                material_subtype: item.material_subtype || null,
                manufacturer_color_name: item.manufacturer_color_name || null,
                diameter_mm: item.diameter_mm || 1.75,
                density_g_cm3: item.density_g_cm3 || null,
                temp_nozzle_min: item.temp_nozzle_min ?? null,
                temp_nozzle_max: item.temp_nozzle_max ?? null,
                temp_bed: item.temp_bed ?? null,
                sku: item.sku ?? null,
                datasheet_url: item.datasheet_url ?? null,
                image_url: item.image_url ?? null,
                image_file: item.image_file ?? null,
                discontinued: item.discontinued ?? null,
                dry_temp: item.dry_temp ?? null,
                dry_time_hours: item.dry_time_hours ?? null,
                softening_temp: item.softening_temp ?? null,
                fan_speed_min: item.fan_speed_min ?? null,
                fan_speed_max: item.fan_speed_max ?? null,
                chamber_temp: item.chamber_temp ?? null,
                max_volumetric_speed: item.max_volumetric_speed ?? null,
                flow_ratio: item.flow_ratio ?? null,
                k_value: item.k_value ?? null,
                ams_compatible: item.ams_compatible ?? null,
                build_plates: item.build_plates ?? null,
                nominal_weight_g: item.nominal_weight_g || null,
                price: item.price || null,
                currency: item.currency || null,
                shop_url: item.shop_url || null,
                color_mode: (item.colors || []).length > 1 ? 'multi' : 'single',
                multi_color_style: item.multi_color_style || null,
                colors: (item.colors || []).map((color: any, index: number) => ({
                  hex_code: color.hex_code || '',
                  color_name: color.color_name || color.name || '',
                  position: color.position || index + 1,
                })),
                spool_profile_empty_weight_g: item.spool_profile?.empty_weight_g || null,
                spool_profile_outer_diameter_mm: item.spool_profile?.outer_diameter_mm || null,
                spool_profile_width_mm: item.spool_profile?.width_mm || null,
                spool_profile_material: item.spool_profile?.spool_material || null,
              }),
            })
            if (!response.ok) {
              const error = await response.json()
              throw new Error(error.detail?.message || t('filamentdbLookup.prefillError'))
            }
            const result = await response.json()
            if (result.colors_created > 0) {
              invalidateCachePrefix(CACHE_KEYS.COLORS)
              await loadColors()
            }
            const prefilled = result.prefilled || {}
            const catalogData = { ...prefilled }
            delete catalogData.manufacturer_id
            if (!scopedToManufacturer && result.manufacturer_id) {
              const manufacturerId = Number(result.manufacturer_id)
              const manufacturerName = item.manufacturer?.name || t('common.unknown')
              let option = Array.from(manufacturerSelect.options).find(({ value }) => value === String(manufacturerId))
              if (!option) {
                option = document.createElement('option')
                option.value = String(manufacturerId)
                option.textContent = manufacturerName
                manufacturerSelect.insertBefore(option, addManufacturerOption)
                allManufacturers.push({ id: manufacturerId, name: manufacturerName })
              }
              manufacturerSelect.value = String(manufacturerId)
              manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
            }
            if (item.diameter_mm == null) delete catalogData.diameter_mm
            const finishType = prefilled.finish_type
            if (finishType) catalogData.finish_type = finishType
            if (prefilled.color_ids?.length) {
              catalogData.colors = prefilled.color_ids.map((colorId: number, index: number) => ({
                color_id: colorId,
                position: index + 1,
              }))
            } else {
              delete catalogData.color_mode
              delete catalogData.multi_color_style
            }
            applyInitialData(catalogData, 'catalog')
            const messages = result.colors_created > 0
              ? [`${t('filamentdbLookup.colorsCreated').replace('{count}', String(result.colors_created))}`, t('filamentdbLookup.prefillSuccess')]
              : [t('filamentdbLookup.prefillSuccess')]
            showLookupToast(messages.join(' · '))
          } catch (error) {
            showLookupToast(error instanceof Error ? error.message : t('filamentdbLookup.prefillError'), 'error')
          }
        },
      })
    })
  }

  async function loadColors(): Promise<void> {
    const data = await cachedFetchAllPages<Color>(CACHE_KEYS.COLORS, '/api/v1/colors')
    allColors = data.items
    renderSelectedColors()
    renderColorGrid()
  }

  async function loadReferenceData(): Promise<void> {
    const filamentDbActive = await checkFilamentDbActive()
    let source: FilamentLookupSource = 'filamandb'
    try {
      const response = await fetch('/api/v1/app-settings/public-info', {
        credentials: 'include',
        signal: getAbortSignal(),
      })
      if (response.ok) {
        const settings = await response.json()
        if (['filamandb', 'disabled'].includes(settings.filament_lookup_source)) {
          source = settings.filament_lookup_source
        }
      }
    } catch (error) {
      if (!isAbortError(error)) console.error('Failed to load filament lookup source:', error)
    }

    manufacturerDialog = createManufacturerDialog({
      filamentDbActive,
      onSaved(manufacturer) {
        const index = allManufacturers.findIndex(({ id }) => id === manufacturer.id)
        if (index >= 0) allManufacturers[index] = manufacturer
        else allManufacturers.push(manufacturer)
        let option = Array.from(manufacturerSelect.options).find(({ value }) => value === String(manufacturer.id))
        if (!option) {
          option = document.createElement('option')
          option.value = String(manufacturer.id)
          manufacturerSelect.insertBefore(option, addManufacturerOption)
        }
        option.textContent = manufacturer.name
        manufacturerSelect.value = option.value
        manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
      },
    })
    addManufacturerOption = bindManufacturerCreateOption(manufacturerSelect, () => manufacturerDialog?.open())

    const manufacturers = await cachedFetchAllPages<Manufacturer>(CACHE_KEYS.MANUFACTURERS, '/api/v1/manufacturers')
    allManufacturers = manufacturers.items
    for (const manufacturer of allManufacturers) {
      const option = document.createElement('option')
      option.value = String(manufacturer.id)
      option.textContent = manufacturer.name || t('common.unknown')
      manufacturerSelect.insertBefore(option, addManufacturerOption)
    }

    const typesResponse = await fetch('/api/v1/filaments/types', {
      credentials: 'include',
      signal: getAbortSignal(),
    })
    const types = typesResponse.ok
      ? await typesResponse.json() as string[]
      : ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'NYLON', 'PC']
    for (const type of types) {
      const option = document.createElement('option')
      option.value = type
      option.textContent = type
      typeSelect.appendChild(option)
    }
    const customOption = document.createElement('option')
    customOption.value = CUSTOM_TYPE_VALUE
    customOption.textContent = t('filaments.addCustomType')
    typeSelect.appendChild(customOption)

    await loadColors()
    const systemFieldsResponse = await fetch('/api/v1/system-extra-fields?target_type=filament', {
      credentials: 'include',
      signal: getAbortSignal(),
    })
    if (!systemFieldsResponse.ok) throw new Error(t('common.systemFieldsUnavailable'))
    systemFields = await systemFieldsResponse.json()
    entityExtraFields.setSystemFieldKeys(systemFields.map((field: any) => field.key))
    renderSystemFields()

    const lookupConfig = resolveFilamentLookupSource(source, filamentDbActive)
    if (lookupConfig) bindCatalogLookup(lookupConfig, source)
  }

  function setField(id: string, value: unknown): void {
    byId<HTMLInputElement | HTMLSelectElement>(id).value = value == null ? '' : String(value)
  }

  function setRange(prefix: string, value: unknown): void {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? value as { min?: unknown; max?: unknown }
      : { min: value, max: value }
    const start = range.min ?? range.max
    setField(`${prefix}_value`, start)
    setField(`${prefix}_to`, range.min != null && range.max != null && range.min !== range.max ? range.max : null)
  }

  function applyInitialData(data: InitialData, source: 'initial' | 'duplicate' | 'catalog' = 'initial'): void {
    const hasValue = (key: string): boolean => {
      if (!Object.hasOwn(data, key)) return false
      if (source !== 'catalog') return true
      const value = data[key]
      return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)
    }
    if (source !== 'catalog' && hasValue('manufacturer_id') && data.manufacturer_id != null) {
      manufacturerSelect.value = String(data.manufacturer_id)
      manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (hasValue('designation')) setField('designation', data.designation)
    if (hasValue('material_type') && data.material_type) {
      if (Array.from(typeSelect.options).some(({ value }) => value === data.material_type)) {
        typeSelect.value = data.material_type
      } else {
        typeSelect.value = CUSTOM_TYPE_VALUE
        customTypeInput.value = String(data.material_type).toUpperCase()
      }
      syncType(false)
    }
    for (const [key, id] of [
      ['diameter_mm', 'diameter_mm'],
      ['material_subgroup', 'material_subgroup'],
      ['finish_type', 'finish_type'],
      ['manufacturer_color_name', 'manufacturer_color_name'],
      ['raw_material_weight_g', 'raw_material_weight_g'],
      ['density_g_cm3', 'density_g_cm3'],
      ['manufacturer_sku', 'manufacturer_sku'],
      ['price_currency', 'price_currency'],
      ['datasheet_url', 'datasheet_url'],
      ['image_url', 'image_url'],
      ['drying_temp_c', 'drying_temp_c'],
      ['drying_time_hours', 'drying_time_hours'],
      ['softening_temp_c', 'softening_temp_c'],
      ['chamber_temp_c', 'chamber_temp_c'],
      ['max_volumetric_speed_mm3_s', 'max_volumetric_speed_mm3_s'],
      ['flow_ratio', 'flow_ratio'],
      ['pressure_advance_k', 'pressure_advance_k'],
      ['default_spool_weight_g', 'default_spool_weight_g'],
      ['spool_material', 'spool_material'],
      ['spool_outer_diameter_mm', 'spool_outer_diameter_mm'],
      ['spool_width_mm', 'spool_width_mm'],
      ['price', 'price'],
      ['shop_url', 'shop_url'],
    ] as const) {
      if (hasValue(key)) setField(id, data[key])
    }
    for (const [key, prefix] of [
      ['extruder_temp_range_c', 'extruder_temp'],
      ['bed_temp_range_c', 'bed_temp'],
      ['cooling_fan_range_percent', 'cooling_fan'],
    ] as const) {
      if (hasValue(key)) setRange(prefix, data[key])
    }
    for (const key of ['ams_compatibility', 'build_plate_compatibility'] as const) {
      if (hasValue(key)) setField(key, Array.isArray(data[key]) ? data[key].join(', ') : data[key])
    }
    if (hasValue('is_discontinued')) input('is_discontinued').checked = !!data.is_discontinued
    if (hasValue('color_mode')) {
      colorModeRadios.forEach((radio) => { radio.checked = radio.value === (data.color_mode || 'single') })
      syncColorMode()
    }
    if (hasValue('multi_color_style')) setField('multi_color_style', data.multi_color_style)
    if (hasValue('colors') && Array.isArray(data.colors)) {
      selectedColorIds = [...data.colors]
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map(({ color_id }) => Number(color_id))
        .filter((id) => allColors.some((color) => color.id === id))
      renderSelectedColors()
      renderColorGrid()
    }
    if (hasValue('custom_fields') || hasValue('custom_field_definitions')) {
      const fields = data.custom_fields && typeof data.custom_fields === 'object' ? data.custom_fields : {}
      renderSystemFields(flattenObject(fields), fields)
      entityExtraFields.setData(fields, data.custom_field_definitions)
    }
    syncHeroPreview()
    updateDirtyState()
  }

  function collectPayload(): FilamentFormPayload {
    const formData = new FormData(form)
    let materialType = String(formData.get('type') || '')
    if (materialType === CUSTOM_TYPE_VALUE) materialType = String(formData.get('custom_type') || '').trim().toUpperCase()
    if (!materialType) throw new Error(t('filaments.customTypeLabel'))
    if (!selectedColorIds.length) throw new Error(t('filaments.colorRequired'))

    const colorMode = getColorMode()
    const scalar: Record<string, unknown> = {
      manufacturer_id: Number(formData.get('manufacturer_id')),
      designation: formData.get('designation'),
      material_type: materialType,
      diameter_mm: Number(formData.get('diameter_mm')),
      color_mode: colorMode,
    }
    const optionalText = [
      'material_subgroup', 'finish_type', 'manufacturer_color_name', 'spool_material', 'shop_url',
      'manufacturer_sku', 'datasheet_url', 'image_url',
    ]
    const optionalNumbers = [
      'raw_material_weight_g', 'default_spool_weight_g', 'spool_outer_diameter_mm', 'spool_width_mm',
      'price', 'density_g_cm3', 'drying_temp_c', 'drying_time_hours', 'softening_temp_c',
      'chamber_temp_c', 'max_volumetric_speed_mm3_s', 'flow_ratio', 'pressure_advance_k',
    ]
    for (const key of optionalText) {
      const value = String(formData.get(key) || '').trim()
      if (mode === 'edit' || value) scalar[key] = value || null
    }
    for (const key of optionalNumbers) {
      const value = String(formData.get(key) || '')
      if (mode === 'edit' || value) scalar[key] = value ? Number(value) : null
    }
    for (const [key, prefix] of [
      ['extruder_temp_range_c', 'extruder_temp'],
      ['bed_temp_range_c', 'bed_temp'],
      ['cooling_fan_range_percent', 'cooling_fan'],
    ] as const) {
      const value = rangeValue(prefix)
      if (mode === 'edit' || value !== null) scalar[key] = value
    }
    const priceCurrency = String(formData.get('price_currency') || '').trim().toUpperCase()
    if (mode === 'edit' || priceCurrency) scalar.price_currency = priceCurrency || null
    for (const key of ['ams_compatibility', 'build_plate_compatibility']) {
      const values = String(formData.get(key) || '').split(',').map((value) => value.trim()).filter(Boolean)
      if (mode === 'edit' || values.length) scalar[key] = values.length ? values : null
    }
    scalar.is_discontinued = formData.get('is_discontinued') === 'on'
    if (mode === 'edit' || colorMode === 'multi') {
      scalar.multi_color_style = colorMode === 'multi' ? formData.get('multi_color_style') || null : null
    }
    const extras = collectExtraFieldPayload(systemFieldsGrid, entityExtraFields)
    if (!extras) throw new Error(t('common.invalidValue'))
    scalar.custom_fields = extras.customFields
    scalar.custom_field_definitions = extras.customFieldDefinitions
    return {
      scalar,
      colors: selectedColorIds.map((colorId, index) => ({ color_id: colorId, position: index + 1 })),
    }
  }

  function setSubmitting(active: boolean): void {
    submitButton.disabled = active
    submitButton.textContent = active
      ? t(mode === 'create' ? 'common.creating' : 'common.saving')
      : t(mode === 'create' ? 'filaments.createFilament' : 'filaments.saveFilament')
  }

  function showError(message: string): void {
    errorMessage.textContent = message
    errorMessage.classList.remove('hidden')
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    errorMessage.classList.add('hidden')
    try {
      const payload = collectPayload()
      setSubmitting(true)
      await onSubmit(payload)
    } catch (error) {
      if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }
  form.addEventListener('submit', handleSubmit)

  return {
    loadReferenceData,
    applyInitialData,
    captureBaseline() {
      if (mode !== 'edit') return
      baseline = readSnapshot()
      updateDirtyState()
    },
    collectPayload,
    setSubmitting,
    showError,
    destroy() {
      if (destroyed) return
      destroyed = true
      form.removeEventListener('submit', handleSubmit)
      form.removeEventListener('input', handleDraftChange)
      form.removeEventListener('change', handleDraftChange)
      extraFieldObserver.disconnect()
      manufacturerDialog?.close()
      closeColorDialog()
      colorLauncher.removeEventListener('click', openColorDialog)
      byId<HTMLButtonElement>('filament-color-dialog-close').removeEventListener('click', closeColorDialog)
      byId<HTMLButtonElement>('filament-color-dialog-done').removeEventListener('click', closeColorDialog)
      colorDialog.removeEventListener('click', handleColorDialogClick)
      clearColorFilter()
      lookupContainer.replaceChildren()
      colorTooltip.remove()
    },
  }
}
