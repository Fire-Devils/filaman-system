import { getAbortSignal, isAbortError } from './abort'
import { changedNativeFields, setFormFieldValue } from './detail-edit'
import { CACHE_KEYS, cachedFetchAllPages, invalidateCachePrefix } from './cache'
import { normalizeHexCode, toColorSwatchBackground } from './colors'
import {
  collectExtraFieldPayload,
  createEntityExtraFieldEditor,
  getExtraFieldValue,
  prepareExtraFieldUpdate,
  type EntityExtraFieldPayload,
} from './entity-extra-fields'
import { collectSystemFieldValues, escapeHtml, parseNumericRangeInputs, isIntegrationExtraFieldPath, renderSystemFieldRow, type SystemExtraFieldDef } from './extra-fields'
import {
  bindFilamentDbLookupToManufacturer,
  checkFilamentDbActive,
  createFilamentDbLookup,
} from './filamentdb-lookup'
import { buildFilamentHeroStyle, buildFilamentSwatchStyle } from './filament-detail'
import { filamentSections, type FilamentField } from './filament-fields'
import { t } from './i18n'
import { createSpoolProfilePicker } from './filament-spool-profile'
import { bindInlineColorEditor } from './inline-color-editor'
import {
  ADD_MANUFACTURER_VALUE,
  bindManufacturerCreateOption,
  createManufacturerDialog,
  type Manufacturer,
  type ManufacturerDialog,
} from './manufacturer-dialog'
import {
  bindColorFilterButton,
  isColumnFilterActive,
  type ColorFilterValue,
} from './table-column-filters'

const CUSTOM_TYPE_VALUE = '__custom__'
const pluginFields = new Map<string, Pick<FilamentField, 'kind' | 'required' | 'options' | 'min' | 'max'>>(
  filamentSections.flatMap(section => section.fields)
    .filter(field => !['price', 'price_currency', 'is_discontinued'].includes(field.key))
    .map(field => [field.key, field]),
)
pluginFields.set('manufacturer_color_name', { kind: 'text' })
const pluginTextLimits: Record<string, number> = {
  designation: 255, material_type: 50, material_subgroup: 100, manufacturer_color_name: 255, manufacturer_sku: 255,
}
const rawPluginTextFields = ['material_subgroup', 'manufacturer_color_name'] as const
const spoolProfileFields = ['default_spool_weight_g', 'spool_material', 'spool_outer_diameter_mm', 'spool_width_mm']
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

const colorSnapshotKeys = ['color_mode', 'multi_color_style', 'colors']
function colorSnapshot({ scalar, colors }: FilamentFormPayload): string {
  return serialize([scalar.color_mode, scalar.multi_color_style, colors])
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesDraftValue(current: unknown, old: unknown): boolean {
  if (Array.isArray(current)) {
    return Array.isArray(old) && current.length === old.length && current.every((value, index) => value === old[index])
  }
  if (isRecord(current)) {
    return isRecord(old) && Object.keys(old).every(key => key === 'min' || key === 'max')
      && (current.min ?? null) === (old.min ?? null) && (current.max ?? null) === (old.max ?? null)
  }
  return current === old
}

function hasMaterialOption(select: HTMLSelectElement, value: unknown): boolean {
  return Array.from(select.options).some(option => option.value === value)
}

function isPluginFieldValue(key: string, value: unknown, form: HTMLFormElement): boolean {
  const field = pluginFields.get(key)
  if (!field) return false
  if (value === null) return !field.required
  const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    && (field.min == null || v >= field.min) && (field.max == null || v <= field.max)
  if (field.kind === 'number') {
    if (!isNumber(value) || (key === 'diameter_mm' && value <= 0)) return false
    const input = form.elements.namedItem(key) as HTMLInputElement
    const candidate = input.cloneNode() as HTMLInputElement
    candidate.value = String(value)
    return candidate.validity.valid
  }
  if (field.kind === 'range') {
    return isNumber(value) || (isRecord(value) && Object.keys(value).every(key => key === 'min' || key === 'max')
      && (value.min == null || isNumber(value.min)) && (value.max == null || isNumber(value.max))
      && (value.min != null || value.max != null)
      && (!isNumber(value.min) || !isNumber(value.max) || value.min <= value.max))
  }
  if (field.kind === 'list') return Array.isArray(value) && value.length <= 100
    && value.every(item => typeof item === 'string' && item.length <= 500)
  const textLimit = pluginTextLimits[key] ?? 500
  if (typeof value !== 'string' || !value.trim() || value.length > textLimit) return false
  if (field.kind === 'material') {
    const select = form.elements.namedItem('type') as HTMLSelectElement
    return value.trim() !== CUSTOM_TYPE_VALUE
      && (hasMaterialOption(select, value) || value.trim().toUpperCase().length <= textLimit)
  }
  if (field.kind === 'select') return field.options?.some(([option]) => option === value) ?? false
  if (field.kind === 'url') {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    } catch { return false }
  }
  return true
}

