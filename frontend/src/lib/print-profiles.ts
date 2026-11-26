/**
 * Druckprofile pro Filament und Drucker (Abschnitt auf der Filament-Detailseite).
 * Die Bereiche entsprechen backend/app/services/print_profile_validation.py.
 */

import { ApiError, api } from './api'
import { getMe, hasPermission } from './auth'
import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { mountContributeControl } from './filamentdb-contrib'
import { t } from './i18n'

export type ProfileFieldKind = 'int' | 'float' | 'text' | 'textarea' | 'tristate'

export interface ProfileField {
  key: string
  kind: ProfileFieldKind
  unit?: string
  maxLength?: number
  min?: number
  max?: number
  step?: number
}

export interface ProfileGroup {
  id: string
  fields: ProfileField[]
}

const int = (key: string, unit: string, min: number, max: number): ProfileField => ({ key, kind: 'int', unit, min, max, step: 1 })
const flt = (key: string, unit: string, min: number, max: number, step: number): ProfileField => ({ key, kind: 'float', unit, min, max, step })

export const PROFILE_GROUPS: ProfileGroup[] = [
  { id: 'nozzle', fields: [flt('nozzle_diameter_mm', 'mm', 0.1, 2, 0.05), { key: 'extruder_type', kind: 'text' }] },
  { id: 'temperatures', fields: [int('nozzle_temp_c', '°C', 150, 500), int('bed_temp_c', '°C', 0, 150), int('chamber_temp_c', '°C', 0, 100)] },
  {
    id: 'speed',
    fields: [
      int('print_speed_mm_s', 'mm/s', 1, 1500),
      int('travel_speed_mm_s', 'mm/s', 1, 1500),
      int('first_layer_speed_mm_s', 'mm/s', 1, 1500),
      flt('max_volumetric_flow_mm3_s', 'mm³/s', 0.5, 100, 0.1),
    ],
  },
  {
    id: 'flow',
    fields: [
      int('flowrate_percent', '%', 50, 150),
      flt('extrusion_multiplier', '', 0.5, 1.5, 0.01),
      flt('pressure_advance_k', '', 0, 2, 0.001),
      flt('linear_advance_k', '', 0, 200, 0.01),
    ],
  },
  {
    id: 'retraction',
    fields: [
      flt('retraction_mm', 'mm', 0, 15, 0.1),
      int('retraction_speed_mm_s', 'mm/s', 1, 1500),
      int('deretraction_speed_mm_s', 'mm/s', 1, 1500),
      flt('retraction_extra_prime_mm3', 'mm³', 0, 10, 0.01),
      flt('z_hop_mm', 'mm', 0, 5, 0.05),
      { key: 'z_hop_only_when_retracting', kind: 'tristate' },
    ],
  },
  {
    id: 'fan',
    fields: [
      int('fan_percent_min', '%', 0, 100),
      int('fan_percent_max', '%', 0, 100),
      int('fan_first_layer_percent', '%', 0, 100),
      int('bridge_fan_percent', '%', 0, 100),
    ],
  },
  { id: 'other', fields: [int('bridge_flow_percent', '%', 50, 150), { key: 'build_plate', kind: 'text', maxLength: 100 }, { key: 'material_notes', kind: 'textarea' }] },
]

export const ALL_PROFILE_FIELDS: ProfileField[] = PROFILE_GROUPS.flatMap(group => group.fields)

export interface PrintProfile {
  id: number
  filament_id: number
  printer_id: number
  profile_name: string
  printer_name?: string | null
  printer_manufacturer?: string | null
  printer_model?: string | null
  is_default_for_printer?: boolean
  [key: string]: unknown
}

export interface PrinterOption {
  id: number
  name: string
  nozzle_diameter_mm?: number | null
  printer_manufacturer?: string | null
  printer_model?: string | null
}

type FieldValue = number | string | boolean | null

/** Wandelt Formularwerte (alle als Text) in die API-Nutzlast um; leer wird zu null. */
export function buildProfilePayload(raw: Record<string, string | boolean>): Record<string, FieldValue> {
  const payload: Record<string, FieldValue> = {}
  for (const field of ALL_PROFILE_FIELDS) {
    const value = raw[field.key]
    if (value === undefined) continue
    const text = typeof value === 'string' ? value.trim() : value
    if (field.kind === 'int' || field.kind === 'float') {
      const parsed = text === '' ? NaN : Number(text)
      payload[field.key] = Number.isFinite(parsed) ? (field.kind === 'int' ? Math.round(parsed) : parsed) : null
    } else if (field.kind === 'tristate') {
      payload[field.key] = text === '' ? null : text === 'true'
    } else {
      payload[field.key] = text === '' ? null : String(text)
    }
  }
  return payload
}

