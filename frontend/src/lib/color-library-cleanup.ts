import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { bindColorPickerPopup } from './color-picker-wheel'
import { bindAlphaColorControls, normalizeHexCode, toColorSwatchBackground } from './colors'
import { t } from './i18n'
import { isAbortError } from './abort'

export type LibraryColor = { id: number; name: string; hex_code: string; usage_count: number; custom_fields?: Record<string, unknown> | null }
export type CleanupColor = LibraryColor & { token: string }
type Snapshot = { items: CleanupColor[]; groups: number[][] }

export function bindColorCleanup({ scope, getColors, getVisible, reload, signal, canMerge, canDelete, canSelect = false, onSelectionChange }: {
  scope: HTMLElement
  getColors: () => LibraryColor[]
  getVisible: () => LibraryColor[]
  reload: () => Promise<void>
  signal: AbortSignal
  canMerge: boolean
  canDelete: boolean
  canSelect?: boolean
  onSelectionChange?: () => void
}) {
  const find = <T extends HTMLElement>(selector: string) => scope.querySelector<T>(selector)!
  const dialog = find<HTMLDialogElement>('#color-cleanup-dialog')
  const content = find('#color-cleanup-content')
  const mergeForm = find<HTMLFormElement>('[data-cleanup-merge-form]')
  const survivor = find<HTMLSelectElement>('#cleanup-survivor')
  const name = find<HTMLInputElement>('#cleanup-name')
  const hex = find<HTMLInputElement>('#cleanup-hex')
  name.maxLength = 100
  const colorControls = bindAlphaColorControls({
    picker: find('#cleanup-picker'), hexInput: hex,
    alphaEnabled: find('#cleanup-alpha-enabled'), alphaOptions: find('#cleanup-alpha-options'),
    alphaPreview: find('#cleanup-alpha-preview'), alphaInput: find('#cleanup-alpha'),
    alphaValueInput: find('#cleanup-alpha-value'), alphaHexInput: find('#cleanup-alpha-hex'),
  })
  const selection = new Set<number>()
  let busy = false
  let request = 0
  let snapshot: Snapshot = { items: [], groups: [] }
  const skipped = new Set<string>()
  let groupIndex = 0
  let mode: 'duplicates' | 'selected' | 'delete' = 'duplicates'
  let mergeIds = new Set<number>()
  let selectedIds = new Set<number>()
  let reviewKey = ''
  let incompleteReview = false
  let editedName = false
  let prefilledHex: string | undefined
  let deleteRecords: CleanupColor[] = []
  let deleteIds = new Set<number>()
  let feedback: HTMLElement | undefined
  const wheel = bindColorPickerPopup(find('#cleanup-picker-popup'), hex, signal)
  const formDialog = bindFormDialog(dialog, { canClose: () => !busy })
  const record = (color: CleanupColor) => ({ id: color.id, token: color.token })
  const label = (index: number) => index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
  const icon = (name: string) => `<svg width="18" height="18" aria-hidden="true"><use href="/icons.svg?v=3#icon-${name}" /></svg>`
  const action = (attribute: string, key: string) => `<button type="button" ${attribute} class="fm-btn ${key === 'common.delete' ? 'fm-btn-danger' : 'fm-btn-outline'}">${key === 'common.delete' ? icon('trash') : ''}${t(key)}${key === 'colors.cleanup.next' ? icon('next') : ''}</button>`

  function error(message: string) {
    feedback?.remove()
    feedback = document.createElement('div')
    feedback.className = 'fm-compact-form'
    const alert = document.createElement('p')
    alert.setAttribute('role', 'alert')
    alert.className = 'fm-alert-error'
    alert.textContent = message
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'fm-btn fm-btn-outline'
    refresh.textContent = t('colors.cleanup.refresh')
    refresh.setAttribute('data-cleanup-refresh', '')
    feedback.append(alert, refresh)
    if (mergeForm.hidden) content.prepend(feedback)
    else {
      mergeForm.querySelector('[data-cleanup-warning]')!.after(feedback)
      feedback.scrollIntoView?.({ block: 'nearest' })
    }
  }

  function setBusy(value: boolean) {
    busy = value
    dialog.setAttribute('aria-busy', String(value))
    dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')
      .forEach(element => { element.disabled = value })
    if (!value) { wheel.sync(); syncSelection() }
    syncMerge()
  }

  function syncSelection() {
    const all = new Set(getColors().map(color => color.id))
    for (const id of selection) if (!all.has(id)) selection.delete(id)
    const inputs = [...scope.querySelectorAll<HTMLInputElement>('[data-color-select]')]
    inputs.forEach(input => { input.checked = selection.has(Number(input.dataset.colorSelect)); input.disabled = !(canSelect || canDelete) || busy })
    const header = find<HTMLInputElement>('#color-select-loaded')
    header.disabled = !(canSelect || canDelete) || busy || inputs.length === 0
    header.checked = inputs.length > 0 && inputs.every(input => input.checked)
    header.indeterminate = inputs.some(input => input.checked) && !header.checked
    onSelectionChange?.()
    find('#color-selection-count').textContent = t('colors.cleanup.selected', { count: selection.size })
    find('#color-merge-selected').hidden = !canMerge || selection.size < 2
    find<HTMLButtonElement>('#color-merge-selected').disabled = !canMerge || busy || selection.size < 2
    find('#color-delete-selected').hidden = !canDelete || selection.size === 0
    find('#color-clear-selection').hidden = selection.size === 0
    find<HTMLButtonElement>('#color-delete-selected').disabled = !canDelete || busy || selection.size === 0
    find<HTMLButtonElement>('#color-clear-selection').disabled = busy || selection.size === 0
    find<HTMLButtonElement>('#color-select-matching').disabled = !(canSelect || canDelete) || busy || getVisible().length === 0
  }

  function groupColors() {
    const ids = mode === 'selected' ? selectedIds : new Set(snapshot.groups[groupIndex] ?? [])
    return snapshot.items.filter(color => ids.has(color.id))
  }

  function syncMerge() {
    const validHex = !!normalizeHexCode(hex.value)
    find<HTMLButtonElement>('[data-cleanup-merge]').disabled = busy || !canMerge || mergeForm.hidden || incompleteReview
      || mergeIds.size < 2 || !mergeIds.has(Number(survivor.value)) || !name.value.trim() || !validHex
    find<HTMLButtonElement>('#cleanup-wheel-trigger').disabled = busy || !validHex
    survivor.disabled = busy || incompleteReview
    mergeForm.querySelectorAll<HTMLInputElement>('.fm-opacity-toggle input, .fm-opacity-options input')
      .forEach(input => { input.disabled = busy || !validHex })
    content.querySelectorAll<HTMLButtonElement>('[data-cleanup-delete-one]').forEach(button => { button.disabled = busy })
  }

  function prefill() {
    const color = groupColors().find(color => color.id === Number(survivor.value))
    if (!color) return
    if (!editedName) name.value = color.name
    if (prefilledHex === undefined || prefilledHex === (normalizeHexCode(hex.value) || hex.value)) {
      const normalized = normalizeHexCode(color.hex_code)
      colorControls.reset(normalized || '#000000')
      wheel.reset()
      if (!normalized) {
        hex.value = color.hex_code
        find('#cleanup-alpha-preview').style.background = ''
      }
      prefilledHex = hex.value
    }
    syncMerge()
  }

  function renderGroup(preserveDraft = false) {
    const colors = groupColors()
    feedback?.remove()
    mergeForm.hidden = true
    incompleteReview = mode === 'selected' && colors.length !== selectedIds.size
    if (incompleteReview) {
      content.replaceChildren()
      mergeForm.hidden = !canMerge || !reviewKey
      error(t('colors.cleanup.selectionChanged'))
      return
    }
    if (!colors.length) {
      content.innerHTML = `<p role="status">${t('colors.cleanup.noDuplicates')}</p>`
      return
    }
    const key = colors.map(color => color.id).join(',')
    const keepDraft = preserveDraft && reviewKey === key
    reviewKey = key
    if (!keepDraft) mergeIds = new Set(colors.map(color => color.id))
    content.innerHTML = `${mode === 'duplicates' ? `<p>${t('colors.cleanup.group', { current: groupIndex + 1, count: snapshot.groups.length })}</p>` : ''}
      <p class="fm-field-hint">${t('colors.cleanup.mergeHint')}</p>
      <div class="fm-cleanup-entries">${colors.map((color, index) => `
        <article class="fm-cleanup-entry">
          <div class="fm-cleanup-entry-heading">
            <label><input type="checkbox" class="fm-checkbox" data-merge-entry="${color.id}" aria-label="${label(index)}: ${escapeHtml(color.name)}" ${mergeIds.has(color.id) ? 'checked' : ''} />
              <span class="fm-cleanup-swatch" style="background:${toColorSwatchBackground(color.hex_code)}"></span>
              <strong>${escapeHtml(color.name)}</strong></label>
            <span class="fm-cleanup-entry-letter" aria-hidden="true">${label(index)}</span>
          </div>
          <p>${escapeHtml(color.hex_code)} · ${t('colors.cleanup.usage', { count: color.usage_count })}</p>
          ${canDelete && color.usage_count === 0 ? action(`data-cleanup-delete-one="${color.id}"`, 'common.delete') : ''}
        </article>`).join('')}</div>
      ${mode === 'duplicates' && groupIndex < snapshot.groups.length - 1 ? action('data-cleanup-skip', 'colors.cleanup.next') : ''}`
    const previous = survivor.value
    survivor.innerHTML = colors.map((color, index) => `<option value="${color.id}" ${mergeIds.has(color.id) ? '' : 'disabled'}>${label(index)}: ${escapeHtml(color.name)}</option>`).join('')
    survivor.value = keepDraft && mergeIds.has(Number(previous)) ? previous : String([...mergeIds][0] ?? '')
    mergeForm.hidden = !canMerge
    if (!keepDraft) { editedName = false; prefilledHex = undefined }
    find('[data-cleanup-warning]').textContent = t('colors.cleanup.confirmMerge')
    prefill()
  }

  function renderDelete() {
    feedback?.remove()
    mergeForm.hidden = true; wheel.close()
    const count = deleteRecords.length
    const warning = t(count === 1 ? 'colors.cleanup.confirmDeleteOne' : 'colors.cleanup.confirmDelete', { count })
    content.innerHTML = `<p class="fm-alert-error" role="note">${warning}</p>
      <ul class="fm-cleanup-delete-list">${deleteRecords.map(color => `<li>${escapeHtml(color.name)} <code>${escapeHtml(color.hex_code)}</code></li>`).join('')}</ul>
      ${deleteRecords.some(color => color.usage_count > 0) ? `<p role="alert">${t('colors.inUseWarning')}</p>`
        : deleteRecords.length ? action('data-cleanup-confirm-delete', 'common.delete') : `<p>${t('colors.noColors')}</p>`}`
  }

  async function open(nextMode: typeof mode, keepSkipped = false) {
    if (busy) return
    mode = nextMode
    if (!keepSkipped) {
      skipped.clear(); reviewKey = ''; incompleteReview = false
      if (nextMode === 'delete') deleteIds = new Set(selection)
      if (nextMode === 'selected') selectedIds = new Set(selection)
    }
    const title = find('#color-cleanup-title')
    title.dataset.i18n = mode === 'selected' ? 'colors.cleanup.merge' : 'colors.cleanup.title'
    title.textContent = t(title.dataset.i18n)
    const preserveDraftOnFailure = keepSkipped && !!reviewKey && !mergeForm.hidden
    mergeForm.hidden = true; wheel.close()
    feedback?.remove()
    const current = ++request
    content.innerHTML = `<p role="status">${t('common.loading')}</p>`
    formDialog.open()
    setBusy(true)
    try {
      const response = await fetch('/api/v1/colors/cleanup', { credentials: 'include', signal })
      if (!response.ok) throw new Error(t('colors.failedLoad'))
      const data: Snapshot = await response.json()
      if (signal.aborted || current !== request) return
      snapshot = { ...data, groups: data.groups.filter(ids => !skipped.has(ids.join(','))) }
      if (mode !== 'delete') { groupIndex = 0; renderGroup(keepSkipped) }
      else { deleteRecords = snapshot.items.filter(color => deleteIds.has(color.id)); renderDelete() }
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        content.replaceChildren()
        if (preserveDraftOnFailure) {
          incompleteReview = true
          mergeForm.hidden = false
        }
        error(err instanceof Error ? err.message : t('colors.failedLoad'))
      }
    } finally { if (!signal.aborted && current === request) setBusy(false) }
  }

  async function command(path: string, body: object) {
    if (busy) return
    setBusy(true)
    feedback?.remove()
    try {
      const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1] ?? ''
      const response = await fetch(`/api/v1/colors/${path}`, {
        method: 'POST', credentials: 'include', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: JSON.stringify(body),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail?.message || data?.message || `${t('colors.cleanup.failed')} (${response.status})`)
      }
      if (signal.aborted) return
      selection.clear()
      await reload()
      setBusy(false)
      if (mode === 'duplicates' && path === 'combine') {
        reviewKey = ''
        await open('duplicates', true)
      } else formDialog.close()
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) error(err instanceof Error ? err.message : t('colors.cleanup.failed'))
    } finally { if (!signal.aborted) setBusy(false) }
  }

  find('#btn-review-colors').hidden = !canMerge && !canDelete
  find('#btn-review-colors').addEventListener('click', () => { void open('duplicates') }, { signal })
  find('#color-delete-selected').addEventListener('click', () => { if (canDelete && selection.size) void open('delete') }, { signal })
  find('#color-merge-selected').addEventListener('click', () => { if (canMerge && selection.size >= 2) void open('selected') }, { signal })
  find('#color-select-matching').addEventListener('click', () => { getVisible().forEach(color => selection.add(color.id)); syncSelection() }, { signal })
  find('#color-clear-selection').addEventListener('click', () => { selection.clear(); syncSelection() }, { signal })
  find('#color-select-loaded').addEventListener('change', event => {
    const checked = (event.target as HTMLInputElement).checked
    scope.querySelectorAll<HTMLInputElement>('[data-color-select]').forEach(input => {
      const id = Number(input.dataset.colorSelect)
      if (checked) selection.add(id); else selection.delete(id)
    })
    syncSelection()
  }, { signal })
  find('#colors-list-table').addEventListener('change', event => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-color-select')) return
    const id = Number(input.dataset.colorSelect)
    if (input.checked) selection.add(id); else selection.delete(id)
    syncSelection()
  }, { signal })
  content.addEventListener('change', event => {
    const target = event.target
    if (target instanceof HTMLInputElement && target.hasAttribute('data-merge-entry')) {
      const id = Number(target.dataset.mergeEntry)
      if (target.checked) mergeIds.add(id); else mergeIds.delete(id)
      Array.from(survivor.options).forEach(option => { option.disabled = !mergeIds.has(Number(option.value)) })
      if (!mergeIds.has(Number(survivor.value))) {
        survivor.value = String([...mergeIds][0] ?? '')
        prefill()
      }
      syncMerge()
    }
  }, { signal })
  mergeForm.addEventListener('change', event => {
    if (event.target === survivor) prefill()
    syncMerge()
  }, { signal })
  mergeForm.addEventListener('input', event => {
    if (event.target === name) editedName = true
    syncMerge()
  }, { signal })
  mergeForm.addEventListener('keydown', event => {
    // Editing a result must never implicitly confirm an irreversible merge.
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && ['text', 'number'].includes(event.target.type)) event.preventDefault()
  }, { signal })
  mergeForm.addEventListener('submit', event => {
    event.preventDefault()
    if (busy || !canMerge || mergeForm.hidden || incompleteReview || mergeIds.size < 2 || !mergeIds.has(Number(survivor.value)) || !mergeForm.reportValidity()) return
    const hexCode = normalizeHexCode(hex.value)
    if (!hexCode || !name.value.trim()) return
    void command('combine', { records: groupColors().filter(color => mergeIds.has(color.id)).map(record),
      survivor_id: Number(survivor.value), name: name.value, hex_code: hexCode })
  }, { signal })
  dialog.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button || busy) return
    if (button.hasAttribute('data-cleanup-refresh')) { void open(mode, true); return }
    if (!content.contains(button)) return
    if (button.hasAttribute('data-cleanup-skip')) { skipped.add(snapshot.groups[groupIndex].join(',')); groupIndex++; renderGroup(); return }
    if (button.hasAttribute('data-cleanup-delete-one')) {
      deleteIds = new Set([Number(button.dataset.cleanupDeleteOne)])
      deleteRecords = groupColors().filter(color => deleteIds.has(color.id))
      mode = 'delete'; renderDelete(); return
    }
    if (button.hasAttribute('data-cleanup-confirm-delete') && canDelete) {
      void command('bulk-delete', { records: deleteRecords.map(record) }); return
    }
  }, { signal })
  signal.addEventListener('abort', () => { request++; if (dialog.open) dialog.close() }, { once: true })
  syncSelection()
  return { syncSelection, getSelectedIds: () => [...selection] }
}
