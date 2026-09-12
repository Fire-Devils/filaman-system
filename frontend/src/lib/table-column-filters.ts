import { t } from './i18n'
import { normalizeHexCode, toColorSwatchBackground, toOpaqueRgbHex } from './colors'
import type { SystemExtraFieldDef } from './extra-fields'

export type HeaderFilterOption = {
  value: string
  label: string
  colorHexes?: string[]
}

export type TextFilterOperator = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'notContains' | 'isEmpty' | 'isNotEmpty'
export type NumberFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'isEmpty' | 'isNotEmpty'
export type DateFilterOperator = 'on' | 'before' | 'after' | 'between' | 'isEmpty' | 'isNotEmpty'
export type ColorNeutral = 'black' | 'white' | 'grey'
export type ColorFilterMode = 'none' | 'color' | ColorNeutral
export type ColorFilterValue = {
  type: 'color'
  mode: ColorFilterMode
  hueFrom: number
  hueTo: number
  saturationFrom: number
  saturationTo: number
  valueFrom: number
  valueTo: number
  valuePreview: number
  neutralSaturationTo?: number
  neutralValueFrom?: number
  neutralValueTo?: number
  includeTransparent: boolean
}

export type ColumnFilterValue =
  | { type: 'multi'; values: string[] }
  | { type: 'text'; operator: TextFilterOperator; value: string }
  | { type: 'number'; operator: NumberFilterOperator; value: string; valueTo: string }
  | { type: 'date'; operator: DateFilterOperator; value: string; valueTo: string }
  | ColorFilterValue

export type HeaderFilterDefinition = {
  key: string
  label: string
  columnSelector: string
  type: ColumnFilterValue['type']
  multiDisplay?: 'default' | 'colors'
  searchable?: boolean
  autocomplete?: boolean
  icon?: 'filter' | 'gear'
  disclosureOf?: string
  disclosureStorageKey?: string
  options?: HeaderFilterOption[]
  initialValue?: ColumnFilterValue
  onApply: (value: ColumnFilterValue) => void
}

export type HeaderFilterController = {
  setOptions: (key: string, options: HeaderFilterOption[]) => void
  setValue: (key: string, value: ColumnFilterValue) => void
  getValue: (key: string) => ColumnFilterValue | null
  getActiveCount: () => number
  resetAll: () => void
}

export type SortDirection = 'asc' | 'desc' | null

export type TableFilterControlOptions = {
  onApply: () => void
  onClearColumns: () => void
  onClearAll: () => void
  debounceMs?: number
}

type FilterState = {
  def: HeaderFilterDefinition
  options: HeaderFilterOption[]
  applied: ColumnFilterValue
  working: ColumnFilterValue
  optionSearch: string
  optionView: 'details' | 'swatches'
  colorPreset: ColorPreset
  appliedColorPreset: ColorPreset
  trigger: HTMLElement
  panel: HTMLDivElement
  parentState: FilterState | null
  linkedStates: FilterState[]
  list: HTMLDivElement | null
  optionSearchInput: HTMLInputElement | null
  operatorSelect: HTMLSelectElement | null
  valueInput: HTMLInputElement | null
  valueToInput: HTMLInputElement | null
  suggestionList: HTMLDataListElement | null
  candidateColor: ColorFilterValue | null
  colorDisclosure: HTMLDetailsElement | null
}

const FILTER_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
  </svg>
`

const GEAR_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
`

const RESET_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6v5h-5" />
    <path d="M19 11a8 8 0 1 0 1 5" />
  </svg>
`

const EYE_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
`

const SORT_ICON = `
  <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <g class="fm-header-sort-icon-neutral">
      <path d="M8 18V6m0 0-4 4m4-4 4 4" />
      <path d="M16 6v12m0 0-4-4m4 4 4-4" />
    </g>
    <g class="fm-header-sort-icon-asc">
      <path d="M12 19V5m0 0-5 5m5-5 5 5" />
    </g>
    <g class="fm-header-sort-icon-desc">
      <path d="M12 5v14m0 0-5-5m5 5 5-5" />
    </g>
  </svg>
`

const TEXT_OPERATORS: { value: TextFilterOperator; labelKey: string }[] = [
  { value: 'contains', labelKey: 'filters.contains' },
  { value: 'equals', labelKey: 'filters.equals' },
  { value: 'startsWith', labelKey: 'filters.startsWith' },
  { value: 'endsWith', labelKey: 'filters.endsWith' },
  { value: 'notContains', labelKey: 'filters.notContains' },
  { value: 'isEmpty', labelKey: 'filters.isEmpty' },
  { value: 'isNotEmpty', labelKey: 'filters.isNotEmpty' },
]

const NUMBER_OPERATORS: { value: NumberFilterOperator; labelKey: string }[] = [
  { value: 'eq', labelKey: 'filters.equals' },
  { value: 'neq', labelKey: 'filters.notEquals' },
  { value: 'gt', labelKey: 'filters.greaterThan' },
  { value: 'gte', labelKey: 'filters.atLeast' },
  { value: 'lt', labelKey: 'filters.lessThan' },
  { value: 'lte', labelKey: 'filters.atMost' },
  { value: 'between', labelKey: 'filters.between' },
  { value: 'isEmpty', labelKey: 'filters.isEmpty' },
  { value: 'isNotEmpty', labelKey: 'filters.isNotEmpty' },
]

const DATE_OPERATORS: { value: DateFilterOperator; labelKey: string }[] = [
  { value: 'on', labelKey: 'filters.on' },
  { value: 'before', labelKey: 'filters.before' },
  { value: 'after', labelKey: 'filters.after' },
  { value: 'between', labelKey: 'filters.between' },
  { value: 'isEmpty', labelKey: 'filters.isEmpty' },
  { value: 'isNotEmpty', labelKey: 'filters.isNotEmpty' },
]

const COLOR_NEUTRAL_PRESETS = {
  black: { saturationTo: 20, valueFrom: 0, valueTo: 15 },
  white: { saturationTo: 10, valueFrom: 85, valueTo: 100 },
  grey: { saturationTo: 10, valueFrom: 35, valueTo: 65 },
} satisfies Record<ColorNeutral, { saturationTo: number; valueFrom: number; valueTo: number }>

const COLOR_CHROMATIC_PRESETS = [
  { key: 'red', hueFrom: 320, hueTo: 15, swatch: '#ef4444' },
  { key: 'orange', hueFrom: 15, hueTo: 45, swatch: '#f97316' },
  { key: 'yellow', hueFrom: 45, hueTo: 90, swatch: '#eab308' },
  { key: 'green', hueFrom: 90, hueTo: 180, swatch: '#22c55e' },
  { key: 'blue', hueFrom: 180, hueTo: 250, swatch: '#3b82f6' },
  { key: 'indigo', hueFrom: 250, hueTo: 270, swatch: '#4f46e5' },
  { key: 'violet', hueFrom: 270, hueTo: 320, swatch: '#8b5cf6' },
] as const

type ColorPreset = 'color' | ColorNeutral | typeof COLOR_CHROMATIC_PRESETS[number]['key']

function colorDefaults(mode: 'none' | 'color' = 'none'): ColorFilterValue {
  return { type: 'color', mode, hueFrom: 10, hueTo: 45, saturationFrom: 10, saturationTo: 100, valueFrom: 16, valueTo: 100, valuePreview: 100, includeTransparent: false }
}

function colorPresetFor(value: ColumnFilterValue): ColorPreset {
  if (value.type !== 'color' || value.mode === 'none') return 'color'
  if (value.mode !== 'color') return value.mode
  return COLOR_CHROMATIC_PRESETS.find((preset) => preset.hueFrom === value.hueFrom && preset.hueTo === value.hueTo)?.key || 'color'
}

function colorNeutralPreset(mode: ColorFilterMode) {
  return mode === 'black' || mode === 'white' || mode === 'grey'
    ? COLOR_NEUTRAL_PRESETS[mode]
    : undefined
}

function colorNeutralRange(value: ColorFilterValue): [number, number] {
  const preset = colorNeutralPreset(value.mode)
  if (!preset) return [value.valueFrom, value.valueTo]
  const from = Number.isFinite(value.neutralValueFrom) ? value.neutralValueFrom! : preset.valueFrom
  const to = Number.isFinite(value.neutralValueTo) ? value.neutralValueTo! : preset.valueTo
  return [Math.min(from, to), Math.max(from, to)]
}

function colorNeutralSaturation(value: ColorFilterValue) {
  const preset = colorNeutralPreset(value.mode)
  if (!preset) return value.saturationTo
  const saturation = Number.isFinite(value.neutralSaturationTo)
    ? value.neutralSaturationTo!
    : preset.saturationTo
  return Math.max(0, Math.min(100, saturation))
}

let nextPanelId = 0

export function emptyColumnFilter(type: ColumnFilterValue['type']): ColumnFilterValue {
  if (type === 'multi') return { type, values: [] }
  if (type === 'text') return { type, operator: 'contains', value: '' }
  if (type === 'number') return { type, operator: 'eq', value: '', valueTo: '' }
  if (type === 'color') return colorDefaults()
  return { type, operator: 'on', value: '', valueTo: '' }
}

export function multiColumnFilter(values: string[]): ColumnFilterValue {
  return { type: 'multi', values: [...values] }
}

