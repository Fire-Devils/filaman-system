import {
  collectExtraFieldPayload,
  createEntityExtraFieldEditor,
  getExtraFieldValue,
  type EntityExtraFieldDefinitions,
  type EntityExtraFieldPayload,
} from './entity-extra-fields'
import { escapeHtml, renderFieldInput, type SystemExtraFieldDef } from './extra-fields'
import { t } from './i18n'

interface DialogOptions {
  targetType: 'filament' | 'spool'
  systemFields: Record<string, SystemExtraFieldDef>
  onSave: (payload: EntityExtraFieldPayload) => Promise<void>
}

interface DialogData {
  customFields?: Record<string, unknown> | null
  customFieldDefinitions?: EntityExtraFieldDefinitions | null
}

export function createEntityExtraFieldsDialog(options: DialogOptions) {
  const target = options.targetType === 'spool' ? 'spools' : 'filaments'
  const overlay = document.createElement('dialog')
  overlay.className = 'fm-modal-overlay entity-extra-fields-overlay'
  overlay.setAttribute('aria-labelledby', 'entity-extra-fields-title')
  overlay.innerHTML = `
    <section class="fm-card entity-extra-fields-dialog">
      <header class="entity-extra-fields-dialog-header">
        <h2 id="entity-extra-fields-title">${escapeHtml(t('common.extraFields'))}</h2>
        <button type="button" class="fm-btn fm-btn-outline" data-extra-fields-cancel aria-label="${escapeHtml(t('common.close'))}">×</button>
      </header>
      <form>
        <div class="entity-extra-fields-dialog-body">
          <section class="entity-extra-fields-system-section">
            <h3>${escapeHtml(t('common.systemFields'))}</h3>
            <div class="entity-extra-fields-system-grid"></div>
          </section>
          <section>
            <div class="entity-extra-fields-dialog-heading">
              <h3>${escapeHtml(t(`${target}.specificExtraFields`))}</h3>
              <button type="button" class="fm-btn fm-btn-outline" data-extra-fields-add>+ ${escapeHtml(t('common.add'))}</button>
            </div>
            <p class="entity-extra-fields-help">${escapeHtml(t(`${target}.specificExtraFieldsHelp`))} <a href="/admin/extra-fields">${escapeHtml(t(`${target}.manageSystemExtraFields`))}</a></p>
            <div class="entity-extra-fields-custom-grid"></div>
          </section>
        </div>
        <div class="fm-alert-error entity-extra-fields-error" hidden></div>
        <footer class="entity-extra-fields-dialog-footer">
          <button type="button" class="fm-btn fm-btn-outline" data-extra-fields-cancel>${escapeHtml(t('common.cancel'))}</button>
          <button type="submit" class="fm-btn fm-btn-primary">${escapeHtml(t('common.save'))}</button>
        </footer>
      </form>
    </section>`
  document.body.appendChild(overlay)

  const form = overlay.querySelector<HTMLFormElement>('form')!
  const systemSection = overlay.querySelector<HTMLElement>('.entity-extra-fields-system-section')!
  const systemGrid = overlay.querySelector<HTMLElement>('.entity-extra-fields-system-grid')!
  const error = overlay.querySelector<HTMLElement>('.entity-extra-fields-error')!
  const submit = overlay.querySelector<HTMLButtonElement>('[type="submit"]')!
  let baseline: string | null = null
  let saving = false
  const editor = createEntityExtraFieldEditor({
    container: overlay.querySelector<HTMLElement>('.entity-extra-fields-custom-grid')!,
    addButton: overlay.querySelector<HTMLElement>('[data-extra-fields-add]')!,
    emptyText: t(`${target}.noSpecificExtraFields`),
    onChange: updateSaveState,
  })
  editor.setSystemFieldKeys(Object.keys(options.systemFields))
  let returnFocus: HTMLElement | null = null

  function getSnapshot(): string {
    const values = Array.from(
      systemGrid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'),
      input => input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value,
    )
    return JSON.stringify([values, editor.getSnapshot()])
  }

  function updateSaveState(): void {
    submit.disabled = saving || baseline === null || getSnapshot() === baseline
  }

  form.addEventListener('input', updateSaveState)
  form.addEventListener('change', updateSaveState)

  function close(): void {
    if (saving) return
    if (overlay.open) overlay.close()
    overlay.classList.remove('open')
    returnFocus?.focus()
    returnFocus = null
  }
  overlay.addEventListener('cancel', event => {
    event.preventDefault()
    close()
  })

  overlay.querySelectorAll<HTMLButtonElement>('[data-extra-fields-cancel]')
    .forEach(button => button.addEventListener('click', close))
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close()
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled) return
    error.hidden = true
    const payload = collectExtraFieldPayload(systemGrid, editor)
    if (!payload) return
    saving = true
    updateSaveState()
    try {
      await options.onSave(payload)
      saving = false
      close()
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
      error.hidden = false
    } finally {
      saving = false
      updateSaveState()
    }
  })

  return {
    open(data: DialogData, trigger?: HTMLElement) {
      if (saving) return
      returnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      const values = data.customFields ?? {}
      systemSection.hidden = Object.keys(options.systemFields).length === 0
      systemGrid.innerHTML = Object.values(options.systemFields).map(field => {
        const control = renderFieldInput(field, getExtraFieldValue(values, field.key))
        return `<div>${field.field_type === 'checkbox' ? control : `<label class="fm-label">${escapeHtml(field.label)}</label>${control}`}</div>`
      }).join('')
      editor.setData(values, data.customFieldDefinitions)
      baseline = getSnapshot()
      updateSaveState()
      error.hidden = true
      overlay.showModal()
      overlay.classList.add('open')
    },
  }
}
