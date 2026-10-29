/** Shared printer setup for filament settings and physical-spool exceptions. */
import { api } from './api'
import { escapeHtml, hasOwnFieldValue, setOwnFieldValue, type SystemExtraFieldDef } from './extra-fields'
import { getMe, hasPermission } from './auth'
import { initPerModelProfilePicker } from './cloud-profile-picker'

export type ParameterValues = Record<string, string | null>
export type ParameterDraft = Record<string, string | null>

type WriteOptions = { csrfToken?: string | null; signal?: AbortSignal }

export function resolveParameter(key: string, own: ParameterValues, inherited: ParameterValues, draft: ParameterDraft) {
  const hasDraft = hasOwnFieldValue(draft, key)
  const local = hasDraft ? draft[key] : own[key]
  if ((hasDraft && local !== null) || (!hasDraft && hasOwnFieldValue(own, key))) {
    return { value: local, source: local === '' || local === null ? 'blank' : 'own' } as const
  }
  if (hasOwnFieldValue(inherited, key)) {
    const value = inherited[key]
    return { value, source: value === '' || value === null ? 'blank' : 'filament' } as const
  }
  return { value: null, source: 'unset' } as const
}

export function parameterChanges(own: ParameterValues, draft: ParameterDraft) {
  const updates: { param_key: string; param_value: string }[] = []
  const deletes: string[] = []
  for (const [key, value] of Object.entries(draft)) {
    if (value === null || value === '') {
      if (hasOwnFieldValue(own, key)) deletes.push(key)
    } else if (!hasOwnFieldValue(own, key) || own[key] !== value) {
      updates.push({ param_key: key, param_value: value })
    }
  }
  return { updates, deletes }
}

export function reconcileParameterDraft(previous: ParameterValues, next: ParameterValues, draft: ParameterDraft, previousInherited: ParameterValues = {}, nextInherited: ParameterValues = {}) {
  const remaining: [string, string | null][] = []
  const conflicts: string[] = []
  for (const [key, value] of Object.entries(draft)) {
    const nextOwn = hasOwnFieldValue(next, key)
    if (value === null ? !nextOwn : nextOwn && next[key] === value) continue
    remaining.push([key, value])
    const before = resolveParameter(key, previous, previousInherited, {})
    const after = resolveParameter(key, next, nextInherited, {})
    const resetParentChanged = value === null && (hasOwnFieldValue(previousInherited, key) !== hasOwnFieldValue(nextInherited, key) || previousInherited[key] !== nextInherited[key])
    if (before.source !== after.source || before.value !== after.value || resetParentChanged) conflicts.push(key)
  }
  return { draft: Object.fromEntries(remaining), conflicts }
}

export async function writeParameterChanges(path: string, own: ParameterValues, draft: ParameterDraft, options: WriteOptions) {
  const changes = parameterChanges(own, draft)
  if (changes.updates.length) await api.put(path, { params: changes.updates }, options)
  for (const key of changes.deletes) await api.delete(`${path}?param_key=${encodeURIComponent(key)}`, options)
}

interface Printer { id: number; name: string; driver_key: string; is_active?: boolean }
interface Plugin { name: string; driver_key?: string; is_active?: boolean }
interface ParamRecord { param_key: string; param_value: string | null }
interface PrinterState {
  printer: Printer
  fields: (SystemExtraFieldDef & { readOnly?: boolean })[]
  own: ParameterValues
  inherited: ParameterValues
  draft: ParameterDraft
  conflicts: Set<string>
  epoch: number
  loaded: boolean
  loading?: Promise<void>
  available: boolean
  expanded: boolean
  error: string
}

export interface PrinterSetupOptions {
  mount: HTMLElement
  entityType: 'filament' | 'spool'
  entityId: number
  filamentId?: number
  filamentLabel?: string
  t: (key: string) => string
  getCsrfToken: () => string
  getAbortSignal?: () => AbortSignal | undefined
  isAbortError?: (error: unknown) => boolean
  editing?: boolean
  onDirtyChange?: () => void
}

const BAMBUDDY_MANAGED_KEYS = new Set(['bambu_setting_id', 'bambu_slicer_setting_id'])
const CALIBRATION_KEYS = new Set(['bambu_k_value', 'bambu_cali_idx'])
const TECHNICAL_KEYS = new Set(['bambu_idx', 'bambu_tray_idx', 'bambuddy_spool_id'])
const METADATA_KEYS = new Set(['bambu_bed_temp', 'bambu_flow_ratio', 'bambu_max_volumetric_speed'])
const NOZZLE_KEYS = ['bambu_nozzle_temp_min', 'bambu_nozzle_temp_max']
const pluginIcon = '<svg class="printer-setup-plugin-icon" aria-hidden="true"><use href="/icons.svg#icon-plugin"></use></svg>'
const resetIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10a9 9 0 1 1 2.5 8M3 4v6h6"/></svg>'