export function systemExtraFieldFilterType(
  fieldType: string | null | undefined,
): ColumnFilterValue['type'] {
  if (fieldType === 'number' || fieldType === 'float') return 'number'
  if (fieldType === 'date') return 'date'
  if (fieldType === 'dropdown' || fieldType === 'multiselect' || fieldType === 'checkbox') return 'multi'
  return 'text'
}

export function systemExtraFieldFilterValue(
  field: SystemExtraFieldDef,
  rawValue: unknown,
): unknown {
  if (field.field_type === 'checkbox') {
    return rawValue === true || rawValue === 'true' ? 'true' : 'false'
  }
  if (field.field_type === 'range' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    const range = rawValue as Record<string, unknown>
    return [range.min, range.max]
      .filter((value) => value !== null && value !== undefined && value !== '')
      .map(String)
      .join(' – ')
  }
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return JSON.stringify(rawValue)
  }
  return rawValue
}

export function systemExtraFieldHeaderFilter(
  field: SystemExtraFieldDef,
  initialValue: ColumnFilterValue | undefined,
  onApply: (value: ColumnFilterValue) => void,
): HeaderFilterDefinition {
  const key = `cf_${field.key}`
  const type = systemExtraFieldFilterType(field.field_type)
  let options: HeaderFilterOption[] | undefined
  if (field.field_type === 'checkbox') {
    options = [
      { value: 'true', label: t('common.yes') },
      { value: 'false', label: t('common.no') },
    ]
  } else if (type === 'multi') {
    options = [
      { value: '', label: t('common.empty') },
      ...(field.options ?? []).map((option) => ({ value: option, label: option })),
    ]
  }
  return {
    key,
    label: field.label,
    columnSelector: `th.col-${key}`,
    type,
    options,
    initialValue,
    onApply,
  }
}

export function isColumnFilterActive(value: ColumnFilterValue | null | undefined): boolean {
  if (!value) return false
  if (value.type === 'multi') return value.values.length > 0
  if (value.type === 'color') return value.mode !== 'none' || value.includeTransparent
  if (value.operator === 'isEmpty' || value.operator === 'isNotEmpty') return true
  if (value.operator === 'between') return value.value !== '' && value.valueTo !== ''
  return value.value !== ''
}

export function sanitizeColumnFilters(
  saved: unknown,
  definitions: Array<Pick<HeaderFilterDefinition, 'key' | 'type'>>,
): Record<string, ColumnFilterValue> {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const types = new Map(definitions.map(({ key, type }) => [key, type]))
  const sanitized: Record<string, ColumnFilterValue> = {}

  Object.entries(saved).forEach(([key, candidate]) => {
    const type = types.get(key)
    if (!type || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const value = candidate as Partial<ColumnFilterValue>
    if (value.type !== type) return
    if (type === 'multi' && (!('values' in value) || !Array.isArray(value.values) || !value.values.every(item => typeof item === 'string'))) return
    if (type === 'color') {
      const color = value as Partial<ColorFilterValue>
      const numbers = [
        color.hueFrom,
        color.hueTo,
        color.saturationFrom,
        color.saturationTo,
        color.valueFrom,
        color.valueTo,
        color.valuePreview,
      ]
      if (!['none', 'color', 'black', 'white', 'grey'].includes(String(color.mode))
        || typeof color.includeTransparent !== 'boolean' || !numbers.every(Number.isFinite)) return
    }
    if (type !== 'multi' && type !== 'color' && (!('operator' in value) || !('value' in value) || typeof value.value !== 'string')) return
    const savedOperator = (value as { operator?: unknown }).operator
    if (type === 'text' && !TEXT_OPERATORS.some(({ value: operator }) => operator === savedOperator)) return
    if (type === 'number' && !NUMBER_OPERATORS.some(({ value: operator }) => operator === savedOperator)) return
    if (type === 'date' && !DATE_OPERATORS.some(({ value: operator }) => operator === savedOperator)) return
    if ((type === 'number' || type === 'date') && (!('valueTo' in value) || typeof value.valueTo !== 'string')) return
    if (isColumnFilterActive(value as ColumnFilterValue)) sanitized[key] = cloneFilter(value as ColumnFilterValue)
  })

  return sanitized
}

export function bindTableFilterControls({
  onApply,
  onClearColumns,
  onClearAll,
  debounceMs = 250,
}: TableFilterControlOptions): void {
  let searchTimeout: ReturnType<typeof setTimeout> | null = null
  const cancelSearchDebounce = () => {
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = null
  }

  document.getElementById('filter-search')?.addEventListener('input', () => {
    cancelSearchDebounce()
    searchTimeout = setTimeout(onApply, debounceMs)
  })
  document.getElementById('filter-search-clear')?.addEventListener('click', () => {
    cancelSearchDebounce()
    const search = document.getElementById('filter-search') as HTMLInputElement | null
    if (search) search.value = ''
    onApply()
  })
  document.getElementById('filter-group')?.addEventListener('change', onApply)
  document.getElementById('filter-clear-columns')?.addEventListener('click', onClearColumns)
  document.getElementById('filter-clear')?.addEventListener('click', () => {
    cancelSearchDebounce()
    const search = document.getElementById('filter-search') as HTMLInputElement | null
    if (search) search.value = ''
    const group = document.getElementById('filter-group') as HTMLInputElement | null
    if (group) group.checked = false
    onClearAll()
  })
}

function closeFilterPanel(state: FilterState) {
  state.panel.classList.remove('open')
  state.trigger.setAttribute('aria-expanded', 'false')
}

function isColorGridState(state: FilterState): boolean {
  return state.def.type === 'multi' && state.def.multiDisplay === 'colors'
}

function workingColorFilter(state: FilterState): ColorFilterValue | null {
  return state.working.type === 'color' ? state.working : state.candidateColor
}

function colorControlsChanged(state: FilterState) {
  syncColorControls(state)
  if (isColorGridState(state)) renderMultiList(state)
  if (state.def.type === 'color' && state.working.type === 'color') {
    state.applied = cloneFilter(state.working)
    state.appliedColorPreset = state.colorPreset
    state.def.onApply(cloneFilter(state.applied))
  }
  updateTrigger(state)
}

function positionFilterPanel(state: FilterState) {
  const rect = state.trigger.getBoundingClientRect()
  const disclosure = state.colorDisclosure || state.panel.querySelector<HTMLDetailsElement>('.fm-header-filter-disclosure')
  const disclosurePanel = disclosure?.querySelector<HTMLElement>('.fm-header-filter-disclosure-panel') || null
  const sidecar = window.innerWidth >= 800 && disclosure?.open ? disclosurePanel : null
  if (disclosurePanel && !sidecar) {
    disclosurePanel.style.removeProperty('top')
    disclosurePanel.style.removeProperty('max-height')
  }
  const sidecarGap = sidecar?.offsetWidth ? sidecar.offsetWidth + 8 : 0
  const left = Math.max(8, Math.min(rect.right - state.panel.offsetWidth, window.innerWidth - state.panel.offsetWidth - sidecarGap - 8))
  const panelHeight = state.panel.offsetHeight
  const belowHeight = Math.max(80, window.innerHeight - rect.bottom - 14)
  const aboveHeight = Math.max(80, rect.top - 14)
  const placeBelow = belowHeight >= Math.min(panelHeight, 240) || belowHeight >= aboveHeight
  const availableHeight = placeBelow ? belowHeight : aboveHeight
  const top = placeBelow
    ? rect.bottom + 6
    : Math.max(8, rect.top - Math.min(panelHeight, availableHeight) - 6)
  state.panel.style.setProperty('--fm-filter-max-height', `${availableHeight}px`)
  state.panel.style.left = `${left}px`
  state.panel.style.top = `${top}px`
  if (sidecar) {
    const viewportHeight = window.innerHeight - 16
    const sidecarHeight = Math.min(Math.max(sidecar.offsetHeight, sidecar.scrollHeight), viewportHeight)
    const sidecarTop = Math.max(8, Math.min(top, window.innerHeight - sidecarHeight - 8))
    sidecar.style.top = `${sidecarTop - top}px`
    sidecar.style.maxHeight = `${viewportHeight}px`
  }
}

function openFilterPanel(state: FilterState) {
  state.working = cloneFilter(state.applied)
  state.optionSearch = ''
  if (isColorGridState(state)) {
    state.candidateColor = colorDefaults()
    state.colorPreset = 'color'
  } else {
    state.colorPreset = state.appliedColorPreset
  }
  syncControls(state)
  state.linkedStates.forEach((linked) => {
    linked.working = cloneFilter(linked.applied)
    linked.optionSearch = ''
    syncControls(linked)
  })
  state.panel.classList.add('open')
  state.trigger.setAttribute('aria-expanded', 'true')
  positionFilterPanel(state)
  const focusTarget = state.optionSearchInput
    || state.valueInput
    || state.operatorSelect
    || state.panel.querySelector<HTMLElement>('[aria-pressed="true"]')
    || state.panel.querySelector<HTMLElement>('input:not(:disabled), button')
  focusTarget?.focus()
}

function createFilterActions(
  state: FilterState,
  close: () => void,
  options: { showApply?: boolean; clearLabel?: string } = {},
) {
  const actions = document.createElement('div')
  actions.className = 'fm-header-filter-actions'
  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = 'fm-btn fm-btn-primary fm-header-filter-action'
  apply.textContent = t('filters.apply')
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'fm-btn fm-btn-outline fm-header-filter-action'
  clear.dataset.filterClear = ''
  clear.textContent = options.clearLabel || t(isColorGridState(state) ? 'filters.clearListFilter' : 'filters.clear')
  if (isColorGridState(state)) clear.dataset.clearListFilter = ''
  const showApply = options.showApply ?? state.def.type !== 'color'
  if (!showApply) actions.append(clear)
  else actions.append(apply, clear)

  const applyState = (target: FilterState) => {
    if (isColorGridState(target) && target.working.type === 'multi') {
      const selected = new Set(target.working.values)
      const rangeOptions = target.options.filter((option) => optionMatchesCandidateColor(target, option))
      const narrowed = target.optionSearch.trim() !== ''
        || !!target.candidateColor && isColumnFilterActive(target.candidateColor)
      target.working = {
        type: 'multi',
        values: selected.size > 0
          ? rangeOptions.filter((option) => selected.has(option.value)).map((option) => option.value)
          : narrowed ? visibleOptions(target).map((option) => option.value) : [],
      }
    }
    target.applied = cloneFilter(target.working)
    target.appliedColorPreset = target.colorPreset
    target.def.onApply(cloneFilter(target.applied))
    updateTrigger(target)
  }
  const applyFilter = () => {
    ;[state, ...state.linkedStates].forEach(applyState)
    close()
    updateTrigger(state)
  }
  const clearFilter = () => {
    if (isColorGridState(state) && state.working.type === 'multi') {
      state.working.values = []
      state.optionSearch = ''
      syncControls(state)
      updateTrigger(state)
      return
    }
    state.applied = emptyColumnFilter(state.def.type)
    state.working = emptyColumnFilter(state.def.type)
    state.colorPreset = 'color'
    state.appliedColorPreset = 'color'
    state.optionSearch = ''
    state.def.onApply(cloneFilter(state.applied))
    syncControls(state)
    updateTrigger(state)
  }
  apply.addEventListener('click', applyFilter)
  clear.addEventListener('click', clearFilter)
  state.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && showApply && isColorGridState(state) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      applyFilter()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      state.trigger.focus()
    }
  })
  return { actions, clearFilter }
}