/** Kernwerte für die Karte: Düse, Temperaturen, Geschwindigkeit, PA. */
export function profileCoreSummary(profile: PrintProfile): { label: string; value: string }[] {
  const num = (key: string) => (profile[key] as number | null | undefined) ?? null
  const rows: { label: string; value: string }[] = []
  const push = (labelKey: string, value: string | null) => { if (value) rows.push({ label: t(labelKey), value }) }
  const nozzle = num('nozzle_diameter_mm')
  push('printProfiles.core.nozzle', nozzle != null ? `${nozzle} mm` : null)
  const temps = [num('nozzle_temp_c'), num('bed_temp_c')]
  push('printProfiles.core.temps', temps.some(v => v != null) ? temps.map(v => (v != null ? `${v} °C` : '—')).join(' / ') : null)
  const speed = num('print_speed_mm_s')
  push('printProfiles.core.speed', speed != null ? `${speed} mm/s` : null)
  const pa = num('pressure_advance_k') ?? num('linear_advance_k')
  push('printProfiles.core.pa', pa != null ? String(pa) : null)
  const retraction = num('retraction_mm')
  push('printProfiles.core.retraction', retraction != null ? `${retraction} mm` : null)
  return rows
}

export function profilePrinterLabel(profile: { printer_name?: string | null; printer_manufacturer?: string | null; printer_model?: string | null }): string {
  const model = [profile.printer_manufacturer, profile.printer_model].filter(Boolean).join(' ')
  const name = profile.printer_name ?? ''
  return model ? `${name} (${model})` : name
}

function renderField(field: ProfileField, value: unknown): string {
  const id = `pp-${field.key}`
  const label = escapeHtml(t(`printProfiles.fields.${field.key}`))
  const unit = field.unit ? ` <span class="pp-unit">${escapeHtml(field.unit)}</span>` : ''
  const text = value == null ? '' : String(value)
  let control: string
  if (field.kind === 'int' || field.kind === 'float') {
    control = `<input type="number" id="${id}" class="fm-input" data-pp-field="${field.key}" step="${field.step}" min="${field.min}" max="${field.max}" value="${escapeHtml(text)}" />`
  } else if (field.kind === 'textarea') {
    control = `<textarea id="${id}" class="fm-input" rows="3" maxlength="2000" data-pp-field="${field.key}">${escapeHtml(text)}</textarea>`
  } else if (field.kind === 'tristate') {
    const sel = (v: string) => (text === v ? ' selected' : '')
    control = `<select id="${id}" class="fm-select" data-pp-field="${field.key}"><option value=""${sel('')}>${escapeHtml(t('printProfiles.unset'))}</option><option value="true"${sel('true')}>${escapeHtml(t('common.yes'))}</option><option value="false"${sel('false')}>${escapeHtml(t('common.no'))}</option></select>`
  } else {
    control = `<input type="text" id="${id}" class="fm-input" maxlength="${field.maxLength ?? 50}" data-pp-field="${field.key}" value="${escapeHtml(text)}" />`
  }
  return `<div class="pp-field"><label for="${id}" class="fm-label">${label}${unit}</label>${control}</div>`
}

export function renderProfileForm(profile: PrintProfile | null, printers: PrinterOption[], defaults: { printerId?: number | null } = {}): string {
  const printerId = profile?.printer_id ?? defaults.printerId ?? printers[0]?.id
  const options = printers.map(p => `<option value="${p.id}"${p.id === printerId ? ' selected' : ''}>${escapeHtml(profilePrinterLabel({ printer_name: p.name, printer_manufacturer: p.printer_manufacturer, printer_model: p.printer_model }))}</option>`).join('')
  const groups = PROFILE_GROUPS.map(group => `
    <fieldset class="pp-group">
      <legend>${escapeHtml(t(`printProfiles.groups.${group.id}`))}</legend>
      <div class="pp-grid">${group.fields.map(field => renderField(field, profile?.[field.key])).join('')}</div>
    </fieldset>`).join('')
  return `
    <div class="pp-grid">
      <div class="pp-field"><label for="pp-printer" class="fm-label">${escapeHtml(t('printProfiles.printer'))} *</label>
        <select id="pp-printer" class="fm-select" required>${options}</select></div>
      <div class="pp-field"><label for="pp-name" class="fm-label">${escapeHtml(t('printProfiles.profileName'))} *</label>
        <input type="text" id="pp-name" class="fm-input" required maxlength="255" value="${escapeHtml(profile?.profile_name ?? '')}" /></div>
    </div>
    <label class="pp-check"><input type="checkbox" id="pp-default"${profile?.is_default_for_printer ? ' checked' : ''} /> ${escapeHtml(t('printProfiles.isDefault'))}</label>
    ${groups}
    <div id="pp-error" class="fm-alert-error hidden" role="alert"></div>`
}

export function profileErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'implausible_value' && error.detail) {
    const field = String(error.detail.field ?? '')
    return t('printProfiles.implausible', {
      field: t(`printProfiles.fields.${field}`),
      min: String(error.detail.min ?? ''),
      max: String(error.detail.max ?? ''),
    })
  }
  return error instanceof Error && error.message ? error.message : t('printProfiles.failedSave')
}

export interface PrintProfilesOptions {
  mount: HTMLElement
  dialog: HTMLDialogElement
  filamentId: number
}