/** Owns drafts per physical printer; profile selection keeps its existing API. */
export function initPrinterSetup(opts: PrinterSetupOptions) {
  const root = opts.mount
  const states = new Map<number, PrinterState>()
  const abort = new AbortController()
  const signal = abort.signal
  const externalSignal = opts.getAbortSignal?.()
  let disposed = false
  let permitted = false
  let editing = opts.editing ?? false
  let saving = false
  let pendingSave = false
  let profileWrites = 0
  let profileAbort: AbortController | null = null
  let managePlugins = false
  let managePrinters = false
  let plugins: Plugin[] = []
  let refreshEpoch = 0
  let refreshing: Promise<void> | undefined
  let refreshFailed = false
  const spool = opts.entityType === 'spool'
  const tr = (key: string, vars: Record<string, string | number> = {}) => {
    let text = opts.t(`printerSetup.${key}`)
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const requestOptions = () => ({ signal, csrfToken: opts.getCsrfToken() })
  const entityPath = `/${spool ? 'spools' : 'filaments'}/${opts.entityId}/printer-params`
  const hasChanges = (state: PrinterState) => {
    const { updates, deletes } = parameterChanges(state.own, state.draft)
    return updates.length + deletes.length > 0
  }
  const dirty = () => [...states.values()].some(hasChanges)
  const editableField = (state: PrinterState, key: string) => permitted && editing && !saving && state.available && !state.fields.find(field => field.key === key)?.readOnly && !(state.printer.driver_key === 'bambuddy' && BAMBUDDY_MANAGED_KEYS.has(key))
  const driverName = (printer: Printer) => plugins.find(item => item.driver_key === printer.driver_key)?.name || ({ bambuddy: 'Bambuddy', bambulab: 'Bambu Lab' }[printer.driver_key] ?? printer.driver_key) || tr('driver')
  const driverMark = (printer: Printer) => ['bambuddy', 'bambulab'].includes(printer.driver_key) ? `<img class="printer-setup-driver-logo" src="/driver-logos/${printer.driver_key}.${printer.driver_key === 'bambuddy' ? 'png' : 'svg'}" alt="">` : ''
  const driverLink = (printer: Printer) => managePlugins ? `<a href="/admin/system">${driverMark(printer)}${escapeHtml(driverName(printer))}</a>` : `<span>${driverMark(printer)}${escapeHtml(driverName(printer))}</span>`
  const driverStatus = (printer: Printer) => plugins.find(item => item.driver_key === printer.driver_key)?.is_active === false ? tr('driverDisabled') : printer.is_active === false ? tr('printerDisabled') : tr('printerEnabled')
  const toValues = (rows: ParamRecord[]): ParameterValues => Object.fromEntries(rows.map(row => [row.param_key, row.param_value]))
  const read = <T,>(path: string) => api.get<T>(path, { signal })
  const blank = (value: string | null) => value === '' || value === null
  const numericBounds = (field: SystemExtraFieldDef) => `${field.config?.min_bound != null ? ` min="${escapeHtml(String(field.config.min_bound))}"` : ''}${field.config?.max_bound != null ? ` max="${escapeHtml(String(field.config.max_bound))}"` : ''}`
  const display = (field: SystemExtraFieldDef, value: string | null) => blank(value) ? '—' : field.field_type === 'checkbox' ? opts.t(value === 'true' || value === '1' ? 'common.yes' : 'common.no') : String(value)

  root.innerHTML = `
    <section id="slicer-profile-section" class="printer-setup-card fm-card hidden" aria-labelledby="slicer-profile-title"><header class="printer-setup-heading filament-spec-title"><h2 id="slicer-profile-title">${escapeHtml(tr('profilesTitle'))}</h2><div data-profile-provider class="printer-setup-links"></div></header><div class="printer-setup-card-body"><fieldset data-profile-controls><div id="slicer-profile-picker"></div><div id="slicer-profile-coverage" class="hidden"></div><p id="slicer-profile-msg" role="status" class="hidden"></p></fieldset></div></section>
    <section data-printer-settings class="printer-setup-card fm-card" aria-labelledby="printer-setup-title"><header class="printer-setup-heading filament-spec-title"><h2 id="printer-setup-title">${escapeHtml(tr('filamentTitle'))}</h2><span class="printer-setup-source"></span></header><div class="printer-setup-card-body"><div data-setup-error role="alert" class="printer-setup-error hidden"></div><div data-setup-printers class="printer-setup-printers"></div></div></section>`

  renderSource()

  function renderSource() {
    const source = root.querySelector<HTMLElement>('.printer-setup-source')!
    source.innerHTML = spool && opts.filamentId ? `<a href="/filaments/${opts.filamentId}" title="${escapeHtml(opts.filamentLabel || '')}">${escapeHtml(tr('filamentLink', { id: opts.filamentId }))}</a>` : ''
  }

  async function setFilament(id: number, label?: string) {
    if (!spool || opts.filamentId === id) return
    // A pending read belongs to the previous parent and must not supply inheritance.
    for (const state of states.values()) { state.epoch++; state.loading = undefined }
    opts.filamentId = id
    opts.filamentLabel = label
    renderSource()
    await refresh()
    await renderProfiles()
  }

  const ownsKey = (state: PrinterState, key: string) => hasOwnFieldValue(state.draft, key) ? state.draft[key] !== null : hasOwnFieldValue(state.own, key)
  const fieldUnit = (field: SystemExtraFieldDef) => field.config?.unit ?? (field.key.startsWith('bambu_nozzle_temp_') || field.key === 'bambu_bed_temp' ? '°C' : field.key === 'bambu_default_nozzle_mm' ? 'mm' : field.key === 'bambu_max_volumetric_speed' ? 'mm³/s' : '')
  function sameValue(field: SystemExtraFieldDef, a: string | null, b: string | null) {
    if (blank(a) || blank(b)) return blank(a) && blank(b)
    if (field.field_type === 'checkbox') return ['true', '1'].includes(a!) === ['true', '1'].includes(b!)
    if (field.field_type === 'number' || NOZZLE_KEYS.includes(field.key)) return Number(a) === Number(b)
    return a === b
  }
  const differs = (state: PrinterState, key: string) => spool && ownsKey(state, key) && !sameValue(state.fields.find(field => field.key === key)!, resolveParameter(key, state.own, state.inherited, state.draft).value, state.inherited[key] ?? null)
  function fieldHint(state: PrinterState, keys: string[]) {
    const values = keys.map(key => resolveParameter(key, state.own, state.inherited, state.draft))
    if (state.printer.driver_key === 'bambuddy' && keys.some(key => BAMBUDDY_MANAGED_KEYS.has(key))) return tr('profileManaged')
    if (values.some(value => value.source === 'blank')) return tr('storedBlank')
    if (values.every(value => blank(value.value))) return editing && keys.some(key => state.fields.find(field => field.key === key)?.field_type === 'checkbox') ? tr('notSet') : ''
    if (keys.some(key => differs(state, key))) return tr('spoolValue')
    return editing ? tr(spool && values.some(value => value.source === 'own') ? 'spoolValue' : 'filamentValue') : ''
  }
  function renderControl(state: PrinterState, keys: string[], control: string, unit: string, action: string) {
    return `<div class="printer-setup-control"><span class="printer-setup-reset-slot">${action}</span><div class="printer-setup-entry"><div class="printer-setup-inputs">${control}</div><span class="printer-setup-origin">${escapeHtml(fieldHint(state, keys))}</span></div><span class="printer-setup-unit">${escapeHtml(unit)}</span></div>`
  }
  function renderField(state: PrinterState, field: SystemExtraFieldDef): string {
    const key = field.key
    const resolved = resolveParameter(key, state.own, state.inherited, state.draft)
    const owns = ownsKey(state, key)
    const canEdit = editableField(state, key)
    const id = `printer-param-${state.printer.id}-${encodeURIComponent(key)}`
    const unit = fieldUnit(field)
    const label = key === 'bambu_nozzle_temp_min' ? tr('nozzleMin') : key === 'bambu_nozzle_temp_max' ? tr('nozzleMax') : key === 'bambu_k_value' ? tr('pressureAdvance') : key === 'bambu_default_nozzle_mm' ? tr('fallbackNozzle') : field.label
    const value = resolved.value ?? ''
    const number = field.field_type === 'number'
    let control = `<strong class="printer-setup-value${blank(resolved.value) ? ' is-empty' : ''}">${escapeHtml(display(field, resolved.value))}</strong>`
    if (canEdit) {
      const attributes = `id="${id}" data-setup-value="${escapeHtml(key)}" aria-label="${escapeHtml(label)}"`
      if (field.field_type === 'checkbox') control = `<input type="checkbox" ${attributes} ${value === 'true' || value === '1' ? 'checked' : ''}>`
      else if (field.field_type === 'dropdown') {
        const options = field.options || []
        const values = value && !options.includes(value) ? [value, ...options] : options
        control = `<select class="fm-select" ${attributes}><option value="">—</option>${values.map(option => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`
      } else control = `<input class="fm-input ${number ? 'printer-setup-number' : ''}" type="${number ? 'number' : 'text'}" ${attributes} placeholder="—" value="${escapeHtml(value)}" ${number ? 'step="any"' : 'maxlength="500"'}${number ? numericBounds(field) : ''}>`
    }
    const action = canEdit ? `<button type="button" class="printer-setup-reset${owns ? '' : ' hidden'}" data-setup-action="reset" data-key="${escapeHtml(key)}" aria-label="${escapeHtml(tr(spool ? 'resetToFilament' : 'clearCustom'))}: ${escapeHtml(label)}" title="${escapeHtml(tr(spool ? 'resetToFilament' : 'clearCustom'))}">${resetIcon}</button>` : ''
    const base = spool && hasOwnFieldValue(state.inherited, key) ? `<span class="printer-setup-base${differs(state, key) ? '' : ' hidden'}">${escapeHtml(tr('filamentValue'))}: ${escapeHtml(display(field, state.inherited[key]))}${unit ? ` ${escapeHtml(unit)}` : ''}</span>` : ''
    return `<div class="printer-setup-field" data-parameter="${escapeHtml(key)}" data-type="${escapeHtml(field.field_type || 'text')}" data-owned="${differs(state, key)}"><label ${canEdit ? `for="${id}"` : ''}${key === 'bambu_default_nozzle_mm' ? ` title="${escapeHtml(tr('fallbackNozzleHint'))}"` : ''}>${escapeHtml(label)}</label><div class="printer-setup-field-content">${renderControl(state, [key], control, unit, action)}${base}</div>${renderConflict(state, key)}</div>`
  }

  function renderConflict(state: PrinterState, key: string) {
    return state.conflicts.has(key) ? `<div class="printer-setup-conflict" data-parameter="${escapeHtml(key)}" role="alert"><span>${escapeHtml(tr('conflict'))}</span><button type="button" class="fm-btn fm-btn-outline" data-setup-action="keep" data-key="${escapeHtml(key)}">${escapeHtml(tr('keepEdit'))}</button><button type="button" class="fm-btn fm-btn-outline" data-setup-action="updated" data-key="${escapeHtml(key)}">${escapeHtml(tr('useUpdated'))}</button></div>` : ''
  }

  function renderNozzleRange(state: PrinterState) {
    const values = NOZZLE_KEYS.map(key => resolveParameter(key, state.own, state.inherited, state.draft))
    const owned = NOZZLE_KEYS.some(key => ownsKey(state, key))
    const canEdit = NOZZLE_KEYS.every(key => editableField(state, key))
    const rangeText = (items: (string | null)[]) => items.every(blank) ? '—' : items.map(value => blank(value) ? '—' : value).join('–')
    const inputs = NOZZLE_KEYS.map((key, index) => canEdit ? `<input class="fm-input printer-setup-number" type="number" step="any" placeholder="—" data-setup-value="${key}" aria-label="${escapeHtml(tr(index === 0 ? 'nozzleMin' : 'nozzleMax'))}" value="${escapeHtml(values[index].value ?? '')}"${numericBounds(state.fields.find(field => field.key === key)!)}>` : `<strong class="printer-setup-value${blank(values[index].value) ? ' is-empty' : ''}">${escapeHtml(values[index].value || '—')}</strong>`).join('<span class="printer-setup-range-separator" aria-hidden="true">–</span>')
    const action = canEdit ? `<button type="button" class="printer-setup-reset${owned ? '' : ' hidden'}" data-setup-action="range-reset" aria-label="${escapeHtml(tr(spool ? 'resetToFilament' : 'clearCustom'))}: ${escapeHtml(tr('nozzleRange'))}" title="${escapeHtml(tr(spool ? 'resetToFilament' : 'clearCustom'))}">${resetIcon}</button>` : ''
    const different = NOZZLE_KEYS.some(key => differs(state, key))
    const base = spool ? `<span class="printer-setup-base${different ? '' : ' hidden'}">${escapeHtml(tr('filamentValue'))}: ${escapeHtml(rangeText(NOZZLE_KEYS.map(key => state.inherited[key] ?? null)))} °C</span>` : ''
    return `<div class="printer-setup-field printer-setup-range" data-parameter="nozzle-range" data-type="number" data-owned="${different}"><span class="printer-setup-field-label">${escapeHtml(tr('nozzleRange'))}</span><div class="printer-setup-field-content">${renderControl(state, NOZZLE_KEYS, inputs, '°C', action)}${base}</div>${NOZZLE_KEYS.map(key => renderConflict(state, key)).join('')}</div>`
  }

  function renderStates() {
    if (disposed) return
    const list = root.querySelector<HTMLElement>('[data-setup-printers]')!
    const additionalOpen = new Set([...list.querySelectorAll('details.printer-setup-additional[open]')].map(panel => panel.closest<HTMLElement>('[data-printer-id]')!.dataset.printerId))
    for (const panel of list.querySelectorAll<HTMLDetailsElement>('details.printer-setup-printer')) {
      const state = states.get(Number(panel.dataset.printerId))
      if (state) state.expanded = panel.open
    }
    list.innerHTML = [...states.values()].filter(state => !state.loaded || state.fields.length || state.error || !state.available).map(state => {
      const { printer } = state
      const calibration = state.fields.filter(field => CALIBRATION_KEYS.has(field.key))
      const advanced = state.fields.filter(field => TECHNICAL_KEYS.has(field.key) || BAMBUDDY_MANAGED_KEYS.has(field.key))
      const primary = state.fields.filter(field => !calibration.includes(field) && !advanced.includes(field))
      const hasRange = NOZZLE_KEYS.every(key => primary.some(field => field.key === key))
      calibration.sort((a, b) => Number(a.key === 'bambu_cali_idx') - Number(b.key === 'bambu_cali_idx'))
      return `<details class="printer-setup-printer" data-printer-id="${printer.id}" ${state.expanded ? 'open' : ''}><summary class="printer-setup-printer-heading"><svg class="printer-setup-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg><div class="printer-setup-identity"><svg class="printer-setup-printer-icon" aria-hidden="true"><use href="/icons.svg#icon-printers"></use></svg><h4>${escapeHtml(printer.name)}</h4>${managePrinters ? `<a class="printer-setup-settings" href="/printers/${printer.id}" aria-label="${escapeHtml(tr('settings'))}: ${escapeHtml(printer.name)}" title="${escapeHtml(tr('settings'))}"><svg aria-hidden="true"><use href="/icons.svg#icon-settings"></use></svg></a>` : ''}<span data-printer-dirty class="printer-setup-dirty hidden">${escapeHtml(opts.t('filaments.changed'))}</span></div><div class="printer-setup-links"><span class="printer-setup-driver-label">${pluginIcon}${driverLink(printer)}</span><span class="printer-setup-activation">${escapeHtml(driverStatus(printer))}</span></div></summary><div class="printer-setup-printer-body">
        ${!state.available ? `<p class="printer-setup-error">${escapeHtml(tr('unavailable'))}</p>` : ''}
        ${state.error ? `<p role="alert" class="printer-setup-error">${escapeHtml(state.error)}</p>` : ''}
        ${!state.loaded ? state.loading ? `<p role="status">${escapeHtml(opts.t('common.loading'))}</p>` : `<button type="button" class="fm-btn fm-btn-outline" data-setup-action="retry">${escapeHtml(tr('retry'))}</button>` : state.fields.length === 0 ? `<p class="printer-setup-note">${escapeHtml(tr('noFields'))}</p>` : `
        <div class="printer-setup-groups"><div>${primary.length ? `<div class="printer-setup-group-title"><h5>${escapeHtml(tr('assignment'))}</h5>${printer.driver_key === 'bambuddy' ? `<span>${escapeHtml(tr('assignmentHint'))}</span>` : ''}</div>${hasRange ? renderNozzleRange(state) : ''}${primary.filter(field => !hasRange || !NOZZLE_KEYS.includes(field.key)).map(field => renderField(state, field)).join('')}${printer.driver_key === 'bambuddy' && primary.some(field => METADATA_KEYS.has(field.key)) ? `<p class="printer-setup-note">${escapeHtml(tr('metadataHint'))}</p>` : ''}` : ''}</div>
        ${calibration.length ? `<div><div class="printer-setup-group-title"><h5>${escapeHtml(tr('calibration'))}</h5><span>${escapeHtml(tr('calibrationHint'))}</span></div>${calibration.map(field => renderField(state, field)).join('')}</div>` : ''}</div>
        ${advanced.length ? `<details class="printer-setup-additional" ${additionalOpen.has(String(printer.id)) ? 'open' : ''}><summary>${escapeHtml(tr('additional'))}</summary>${advanced.map(field => renderField(state, field)).join('')}</details>` : ''}
        `}</div></details>`
    }).join('')
    root.querySelector<HTMLElement>('[data-printer-settings]')!.classList.toggle('hidden', !list.childElementCount)
    syncStatus()
  }

  function syncStatus() {
    for (const state of states.values()) {
      const panel = root.querySelector(`[data-printer-id="${state.printer.id}"]`)
      const changes = parameterChanges(state.own, state.draft)
      const keys = new Set([...changes.updates.map(item => item.param_key), ...changes.deletes])
      panel?.querySelector('[data-printer-dirty]')?.classList.toggle('hidden', !keys.size)
      for (const field of panel?.querySelectorAll<HTMLElement>('.printer-setup-field') ?? []) {
        const fields = field.dataset.parameter === 'nozzle-range' ? NOZZLE_KEYS : [field.dataset.parameter!]
        field.classList.toggle('is-dirty', fields.some(key => keys.has(key)))
      }
    }
    opts.onDirtyChange?.()
  }

  function loadState(state: PrinterState, fresh = false): Promise<void> {
    if (state.loading && !fresh) return state.loading
    const loading = readState(state).finally(() => { if (state.loading === loading) state.loading = undefined })
    state.loading = loading
    return loading
  }

  async function readState(state: PrinterState) {
    const epoch = ++state.epoch
    try {
      const [fields, own, inherited] = await Promise.all([
        read<SystemExtraFieldDef[]>(`/printers/${state.printer.id}/parameter-fields?target_type=${opts.entityType}_printer_param`),
        read<ParamRecord[]>(`${entityPath}?printer_id=${state.printer.id}`),
        spool && opts.filamentId ? read<ParamRecord[]>(`/filaments/${opts.filamentId}/printer-params?printer_id=${state.printer.id}`) : Promise.resolve([]),
      ])
      if (disposed || epoch !== state.epoch) return
      const next = toValues(own)
      const nextInherited = toValues(inherited)
      const reconciled = reconcileParameterDraft(state.own, next, state.draft, state.inherited, nextInherited)
      state.conflicts = new Set([...state.conflicts, ...reconciled.conflicts].filter(key => hasOwnFieldValue(reconciled.draft, key)))
      state.draft = reconciled.draft
      state.own = next
      state.inherited = nextInherited
      const declared = new Set(fields.map(field => field.key))
      state.fields = [...fields, ...[...new Set([...Object.keys(next), ...Object.keys(nextInherited)])]
        .filter(key => !declared.has(key)).map(key => ({ key, label: key, field_type: 'text', readOnly: true }))]
      state.loaded = true
      state.error = ''
    } catch (error) {
      if (disposed || epoch !== state.epoch) return
      state.loaded = false
      state.error = error instanceof Error ? error.message : tr('loadFailed')
    }
  }

  function refresh(): Promise<void> {
    const current = refreshing = refreshStates()
    void current.finally(() => { if (refreshing === current) refreshing = undefined })
    return current
  }

  async function refreshStates() {
    const epoch = ++refreshEpoch
    try {
      const response = await read<{ items: Printer[] } | Printer[]>('/printers?page_size=200')
      if (disposed || epoch !== refreshEpoch) return
      refreshFailed = false
      root.querySelector('[data-setup-error]')!.classList.add('hidden')
      const printers = Array.isArray(response) ? response : response.items
      for (const state of states.values()) state.available = printers.some(printer => printer.id === state.printer.id)
      for (const printer of printers) {
        if (!states.has(printer.id)) states.set(printer.id, { printer, fields: [], own: {}, inherited: {}, draft: {}, conflicts: new Set(), epoch: 0, loaded: false, available: true, expanded: states.size === 0, error: '' })
        else states.get(printer.id)!.printer = printer
      }
      if (!states.size) { root.classList.add('hidden'); return }
      root.classList.remove('hidden')
      await Promise.all([...states.values()].filter(state => state.available && (state.loaded || state.expanded || hasChanges(state))).map(state => loadState(state, true)))
      if (!disposed && epoch === refreshEpoch) renderStates()
    } catch (error) {
      if (disposed || epoch !== refreshEpoch) return
      refreshFailed = true
      root.classList.remove('hidden')
      const message = root.querySelector<HTMLElement>('[data-setup-error]')!
      message.textContent = error instanceof Error ? error.message : tr('loadFailed')
      message.classList.remove('hidden')
    }
  }

  async function save(saveEntity?: () => Promise<void>) {
    if (profileWrites) throw new Error(tr('resolveBeforeSave'))
    if (pendingSave || saving || disposed) throw new Error(tr('saveFailed'))
    pendingSave = true
    root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = true
    try {
      await ready
      if (refreshFailed && !refreshing) void refresh()
      // Refresh includes printer discovery, before per-printer reads even exist.
      while (refreshing) {
        const current = refreshing
        await current
        if (current === refreshing) break
      }
      const changed = [...states.values()].filter(hasChanges)
      if (!permitted || !editing || saving || disposed) throw new Error(tr('saveFailed'))
      if (refreshFailed || changed.some(state => !state.available || !state.loaded || state.conflicts.size)) throw new Error(tr('resolveBeforeSave'))
      // Validate every printer before any entity or parameter write.
      for (const control of root.querySelectorAll<HTMLInputElement>('input[data-setup-value], select[data-setup-value]')) {
        if (!control.reportValidity()) throw new Error(opts.t('common.invalidValue'))
      }
      saving = true
      root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = true
      renderStates()
      try {
        await saveEntity?.()
        if (changed.some(state => state.conflicts.size || !state.loaded || !state.available)) throw new Error(tr('resolveBeforeSave'))
        for (const state of changed) {
          state.error = ''
          let failure = ''
          try {
            await writeParameterChanges(`${entityPath}/${state.printer.id}`, state.own, state.draft, requestOptions())
          } catch (error) {
            failure = error instanceof Error ? error.message : tr('saveFailed')
          }
          await loadState(state, true)
          if (disposed) throw new DOMException('Disposed', 'AbortError')
          state.error = failure || state.error
          if (state.error || hasChanges(state)) throw new Error(`${state.printer.name}: ${state.error || tr('saveFailed')}`)
        }
      } finally {
        saving = false
        root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = !editing || !permitted || pendingSave
        renderStates()
      }
    } finally {
      pendingSave = false
      root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = !editing || !permitted
    }
  }

  async function setEditing(value: boolean) {
    if (pendingSave || saving || profileWrites || disposed) return
    const changed = editing !== value
    editing = value
    if (changed) {
      profileAbort?.abort()
      root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = true
      root.querySelector('#slicer-profile-picker')!.replaceChildren()
    }
    if (!editing) for (const state of states.values()) { state.draft = {}; state.conflicts.clear(); state.error = '' }
    renderStates()
    if (changed) { await ready; if (!disposed) await renderProfiles() }
  }

  function onClick(event: Event) {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-setup-action]')
    const article = button?.closest<HTMLElement>('[data-printer-id]')
    if (!button || !article) return
    const state = states.get(Number(article.dataset.printerId))!
    const key = button.dataset.key || ''
    const action = button.dataset.setupAction
    if (action === 'retry') { void loadState(state).then(renderStates); return }
    if (action === 'range-reset') {
      if (!NOZZLE_KEYS.every(rangeKey => editableField(state, rangeKey))) return
      for (const rangeKey of NOZZLE_KEYS) {
        const value = null
        setOwnFieldValue(state.draft, rangeKey, value)
        state.conflicts.delete(rangeKey)
      }
      renderStates()
      return
    }
    if (!editableField(state, key)) return
    if (action === 'reset') {
      setOwnFieldValue(state.draft, key, null)
      state.conflicts.delete(key)
    } else if (action === 'updated') {
      delete state.draft[key]; state.conflicts.delete(key)
    } else if (action === 'keep') state.conflicts.delete(key)
    renderStates()
  }

  function onToggle(event: Event) {
    const panel = event.target as HTMLDetailsElement
    if (!panel.matches('details.printer-setup-printer') || !root.contains(panel)) return
    const state = states.get(Number(panel.dataset.printerId))!
    state.expanded = panel.open
    if (panel.open && state.available && !state.loaded && !state.loading && !state.error) {
      const loading = loadState(state)
      renderStates()
      void loading.then(renderStates)
    }
  }

  function onInput(event: Event) {
    const input = event.target as HTMLInputElement
    const key = input.dataset.setupValue
    const article = input.closest<HTMLElement>('[data-printer-id]')
    if (!key || !article) return
    const state = states.get(Number(article.dataset.printerId))!
    if (!editableField(state, key)) return
    const value = input.type === 'checkbox' ? String(input.checked) : input.value.trim() || null
    const baseline = resolveParameter(key, state.own, state.inherited, {})
    if (sameValue(state.fields.find(field => field.key === key)!, value, baseline.value)) delete state.draft[key]
    else setOwnFieldValue(state.draft, key, value)
    const field = input.closest<HTMLElement>('.printer-setup-field')!
    const range = field.dataset.parameter === 'nozzle-range'
    const keys = range ? NOZZLE_KEYS : [key]
    const owns = keys.some(k => hasOwnFieldValue(state.draft, k) ? state.draft[k] !== null : hasOwnFieldValue(state.own, k))
    const different = keys.some(k => differs(state, k))
    field.dataset.owned = String(different)
    field.querySelector('.printer-setup-reset')?.classList.toggle('hidden', !owns)
    field.querySelector('.printer-setup-base')?.classList.toggle('hidden', !different)
    const origin = field.querySelector<HTMLElement>('.printer-setup-origin')!
    origin.textContent = fieldHint(state, keys)
    syncStatus()
  }
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty() || pendingSave) { event.preventDefault(); event.returnValue = '' } }
  function beforeNavigation(event: MouseEvent) {
    if (!dirty() && !pendingSave && !saving) return
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
    if (link && (pendingSave || saving)) { event.preventDefault(); event.stopImmediatePropagation(); return }
    if (link?.hasAttribute('data-discard-printer-draft')) return
    if (!link || link.target === '_blank' || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#')) return
    if (link.origin === location.origin && link.pathname === location.pathname && link.search === location.search) return
    if (!window.confirm(tr('discard'))) { event.preventDefault(); event.stopImmediatePropagation() }
  }
  function dispose() {
    disposed = true
    abort.abort()
    profileAbort?.abort()
    root.removeEventListener('click', onClick)
    root.removeEventListener('input', onInput)
    root.removeEventListener('change', onInput)
    root.removeEventListener('toggle', onToggle, true)
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('pagehide', dispose)
    document.removeEventListener('click', beforeNavigation, true)
    externalSignal?.removeEventListener('abort', dispose)
  }
  root.addEventListener('click', onClick)
  root.addEventListener('input', onInput)
  root.addEventListener('change', onInput)
  root.addEventListener('toggle', onToggle, true)
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('pagehide', dispose)
  document.addEventListener('click', beforeNavigation, true)
  externalSignal?.addEventListener('abort', dispose, { once: true })

  async function renderProfiles() {
    if (disposed) return
    profileAbort?.abort()
    const controller = profileAbort = new AbortController()
    const bambuddy = [...states.values()].find(state => state.printer.driver_key === 'bambuddy')
    if (bambuddy) {
      root.querySelector<HTMLElement>('[data-profile-provider]')!.innerHTML = `${pluginIcon}${driverLink(bambuddy.printer)}`
      if (plugins.find(plugin => plugin.driver_key === 'bambuddy')?.is_active === false) {
        root.querySelector('#slicer-profile-section')!.classList.remove('hidden')
        root.querySelector('#slicer-profile-picker')!.textContent = tr('inactiveProfiles')
        return
      }
      root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = true
      await initPerModelProfilePicker({ entityType: opts.entityType, entityId: opts.entityId, filamentId: opts.filamentId, filamentLabel: opts.filamentLabel, t: opts.t, getCsrfToken: opts.getCsrfToken, getAbortSignal: () => controller.signal, isAbortError: error => opts.isAbortError?.(error) || (error instanceof DOMException && error.name === 'AbortError'), onSaved: refresh, onSavingChange: busy => { if (busy && (pendingSave || saving || disposed)) throw new Error(tr('resolveBeforeSave')); profileWrites += busy ? 1 : -1 }, readOnly: !permitted || !editing })
      if (!disposed && profileAbort === controller) root.querySelector<HTMLFieldSetElement>('[data-profile-controls]')!.disabled = !permitted || !editing || saving || pendingSave
    }
  }

  const ready = (async () => {
    const user = await getMe()
    if (disposed) return
    permitted = !!user && hasPermission(user, `${spool ? 'spools' : 'filaments'}:update`)
    managePlugins = !!user && hasPermission(user, 'admin:plugins_manage')
    managePrinters = !!user && hasPermission(user, 'printers:update')
    if (managePlugins) plugins = await read<Plugin[]>('/admin/system/plugins').catch(() => [])
    await refresh()
    if (disposed) return
    await renderProfiles()
  })()
  return { ready, refresh, dispose, setEditing, isDirty: dirty, isSaving: () => pendingSave || saving || profileWrites > 0, save, setFilament }
}