export function bindColorFilterButton(
  trigger: HTMLButtonElement,
  onApply: (value: ColorFilterValue) => void,
): () => void {
  const label = t('filaments.colors')
  const initial = emptyColumnFilter('color')
  if (initial.type !== 'color') return () => {}

  trigger.insertAdjacentHTML('afterbegin', FILTER_ICON)
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.title = t('filters.filterColumn', { label })

  const panel = document.createElement('div')
  panel.className = 'fm-header-filter-panel'
  panel.id = `fm-header-filter-panel-${nextPanelId++}`
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', t('filters.filterColumn', { label }))
  trigger.setAttribute('aria-controls', panel.id)

  const state: FilterState = {
    def: {
      key: 'color',
      label,
      columnSelector: '',
      type: 'color',
      onApply: (value) => { if (value.type === 'color') onApply(value) },
    },
    options: [],
    applied: cloneFilter(initial),
    working: cloneFilter(initial),
    optionSearch: '',
    optionView: 'details',
    colorPreset: colorPresetFor(initial),
    appliedColorPreset: colorPresetFor(initial),
    trigger,
    panel,
    parentState: null,
    linkedStates: [],
    list: null,
    optionSearchInput: null,
    operatorSelect: null,
    valueInput: null,
    valueToInput: null,
    suggestionList: null,
    candidateColor: null,
    colorDisclosure: null,
  }

  buildColorControls(state)
  const close = () => closeFilterPanel(state)
  const { actions, clearFilter } = createFilterActions(state, close)
  panel.appendChild(actions)
  document.body.appendChild(panel)

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    if (panel.classList.contains('open')) {
      close()
      return
    }
    openFilterPanel(state)
  })
  panel.addEventListener('click', (event) => event.stopPropagation())
  panel.addEventListener('dragstart', (event) => event.preventDefault())
  document.addEventListener('click', close)
  window.addEventListener('resize', () => { if (panel.classList.contains('open')) positionFilterPanel(state) })
  window.addEventListener('scroll', () => { if (panel.classList.contains('open')) positionFilterPanel(state) }, true)

  syncControls(state)
  updateTrigger(state)
  return clearFilter
}

export function matchesColumnFilter(rawValue: unknown, filter: ColumnFilterValue | null | undefined): boolean {
  if (!isColumnFilterActive(filter) || !filter) return true

  if (filter.type === 'color') return matchesColorFilter(rawValue, filter)

  const isEmpty = rawValue == null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0)
  if (filter.type !== 'multi' && filter.operator === 'isEmpty') return isEmpty
  if (filter.type !== 'multi' && filter.operator === 'isNotEmpty') return !isEmpty

  if (filter.type === 'multi') {
    const values = isEmpty ? [''] : Array.isArray(rawValue) ? rawValue : [rawValue]
    const normalized = values.map((value) => value == null ? '' : String(value))
    return filter.values.some((value) => normalized.includes(value))
  }

  if (isEmpty) return false

  if (filter.type === 'text') {
    const actual = String(rawValue ?? '').toLowerCase()
    const expected = filter.value.toLowerCase()
    if (filter.operator === 'equals') return actual === expected
    if (filter.operator === 'startsWith') return actual.startsWith(expected)
    if (filter.operator === 'endsWith') return actual.endsWith(expected)
    if (filter.operator === 'notContains') return !actual.includes(expected)
    return actual.includes(expected)
  }

  if (filter.type === 'number') {
    const actual = Number(rawValue)
    const expected = Number(filter.value)
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
    if (filter.operator === 'neq') return actual !== expected
    if (filter.operator === 'gt') return actual > expected
    if (filter.operator === 'gte') return actual >= expected
    if (filter.operator === 'lt') return actual < expected
    if (filter.operator === 'lte') return actual <= expected
    if (filter.operator === 'between') {
      const upper = Number(filter.valueTo)
      return Number.isFinite(upper) && actual >= Math.min(expected, upper) && actual <= Math.max(expected, upper)
    }
    return actual === expected
  }

  const actual = normalizeDate(rawValue)
  const expected = normalizeDate(filter.value)
  if (!actual || !expected) return false
  if (filter.operator === 'before') return actual < expected
  if (filter.operator === 'after') return actual > expected
  if (filter.operator === 'between') {
    const upper = normalizeDate(filter.valueTo)
    return !!upper && actual >= (expected < upper ? expected : upper) && actual <= (expected > upper ? expected : upper)
  }
  return actual === expected
}

export function matchesColorFilter(rawValue: unknown, filter: ColorFilterValue): boolean {
  const values = Array.isArray(rawValue) ? rawValue : [rawValue]
  return values.some((value) => {
    const normalized = typeof value === 'string' ? normalizeHexCode(value) : ''
    if (!normalized) return false
    const transparent = normalized.length === 9 && normalized.slice(-2) !== 'FF'
    if (transparent && !filter.includeTransparent) return false
    const hex = toOpaqueRgbHex(normalized)
    const { hue, saturation, value: brightness } = hexToHsv(hex)
    const hueMatches = filter.hueFrom <= filter.hueTo
      ? hue >= filter.hueFrom && hue <= filter.hueTo
      : hue >= filter.hueFrom || hue <= filter.hueTo
    const chromatic = filter.mode === 'color'
      && hueMatches
      && saturation >= Math.min(filter.saturationFrom, filter.saturationTo)
      && saturation <= Math.max(filter.saturationFrom, filter.saturationTo)
      && brightness >= Math.min(filter.valueFrom, filter.valueTo)
      && brightness <= Math.max(filter.valueFrom, filter.valueTo)
    const neutralPreset = colorNeutralPreset(filter.mode)
    const [neutralFrom, neutralTo] = colorNeutralRange(filter)
    const neutral = !!neutralPreset
      && brightness >= neutralFrom
      && brightness <= neutralTo
      && saturation <= colorNeutralSaturation(filter)
    return filter.mode === 'none' ? transparent : chromatic || neutral
  })
}

export function normalizeColorFilter(value: ColorFilterValue): ColorFilterValue {
  const mode: ColorFilterMode = value.mode === 'none' || value.mode === 'color'
    || value.mode === 'black' || value.mode === 'white' || value.mode === 'grey'
    ? value.mode
    : 'none'
  const valueLow = Math.min(value.valueFrom, value.valueTo)
  const valueHigh = Math.max(value.valueFrom, value.valueTo)
  const preview = Number.isFinite(value.valuePreview) ? value.valuePreview : valueHigh
  const valuePreview = Math.max(valueLow, Math.min(valueHigh, preview))
  const neutralPreset = colorNeutralPreset(mode)
  const neutralSaturationTo = neutralPreset
    ? colorNeutralSaturation({ ...value, mode })
    : undefined
  const neutralFrom = neutralPreset
    ? Number.isFinite(value.neutralValueFrom) ? value.neutralValueFrom! : neutralPreset.valueFrom
    : undefined
  const neutralTo = neutralPreset
    ? Number.isFinite(value.neutralValueTo) ? value.neutralValueTo! : neutralPreset.valueTo
    : undefined
  return {
    type: 'color', mode,
    hueFrom: value.hueFrom, hueTo: value.hueTo,
    saturationFrom: value.saturationFrom, saturationTo: value.saturationTo,
    valueFrom: value.valueFrom, valueTo: value.valueTo, valuePreview,
    ...(neutralSaturationTo !== undefined && neutralFrom !== undefined && neutralTo !== undefined
      ? {
          neutralSaturationTo,
          neutralValueFrom: Math.min(neutralFrom, neutralTo),
          neutralValueTo: Math.max(neutralFrom, neutralTo),
        }
      : {}),
    includeTransparent: value.includeTransparent,
  }
}

