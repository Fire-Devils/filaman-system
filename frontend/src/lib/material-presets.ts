import { api, ApiError } from './api'
import { t } from './i18n'

export interface MaterialPreset {
  id: number
  material_type: string
  extruder_temp_min_c: number | null
  extruder_temp_max_c: number | null
  bed_temp_min_c: number | null
  bed_temp_max_c: number | null
  flow_ratio: number | null
  drying_temp_c: number | null
  drying_time_hours: number | null
  drying_interval_days: number | null
  density_g_cm3: number | null
}

type PresetField = Exclude<keyof MaterialPreset, 'id' | 'material_type'>

const NUMERIC_COLUMNS: { key: PresetField; step: string }[] = [
  { key: 'extruder_temp_min_c', step: '1' },
  { key: 'extruder_temp_max_c', step: '1' },
  { key: 'bed_temp_min_c', step: '1' },
  { key: 'bed_temp_max_c', step: '1' },
  { key: 'flow_ratio', step: '0.01' },
  { key: 'drying_temp_c', step: '1' },
  { key: 'drying_time_hours', step: '0.5' },
  { key: 'drying_interval_days', step: '1' },
  { key: 'density_g_cm3', step: '0.01' },
]

const BASE = '/admin/material-presets'

export function presetPayload(row: HTMLElement): Record<string, string | number | null> {
  const payload: Record<string, string | number | null> = {
    material_type: (row.querySelector<HTMLInputElement>('[data-field="material_type"]')?.value ?? '').trim(),
  }
  for (const { key } of NUMERIC_COLUMNS) {
    const raw = row.querySelector<HTMLInputElement>(`[data-field="${key}"]`)?.value.trim() ?? ''
    payload[key] = raw === '' ? null : Number(raw)
  }
  return payload
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.message) return error.message
  return t('admin.presetSaveFailed')
}

export function initMaterialPresets(): void {
  const body = document.getElementById('presets-body')
  const message = document.getElementById('presets-message')
  const addButton = document.getElementById('preset-add') as HTMLButtonElement | null
  const resetButton = document.getElementById('preset-reset') as HTMLButtonElement | null
  const applyButton = document.getElementById('preset-apply') as HTMLButtonElement | null
  if (!body || !message || !addButton || !resetButton || !applyButton) return

  function show(text: string, isError: boolean): void {
    message!.textContent = text
    message!.className = isError ? 'fm-alert-error' : 'fm-alert-success'
    setTimeout(() => message!.classList.add('hidden'), 6000)
  }

  function makeInput(field: string, value: string | number | null, step?: string): HTMLTableCellElement {
    const cell = document.createElement('td')
    const input = document.createElement('input')
    input.className = 'fm-input'
    input.dataset.field = field
    input.setAttribute('aria-label', field)
    if (step) {
      input.type = 'number'
      input.step = step
      input.min = '0'
      input.style.minWidth = '72px'
    } else {
      input.type = 'text'
      input.maxLength = 50
      input.style.minWidth = '110px'
    }
    input.value = value == null ? '' : String(value)
    cell.appendChild(input)
    return cell
  }

  function buildRow(preset: Partial<MaterialPreset> & { id?: number }): HTMLTableRowElement {
    const row = document.createElement('tr')
    if (preset.id != null) row.dataset.id = String(preset.id)
    row.appendChild(makeInput('material_type', preset.material_type ?? ''))
    for (const { key, step } of NUMERIC_COLUMNS) row.appendChild(makeInput(key, preset[key] ?? null, step))
    const actions = document.createElement('td')
    actions.style.whiteSpace = 'nowrap'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'fm-btn'
    save.textContent = t('admin.presetSave')
    save.addEventListener('click', () => void saveRow(row))
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'fm-btn'
    del.textContent = t('admin.presetDelete')
    del.addEventListener('click', () => void deleteRow(row))
    actions.append(save, ' ', del)
    row.appendChild(actions)
    return row
  }

  function render(presets: MaterialPreset[]): void {
    body!.replaceChildren(...presets.map(buildRow))
  }

  async function load(): Promise<void> {
    try {
      render(await api.get<MaterialPreset[]>(BASE))
    } catch (error) {
      show(errorText(error), true)
    }
  }

  async function saveRow(row: HTMLTableRowElement): Promise<void> {
    const payload = presetPayload(row)
    if (!payload.material_type) {
      show(t('admin.presetMaterialRequired'), true)
      return
    }
    try {
      const id = row.dataset.id
      const saved = id
        ? await api.patch<MaterialPreset>(`${BASE}/${id}`, payload)
        : await api.post<MaterialPreset>(BASE, payload)
      row.replaceWith(buildRow(saved))
      show(t('admin.presetSaved'), false)
    } catch (error) {
      show(errorText(error), true)
    }
  }

  async function deleteRow(row: HTMLTableRowElement): Promise<void> {
    const id = row.dataset.id
    if (!id) {
      row.remove()
      return
    }
    if (!window.confirm(t('admin.presetDeleteConfirm'))) return
    try {
      await api.delete(`${BASE}/${id}`)
      row.remove()
    } catch (error) {
      show(errorText(error), true)
    }
  }

  addButton.addEventListener('click', () => {
    const row = buildRow({})
    body.appendChild(row)
    row.querySelector<HTMLInputElement>('[data-field="material_type"]')?.focus()
  })

  resetButton.addEventListener('click', async () => {
    if (!window.confirm(t('admin.presetResetConfirm'))) return
    try {
      render(await api.post<MaterialPreset[]>(`${BASE}/reset`))
      show(t('admin.presetResetDone'), false)
    } catch (error) {
      show(errorText(error), true)
    }
  })

  applyButton.addEventListener('click', async () => {
    if (!window.confirm(t('admin.presetApplyConfirm'))) return
    applyButton.disabled = true
    try {
      const result = await api.post<{ updated_filaments: number; updated_fields: number }>(`${BASE}/apply-to-filaments`)
      show(t('admin.presetApplyResult', { filaments: result.updated_filaments, fields: result.updated_fields }), false)
    } catch (error) {
      show(errorText(error), true)
    } finally {
      applyButton.disabled = false
    }
  })

  void load()
}