export async function initPrintProfiles(options: PrintProfilesOptions): Promise<{ reload: () => Promise<void> }> {
  const { mount, dialog, filamentId } = options
  const base = `/filaments/${filamentId}/printer-profiles`
  const user = await getMe()
  const canEdit = !!user && hasPermission(user, 'filaments:update')
  const form = dialog.querySelector('form') as HTMLFormElement
  const formBody = dialog.querySelector('[data-pp-body]') as HTMLElement
  const title = dialog.querySelector('[data-pp-title]') as HTMLElement
  bindFormDialog(dialog)
  let profiles: PrintProfile[] = []
  let printers: PrinterOption[] = []
  let editingId: number | null = null

  async function load() {
    try {
      const [profileList, printerPage] = await Promise.all([
        api.get<PrintProfile[]>(base),
        api.get<{ items: PrinterOption[] }>('/printers?page_size=200'),
      ])
      profiles = profileList
      printers = printerPage.items
      render()
    } catch {
      mount.querySelector('[data-pp-list]')!.innerHTML = `<p class="pp-muted">${escapeHtml(t('printProfiles.failedLoad'))}</p>`
    }
  }

  function render() {
    const cards = profiles.map(profile => {
      const rows = profileCoreSummary(profile).map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('')
      const actions = canEdit
        ? `<div class="pp-card-actions"><button type="button" class="fm-btn fm-btn-outline fm-btn-sm" data-pp-edit="${profile.id}">${escapeHtml(t('common.edit'))}</button> <button type="button" class="fm-btn fm-btn-danger fm-btn-sm" data-pp-delete="${profile.id}">${escapeHtml(t('common.delete'))}</button></div>`
        : ''
      return `<article class="fm-card pp-card">
        <header><h3>${escapeHtml(profilePrinterLabel(profile))}</h3>
          <span class="pp-muted">${escapeHtml(profile.profile_name)}${profile.is_default_for_printer ? ` · ${escapeHtml(t('printProfiles.default'))}` : ''}</span></header>
        <dl>${rows || `<p class="pp-muted">${escapeHtml(t('printProfiles.noCore'))}</p>`}</dl>${actions}
        <div class="pp-contrib" data-pp-contrib="${profile.id}"></div></article>`
    }).join('')
    mount.querySelector('[data-pp-list]')!.innerHTML = cards || `<p class="pp-muted">${escapeHtml(t('printProfiles.empty'))}</p>`
    mount.querySelector('[data-pp-add]')?.classList.toggle('hidden', !canEdit || printers.length === 0)
    mount.querySelectorAll<HTMLElement>('[data-pp-contrib]').forEach(host => {
      void mountContributeControl(host, 'print_profile', Number(host.dataset.ppContrib))
    })
  }

  function openForm(profile: PrintProfile | null) {
    editingId = profile?.id ?? null
    title.textContent = t(profile ? 'printProfiles.editTitle' : 'printProfiles.addTitle')
    formBody.innerHTML = renderProfileForm(profile, printers)
    dialog.showModal()
  }

  mount.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-pp-add]')) return openForm(null)
    const edit = target.closest('[data-pp-edit]') as HTMLElement | null
    if (edit) return openForm(profiles.find(p => String(p.id) === edit.dataset.ppEdit) ?? null)
    const del = target.closest('[data-pp-delete]') as HTMLElement | null
    if (del) {
      const dialogs = window as unknown as { __fmConfirm?: (message: string, options?: { isDanger?: boolean }) => Promise<boolean> }
      if (dialogs.__fmConfirm && !(await dialogs.__fmConfirm(t('printProfiles.confirmDelete'), { isDanger: true }))) return
      try {
        await api.delete(`${base}/${del.dataset.ppDelete}`)
        await load()
      } catch (error) {
        mount.querySelector('[data-pp-list]')?.insertAdjacentHTML('afterbegin', `<p class="fm-alert-error" role="alert">${escapeHtml(profileErrorMessage(error))}</p>`)
      }
    }
  })

  dialog.querySelector('[data-pp-cancel]')?.addEventListener('click', () => dialog.close())

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const errorBox = form.querySelector('#pp-error') as HTMLElement
    errorBox.classList.add('hidden')
    if (!form.reportValidity()) return
    const raw: Record<string, string | boolean> = {}
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-pp-field]').forEach(el => { raw[el.dataset.ppField!] = el.value })
    const body = {
      ...buildProfilePayload(raw),
      printer_id: Number((form.querySelector('#pp-printer') as HTMLSelectElement).value),
      profile_name: (form.querySelector('#pp-name') as HTMLInputElement).value.trim(),
      is_default_for_printer: (form.querySelector('#pp-default') as HTMLInputElement).checked,
    }
    try {
      if (editingId == null) await api.post(base, body)
      else await api.put(`${base}/${editingId}`, body)
      dialog.close()
      await load()
    } catch (error) {
      errorBox.textContent = profileErrorMessage(error)
      errorBox.classList.remove('hidden')
    }
  })

  await load()
  return { reload: load }
}