function hexToHsv(hex: string): { hue: number; saturation: number; value: number } {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  return {
    hue,
    saturation: max === 0 ? 0 : delta / max * 100,
    value: max * 100,
  }
}

function normalizeDate(value: unknown): string {
  if (!value) return ''
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-')
}

function cloneFilter(value: ColumnFilterValue): ColumnFilterValue {
  if (value.type === 'multi') return { type: 'multi', values: [...value.values] }
  if (value.type === 'color') return normalizeColorFilter(value)
  if (value.type === 'text') return { ...value }
  return { ...value }
}

function sameFilter(a: ColumnFilterValue, b: ColumnFilterValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function initHeaderColumnFilters(
  table: HTMLTableElement,
  defs: HeaderFilterDefinition[],
): HeaderFilterController {
  const firstHeader = table.querySelector('thead tr')
  if (!firstHeader) throw new Error('initHeaderColumnFilters: missing table header row')

  const states = new Map<string, FilterState>()
  const openPanels = new Set<HTMLDivElement>()

  installHeaderSortButtons(firstHeader)

  function closePanel(panel: HTMLDivElement) {
    const state = [...states.values()].find((candidate) => candidate.panel === panel)
    if (state) closeFilterPanel(state)
    openPanels.delete(panel)
  }

  function repositionOpenPanels() {
    openPanels.forEach((panel) => {
      const state = [...states.values()].find((candidate) => candidate.panel === panel)
      if (state) positionFilterPanel(state)
    })
  }

  defs.forEach((def) => {
    const parentState = def.disclosureOf ? states.get(def.disclosureOf) || null : null
    if (def.disclosureOf && !parentState) {
      throw new Error(`initHeaderColumnFilters: disclosure parent ${def.disclosureOf} must be defined first`)
    }
    const cell = firstHeader.querySelector(def.columnSelector) as HTMLTableCellElement | null
    if (!cell) return

    if (!parentState) preserveTranslatedHeading(cell, def.label)

    const wrap = ensureHeaderControls(cell)

    const trigger = parentState ? document.createElement('summary') : document.createElement('button')
    if (trigger instanceof HTMLButtonElement) trigger.type = 'button'
    trigger.className = parentState ? 'fm-header-filter-disclosure-summary' : 'fm-header-filter-trigger'
    trigger.setAttribute('aria-label', t('filters.filterColumn', { label: def.label }))
    trigger.setAttribute('aria-expanded', 'false')
    if (!parentState) trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.title = t('filters.filterColumn', { label: def.label })
    if (def.icon === 'gear') trigger.dataset.tooltip = trigger.title
    trigger.innerHTML = `${def.icon === 'gear' ? GEAR_ICON : FILTER_ICON}${parentState ? `<span class="fm-sr-only">${def.label}</span>` : ''}`

    const panel = document.createElement('div')
    panel.className = 'fm-header-filter-panel'
    panel.id = `fm-header-filter-panel-${nextPanelId++}`
    panel.setAttribute('role', parentState ? 'group' : 'dialog')
    panel.setAttribute('aria-label', t('filters.filterColumn', { label: def.label }))
    trigger.setAttribute('aria-controls', panel.id)

    const initial = def.initialValue?.type === def.type
      ? cloneFilter(def.initialValue)
      : emptyColumnFilter(def.type)

    const state: FilterState = {
      def,
      options: [...(def.options || [])],
      applied: cloneFilter(initial),
      working: cloneFilter(initial),
      optionSearch: '',
      optionView: def.multiDisplay === 'colors' ? 'swatches' : 'details',
      colorPreset: colorPresetFor(initial),
      appliedColorPreset: colorPresetFor(initial),
      trigger,
      panel,
      parentState,
      linkedStates: [],
      list: null,
      optionSearchInput: null,
      operatorSelect: null,
      valueInput: null,
      valueToInput: null,
      suggestionList: null,
      candidateColor: def.multiDisplay === 'colors' ? colorDefaults() : null,
      colorDisclosure: null,
    }

    if (def.type === 'multi') {
      buildMultiControls(state)
      if (def.multiDisplay === 'colors') buildColorDisclosure(state)
    }
    else if (def.type === 'color') buildColorControls(state)
    else buildTypedControls(state)

    const close = () => closePanel(parentState?.panel || panel)
    const { actions } = createFilterActions(state, close, parentState
      ? { showApply: false, clearLabel: t('filters.clearFilter', { label: def.label }) }
      : undefined)
    if (def.multiDisplay === 'colors') appendColorGridToggle(actions, state)
    panel.appendChild(actions)

    if (parentState) {
      parentState.linkedStates.push(state)
      parentState.panel.classList.add('fm-header-filter-panel-disclosure')
      panel.classList.add('fm-header-filter-disclosure-panel', 'fm-header-linked-filter-panel')
      const disclosure = document.createElement('details')
      disclosure.className = 'fm-header-filter-disclosure'
      disclosure.open = !def.disclosureStorageKey || localStorage.getItem(def.disclosureStorageKey) !== 'false'
      trigger.setAttribute('aria-expanded', String(disclosure.open))
      disclosure.append(trigger, panel)
      disclosure.addEventListener('toggle', () => {
        trigger.setAttribute('aria-expanded', String(disclosure.open))
        if (def.disclosureStorageKey) localStorage.setItem(def.disclosureStorageKey, String(disclosure.open))
        if (parentState.panel.classList.contains('open')) positionFilterPanel(parentState)
      })
      parentState.panel.appendChild(disclosure)
      const parentClear = parentState.panel.querySelector<HTMLButtonElement>('.fm-header-filter-actions [data-filter-clear]')
      if (parentClear) parentClear.textContent = t('filters.clearFilter', { label: parentState.def.label })
      states.set(def.key, state)
      syncControls(state)
      updateTrigger(state)
      return
    }

    wrap.appendChild(trigger)
    document.body.appendChild(panel)
    states.set(def.key, state)

    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      if (panel.classList.contains('open')) {
        closePanel(panel)
        return
      }
      openPanels.forEach(closePanel)
      openFilterPanel(state)
      openPanels.add(panel)
    })

    panel.addEventListener('click', (event) => event.stopPropagation())
    panel.addEventListener('dragstart', (event) => event.preventDefault())

    syncControls(state)
    updateTrigger(state)
  })

  document.addEventListener('click', () => openPanels.forEach(closePanel))
  window.addEventListener('resize', repositionOpenPanels)
  window.addEventListener('scroll', repositionOpenPanels, true)

  return {
    setOptions: (key, options) => {
      const state = states.get(key)
      if (!state || (state.def.type !== 'multi' && !state.def.autocomplete)) return
      state.options = [...options]
      syncControls(state)
      updateTrigger(state)
    },
    setValue: (key, value) => {
      const state = states.get(key)
      if (!state || value.type !== state.def.type) return
      state.applied = cloneFilter(value)
      state.working = cloneFilter(value)
      state.colorPreset = colorPresetFor(value)
      state.appliedColorPreset = state.colorPreset
      syncControls(state)
      updateTrigger(state)
    },
    getValue: (key) => {
      const state = states.get(key)
      return state ? cloneFilter(state.applied) : null
    },
    getActiveCount: () => [...states.values()].filter((state) => isColumnFilterActive(state.applied)).length,
    resetAll: () => {
      states.forEach((state) => {
        state.applied = emptyColumnFilter(state.def.type)
        state.working = emptyColumnFilter(state.def.type)
        state.colorPreset = 'color'
        state.appliedColorPreset = 'color'
        state.optionSearch = ''
        syncControls(state)
        updateTrigger(state)
      })
      openPanels.forEach(closePanel)
    },
  }
}

function ensureHeaderControls(cell: HTMLTableCellElement): HTMLDivElement {
  const existing = cell.querySelector(':scope > .fm-header-filter-wrap') as HTMLDivElement | null
  if (existing) return existing
  const wrap = document.createElement('div')
  wrap.className = 'fm-header-filter-wrap'
  cell.appendChild(wrap)
  return wrap
}

function installHeaderSortButtons(headerRow: Element) {
  headerRow.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach((cell) => {
    const wrap = ensureHeaderControls(cell)
    if (wrap.querySelector('.fm-header-sort-trigger')) return
    const label = cell.textContent?.trim() || cell.dataset.sort || ''
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fm-header-sort-trigger'
    button.dataset.sortLabel = label
    button.setAttribute('aria-label', t('filters.sortColumn', { label }))
    button.title = t('filters.sortColumn', { label })
    button.innerHTML = SORT_ICON
    wrap.appendChild(button)
  })
}

export function syncHeaderSortButtons(
  table: HTMLTableElement,
  activeKey: string | null,
  direction: SortDirection,
) {
  table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach((cell) => {
    const button = cell.querySelector('.fm-header-sort-trigger') as HTMLButtonElement | null
    if (!button) return
    const label = button.dataset.sortLabel || cell.dataset.sort || ''
    const isActive = cell.dataset.sort === activeKey && direction !== null
    const state = isActive
      ? direction === 'asc' ? t('filters.ascending') : t('filters.descending')
      : t('filters.notSorted')
    button.setAttribute('aria-label', t('filters.sortColumnState', { label, state }))
    button.title = t('filters.sortColumnState', { label, state })
    button.setAttribute('aria-pressed', String(isActive))
  })
}