export function createFilamentFormController(options: {
  form: HTMLFormElement
  mode: FormMode
  onSubmit(payload: FilamentFormPayload): Promise<void>
  hasExternalChanges?: () => boolean
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
  const colorHint = byId<HTMLSpanElement>('color-hint')
  const colorSelectionTitle = byId<HTMLElement>('color-selection-title')
  const colorDialogPreview = byId<HTMLElement>('filament-color-dialog-preview')
  const colorLauncher = byId<HTMLButtonElement>('filament-color-launcher')
  const existingColorPicker = byId<HTMLElement>('existing-color-picker')
  const errorMessage = byId<HTMLDivElement>('error-message')
  const submitButton = form.elements.namedItem('submit-btn') as HTMLButtonElement
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
  colorDialog.appendChild(colorTooltip)
  let colorDialogInvoker: HTMLElement | null = null

  let allColors: Color[] = []
  let selectedColorIds: number[] = []
  let colorFilter: ColorFilterValue | null = null
  let matchingColorHexes: ReadonlySet<string> | null = null
  let matchingColorSource: Color[] | null = null
  let allManufacturers: Manufacturer[] = []
  let systemFields: SystemExtraFieldDef[] = []
  let addManufacturerOption: HTMLOptionElement | null = null
  let manufacturerDialog: ManufacturerDialog | null = null
  let referenceRequest = 0
  let lookupBound = false
  // The detail page reuses this controller after Cancel, while catalog work may still be pending.
  let catalogRequest = 0
  let newColorEditorOpen = false
  let destroyed = false
  let baseline: FormSnapshot | null = null
  let payloadBaseline: FilamentFormPayload | null = null
  let rawPluginTextBaseline: Record<string, string> = {}
  let colorBaseline: string | null = null
  let submittedSnapshot: FormSnapshot | null = null
  let extraFieldBaseline: EntityExtraFieldPayload = { customFields: null, customFieldDefinitions: null }
  let submitting = false
  let hasChanges = mode === 'create'
  let explicitMaterial = false
  let explicitDiameter = false
  submitButton.disabled = !hasChanges
  let spoolImageFile: string | null | undefined
  let spoolProfileId: number | null | undefined
  const spoolProfilePicker = form.querySelector('#filament-spool-profile')
    ? createSpoolProfilePicker(form, (id, image) => {
      spoolProfileId = id
      spoolImageFile = image
      updateDirtyState()
    }) : null

  const entityExtraFields = createEntityExtraFieldEditor({
    container: customFieldsContainer,
    addButton: byId('btn-add-field'),
    emptyText: t('filaments.noSpecificExtraFields'),
    onChange: updateDirtyState,
  })

  const dirtyWrappers = mode === 'edit'
    ? Array.from(form.querySelectorAll<HTMLElement>('[data-dirty-key]'))
    : []
  const dirtyMarkers = new Map<HTMLElement, HTMLElement>()
  for (const wrapper of dirtyWrappers) {
    const marker = document.createElement('span')
    marker.className = 'filament-dirty-indicator'
    marker.textContent = t('filaments.changed')
    marker.hidden = true
    const label = wrapper.querySelector<HTMLElement>(':scope > .fm-label, :scope > label.fm-label, :scope > h3.fm-label, :scope > div > .fm-label')
    const markerHost = wrapper.classList.contains('filament-form-check')
      ? wrapper.querySelector<HTMLElement>('span') || wrapper
      : label || wrapper
    markerHost.appendChild(marker)
    dirtyMarkers.set(wrapper, marker)
  }
  const unsavedStatus = form.ownerDocument.getElementById('unsaved-changes-status')
  const clearColorFilter = bindColorFilterButton(byId('color-filter-button'), (value, matchingHexes) => {
    colorFilter = value
    matchingColorHexes = matchingHexes || null
    matchingColorSource = allColors
    renderColorGrid()
  }, () => allColors.map(color => color.hex_code))

  const inlineColorEditor = bindInlineColorEditor({
    getAbortSignal,
    getCsrfToken: csrfToken,
    isAbortError,
    translate: t,
    onOpenChange(open) {
      newColorEditorOpen = open
      syncExistingColorPickerAvailability()
    },
    onCreated(newColor, isCurrentSession) {
      invalidateCachePrefix(CACHE_KEYS.COLORS)
      if (destroyed) return
      allColors.push(newColor)
      matchingColorSource = null
      if (isCurrentSession) toggleColor(newColor.id)
      else renderColorGrid()
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
    renderColorGrid()
    byId<HTMLButtonElement>('filament-color-dialog-close').focus()
  }

  function closeColorDialog(): void {
    if (!colorDialog.open) return
    inlineColorEditor.close()
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

  function listValue(id: string): string[] | null {
    const value = input(id).value.trim()
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
    } catch { /* Plain comma-separated text remains supported. */ }
    const values = value.split(',').map(item => item.trim()).filter(Boolean)
    return values.length ? values : null
  }

  function rangeValue(prefix: string): number | { min: number | null; max: number | null } | null {
    const startInput = input(`${prefix}_value`)
    const endInput = input(`${prefix}_to`)
    const value = parseNumericRangeInputs(startInput.value, endInput.value)
    if (value === null || typeof value === 'object') return value
    if (!startInput.value && endInput.value) return { min: null, max: value }
    if (startInput.dataset.openEndedRange === 'true' && !endInput.value) return { min: value, max: null }
    return value
  }

  function readSnapshot(): FormSnapshot {
    const systemValues = collectSystemFieldValues(systemFieldsGrid)
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
      ams_compatibility: serialize(listValue('ams_compatibility')),
      build_plate_compatibility: serialize(listValue('build_plate_compatibility')),
      is_discontinued: serialize(input('is_discontinued').checked),
      default_spool_weight_g: serialize(numberValue('default_spool_weight_g')),
      filamentdb_spool_image_file: serialize(spoolImageFile ?? null),
      filamentdb_spool_profile_id: serialize(spoolProfileId ?? null),
      spool_material: serialize(select('spool_material').value),
      spool_outer_diameter_mm: serialize(numberValue('spool_outer_diameter_mm')),
      spool_width_mm: serialize(numberValue('spool_width_mm')),
      price: serialize(numberValue('price')),
      shop_url: serialize(input('shop_url').value.trim()),
      system_fields: serialize(systemValues ?? fallbackExtraFields),
      entity_fields: entityExtraFields.getSnapshot(),
    }
  }

  function updateDirtyState(): void {
    if (!baseline || mode !== 'edit') return
    const current = readSnapshot()
    // Mode/style are also PATCH fields, even when their color PUT failed.
    const nativeChanges = changedNativeFields(payloadBaseline?.scalar ?? {}, {
      color_mode: getColorMode(),
      multi_color_style: getColorMode() === 'multi' ? select('multi_color_style').value || null : null,
    })
    let anyDirty = Object.keys(nativeChanges).length > 0 || baseline.filamentdb_spool_image_file !== current.filamentdb_spool_image_file || baseline.filamentdb_spool_profile_id !== current.filamentdb_spool_profile_id
    for (const wrapper of dirtyWrappers) {
      const keys = (wrapper.dataset.dirtyKey || '').split(/\s+/).filter(Boolean)
      const dirty = keys.some((key) => Object.hasOwn(nativeChanges, key) || baseline?.[key] !== current[key])
      wrapper.classList.toggle('is-dirty', dirty)
      dirtyMarkers.get(wrapper)!.hidden = !dirty
      anyDirty ||= dirty
    }
    colorLauncher.classList.toggle('is-dirty', [
      'manufacturer_color_name',
      'color_mode',
      'multi_color_style',
      'colors',
    ].some((key) => Object.hasOwn(nativeChanges, key) || baseline?.[key] !== current[key]))
    anyDirty ||= options.hasExternalChanges?.() ?? false
    unsavedStatus?.classList.toggle('hidden', !anyDirty)
    hasChanges = anyDirty
    submitButton.disabled = submitting || !hasChanges
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
    if (!colorDialog.open) return
    const focused = colorGrid.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : null
    const restoreFocus = () => {
      if (!focused || document.activeElement === focused) return
      const target = focused.isConnected ? focused : [...colorGrid.querySelectorAll<HTMLButtonElement>('button[data-color-id]')]
        .find(button => button.dataset.colorId === focused.dataset.colorId)
      ;(target || colorSearch).focus({ preventScroll: true })
    }
    colorFilterClear.disabled = !colorSearch.value.trim() && (!colorFilter || !isColumnFilterActive(colorFilter))
    if (matchingColorSource !== allColors) {
      matchingColorHexes = clearColorFilter.refresh()
      matchingColorSource = allColors
    }
    if (!allColors.length) {
      colorGrid.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">${t('filaments.noColorsAvailable')}</p>`
      restoreFocus()
      return
    }
    const query = colorSearch.value.trim().toLocaleLowerCase()
    const visible = allColors.filter((color) =>
      (!query || color.name.toLocaleLowerCase().includes(query))
      && (!colorFilter || !isColumnFilterActive(colorFilter) || matchingColorHexes?.has(normalizeHexCode(color.hex_code))))
    if (colorSortKey && colorSortDirection) {
      const direction = colorSortDirection === 'asc' ? 1 : -1
      visible.sort((left, right) => direction * (colorSortKey === 'hex'
        ? left.hex_code.localeCompare(right.hex_code) || left.name.localeCompare(right.name)
        : left.name.localeCompare(right.name) || left.hex_code.localeCompare(right.hex_code)))
    }
    if (!visible.length) {
      colorGrid.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">${t('filters.noMatchingOptions')}</p>`
      restoreFocus()
      return
    }
    const buttons = colorGrid.classList.contains('fm-color-list') === colorListToggle.checked
      ? new Map([...colorGrid.querySelectorAll<HTMLButtonElement>('button[data-color-id]')].map(button => [Number(button.dataset.colorId), button]))
      : new Map<number, HTMLButtonElement>()
    colorGrid.classList.toggle('fm-color-list', colorListToggle.checked)
    let next = colorGrid.firstElementChild
    const multi = getColorMode() === 'multi'
    for (const color of visible) {
      const label = `${color.name} (${color.hex_code})`
      let swatch = buttons.get(color.id)
      if (swatch?.getAttribute('aria-label') !== label) swatch = undefined
      const created = !swatch
      swatch ||= document.createElement('button')
      if (created) {
        swatch.type = 'button'
        swatch.dataset.colorId = String(color.id)
        swatch.setAttribute('aria-label', label)
      }
      const selected = selectedColorIds.includes(color.id) ? 'selected' : ''
      const order = multi ? selectedColorIds.indexOf(color.id) + 1 : 0
      const className = colorListToggle.checked ? `fm-color-choice ${selected}` : `fm-color-swatch ${selected}`
      if (swatch.className !== className) swatch.className = className
      if (created && colorListToggle.checked) {
        swatch.innerHTML = `
          <span class="fm-color-swatch ${selected}"${order ? ` data-order="${order}"` : ''} style="background:${toColorSwatchBackground(color.hex_code)}"></span>
          <span class="fm-color-choice-name">${escapeHtml(color.name)}</span>
          <span class="fm-color-choice-hex">${escapeHtml(color.hex_code)}</span>
        `
      } else if (created) swatch.style.background = toColorSwatchBackground(color.hex_code)
      const chip = colorListToggle.checked ? swatch.querySelector<HTMLElement>('.fm-color-swatch')! : swatch
      if (chip !== swatch && chip.classList.contains('selected') !== !!selected) chip.classList.toggle('selected', !!selected)
      const nextOrder = order ? String(order) : undefined
      if (chip.dataset.order !== nextOrder) {
        if (nextOrder) chip.dataset.order = nextOrder
        else delete chip.dataset.order
      }
      if (swatch === next) next = next.nextElementSibling
      else colorGrid.insertBefore(swatch, next)
    }
    while (next) {
      const remove = next
      next = next.nextElementSibling
      remove.remove()
    }
    restoreFocus()
  }

  const paletteButton = (event: Event) => event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('button[data-color-id]') : null
  const showPaletteTooltip = (event: Event) => {
    const button = paletteButton(event)
    if (!button || colorListToggle.checked || event instanceof MouseEvent && event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
    const rect = button.getBoundingClientRect()
    colorTooltip.textContent = button.getAttribute('aria-label')
    colorTooltip.style.left = `${rect.left + rect.width / 2}px`
    colorTooltip.style.top = `${rect.top - 6}px`
    colorTooltip.hidden = false
  }
  const hidePaletteTooltip = () => { colorTooltip.hidden = true }
  colorGrid.addEventListener('pointerover', showPaletteTooltip)
  colorGrid.addEventListener('focusin', showPaletteTooltip)
  colorGrid.addEventListener('pointerout', hidePaletteTooltip)
  colorGrid.addEventListener('focusout', hidePaletteTooltip)
  colorGrid.addEventListener('click', event => {
    const button = paletteButton(event)
    if (button) toggleColor(Number(button.dataset.colorId))
  })

  function toggleColor(colorId: number): void {
    const index = selectedColorIds.indexOf(colorId)
    const shouldClearFilter = index < 0 && isColumnFilterActive(colorFilter)
    if (index >= 0) selectedColorIds.splice(index, 1)
    else if (getColorMode() === 'single') selectedColorIds = [colorId]
    else selectedColorIds.push(colorId)
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

  let preserveDraftSpoolFields = false
  function applyManufacturerDefaults(): void {
    if (preserveDraftSpoolFields || manufacturerSelect.value === ADD_MANUFACTURER_VALUE) return
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
    // Initial data may replace these defaults before its saved link is restored.
    queueMicrotask(() => { if (!destroyed) spoolProfilePicker?.match() })
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
  const handleDraftChange = (event?: Event | MutationRecord[]) => {
    if (event instanceof Event && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
      const { name } = event.target
      if (name === 'type' || name === 'custom_type') explicitMaterial = true
      if (name === 'diameter_mm') explicitDiameter = true
      if (spoolProfileFields.includes(name)) spoolProfilePicker?.match()
    }
    syncHeroPreview()
    updateDirtyState()
  }
  form.addEventListener('input', handleDraftChange)
  form.addEventListener('change', handleDraftChange)

  function renderSystemFields(values: Record<string, unknown> = {}, raw?: Record<string, unknown>): void {
    if (!systemFields.length) {
      systemFieldsContainer.style.display = 'none'
      systemFieldsGrid.replaceChildren()
      return
    }
    systemFieldsContainer.style.display = 'block'
    systemFieldsGrid.innerHTML = systemFields.map(field => renderSystemFieldRow(field, raw ? getExtraFieldValue(raw, field.key) : null, values)).join('')
  }

  function showLookupToast(message: string, variant: 'success' | 'error' = 'success'): void {
    lookupToast.className = `fdb-toast fdb-toast-${variant}`
    lookupToast.textContent = message
    lookupToast.style.display = ''
  }

  function selectedManufacturerName(): string {
    return allManufacturers.find(({ id }) => id === Number(manufacturerSelect.value))?.name || ''
  }

  function bindCatalogLookup(): void {
    if (lookupBound) return
    lookupBound = true
    lookupHeading.textContent = t('filamentdbLookup.searchExistingFilament', { database: t('admin.filamentLookupFilaManDB') })
    lookupScopeHint.textContent = t('filamentdbLookup.selectManufacturerToSearch', { database: t('admin.filamentLookupFilaManDB') })
    manufacturerSelect.addEventListener('change', invalidateCatalogRequest)
    lookupSearchAll.addEventListener('change', invalidateCatalogRequest)
    bindFilamentDbLookupToManufacturer(manufacturerSelect, lookupSearchAll, lookupSection, (scopedToManufacturer) => {
      catalogRequest++
      lookupToast.style.display = 'none'
      return createFilamentDbLookup<any>({
        container: lookupContainer,
        endpoint: '/filamentdb/filaments',
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
          return `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;min-width:0"><div class="fdb-lookup-item-name">${escapeHtml(item.name || item.designation || '?')}</div><div class="fdb-lookup-item-sub">${details} ${colors}</div></div><span style="font-size:1.2rem;flex-shrink:0">&#x1F9F5;</span></div>`
        },
        async onSelect(item) {
          const request = ++catalogRequest
          const isCurrent = () => !destroyed && request === catalogRequest
          try {
            const response = await fetch('/api/v1/filamentdb/prepare-filament', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
              credentials: 'include',
              signal: getAbortSignal(),
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
                price: item.price ?? null,
                currency: item.currency || null,
                shop_url: item.shop_url || null,
                color_mode: (item.colors || []).length > 1 ? 'multi' : 'single',
                multi_color_style: item.multi_color_style || null,
                colors: (item.colors || []).map((color: any, index: number) => ({
                  hex_code: color.hex_code || '',
                  color_name: color.color_name || color.name || '',
                  position: color.position || index + 1,
                })),
                spool_profile_empty_weight_g: item.spool_profile?.empty_weight_g ?? null,
                spool_profile_outer_diameter_mm: item.spool_profile?.outer_diameter_mm || null,
                spool_profile_width_mm: item.spool_profile?.width_mm || null,
                spool_profile_material: item.spool_profile?.spool_material || null,
                spool_profile_image_file: item.spool_profile?.image_file ?? null,
                spool_profile_id: item.spool_profile?.id ?? null,
              }),
            })
            const result = await response.json()
            // Prepared colors are committed server-side even when this edit was canceled.
            if (response.ok && result.colors_created > 0) invalidateCachePrefix(CACHE_KEYS.COLORS)
            if (!isCurrent()) return
            if (!response.ok) throw new Error(result.detail?.message || t('filamentdbLookup.prefillError'))
            const prefilled = result.prefilled || {}
            if (result.colors_created > 0 || prefilled.color_ids?.some((id: number) => !allColors.some(color => color.id === id))) {
              invalidateCachePrefix(CACHE_KEYS.COLORS)
              await loadColors(isCurrent)
              if (!isCurrent()) return
            }
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
              preserveDraftSpoolFields = true
              try {
                manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
              } finally {
                preserveDraftSpoolFields = false
              }
            }
            if (item.diameter_mm == null) delete catalogData.diameter_mm
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
            if (!isCurrent() || isAbortError(error)) return
            showLookupToast(error instanceof Error ? error.message : t('filamentdbLookup.prefillError'), 'error')
          }
        },
      })
    })
  }

  async function loadColors(isCurrent = () => !destroyed): Promise<void> {
    const data = await cachedFetchAllPages<Color>(CACHE_KEYS.COLORS, '/api/v1/colors')
    if (!isCurrent()) return
    allColors = data.items
    renderColorGrid()
  }

  function invalidateCatalogRequest(): void { catalogRequest++ }

  function reconcileManufacturer(manufacturer: Manufacturer): HTMLOptionElement {
    const index = allManufacturers.findIndex(({ id }) => id === manufacturer.id)
    if (index >= 0) allManufacturers[index] = { ...allManufacturers[index], ...manufacturer }
    else allManufacturers.push(manufacturer)
    let option = Array.from(manufacturerSelect.options).find(({ value }) => value === String(manufacturer.id))
    if (!option) {
      option = document.createElement('option')
      option.value = String(manufacturer.id)
      manufacturerSelect.insertBefore(option, addManufacturerOption)
    }
    option.textContent = manufacturer.name || t('common.unknown')
    return option
  }

  async function loadReferenceData(isCurrent = () => true): Promise<SystemExtraFieldDef[] | undefined> {
    const request = ++referenceRequest
    const filamentDbActive = await checkFilamentDbActive()
    let lookupSource = 'filamandb'
    try {
      const response = await fetch('/api/v1/app-settings/public-info', {
        credentials: 'include',
        signal: getAbortSignal(),
      })
      if (response.ok) {
        const settings = await response.json()
        lookupSource = settings.filament_lookup_source ?? 'filamandb'
      }
    } catch (error) {
      if (!isAbortError(error)) console.error('Failed to load filament lookup source:', error)
    }

    // Failed edit entry retries this controller; install controls only after required reads succeed.
    const manufacturers = await cachedFetchAllPages<Manufacturer>(CACHE_KEYS.MANUFACTURERS, '/api/v1/manufacturers')
    const typesResponse = await fetch('/api/v1/filaments/types', {
      credentials: 'include',
      signal: getAbortSignal(),
    })
    const types = typesResponse.ok
      ? await typesResponse.json() as string[]
      : ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'NYLON', 'PC']
    const colors = await cachedFetchAllPages<Color>(CACHE_KEYS.COLORS, '/api/v1/colors')
    const systemFieldsResponse = await fetch('/api/v1/system-extra-fields?target_type=filament', {
      credentials: 'include',
      signal: getAbortSignal(),
    })
    if (!systemFieldsResponse.ok) throw new Error(t('common.systemFieldsUnavailable'))
    const definitions: SystemExtraFieldDef[] = await systemFieldsResponse.json()
    if (destroyed || request !== referenceRequest || !isCurrent()) return

    if (!manufacturerDialog) {
      manufacturerDialog = createManufacturerDialog({
        filamentDbActive,
        onSaved(manufacturer, isCurrentSession) {
          if (destroyed) return
          const option = reconcileManufacturer(manufacturer)
          if (!isCurrentSession) return
          manufacturerSelect.value = option.value
          manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
        },
      })
      addManufacturerOption = bindManufacturerCreateOption(manufacturerSelect, () => manufacturerDialog?.open())
    }
    // Apply the complete reference snapshot only after every required read succeeds.
    systemFields = definitions.filter(field => !isIntegrationExtraFieldPath(field.key))
    allColors = colors.items
    renderColorGrid()
    for (const option of Array.from(manufacturerSelect.options)) {
      if (option.value && option !== addManufacturerOption) option.remove()
    }
    allManufacturers = manufacturers.items
    for (const manufacturer of allManufacturers) reconcileManufacturer(manufacturer)

    typeSelect.replaceChildren()
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

    entityExtraFields.setSystemFieldKeys(systemFields.map(field => field.key))
    renderSystemFields()

    if (lookupSource === 'filamandb' && filamentDbActive) bindCatalogLookup()
    if (filamentDbActive) void spoolProfilePicker?.load()
    return definitions
  }

  function setField(id: string, value: unknown): void {
    setFormFieldValue(byId<HTMLInputElement | HTMLSelectElement>(id), value)
  }

  function setRange(prefix: string, value: unknown): void {
    const range = value && typeof value === 'object' && !Array.isArray(value)
      ? value as { min?: unknown; max?: unknown }
      : { min: value, max: value }
    const startInput = input(`${prefix}_value`)
    startInput.dataset.openEndedRange = String(range.min != null && range.max == null)
    setField(`${prefix}_value`, range.min)
    if (range.min == null || range.max == null) {
      setField(`${prefix}_to`, range.max)
      return
    }
    setField(`${prefix}_to`, range.min !== range.max ? range.max : null)
  }

  function applyInitialData(data: InitialData, source: 'initial' | 'duplicate' | 'catalog' | 'plugin' = 'initial'): void {
    if (Object.hasOwn(data, 'filamentdb_spool_image_file')) spoolImageFile = data.filamentdb_spool_image_file ?? null
    if (Object.hasOwn(data, 'filamentdb_spool_profile_id')) spoolProfileId = data.filamentdb_spool_profile_id ?? null
    const hasValue = (key: string): boolean => {
      if (!Object.hasOwn(data, key)) return false
      if (source !== 'catalog') return true
      const value = data[key]
      return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)
    }
    if (source !== 'catalog' && hasValue('manufacturer_id') && data.manufacturer_id != null) {
      if (data.manufacturer?.id === data.manufacturer_id) reconcileManufacturer(data.manufacturer)
      setField('manufacturer_id', data.manufacturer_id)
      manufacturerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (hasValue('designation')) setField('designation', data.designation)
    if (hasValue('material_type') && data.material_type) {
      explicitMaterial = true
      if (hasMaterialOption(typeSelect, data.material_type)) {
        typeSelect.value = data.material_type
      } else {
        typeSelect.value = CUSTOM_TYPE_VALUE
        customTypeInput.value = String(data.material_type).toUpperCase()
      }
      syncType(false)
    }
    if (hasValue('diameter_mm')) explicitDiameter = true
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
      if (!hasValue(key)) continue
      const value = data[key]
      const simpleCsv = Array.isArray(value) && value.length > 0
        && value.every(item => typeof item === 'string' && item !== '' && item === item.trim() && !/[,\r\n]/.test(item))
        && !value[0].startsWith('[')
      setField(key, Array.isArray(value) ? simpleCsv ? value.join(', ') : JSON.stringify(value) : value)
    }
    if (hasValue('is_discontinued')) input('is_discontinued').checked = !!data.is_discontinued
    if (hasValue('color_mode')) {
      colorModeRadios.forEach((radio) => { radio.checked = radio.value === (data.color_mode || 'single') })
      syncColorMode()
    }
    if (hasValue('multi_color_style')) setField('multi_color_style', data.multi_color_style || 'striped')
    if (hasValue('colors') && Array.isArray(data.colors)) {
      matchingColorSource = null
      for (const { color } of data.colors) {
        if (!color) continue
        const index = allColors.findIndex(({ id }) => id === color.id)
        if (index >= 0) allColors[index] = { ...allColors[index], ...color }
        else allColors.push(color)
      }
      selectedColorIds = [...data.colors]
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map(({ color_id }) => Number(color_id))
      renderColorGrid()
    }
    if (hasValue('custom_fields') || hasValue('custom_field_definitions')) {
      const fields = data.custom_fields && typeof data.custom_fields === 'object' ? data.custom_fields : {}
      renderSystemFields(flattenObject(fields), fields)
      entityExtraFields.setData(fields, data.custom_field_definitions)
    }
    if (source !== 'plugin') {
      spoolProfilePicker?.setLink(spoolProfileId ?? null, spoolImageFile ?? null)
      if (mode === 'create' || source === 'catalog') spoolProfilePicker?.match()
    } else if (spoolProfileFields.some(hasValue)) {
      spoolProfilePicker?.match()
    }
    syncHeroPreview()
    updateDirtyState()
  }

  function collectPayload(validate = true): FilamentFormPayload {
    const formData = new FormData(form)
    let materialType = String(formData.get('type') || '')
    if (materialType === CUSTOM_TYPE_VALUE) materialType = String(formData.get('custom_type') || '').trim().toUpperCase()
    if (validate && !materialType) throw new Error(t('filaments.customTypeLabel'))
    if (validate && !selectedColorIds.length) throw new Error(t('filaments.colorRequired'))

    const colorMode = getColorMode()
    const scalar: Record<string, unknown> = {
      manufacturer_id: Number(formData.get('manufacturer_id')),
      designation: formData.get('designation'),
      material_type: materialType,
      diameter_mm: Number(formData.get('diameter_mm')),
      color_mode: colorMode,
    }
    if (spoolImageFile !== undefined) scalar.filamentdb_spool_image_file = spoolImageFile
    if (spoolProfileId !== undefined) scalar.filamentdb_spool_profile_id = spoolProfileId
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
      const values = listValue(key)
      if (mode === 'edit' || values !== null) scalar[key] = values
    }
    scalar.is_discontinued = formData.get('is_discontinued') === 'on'
    if (mode === 'edit' || colorMode === 'multi') {
      scalar.multi_color_style = colorMode === 'multi' ? formData.get('multi_color_style') || null : null
    }
    const extras = validate ? collectExtraFieldPayload(systemFieldsGrid, entityExtraFields) : extraFieldBaseline
    if (!extras) throw new Error(t('common.invalidValue'))
    scalar.custom_fields = extras.customFields
    scalar.custom_field_definitions = extras.customFieldDefinitions
    return {
      scalar,
      colors: selectedColorIds.map((colorId, index) => ({ color_id: colorId, position: index + 1 })),
    }
  }

  function readPluginDraft(): Record<string, unknown> {
    const { scalar } = collectPayload(false)
    const colorId = getColorMode() === 'single' ? selectedColorIds[0] ?? null : null
    return {
      ...Object.fromEntries([...pluginFields.keys()].map(key => [key, scalar[key] ?? null])),
      ...Object.fromEntries(rawPluginTextFields.map(key => [key, input(key).value || null])),
      material_type: mode === 'create' && !explicitMaterial ? null : scalar.material_type || null,
      diameter_mm: mode === 'create' && !explicitDiameter ? null : numberValue('diameter_mm'),
      manufacturer_id: scalar.manufacturer_id || null,
      manufacturer_name: selectedManufacturerName() || null,
      color_mode: getColorMode(),
      color_id: colorId,
      palette_color_name: allColors.find(color => color.id === colorId)?.name ?? null,
    }
  }

  function stagePluginDraft(units: unknown, draft: Record<string, unknown>) {
    const staged: string[] = []
    const skipped: string[] = []
    if (!Array.isArray(units) || units.length > 50) return { staged, skipped }
    const current = readPluginDraft()
    const sameDraft = serialize(draft) === serialize(current) && !submitting && !destroyed
    const values: InitialData = {}
    for (const unit of units) {
      if (!isRecord(unit)) continue
      const changes = Object.entries(unit)
      if (!changes.length || changes.length > pluginFields.size + 2) continue
      const valid = sameDraft && changes.every(([key, change]) => {
        if (!Object.hasOwn(current, key) || Object.hasOwn(values, key) || !isRecord(change)
          || !Object.hasOwn(change, 'old') || !Object.hasOwn(change, 'value')
          || !matchesDraftValue(current[key], change.old)) return false
        if (key === 'manufacturer_id') return mode === 'create' && allManufacturers.some(item => item.id === change.value)
        if (key === 'color_id') return mode === 'create' && getColorMode() === 'single'
          && allColors.some(item => item.id === change.value)
        return isPluginFieldValue(key, change.value, form)
      })
      if (!valid) {
        skipped.push(...changes.map(([key]) => key))
        continue
      }
      for (const [key, change] of changes) {
        values[key] = (change as { value: unknown }).value
        staged.push(key)
      }
    }
    if (!staged.length) return { staged, skipped }

    // Use the raw baseline for an explicitly selected formatting-only change.
    for (const key of rawPluginTextFields) {
      const raw = rawPluginTextBaseline[key]
      if (baseline && payloadBaseline && raw && raw !== raw.trim() && Object.hasOwn(values, key) && values[key] !== raw) {
        baseline[key] = serialize(raw)
        payloadBaseline.scalar[key] = raw
      }
    }
    if (Object.hasOwn(values, 'color_id')) values.colors = [{ color_id: values.color_id, position: 1 }]
    preserveDraftSpoolFields = true
    try {
      applyInitialData(values, 'plugin')
    } finally {
      preserveDraftSpoolFields = false
    }
    return { staged, skipped }
  }

  function setSubmitting(active: boolean): void {
    submitting = active
    submitButton.disabled = active || !hasChanges
    submitButton.textContent = active
      ? t(mode === 'create' ? 'common.creating' : 'common.saving')
      : t(mode === 'create' ? 'filaments.createFilament' : 'common.save')
  }

  function showError(message: string): void {
    errorMessage.textContent = message
    errorMessage.classList.remove('hidden')
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (submitting || !hasChanges) return
    errorMessage.classList.add('hidden')
    try {
      const payload = structuredClone(collectPayload())
      submittedSnapshot = readSnapshot()
      setSubmitting(true)
      await onSubmit(payload)
    } catch (error) {
      if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error))
    } finally {
      submittedSnapshot = null
      setSubmitting(false)
    }
  }
  form.addEventListener('submit', handleSubmit)

  return {
    readPluginDraft,
    stagePluginDraft,
    loadReferenceData,
    applyInitialData,
    resetInitialData(data: InitialData) {
      catalogRequest++
      manufacturerDialog?.close()
      closeColorDialog()
      inlineColorEditor.close()
      baseline = null
      payloadBaseline = null
      colorBaseline = null
      extraFieldBaseline = { customFields: data.custom_fields ?? null, customFieldDefinitions: data.custom_field_definitions ?? null }
      const listView = colorListToggle.checked
      form.reset()
      explicitMaterial = false
      explicitDiameter = false
      colorListToggle.checked = listView
      spoolImageFile = undefined
      spoolProfileId = undefined
      for (const prefix of ['extruder_temp', 'bed_temp', 'cooling_fan']) setRange(prefix, null)
      applyInitialData({ colors: [], color_mode: 'single', custom_fields: {}, custom_field_definitions: {}, ...data }, 'initial')
    },
    captureBaseline() {
      if (mode !== 'edit') return
      extraFieldBaseline = collectExtraFieldPayload(systemFieldsGrid, entityExtraFields) ?? extraFieldBaseline
      baseline = readSnapshot()
      payloadBaseline = collectPayload(false)
      rawPluginTextBaseline = Object.fromEntries(rawPluginTextFields.map(key => [key, input(key).value]))
      colorBaseline = colorSnapshot(payloadBaseline)
      spoolProfilePicker?.match()
      updateDirtyState()
    },
    prepareExtraFieldUpdate(path: string, scalar: Record<string, unknown>) {
      return prepareExtraFieldUpdate(path, extraFieldBaseline, {
        customFields: scalar.custom_fields as EntityExtraFieldPayload['customFields'],
        customFieldDefinitions: scalar.custom_field_definitions as EntityExtraFieldPayload['customFieldDefinitions'],
      })
    },
    prepareNativeFieldUpdate(scalar: Record<string, unknown>) {
      return changedNativeFields(payloadBaseline?.scalar ?? {}, scalar)
    },
    hasColorChanges(payload: FilamentFormPayload) {
      return colorSnapshot(payload) !== colorBaseline
    },
    acceptNativeUpdate(scalar: Record<string, unknown>) {
      if (!payloadBaseline || !baseline || !submittedSnapshot) return
      payloadBaseline.scalar = structuredClone(scalar)
      rawPluginTextBaseline = Object.fromEntries(rawPluginTextFields.map(key => [key, String(scalar[key] ?? '')]))
      extraFieldBaseline = {
        customFields: payloadBaseline.scalar.custom_fields as EntityExtraFieldPayload['customFields'],
        customFieldDefinitions: payloadBaseline.scalar.custom_field_definitions as EntityExtraFieldPayload['customFieldDefinitions'],
      }
      for (const [key, value] of Object.entries(submittedSnapshot)) {
        if (!colorSnapshotKeys.includes(key)) baseline[key] = value
      }
      updateDirtyState()
    },
    acceptColorUpdate(payload: FilamentFormPayload) {
      if (!baseline || !submittedSnapshot) return
      colorBaseline = colorSnapshot(payload)
      for (const key of colorSnapshotKeys) baseline[key] = submittedSnapshot[key]
      updateDirtyState()
    },
    collectPayload,
    updateDirtyState,
    setSubmitting,
    showError,
    destroy() {
      if (destroyed) return
      destroyed = true
      catalogRequest++
      referenceRequest++
      form.removeEventListener('submit', handleSubmit)
      form.removeEventListener('input', handleDraftChange)
      form.removeEventListener('change', handleDraftChange)
      spoolProfilePicker?.destroy()
      manufacturerDialog?.close()
      closeColorDialog()
      inlineColorEditor.close()
      colorLauncher.removeEventListener('click', openColorDialog)
      byId<HTMLButtonElement>('filament-color-dialog-close').removeEventListener('click', closeColorDialog)
      byId<HTMLButtonElement>('filament-color-dialog-done').removeEventListener('click', closeColorDialog)
      colorDialog.removeEventListener('click', handleColorDialogClick)
      manufacturerSelect.removeEventListener('change', invalidateCatalogRequest)
      lookupSearchAll.removeEventListener('change', invalidateCatalogRequest)
      clearColorFilter()
      lookupContainer.replaceChildren()
      colorTooltip.remove()
    },
  }
}
