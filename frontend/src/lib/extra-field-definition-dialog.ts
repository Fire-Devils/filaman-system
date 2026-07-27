import {
  collectSystemFieldValues,
  escapeHtml,
  formatDateTimeInputValue,
  parseExtraFieldDefaultValue,
  renderFieldInput,
  serializeExtraFieldDefaultValue,
  TODAY_EXTRA_FIELD_DEFAULT,
  unflattenFieldValues,
  type SystemExtraFieldDef,
} from './extra-fields'
import { t } from './i18n'

export interface ExtraFieldDefinitionDialogDraft {
  targetType?: 'filament' | 'spool'
  key: string
  label: string
  fieldType: string
  options: string[]
  unit: string
  decimalPlaces: string
  minBound: string
  maxBound: string
  maxLength: string
  defaultValue?: string | null
  value?: unknown
}

export interface ExtraFieldDefinitionDialogResult extends ExtraFieldDefinitionDialogDraft {
  defaultValue: string | null
}

interface OpenDialogOptions {
  title: string
  draft: ExtraFieldDefinitionDialogDraft
  lockIdentity?: boolean
  lockType?: boolean
  onSubmit: (result: ExtraFieldDefinitionDialogResult) => void | Promise<void>
}

interface DialogOptions {
  mode: 'system' | 'entity'
}

const SYSTEM_FIELD_TYPES = [
  'text',
  'number',
  'range',
  'dropdown',
  'multiselect',
  'checkbox',
  'date',
  'datetime',
  'url',
  'textarea',
] as const

const ENTITY_FIELD_TYPES = SYSTEM_FIELD_TYPES

function translate(key: string, fallback: string): string {
  const translated = t(key)
  return translated === key ? fallback : translated
}

function parseOptions(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map(option => option.trim())
    .filter(Boolean)
}

export function extraFieldDefinitionFromDialogDraft(
  draft: ExtraFieldDefinitionDialogDraft,
  key = '__dialog_value',
): SystemExtraFieldDef {
  const config: NonNullable<SystemExtraFieldDef['config']> = {}
  if (draft.unit.trim() && ['number', 'range'].includes(draft.fieldType)) {
    config.unit = draft.unit.trim()
  }
  if (draft.decimalPlaces !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.decimal_places = Number(draft.decimalPlaces)
  }
  if (draft.minBound !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.min_bound = Number(draft.minBound)
  }
  if (draft.maxBound !== '' && ['number', 'range'].includes(draft.fieldType)) {
    config.max_bound = Number(draft.maxBound)
  }
  if (draft.maxLength !== '' && draft.fieldType === 'textarea') {
    config.max_length = Number(draft.maxLength)
  }
  return {
    key,
    label: draft.label.trim() || draft.key.trim() || translate('common.value', 'Value'),
    field_type: draft.fieldType,
    options: ['dropdown', 'multiselect'].includes(draft.fieldType) ? draft.options : null,
    config: Object.keys(config).length ? config : null,
  }
}