function preserveTranslatedHeading(cell: HTMLTableCellElement, label: string) {
  const i18nKey = cell.getAttribute('data-i18n')
  if (!i18nKey) return
  const heading = document.createElement('span')
  heading.className = 'fm-header-filter-heading'
  heading.setAttribute('data-i18n', i18nKey)
  heading.textContent = label
  Array.from(cell.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .forEach((node) => node.remove())
  cell.removeAttribute('data-i18n')
  cell.insertBefore(heading, cell.firstChild)
}

function buildMultiControls(state: FilterState) {
  const searchable = state.def.searchable !== false
  const search = document.createElement('input')
  search.className = 'fm-input fm-header-filter-search'
  search.type = 'text'
  search.placeholder = t('filters.searchOptions', { label: state.def.label })
  search.setAttribute('aria-label', t('filters.searchOptions', { label: state.def.label }))

  const selectionActions = document.createElement('div')
  selectionActions.className = 'fm-header-filter-selection-actions'

  const selectAll = document.createElement('button')
  selectAll.type = 'button'
  selectAll.className = 'fm-btn fm-btn-outline fm-header-filter-action'
  selectAll.textContent = t('filters.selectAll')

  const selectNone = document.createElement('button')
  selectNone.type = 'button'
  selectNone.className = 'fm-btn fm-btn-outline fm-header-filter-action'
  selectNone.textContent = t('filters.selectNone')

  selectionActions.appendChild(selectAll)
  selectionActions.appendChild(selectNone)

  const list = document.createElement('div')
  list.className = 'fm-header-filter-list'

  if (searchable) {
    search.addEventListener('input', () => {
      state.optionSearch = search.value
      renderMultiList(state)
      if (isColorGridState(state)) syncColorControls(state)
    })
  }
  selectAll.addEventListener('click', () => updateVisibleMultiOptions(state, true))
  selectNone.addEventListener('click', () => updateVisibleMultiOptions(state, false))

  state.optionSearchInput = searchable ? search : null
  state.list = list
  if (searchable) state.panel.appendChild(search)
  if (!isColorGridState(state)) state.panel.appendChild(selectionActions)
  state.panel.appendChild(list)
}

function appendColorGridToggle(actions: HTMLDivElement, state: FilterState) {
  const label = document.createElement('label')
  label.className = 'fm-header-filter-grid-toggle'

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = state.optionView === 'details'
  input.setAttribute('role', 'switch')
  input.setAttribute('aria-label', t('filters.colorList'))

  const track = document.createElement('span')
  track.className = 'fm-header-filter-grid-toggle-track'
  track.setAttribute('aria-hidden', 'true')

  const text = document.createElement('span')
  text.textContent = t('filters.colorList')

  input.addEventListener('change', () => {
    state.optionView = input.checked ? 'details' : 'swatches'
    renderMultiList(state)
  })

  label.appendChild(input)
  label.appendChild(track)
  label.appendChild(text)
  actions.appendChild(label)
}

function buildColorDisclosure(state: FilterState) {
  state.panel.classList.add('fm-header-filter-panel-color', 'fm-header-filter-panel-disclosure')
  const disclosure = document.createElement('details')
  disclosure.className = 'fm-header-filter-disclosure fm-header-color-disclosure'
  disclosure.open = localStorage.getItem('filaman-color-range-open') !== 'false'
  const summary = document.createElement('summary')
  summary.setAttribute('aria-label', t('filters.colorFilter'))
  summary.title = t('filters.colorFilter')
  summary.innerHTML = `<span class="fm-header-color-wheel-icon" aria-hidden="true"></span><span class="fm-sr-only">${t('filters.colorFilter')}</span>`
  disclosure.appendChild(summary)
  disclosure.addEventListener('toggle', () => {
    localStorage.setItem('filaman-color-range-open', String(disclosure.open))
    if (state.panel.classList.contains('open')) positionFilterPanel(state)
  })
  state.colorDisclosure = disclosure
  const sidecar = document.createElement('div')
  sidecar.className = 'fm-header-filter-disclosure-panel fm-header-color-disclosure-panel'
  buildColorControls(state, sidecar)

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'fm-btn fm-btn-outline fm-header-filter-action'
  clear.dataset.clearColorRange = ''
  clear.textContent = t('filters.clearColorRange')
  clear.addEventListener('click', () => {
    state.candidateColor = colorDefaults()
    state.colorPreset = 'color'
    colorControlsChanged(state)
  })
  sidecar.appendChild(clear)
  disclosure.appendChild(sidecar)
  state.panel.appendChild(disclosure)
}

function buildColorControls(state: FilterState, parent: HTMLElement = state.panel) {
  const controls = document.createElement('div')
  controls.className = 'fm-header-color-controls'

  const title = document.createElement('h3')
  title.className = 'fm-header-color-title'
  title.textContent = t('filters.colorFilter')
  controls.appendChild(title)

  const colorMode = document.createElement('button')
  colorMode.type = 'button'
  colorMode.className = 'fm-header-color-default'
  colorMode.dataset.colorMode = 'color'
  colorMode.setAttribute('aria-pressed', 'false')
  colorMode.innerHTML = `<span class="fm-header-color-wheel-icon" aria-hidden="true"></span>${t('filaments.color')}`
  colorMode.addEventListener('click', () => {
    if (isColorGridState(state)) state.candidateColor = colorDefaults('color')
    else state.working = colorDefaults('color')
    state.colorPreset = 'color'
    colorControlsChanged(state)
  })
  controls.appendChild(colorMode)

  const modes = document.createElement('div')
  modes.className = 'fm-header-color-modes'

  ;(['black', 'grey', 'white'] as const).forEach((neutral) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.colorNeutral = neutral
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => {
      const value = workingColorFilter(state)
      if (!value) return
      const preset = COLOR_NEUTRAL_PRESETS[neutral]
      value.mode = neutral
      state.colorPreset = neutral
      value.neutralSaturationTo = preset.saturationTo
      value.neutralValueFrom = preset.valueFrom
      value.neutralValueTo = preset.valueTo
      colorControlsChanged(state)
    })
    const swatch = document.createElement('span')
    swatch.className = `fm-header-color-neutral-swatch ${neutral}`
    swatch.setAttribute('aria-hidden', 'true')
    button.appendChild(swatch)
    button.append(t(`filters.soft${neutral.charAt(0).toUpperCase()}${neutral.slice(1)}`))
    modes.appendChild(button)
  })

  COLOR_CHROMATIC_PRESETS.forEach((preset) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.colorPreset = preset.key
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => {
      const value = workingColorFilter(state)
      if (!value) return
      Object.assign(value, {
        mode: 'color',
        hueFrom: preset.hueFrom,
        hueTo: preset.hueTo,
        saturationFrom: 10,
        saturationTo: 100,
        valueFrom: 16,
        valueTo: 100,
        valuePreview: 100,
      })
      state.colorPreset = preset.key
      colorControlsChanged(state)
    })
    const swatch = document.createElement('span')
    swatch.className = 'fm-header-color-neutral-swatch'
    swatch.style.background = preset.swatch
    swatch.setAttribute('aria-hidden', 'true')
    button.appendChild(swatch)
    button.append(t(`filters.preset${preset.key.charAt(0).toUpperCase()}${preset.key.slice(1)}`))
    modes.appendChild(button)
  })
  controls.appendChild(modes)

  const wheel = document.createElement('div')
  wheel.className = 'fm-header-color-wheel'
  wheel.tabIndex = 0
  wheel.setAttribute('role', 'slider')
  wheel.setAttribute('aria-label', t('filters.moveHueArc'))
  wheel.setAttribute('aria-valuemin', '0')
  wheel.setAttribute('aria-valuemax', '359')
  const surface = document.createElement('span')
  surface.className = 'fm-header-color-wheel-surface'
  surface.setAttribute('aria-hidden', 'true')
  const selection = document.createElement('span')
  selection.className = 'fm-header-color-wheel-selection'
  wheel.append(surface, selection)
  const wheelWrap = document.createElement('div')
  wheelWrap.className = 'fm-header-color-wheel-wrap'
  wheelWrap.appendChild(wheel)
  controls.appendChild(wheelWrap)

  const shiftHueArc = (delta: number) => {
    const value = workingColorFilter(state)
    if (!value || Math.abs(value.hueTo - value.hueFrom) >= 360) return
    value.hueFrom = ((value.hueFrom + delta) % 360 + 360) % 360
    value.hueTo = ((value.hueTo + delta) % 360 + 360) % 360
    state.colorPreset = 'color'
    value.mode = 'color'
    colorControlsChanged(state)
  }
  const centerHueArc = (center: number) => {
    const value = workingColorFilter(state)
    if (!value) return
    const span = Math.abs(value.hueTo - value.hueFrom) >= 360
      ? 360
      : (value.hueTo - value.hueFrom + 360) % 360
    if (span >= 360) {
      value.hueFrom = 0
      value.hueTo = 360
    } else {
      value.hueFrom = Math.round((center - span / 2 + 360) % 360)
      value.hueTo = Math.round((value.hueFrom + span) % 360)
    }
    state.colorPreset = 'color'
    value.mode = 'color'
    colorControlsChanged(state)
  }
  const centerHueArcAtPointer = (event: PointerEvent) => {
    const value = workingColorFilter(state)
    if (!value || (value.mode !== 'none' && value.mode !== 'color')) return
    if (value.mode === 'none') Object.assign(value, colorDefaults('color'))
    const rect = wheel.getBoundingClientRect()
    const angle = Math.atan2(event.clientY - (rect.top + rect.height / 2), event.clientX - (rect.left + rect.width / 2)) * 180 / Math.PI
    centerHueArc((360 - angle + 360) % 360)
  }
  let wheelDragging = false
  wheel.addEventListener('pointerdown', (event) => {
    const mode = workingColorFilter(state)?.mode
    if (mode !== 'none' && mode !== 'color') return
    wheelDragging = true
    wheel.setPointerCapture?.(event.pointerId)
    centerHueArcAtPointer(event)
  })
  wheel.addEventListener('pointermove', (event) => {
    if (wheelDragging) centerHueArcAtPointer(event)
  })
  const stopWheelDrag = () => { wheelDragging = false }
  wheel.addEventListener('pointerup', stopWheelDrag)
  wheel.addEventListener('pointercancel', stopWheelDrag)
  wheel.addEventListener('keydown', (event) => {
    if (workingColorFilter(state)?.mode !== 'color') return
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown'
      ? -1
      : event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : 0
    if (!delta) return
    event.preventDefault()
    shiftHueArc(delta * (event.shiftKey ? 10 : 1))
  })

  const ranges = [
    { label: t('filters.hueArc'), from: 'hueFrom', to: 'hueTo', max: 360, suffix: '°' },
    { label: t('filters.saturationRange'), from: 'saturationFrom', to: 'saturationTo', max: 100, suffix: '%' },
    { label: t('filters.valueRange'), from: 'valueFrom', to: 'valueTo', max: 100, suffix: '%' },
  ] as const

  ranges.forEach((range) => {
    const group = document.createElement('div')
    group.className = 'fm-header-color-range'
    const heading = document.createElement('div')
    heading.className = 'fm-header-color-range-heading'
    const label = document.createElement('span')
    label.dataset.colorRangeLabel = range.from
    label.textContent = range.label
    heading.appendChild(label)
    const headingValue = document.createElement('span')
    headingValue.className = 'fm-header-color-range-value'
    const output = document.createElement('output')
    output.dataset.colorOutput = range.from
    headingValue.appendChild(output)
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'fm-header-color-range-reset'
    reset.dataset.colorRangeReset = range.from
    reset.title = t('filters.resetRange', { label: range.label })
    reset.setAttribute('aria-label', reset.title)
    reset.innerHTML = RESET_ICON
    reset.addEventListener('click', () => {
      const value = workingColorFilter(state)
      if (!value) return
      const neutral = colorNeutralPreset(value.mode)
      const chromatic = COLOR_CHROMATIC_PRESETS.find((preset) => preset.key === state.colorPreset)
      const defaults = colorDefaults('color')
      if (range.from === 'hueFrom') {
        if (neutral) return
        value.hueFrom = chromatic?.hueFrom ?? defaults.hueFrom
        value.hueTo = chromatic?.hueTo ?? defaults.hueTo
      } else if (range.from === 'saturationFrom') {
        if (neutral) value.neutralSaturationTo = neutral.saturationTo
        else {
          value.saturationFrom = defaults.saturationFrom
          value.saturationTo = defaults.saturationTo
        }
      } else if (neutral) {
        value.neutralValueFrom = neutral.valueFrom
        value.neutralValueTo = neutral.valueTo
      } else {
        value.valueFrom = defaults.valueFrom
        value.valueTo = defaults.valueTo
        value.valuePreview = defaults.valuePreview
      }
      colorControlsChanged(state)
    })
    headingValue.appendChild(reset)
    heading.appendChild(headingValue)
    group.appendChild(heading)
    const slider = document.createElement('div')
    slider.className = 'fm-header-color-dual-range'
    ;([range.from, range.to] as const).forEach((field, index) => {
      const bound = index === 0 ? t('filters.rangeStart') : t('filters.rangeEnd')
      const input = document.createElement('input')
      input.type = 'range'
      input.min = '0'
      input.max = String(range.max)
      input.step = '1'
      input.dataset.colorField = field
      input.setAttribute('aria-label', `${range.label} ${bound}`)
      input.addEventListener('input', () => {
        const value = workingColorFilter(state)
        if (!value) return
        const next = Number(input.value)
        const neutralPreset = colorNeutralPreset(value.mode)
        if (neutralPreset && range.from === 'saturationFrom' && index === 1) {
          value.neutralSaturationTo = next
          colorControlsChanged(state)
          return
        }
        if (neutralPreset && range.from === 'valueFrom') {
          const [from, to] = colorNeutralRange(value)
          value.neutralValueFrom = index === 0 ? Math.min(next, to) : from
          value.neutralValueTo = index === 0 ? to : Math.max(next, from)
          colorControlsChanged(state)
          return
        }
        const hueWraps = range.from === 'hueFrom' && value.hueFrom > value.hueTo
        value[field] = hueWraps
          ? index === 0 ? Math.max(next, value[range.to]) : Math.min(next, value[range.from])
          : index === 0 ? Math.min(next, value[range.to]) : Math.max(next, value[range.from])
        if (range.from === 'valueFrom') {
          value.valuePreview = Math.max(value.valueFrom, Math.min(value.valueTo, value.valuePreview))
        }
        state.colorPreset = 'color'
        value.mode = 'color'
        colorControlsChanged(state)
      })
      slider.appendChild(input)
    })
    if (range.from === 'hueFrom') {
      const grab = document.createElement('span')
      grab.className = 'fm-header-color-range-grab'
      grab.dataset.colorGrab = 'hue'
      grab.tabIndex = 0
      grab.setAttribute('role', 'slider')
      grab.setAttribute('aria-label', t('filters.moveHueArc'))
      grab.setAttribute('aria-valuemin', '0')
      grab.setAttribute('aria-valuemax', '359')
      grab.innerHTML = '<span class="fm-header-color-range-grab-dot"></span><span class="fm-header-color-range-grab-dot"></span><span class="fm-header-color-range-grab-dot"></span>'
      let dragging = false
      let startX = 0
      grab.addEventListener('pointerdown', (event) => {
        if (workingColorFilter(state)?.mode !== 'color') return
        dragging = true
        startX = event.clientX
        grab.setPointerCapture?.(event.pointerId)
      })
      grab.addEventListener('pointermove', (event) => {
        if (!dragging) return
        const width = slider.getBoundingClientRect().width
        const travel = width - 17
        if (travel <= 0) return
        const delta = Math.round((event.clientX - startX) / travel * 360)
        if (!delta) return
        startX = event.clientX
        shiftHueArc(delta)
      })
      const stopDrag = () => { dragging = false }
      grab.addEventListener('pointerup', stopDrag)
      grab.addEventListener('pointercancel', stopDrag)
      grab.addEventListener('keydown', (event) => {
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? 1
            : 0
        if (!delta || workingColorFilter(state)?.mode !== 'color') return
        event.preventDefault()
        shiftHueArc(delta * (event.shiftKey ? 10 : 1))
      })
      slider.appendChild(grab)
    }
    if (range.from === 'valueFrom') {
      const preview = document.createElement('input')
      preview.type = 'range'
      preview.min = '0'
      preview.max = '100'
      preview.step = '1'
      preview.className = 'fm-header-color-preview-range'
      preview.dataset.colorField = 'valuePreview'
      preview.setAttribute('aria-label', t('filters.wheelPreview'))
      preview.addEventListener('input', () => {
        const value = workingColorFilter(state)
        if (!value || value.mode !== 'color') return
        value.valuePreview = Math.max(value.valueFrom, Math.min(value.valueTo, Number(preview.value)))
        state.colorPreset = 'color'
        value.mode = 'color'
        colorControlsChanged(state)
      })
      slider.appendChild(preview)
      const previewGrab = document.createElement('span')
      previewGrab.className = 'fm-header-color-preview-grab'
      previewGrab.setAttribute('aria-hidden', 'true')
      previewGrab.innerHTML = EYE_ICON
      slider.appendChild(previewGrab)
    }
    group.appendChild(slider)
    group.dataset.suffix = range.suffix
    controls.appendChild(group)
  })

  const transparentLabel = document.createElement('label')
  transparentLabel.className = 'fm-header-color-transparent'
  const transparentInput = document.createElement('input')
  transparentInput.type = 'checkbox'
  transparentInput.dataset.colorTransparent = ''
  transparentInput.addEventListener('change', () => {
    const value = workingColorFilter(state)
    if (!value) return
    value.includeTransparent = transparentInput.checked
    colorControlsChanged(state)
  })
  transparentLabel.appendChild(transparentInput)
  transparentLabel.append(t('filters.includeTransparent'))
  controls.appendChild(transparentLabel)
  parent.appendChild(controls)
}

function buildTypedControls(state: FilterState) {
  const controls = document.createElement('div')
  controls.className = 'fm-header-filter-typed-controls'

  const operator = document.createElement('select')
  operator.className = 'fm-select fm-header-filter-operator'
  operator.setAttribute('aria-label', t('filters.filterOperator', { label: state.def.label }))

  const operators = state.def.type === 'text'
    ? TEXT_OPERATORS
    : state.def.type === 'number'
      ? NUMBER_OPERATORS
      : DATE_OPERATORS
  operator.innerHTML = operators.map((item) => `<option value="${item.value}">${t(item.labelKey)}</option>`).join('')

  const value = document.createElement('input')
  value.className = 'fm-input fm-header-filter-value'
  value.type = state.def.type === 'number' ? 'number' : state.def.type === 'date' ? 'date' : 'text'
  if (state.def.type === 'number') value.step = state.def.autocomplete ? '1' : 'any'
  value.placeholder = t('filters.filterValue', { label: state.def.label })
  value.setAttribute('aria-label', t('filters.filterInput', { label: state.def.label }))
  if ((state.def.type === 'text' || state.def.type === 'number') && state.def.autocomplete) {
    const suggestions = document.createElement('datalist')
    suggestions.id = `${state.panel.id}-suggestions`
    value.setAttribute('list', suggestions.id)
    state.suggestionList = suggestions
    controls.appendChild(suggestions)
  }

  const valueTo = document.createElement('input')
  valueTo.className = 'fm-input fm-header-filter-value'
  valueTo.type = state.def.type === 'number' ? 'number' : 'date'
  if (state.def.type === 'number') valueTo.step = state.def.autocomplete ? '1' : 'any'
  if (state.suggestionList) valueTo.setAttribute('list', state.suggestionList.id)
  valueTo.setAttribute('aria-label', t('filters.upperFilterInput', { label: state.def.label }))

  operator.addEventListener('change', () => {
    setWorkingOperator(state, operator.value)
    syncTypedInputVisibility(state)
    updateTrigger(state)
  })
  value.addEventListener('input', () => {
    if (state.working.type !== 'multi' && state.working.type !== 'color') state.working.value = value.value
    updateTrigger(state)
  })
  valueTo.addEventListener('input', () => {
    if (state.working.type === 'number' || state.working.type === 'date') state.working.valueTo = valueTo.value
    updateTrigger(state)
  })

  state.operatorSelect = operator
  state.valueInput = value
  state.valueToInput = valueTo
  controls.appendChild(operator)
  controls.appendChild(value)
  controls.appendChild(valueTo)
  state.panel.appendChild(controls)
}