export function createExtraFieldDefinitionDialog(options: DialogOptions) {
  const overlay = document.createElement('div')
  overlay.className = 'fm-modal-overlay'
  overlay.innerHTML = `
    <style>
      .extra-field-dialog-lockable { position: relative; }
      .extra-field-dialog-lock {
        display: none;
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        cursor: help;
        font-size: 0.9rem;
      }
      .extra-field-dialog-lockable.is-locked .extra-field-dialog-lock { display: inline-flex; }
      .extra-field-dialog-lockable.is-locked select,
      .extra-field-dialog-lockable.is-locked input {
        appearance: none;
        -webkit-appearance: none;
        cursor: not-allowed;
        padding-right: 38px;
      }
      .extra-field-dialog-lockable.is-locked select {
        background-image: none;
      }
    </style>
    <div class="fm-card" style="width:100%;max-width:30rem;margin:0 1rem;padding:24px;max-height:90vh;overflow-y:auto">
      <h3 class="extra-field-dialog-title" style="font-size:1.15rem;font-weight:600;margin-bottom:16px"></h3>
      <form class="extra-field-dialog-form" style="display:flex;flex-direction:column;gap:16px">
        <div class="extra-field-dialog-target-row">
          <label class="fm-label">${escapeHtml(translate('admin.targetType', 'Target Type'))} *</label>
          <div class="extra-field-dialog-lockable" data-lock-control="identity">
            <select class="fm-select extra-field-dialog-target" required>
              <option value="filament">${escapeHtml(translate('dashboard.filament', 'Filament'))}</option>
              <option value="spool">${escapeHtml(translate('dashboard.spool', 'Spool'))}</option>
            </select>
            <span class="extra-field-dialog-lock" role="img">🔒</span>
          </div>
        </div>

        <div>
          <label class="fm-label">${escapeHtml(translate('admin.keyJson', 'Key (JSON)'))} *</label>
          <div class="extra-field-dialog-lockable" data-lock-control="identity">
            <input class="fm-input extra-field-dialog-key" required />
            <span class="extra-field-dialog-lock" role="img">🔒</span>
          </div>
          <small style="color:var(--text-muted);font-size:0.75rem">${escapeHtml(translate('admin.keyJsonHint', 'Used as key in the custom_fields JSON.'))}</small>
        </div>

        <div>
          <label class="fm-label">${escapeHtml(translate('admin.displayLabel', 'Display Label'))} *</label>
          <input class="fm-input extra-field-dialog-label" required />
        </div>

        <div>
          <label class="fm-label">${escapeHtml(translate('admin.fieldType', 'Field Type'))} *</label>
          <div class="extra-field-dialog-lockable" data-lock-control="type">
            <select class="fm-select extra-field-dialog-type" required></select>
            <span class="extra-field-dialog-lock" role="img">🔒</span>
          </div>
        </div>

        <div class="extra-field-dialog-options-row" style="display:none">
          <label class="fm-label extra-field-dialog-options-label"></label>
          <textarea class="fm-input extra-field-dialog-options" rows="5" style="resize:vertical"></textarea>
          <small style="color:var(--text-muted);font-size:0.75rem">${escapeHtml(translate('admin.dropdownOptionsHint', 'Enter one option per line.'))}</small>
        </div>

        <div class="extra-field-dialog-numeric-row" style="display:none;flex-direction:column;gap:10px;border:1px solid var(--border);border-radius:6px;padding:12px;background:var(--bg-soft)">
          <div style="font-size:0.8rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(translate('admin.fieldConfig', 'Field Config'))}</div>
          <div style="display:flex;gap:12px;align-items:flex-end">
            <div style="flex:1">
              <label class="fm-label" style="font-size:0.8rem">${escapeHtml(translate('admin.unit', 'Unit'))}</label>
              <input class="fm-input extra-field-dialog-unit" placeholder="e.g. °C, mm, %" style="height:32px;font-size:0.85rem" />
            </div>
            <div style="flex:1">
              <label class="fm-label" style="font-size:0.8rem">${escapeHtml(translate('admin.decimalPlaces', 'Decimal places'))}</label>
              <input type="number" min="0" max="10" class="fm-input extra-field-dialog-decimals" placeholder="0=int, blank=any" style="height:32px;font-size:0.85rem" />
            </div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-end">
            <div style="flex:1">
              <label class="fm-label" style="font-size:0.8rem">${escapeHtml(translate('admin.minBound', 'Min bound'))}</label>
              <input type="number" step="any" class="fm-input extra-field-dialog-min-bound" placeholder="e.g. 0" style="height:32px;font-size:0.85rem" />
            </div>
            <div style="flex:1">
              <label class="fm-label" style="font-size:0.8rem">${escapeHtml(translate('admin.maxBound', 'Max bound'))}</label>
              <input type="number" step="any" class="fm-input extra-field-dialog-max-bound" placeholder="e.g. 500" style="height:32px;font-size:0.85rem" />
            </div>
          </div>
        </div>

        <div class="extra-field-dialog-textarea-row" style="display:none">
          <label class="fm-label">${escapeHtml(translate('admin.maxLength', 'Max length'))}</label>
          <input type="number" min="1" max="100000" class="fm-input extra-field-dialog-max-length" placeholder="2000" />
        </div>

        <div class="extra-field-dialog-default-row">
          <label class="fm-label">${escapeHtml(translate('admin.defaultValue', 'Default Value (Optional)'))}</label>
          <div class="extra-field-dialog-default"></div>
          <small style="color:var(--text-muted);font-size:0.75rem">${escapeHtml(translate('admin.defaultValueHint', 'This value will be pre-filled when creating new items.'))}</small>
        </div>

        <div class="extra-field-dialog-value-row">
          <label class="fm-label">${escapeHtml(translate('admin.fieldDefaultValue', 'Default Value'))}</label>
          <div class="extra-field-dialog-value"></div>
        </div>

        <div class="extra-field-dialog-system-lock-note" style="display:${options.mode === 'system' ? 'flex' : 'none'};gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-soft);color:var(--text-muted);font-size:0.78rem;line-height:1.45">
          <span aria-hidden="true">🔒</span>
          <span>${escapeHtml(translate('admin.systemFieldLockNote', 'Target type, JSON key, and field type cannot be changed after creation. Delete and recreate the field to change them. The same key can be reused, but existing stored values remain and must be compatible with the new type.'))}</span>
        </div>

        <div class="fm-alert-error hidden extra-field-dialog-error"></div>
        <div style="display:flex;gap:12px">
          <button type="submit" class="fm-btn fm-btn-primary extra-field-dialog-submit">${escapeHtml(translate('common.save', 'Save'))}</button>
          <button type="button" class="fm-btn fm-btn-outline extra-field-dialog-cancel">${escapeHtml(translate('common.cancel', 'Cancel'))}</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(overlay)

  const form = overlay.querySelector<HTMLFormElement>('.extra-field-dialog-form')!
  const title = overlay.querySelector<HTMLElement>('.extra-field-dialog-title')!
  const targetRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-target-row')!
  const target = overlay.querySelector<HTMLSelectElement>('.extra-field-dialog-target')!
  const key = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-key')!
  const label = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-label')!
  const fieldType = overlay.querySelector<HTMLSelectElement>('.extra-field-dialog-type')!
  const optionsRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-options-row')!
  const optionsLabel = overlay.querySelector<HTMLElement>('.extra-field-dialog-options-label')!
  const fieldOptions = overlay.querySelector<HTMLTextAreaElement>('.extra-field-dialog-options')!
  const numericRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-numeric-row')!
  const unit = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-unit')!
  const decimals = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-decimals')!
  const minBound = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-min-bound')!
  const maxBound = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-max-bound')!
  const textareaRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-textarea-row')!
  const maxLength = overlay.querySelector<HTMLInputElement>('.extra-field-dialog-max-length')!
  const defaultRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-default-row')!
  const defaultEditor = overlay.querySelector<HTMLElement>('.extra-field-dialog-default')!
  const valueRow = overlay.querySelector<HTMLElement>('.extra-field-dialog-value-row')!
  const valueEditor = overlay.querySelector<HTMLElement>('.extra-field-dialog-value')!
  const error = overlay.querySelector<HTMLElement>('.extra-field-dialog-error')!
  const submit = overlay.querySelector<HTMLButtonElement>('.extra-field-dialog-submit')!
  const cancel = overlay.querySelector<HTMLButtonElement>('.extra-field-dialog-cancel')!

  let current: OpenDialogOptions | null = null
  let draft: ExtraFieldDefinitionDialogDraft | null = null

  const fieldTypes = options.mode === 'system' ? SYSTEM_FIELD_TYPES : ENTITY_FIELD_TYPES
  fieldType.innerHTML = fieldTypes
    .map(
      type =>
        `<option value="${type}">${escapeHtml(translate(`admin.fieldType_${type}`, type))}</option>`,
    )
    .join('')
  targetRow.style.display = options.mode === 'system' ? 'block' : 'none'
  defaultRow.style.display = options.mode === 'system' ? 'block' : 'none'
  valueRow.style.display = options.mode === 'entity' ? 'block' : 'none'
  key.pattern = options.mode === 'system' ? '[a-zA-Z0-9_]+' : '[a-zA-Z0-9_.]+'
  key.placeholder = options.mode === 'system' ? 'e.g. material_type' : 'e.g. drying.temperature'

  function syncDefinition(): void {
    if (!draft) return
    draft.targetType = target.value as 'filament' | 'spool'
    draft.key = key.value
    draft.label = label.value
    draft.fieldType = fieldType.value
    draft.options = parseOptions(fieldOptions.value)
    draft.unit = unit.value
    draft.decimalPlaces = decimals.value
    draft.minBound = minBound.value
    draft.maxBound = maxBound.value
    draft.maxLength = maxLength.value
  }

  function syncValue(): boolean {
    if (!draft || options.mode !== 'entity') return true
    const values = collectSystemFieldValues(valueEditor)
    if (!values) return false
    const nested = unflattenFieldValues(values.flat)
    draft.value = values.direct.__dialog_value ?? nested.__dialog_value
    if (
      draft.value === undefined &&
      ['text', 'url', 'date', 'datetime', 'textarea', 'dropdown'].includes(draft.fieldType)
    ) {
      draft.value = ''
    }
    return true
  }

  function syncDefault(): void {
    if (!draft || options.mode !== 'system') return
    let value: unknown
    switch (draft.fieldType) {
      case 'range':
        value = {
          min: defaultEditor.querySelector<HTMLInputElement>('[data-default-range="min"]')?.value,
          max: defaultEditor.querySelector<HTMLInputElement>('[data-default-range="max"]')?.value,
        }
        break
      case 'multiselect':
        value = [
          ...defaultEditor.querySelectorAll<HTMLInputElement>('[data-default-multi]:checked'),
        ].map(input => input.value)
        break
      case 'checkbox':
        value =
          defaultEditor.querySelector<HTMLInputElement>('[data-default-checkbox]')?.checked ?? false
        break
      case 'date':
        value = defaultEditor.querySelector<HTMLInputElement>('[data-default-today]')?.checked
          ? TODAY_EXTRA_FIELD_DEFAULT
          : defaultEditor.querySelector<HTMLInputElement>('[data-default-scalar]')?.value
        break
      default:
        value = defaultEditor.querySelector<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >('[data-default-scalar]')?.value
    }
    draft.defaultValue = serializeExtraFieldDefaultValue(draft.fieldType, value)
  }

  function renderDefault(): void {
    if (!draft || options.mode !== 'system') return
    const parsed = parseExtraFieldDefaultValue({
      field_type: draft.fieldType,
      default_value: draft.defaultValue,
    })
    const scalar = typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed) : ''
    switch (draft.fieldType) {
      case 'number':
        defaultEditor.innerHTML = `<input type="number" step="any" class="fm-input" data-default-scalar value="${escapeHtml(scalar)}" placeholder="e.g. 0" />`
        break
      case 'range': {
        const range =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        defaultEditor.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" step="any" class="fm-input" data-default-range="min" value="${escapeHtml(String(range.min ?? ''))}" placeholder="${escapeHtml(translate('admin.defaultRangeMin', 'Default minimum'))}" />
            <span style="color:var(--text-muted)">–</span>
            <input type="number" step="any" class="fm-input" data-default-range="max" value="${escapeHtml(String(range.max ?? ''))}" placeholder="${escapeHtml(translate('admin.defaultRangeMax', 'Default maximum'))}" />
          </div>`
        break
      }
      case 'dropdown':
        defaultEditor.innerHTML = `
          <select class="fm-select" data-default-scalar>
            <option value="">${escapeHtml(translate('admin.noDefault', 'No default selected'))}</option>
            ${draft.options.map(option => `<option value="${escapeHtml(option)}"${parsed === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>`
        break
      case 'multiselect': {
        const selected = Array.isArray(parsed) ? parsed.map(String) : []
        defaultEditor.innerHTML = draft.options.length
          ? `<div style="display:flex;flex-direction:column;gap:5px">${draft.options
              .map(
                option =>
                  `<label style="display:flex;align-items:center;gap:7px"><input type="checkbox" data-default-multi value="${escapeHtml(option)}"${selected.includes(option) ? ' checked' : ''} />${escapeHtml(option)}</label>`,
              )
              .join('')}</div><small style="display:block;color:var(--text-muted);font-size:0.75rem;margin-top:4px">${escapeHtml(translate('admin.multiselectDefaultHint', 'Selected options will be selected by default.'))}</small>`
          : `<small style="color:var(--text-muted)">${escapeHtml(translate('admin.addOptionsForDefault', 'Add options above to choose defaults.'))}</small>`
        break
      }
      case 'checkbox':
        defaultEditor.innerHTML = `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" data-default-checkbox${parsed === true ? ' checked' : ''} />${escapeHtml(draft.label.trim() || translate('admin.displayLabel', 'Display Label'))}</label><small style="display:block;color:var(--text-muted);font-size:0.75rem;margin-top:4px">${escapeHtml(translate('admin.checkboxDefaultHint', 'Set the checkbox default value: checked or unchecked.'))}</small>`
        break
      case 'date': {
        const today = draft.defaultValue?.toUpperCase() === TODAY_EXTRA_FIELD_DEFAULT
        defaultEditor.innerHTML = `
          <input type="date" class="fm-input" data-default-scalar value="${today ? '' : escapeHtml(scalar)}"${today ? ' disabled' : ''} />
          <label style="display:flex;align-items:center;gap:7px;margin-top:7px;cursor:pointer">
            <input type="checkbox" data-default-today${today ? ' checked' : ''} />
            ${escapeHtml(translate('admin.useTodayDefault', 'Use today when creating a new item'))}
          </label>`
        defaultEditor
          .querySelector<HTMLInputElement>('[data-default-today]')
          ?.addEventListener('change', event => {
            const dateInput = defaultEditor.querySelector<HTMLInputElement>('[data-default-scalar]')
            if (dateInput) dateInput.disabled = (event.currentTarget as HTMLInputElement).checked
          })
        break
      }
      case 'datetime': {
        const inputValue = formatDateTimeInputValue(scalar)
        defaultEditor.innerHTML = `<input type="datetime-local" class="fm-input" data-default-scalar value="${escapeHtml(inputValue ?? scalar)}" />`
        break
      }
      case 'url':
        defaultEditor.innerHTML = `<input type="url" class="fm-input" data-default-scalar value="${escapeHtml(scalar)}" placeholder="https://..." />`
        break
      case 'textarea':
        defaultEditor.innerHTML = `<textarea class="fm-input" rows="3" data-default-scalar placeholder="e.g. The quick brown fox jumps over the lazy dog." style="resize:vertical">${escapeHtml(scalar)}</textarea>`
        break
      default:
        defaultEditor.innerHTML = `<input type="text" class="fm-input" data-default-scalar value="${escapeHtml(scalar)}" placeholder="e.g. PLA" />`
    }
  }

  function renderValue(): void {
    if (!draft || options.mode !== 'entity') return
    const definition = extraFieldDefinitionFromDialogDraft(draft)
    const defaultHint =
      draft.fieldType === 'checkbox'
          ? translate(
              'admin.checkboxDefaultHint',
              'Set the checkbox default value: checked or unchecked.',
            )
        : draft.fieldType === 'multiselect'
          ? translate(
              'admin.multiselectDefaultHint',
              'Selected options will be selected by default.',
            )
          : ''
    valueEditor.innerHTML = `${renderFieldInput(definition, draft.value)}${
      defaultHint
        ? `<small style="display:block;color:var(--text-muted);font-size:0.75rem;margin-top:4px">${escapeHtml(defaultHint)}</small>`
        : ''
    }`
    if (draft.fieldType === 'dropdown') {
      const emptyOption = valueEditor.querySelector<HTMLOptionElement>('option[value=""]')
      if (emptyOption) {
        emptyOption.textContent = translate('admin.noDefault', 'No default selected')
      }
    }
  }

  function renderTypeUi(): void {
    if (!draft) return
    const showOptions = draft.fieldType === 'dropdown' || draft.fieldType === 'multiselect'
    optionsRow.style.display = showOptions ? 'block' : 'none'
    fieldOptions.required = showOptions
    optionsLabel.textContent =
      draft.fieldType === 'multiselect'
        ? translate('admin.multiselectOptions', 'Multi-select Options')
        : translate('admin.dropdownOptions', 'Dropdown Options')
    numericRow.style.display = ['number', 'range'].includes(draft.fieldType) ? 'flex' : 'none'
    textareaRow.style.display = draft.fieldType === 'textarea' ? 'block' : 'none'
    renderDefault()
    renderValue()
  }

  function setLocked(kind: 'identity' | 'type', locked: boolean, reason: string): void {
    overlay.querySelectorAll<HTMLElement>(`[data-lock-control="${kind}"]`).forEach(control => {
      control.classList.toggle('is-locked', locked)
      control.title = locked ? reason : ''
      const icon = control.querySelector<HTMLElement>('.extra-field-dialog-lock')
      if (icon) {
        icon.title = locked ? reason : ''
        icon.setAttribute('aria-label', locked ? reason : '')
        icon.tabIndex = locked ? 0 : -1
      }
    })
  }

  function close(): void {
    overlay.classList.remove('open')
    current = null
    draft = null
  }

  fieldType.addEventListener('change', () => {
    if (!draft) return
    const previousType = draft.fieldType
    syncDefault()
    syncValue()
    syncDefinition()
    if (draft.fieldType !== previousType) {
      if (options.mode === 'system') draft.defaultValue = null
      else draft.value = undefined
    }
    renderTypeUi()
  })
  fieldOptions.addEventListener('input', () => {
    syncDefault()
    syncValue()
    syncDefinition()
    renderDefault()
    renderValue()
  })
  label.addEventListener('input', () => {
    if (!draft) return
    syncValue()
    syncDefinition()
    renderDefault()
    renderValue()
  })
  for (const input of [unit, decimals, minBound, maxBound, maxLength]) {
    input.addEventListener('change', () => {
      syncValue()
      syncDefinition()
      renderValue()
    })
  }
  cancel.addEventListener('click', close)
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close()
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!current || !draft) return
    syncDefault()
    if (!syncValue()) return
    syncDefinition()
    if (['dropdown', 'multiselect'].includes(draft.fieldType) && draft.options.length === 0) {
      error.textContent = translate(
        'admin.dropdownOptionsRequired',
        'At least one option is required',
      )
      error.classList.remove('hidden')
      return
    }
    if (draft.fieldType === 'range' && draft.defaultValue) {
      const range = parseExtraFieldDefaultValue({
        field_type: 'range',
        default_value: draft.defaultValue,
      }) as Record<string, number> | undefined
      if (range && (range.min === undefined || range.max === undefined)) {
        error.textContent = translate(
          'admin.rangeDefaultRequiresBoth',
          'A range default requires both minimum and maximum values.',
        )
        error.classList.remove('hidden')
        return
      }
      if (range && range.min > range.max) {
        error.textContent = translate(
          'admin.rangeDefaultOrder',
          'The default maximum must be greater than or equal to the default minimum.',
        )
        error.classList.remove('hidden')
        return
      }
    }

    error.classList.add('hidden')
    submit.disabled = true
    submit.textContent = translate('common.saving', 'Saving…')
    try {
      await current.onSubmit({
        ...draft,
        defaultValue: draft.defaultValue ?? null,
      })
      close()
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
      error.classList.remove('hidden')
    } finally {
      submit.disabled = false
      submit.textContent = translate('common.save', 'Save')
    }
  })

  return {
    open(openOptions: OpenDialogOptions): void {
      current = openOptions
      draft = {
        ...openOptions.draft,
        options: [...openOptions.draft.options],
      }
      title.textContent = openOptions.title
      target.value = draft.targetType ?? 'filament'
      key.value = draft.key
      label.value = draft.label
      fieldType.value = draft.fieldType
      fieldOptions.value = draft.options.join('\n')
      unit.value = draft.unit
      decimals.value = draft.decimalPlaces
      minBound.value = draft.minBound
      maxBound.value = draft.maxBound
      maxLength.value = draft.maxLength
      const identityReason = translate(
        'admin.fieldIdentityLockedHint',
        'Target type and JSON key identify stored data and cannot be changed after creation. Create a new field instead.',
      )
      const typeReason = translate(
        'admin.fieldTypeLockedHint',
        'Field type is locked after creation because existing values may use its storage format. Create a new field to use a different type.',
      )
      setLocked('identity', Boolean(openOptions.lockIdentity), identityReason)
      setLocked('type', Boolean(openOptions.lockType), typeReason)
      target.disabled = Boolean(openOptions.lockIdentity)
      key.disabled = Boolean(openOptions.lockIdentity)
      fieldType.disabled = Boolean(openOptions.lockType)
      error.classList.add('hidden')
      renderTypeUi()
      overlay.classList.add('open')
      requestAnimationFrame(() => (openOptions.lockIdentity ? label : key).focus())
    },
    close,
  }
}