function setWorkingOperator(state: FilterState, operator: string) {
  if (state.working.type === 'text') state.working.operator = operator as TextFilterOperator
  else if (state.working.type === 'number') state.working.operator = operator as NumberFilterOperator
  else if (state.working.type === 'date') state.working.operator = operator as DateFilterOperator
}

function syncControls(state: FilterState) {
  if (state.def.type === 'multi') {
    if (state.optionSearchInput) state.optionSearchInput.value = state.optionSearch
    renderMultiList(state)
    if (isColorGridState(state)) syncColorControls(state)
    return
  }
  if (state.def.type === 'color') {
    syncColorControls(state)
    return
  }
  if (state.working.type === 'multi' || state.working.type === 'color') return
  if (state.suggestionList) {
    state.suggestionList.replaceChildren(...state.options.map((item) => {
      const option = document.createElement('option')
      option.value = item.value
      if (item.label !== item.value) option.label = item.label
      return option
    }))
  }
  if (state.operatorSelect) state.operatorSelect.value = state.working.operator
  if (state.valueInput) state.valueInput.value = state.working.value
  if (state.valueToInput && (state.working.type === 'number' || state.working.type === 'date')) {
    state.valueToInput.value = state.working.valueTo
  }
  syncTypedInputVisibility(state)
}

function syncColorControls(state: FilterState) {
  const value = workingColorFilter(state)
  if (!value) return
  const rangeActive = isColumnFilterActive(value)
  const listStarted = state.optionSearch.trim() !== ''
    || (state.working.type === 'multi' && state.working.values.length > 0)
  const rangeLocked = isColorGridState(state) && !rangeActive && listStarted
  const controls = state.panel.querySelector<HTMLElement>('.fm-header-color-controls')
  controls?.classList.toggle('is-inactive', !rangeActive)
  state.colorDisclosure?.classList.toggle('is-locked', rangeLocked)
  state.panel.querySelectorAll<HTMLButtonElement>('[data-color-mode], [data-color-preset], [data-color-neutral]').forEach((button) => {
    button.disabled = rangeLocked
  })
  const neutralPreset = colorNeutralPreset(value.mode)
  const neutralSaturationTo = colorNeutralSaturation(value)
  const [neutralValueFrom, neutralValueTo] = colorNeutralRange(value)
  const displayValue = (field: keyof ColorFilterValue) => {
    if (!neutralPreset) return value[field]
    if (field === 'saturationFrom') return 0
    if (field === 'saturationTo') return neutralSaturationTo
    if (field === 'valueFrom') return neutralValueFrom
    if (field === 'valueTo' || field === 'valuePreview') return neutralValueTo
    return value[field]
  }
  state.panel.querySelectorAll<HTMLInputElement>('[data-color-field]').forEach((input) => {
    const field = input.dataset.colorField as keyof ColorFilterValue
    input.value = String(displayValue(field))
  })
  state.panel.querySelectorAll<HTMLElement>('[data-color-output]').forEach((output) => {
    const from = output.dataset.colorOutput as 'hueFrom' | 'saturationFrom' | 'valueFrom'
    const to = from.replace('From', 'To') as 'hueTo' | 'saturationTo' | 'valueTo'
    const suffix = output.closest<HTMLElement>('.fm-header-color-range')?.dataset.suffix || ''
    const fromValue = Number(displayValue(from))
    const toValue = Number(displayValue(to))
    output.textContent = `${fromValue}${suffix}–${toValue}${suffix}`
    const slider = output.closest<HTMLElement>('.fm-header-color-range')?.querySelector<HTMLElement>('.fm-header-color-dual-range')
    const max = Number(slider?.querySelector<HTMLInputElement>('input')?.max) || 100
    slider?.style.setProperty('--color-range-low', `${Math.min(fromValue, toValue) / max * 100}%`)
    slider?.style.setProperty('--color-range-high', `${Math.max(fromValue, toValue) / max * 100}%`)
    if (slider) slider.dataset.wrap = String(from === 'hueFrom' && value.hueFrom > value.hueTo)
  })
  state.panel.querySelectorAll<HTMLButtonElement>('[data-color-neutral]').forEach((button) => {
    const selected = value.mode === button.dataset.colorNeutral && state.colorPreset === button.dataset.colorNeutral
    button.setAttribute('aria-pressed', String(selected))
    button.classList.toggle('active', selected)
  })
  const chromaticMode = value.mode === 'color'
  const controlsMuted = !chromaticMode || rangeLocked
  const colorMode = state.panel.querySelector<HTMLButtonElement>('[data-color-mode="color"]')
  if (colorMode) {
    const selected = chromaticMode && state.colorPreset === 'color'
    colorMode.setAttribute('aria-pressed', String(selected))
    colorMode.classList.toggle('active', selected)
  }
  state.panel.querySelectorAll<HTMLButtonElement>('[data-color-preset]').forEach((button) => {
    const selected = chromaticMode && state.colorPreset === button.dataset.colorPreset
    button.setAttribute('aria-pressed', String(selected))
    button.classList.toggle('active', selected)
  })
  const saturationLabel = neutralPreset ? t('filters.colorTolerance') : t('filters.saturationRange')
  const saturationHeading = state.panel.querySelector<HTMLElement>('[data-color-range-label="saturationFrom"]')
  if (saturationHeading) saturationHeading.textContent = saturationLabel
  state.panel.querySelectorAll<HTMLInputElement>('[data-color-field="saturationFrom"], [data-color-field="saturationTo"]').forEach((input) => {
    const bound = input.dataset.colorField === 'saturationFrom' ? t('filters.rangeStart') : t('filters.rangeEnd')
    input.setAttribute('aria-label', `${saturationLabel} ${bound}`)
  })
  state.panel.querySelectorAll<HTMLElement>('.fm-header-color-range').forEach((range) => {
    const valueRange = !!range.querySelector('[data-color-output="valueFrom"]')
    const saturationRange = !!range.querySelector('[data-color-output="saturationFrom"]')
    range.classList.toggle('is-muted', value.mode === 'none' || (!!neutralPreset && !valueRange && !saturationRange))
  })
  state.panel.querySelectorAll<HTMLInputElement>('[data-color-field]').forEach((input) => {
    const field = input.dataset.colorField
    input.disabled = rangeLocked || value.mode === 'none'
      || (!!neutralPreset && field !== 'saturationTo' && field !== 'valueFrom' && field !== 'valueTo')
    input.hidden = !!neutralPreset && field === 'valuePreview'
  })
  state.panel.querySelectorAll<HTMLButtonElement>('[data-color-range-reset]').forEach((button) => {
    button.disabled = rangeLocked
    button.hidden = value.mode === 'none' || (!!neutralPreset && button.dataset.colorRangeReset === 'hueFrom')
  })
  const hueGrab = state.panel.querySelector<HTMLElement>('[data-color-grab="hue"]')
  if (hueGrab) {
    hueGrab.tabIndex = controlsMuted ? -1 : 0
    hueGrab.setAttribute('aria-disabled', String(controlsMuted))
  }
  const transparent = state.panel.querySelector<HTMLInputElement>('[data-color-transparent]')
  if (transparent) {
    transparent.checked = value.includeTransparent
    transparent.disabled = rangeLocked
    transparent.closest('.fm-header-color-transparent')?.classList.toggle(
      'is-muted',
      value.mode === 'none' && !value.includeTransparent,
    )
  }
  const wheel = state.panel.querySelector<HTMLElement>('.fm-header-color-wheel')
  if (wheel) {
    const hueSpan = Math.abs(value.hueTo - value.hueFrom) >= 360
      ? 360
      : (value.hueTo - value.hueFrom + 360) % 360
    wheel.style.setProperty('--color-hue-from', neutralPreset ? '0deg' : `${90 - value.hueTo}deg`)
    wheel.style.setProperty('--color-hue-span', neutralPreset ? '360deg' : `${hueSpan}deg`)
    wheel.style.setProperty('--color-saturation-inner', `${neutralPreset ? neutralValueFrom : Math.min(value.saturationFrom, value.saturationTo)}%`)
    wheel.style.setProperty('--color-saturation-outer', `${neutralPreset ? neutralValueTo : Math.max(value.saturationFrom, value.saturationTo)}%`)
    wheel.style.setProperty('--color-wheel-darkness', neutralPreset ? '0' : String(1 - value.valuePreview / 100))
    wheel.style.setProperty('--color-neutral-saturation', String(neutralSaturationTo / 100))
    wheel.style.setProperty('--color-selection-outline', value.mode === 'black' ? 'rgb(255 255 255 / 70%)' : 'rgb(0 0 0 / 65%)')
    wheel.classList.toggle('is-neutral', !!neutralPreset)
    if (neutralPreset) wheel.dataset.neutralMode = value.mode
    else delete wheel.dataset.neutralMode
    wheel.classList.toggle('is-muted', controlsMuted)
    wheel.tabIndex = controlsMuted ? -1 : 0
    wheel.setAttribute('aria-disabled', String(controlsMuted))
    wheel.setAttribute('aria-valuenow', String(Math.round(neutralPreset ? neutralValueTo : (value.hueFrom + hueSpan / 2) % 360)))
    wheel.setAttribute('aria-valuetext', neutralPreset
      ? `${neutralValueFrom}%–${neutralValueTo}%`
      : `${value.hueFrom}°–${value.hueTo}°`)
    const selection = wheel.querySelector<HTMLElement>('.fm-header-color-wheel-selection')
    if (selection) selection.hidden = value.mode === 'none'
  }
  const hueSpan = Math.abs(value.hueTo - value.hueFrom) >= 360 ? 360 : (value.hueTo - value.hueFrom + 360) % 360
  const hueCenter = (value.hueFrom + hueSpan / 2) % 360
  if (hueGrab) {
    const ratio = hueCenter / 360
    hueGrab.style.left = `calc(${(ratio * 100).toFixed(4)}% + ${(8.5 * (1 - 2 * ratio)).toFixed(4)}px)`
    hueGrab.hidden = controlsMuted || value.hueFrom > value.hueTo
    hueGrab.setAttribute('aria-valuenow', String(Math.round(hueCenter)))
    hueGrab.setAttribute('aria-valuetext', `${value.hueFrom}°–${value.hueTo}°`)
  }
  const previewGrab = state.panel.querySelector<HTMLElement>('.fm-header-color-preview-grab')
  if (previewGrab) {
    const previewRatio = Number(displayValue('valuePreview')) / 100
    previewGrab.style.left = `calc(${(previewRatio * 100).toFixed(4)}% + ${(13 * (1 - 2 * previewRatio)).toFixed(4)}px)`
    previewGrab.hidden = value.mode === 'none' || !!neutralPreset
  }
}

function syncTypedInputVisibility(state: FilterState) {
  if (state.working.type === 'multi' || state.working.type === 'color') return
  const noValue = state.working.operator === 'isEmpty' || state.working.operator === 'isNotEmpty'
  const between = state.working.operator === 'between'
  if (state.valueInput) state.valueInput.style.display = noValue ? 'none' : ''
  if (state.valueToInput) state.valueToInput.style.display = !noValue && between ? '' : 'none'
}

function visibleOptions(state: FilterState): HeaderFilterOption[] {
  const query = state.optionSearch.toLowerCase().trim()
  return state.options.filter((option) =>
    (!query || option.label.toLowerCase().includes(query))
    && optionMatchesCandidateColor(state, option),
  )
}

function optionMatchesCandidateColor(state: FilterState, option: HeaderFilterOption): boolean {
  return !state.candidateColor
    || !isColumnFilterActive(state.candidateColor)
    || matchesColumnFilter(option.colorHexes || [], state.candidateColor)
}

function updateVisibleMultiOptions(state: FilterState, selected: boolean) {
  if (state.working.type !== 'multi') return
  const values = new Set(state.working.values)
  visibleOptions(state).forEach((option) => selected ? values.add(option.value) : values.delete(option.value))
  state.working.values = [...values]
  renderMultiList(state)
  updateTrigger(state)
}

function renderMultiList(state: FilterState) {
  if (!state.list || state.working.type !== 'multi') return
  const options = state.def.multiDisplay === 'colors' && state.optionView === 'swatches'
    ? [...visibleOptions(state)].sort(compareColorOptions)
    : visibleOptions(state)
  state.list.classList.toggle('fm-color-grid', state.def.multiDisplay === 'colors' && state.optionView === 'swatches')
  if (options.length === 0) {
    state.list.innerHTML = `<div class="fm-header-filter-empty-text">${escapeHtml(t('filters.noMatchingOptions'))}</div>`
    return
  }
  const selected = new Set(state.working.values)
  state.list.innerHTML = options.map((option) => {
    const checked = selected.has(option.value) ? 'checked' : ''
    const swatches = renderOptionSwatches(option)
    if (state.def.multiDisplay === 'colors' && state.optionView === 'swatches') {
      return `<label class="fm-header-filter-color-option" title="${escapeHtml(option.label)}"><input type="checkbox" data-value="${escapeHtml(option.value)}" ${checked} />${renderColorGridSwatch(option)}<span class="fm-sr-only">${escapeHtml(option.label)}</span></label>`
    }
    return `<label class="fm-header-filter-option"><input type="checkbox" data-value="${escapeHtml(option.value)}" ${checked} />${swatches}<span>${escapeHtml(option.label)}</span></label>`
  }).join('')
  state.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (state.working.type !== 'multi') return
      const values = new Set(state.working.values)
      const optionValue = input.dataset.value || ''
      if (input.checked) values.add(optionValue)
      else values.delete(optionValue)
      state.working.values = [...values]
      if (isColorGridState(state)) syncColorControls(state)
      updateTrigger(state)
    })
  })
}

function renderColorGridSwatch(option: HeaderFilterOption): string {
  const color = (option.colorHexes || []).map(normalizeHexCode).find(Boolean)
  const style = color ? ` style="background:${escapeHtml(toColorSwatchBackground(color))}"` : ''
  return `<span class="fm-color-swatch"${style}>${color ? '' : '<span class="fm-header-filter-empty-swatch">&mdash;</span>'}</span>`
}

function renderOptionSwatches(option: HeaderFilterOption): string {
  const colors = (option.colorHexes || []).map(normalizeHex).filter((hex): hex is string => Boolean(hex))
  if (colors.length === 0) return ''
  return `<span class="fm-header-filter-color-dots" aria-hidden="true">${colors.map((hex) =>
    `<span class="fm-header-filter-color-dot" style="background:${hex}"></span>`).join('')}</span>`
}

function normalizeHex(value: string): string | null {
  return toOpaqueRgbHex(value, '') || null
}

function compareColorOptions(a: HeaderFilterOption, b: HeaderFilterOption): number {
  const aSort = colorSortKey(a.colorHexes?.[0])
  const bSort = colorSortKey(b.colorHexes?.[0])
  for (let index = 0; index < aSort.length; index++) {
    if (aSort[index] !== bSort[index]) return aSort[index] - bSort[index]
  }
  return a.label.localeCompare(b.label)
}

function colorSortKey(value?: string): [number, number, number, number] {
  const hex = value ? normalizeHex(value) : null
  if (!hex) return [2, 0, 0, 0]
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  // Neutrals read best as a dark-to-light strip before the hue wheel.
  return saturation < 0.12
    ? [0, 0, Math.round(lightness * 1000), 0]
    : [1, Math.round(hue * 10), Math.round(lightness * 1000), Math.round(saturation * 1000)]
}

function triggerActivity(state: FilterState): { active: boolean; pending: boolean } {
  // For multi filters that default to "all selected", only flag as active once something is deselected.
  const active = state.def.type === 'multi' && state.applied.type === 'multi' && state.options.length > 0
    ? state.applied.values.length > 0 && state.applied.values.length < state.options.length
    : isColumnFilterActive(state.applied)
  const pending = state.def.type === 'color' || isColorGridState(state)
    ? active
    : !sameFilter(state.applied, state.working)
  return { active, pending }
}

function updateTrigger(state: FilterState) {
  const own = triggerActivity(state)
  const linked = state.linkedStates.map(triggerActivity)
  const active = own.active || linked.some((activity) => activity.active)
  const pending = own.pending || linked.some((activity) => activity.pending)
  state.trigger.classList.toggle('active', active)
  state.trigger.classList.toggle('pending', pending)
  state.trigger.setAttribute(
    'aria-label',
    t(active ? 'filters.filterColumnActive' : 'filters.filterColumn', { label: state.def.label }),
  )
  if (state.parentState) updateTrigger(state.parentState)
}
