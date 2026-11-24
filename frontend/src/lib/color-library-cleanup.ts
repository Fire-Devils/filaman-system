import { escapeHtml } from './extra-fields'
import { bindFormDialog } from './form-dialog'
import { toColorSwatchBackground } from './colors'
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
  const selection = new Set<number>()
  let busy = false
  let request = 0
  let snapshot: Snapshot = { items: [], groups: [] }
  const skipped = new Set<string>()
  let groupIndex = 0
  let mode: 'duplicates' | 'delete' = 'duplicates'
  let mergeIds = new Set<number>()
  let deleteRecords: CleanupColor[] = []
  let deleteIds = new Set<number>()
  const formDialog = bindFormDialog(dialog, { canClose: () => !busy })
  const record = (color: CleanupColor) => ({ id: color.id, token: color.token })
  const label = (index: number) => index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
  const icon = (name: string) => `<svg width="18" height="18" aria-hidden="true"><use href="/icons.svg?v=3#icon-${name}" /></svg>`
  const action = (attribute: string, key: string, primary = false) => `<button type="button" ${attribute} class="fm-btn ${key === 'common.delete' ? 'fm-btn-danger' : primary ? 'fm-btn-primary' : 'fm-btn-outline'}">${key === 'common.delete' ? icon('trash') : key === 'colors.cleanup.merge' ? icon('merge') : ''}${t(key)}${key === 'colors.cleanup.next' ? icon('next') : ''}</button>`

  function error(message: string) {
    let alert = content.querySelector<HTMLElement>('[role="alert"]')
    if (!alert) {
      alert = document.createElement('p'); alert.setAttribute('role', 'alert'); alert.className = 'fm-alert-error'
      content.prepend(alert)
    }
    alert.textContent = message
    if (!content.querySelector('[data-cleanup-refresh]')) content.appendChild(Object.assign(document.createElement('button'), {
      type: 'button', className: 'fm-btn fm-btn-outline', textContent: t('colors.cleanup.refresh'),
    })).setAttribute('data-cleanup-refresh', '')
  }

  function setBusy(value: boolean) {
    busy = value
    dialog.setAttribute('aria-busy', String(value))
    dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')
      .forEach(element => { element.disabled = value })
    if (!value) syncSelection()
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
    find('#color-delete-selected').hidden = !canDelete || selection.size === 0
    find('#color-clear-selection').hidden = selection.size === 0
    find<HTMLButtonElement>('#color-delete-selected').disabled = !canDelete || busy || selection.size === 0
    find<HTMLButtonElement>('#color-clear-selection').disabled = busy || selection.size === 0
    find<HTMLButtonElement>('#color-select-matching').disabled = !(canSelect || canDelete) || busy || getVisible().length === 0
  }

  function groupColors() {
    const ids = new Set(snapshot.groups[groupIndex] ?? [])
    return snapshot.items.filter(color => ids.has(color.id))
  }

  function renderGroup() {
    const colors = groupColors()
    if (!colors.length) {
      content.innerHTML = `<p role="status">${t('colors.cleanup.noDuplicates')}</p>`
      return
    }
    mergeIds = new Set(colors.map(color => color.id))
    content.innerHTML = `<p>${t('colors.cleanup.group', { current: groupIndex + 1, count: snapshot.groups.length })}</p>
      <p class="fm-field-hint">${t('colors.cleanup.mergeHint')}</p>
      <div class="fm-cleanup-entries">${colors.map((color, index) => `
        <article class="fm-cleanup-entry">
          <div class="fm-cleanup-entry-heading">
            <label><input type="checkbox" class="fm-checkbox" data-merge-entry="${color.id}" aria-label="${label(index)}: ${escapeHtml(color.name)}" checked />
              <span class="fm-cleanup-swatch" style="background:${toColorSwatchBackground(color.hex_code)}"></span>
              <strong>${escapeHtml(color.name)}</strong></label>
            <span class="fm-cleanup-entry-letter" aria-hidden="true">${label(index)}</span>
          </div>
          <p>${escapeHtml(color.hex_code)} · ${t('colors.cleanup.usage', { count: color.usage_count })}</p>
          ${canDelete && color.usage_count === 0 ? action(`data-cleanup-delete-one="${color.id}"`, 'common.delete') : ''}
        </article>`).join('')}</div>
      <form data-cleanup-merge-form class="fm-compact-form">
        <label class="fm-label" for="cleanup-survivor">${t('colors.cleanup.survivor')}</label>
        <select class="fm-input" id="cleanup-survivor">${colors.map((color, index) => `<option value="${color.id}">${label(index)}: ${escapeHtml(color.name)}</option>`).join('')}</select>
        <label class="fm-label" for="cleanup-name">${t('colors.name')}</label>
        <input class="fm-input" id="cleanup-name" required maxlength="100" value="${escapeHtml(colors[0].name)}" />
        <div class="fm-admin-actions">
          ${groupIndex < snapshot.groups.length - 1 ? action('data-cleanup-skip', 'colors.cleanup.next') : ''}
          ${canMerge ? action('data-cleanup-merge', 'colors.cleanup.merge', true) : ''}
        </div>
      </form>`
  }

  function renderDelete() {
    content.innerHTML = `<p class="fm-alert-error" role="note">${t('colors.cleanup.confirmDelete', { count: deleteRecords.length })}</p>
      <ul class="fm-cleanup-delete-list">${deleteRecords.map(color => `<li>${escapeHtml(color.name)} <code>${escapeHtml(color.hex_code)}</code></li>`).join('')}</ul>
      ${deleteRecords.some(color => color.usage_count > 0) ? `<p role="alert">${t('colors.inUseWarning')}</p>`
        : deleteRecords.length ? action('data-cleanup-confirm-delete', 'common.delete', true) : `<p>${t('colors.noColors')}</p>`}`
  }

  async function open(nextMode: typeof mode, keepSkipped = false) {
    if (busy) return
    mode = nextMode
    if (!keepSkipped) { skipped.clear(); if (nextMode === 'delete') deleteIds = new Set(selection) }
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
      if (mode === 'duplicates') { groupIndex = 0; renderGroup() }
      else { deleteRecords = snapshot.items.filter(color => deleteIds.has(color.id)); renderDelete() }
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) { content.replaceChildren(); error(err instanceof Error ? err.message : t('colors.failedLoad')) }
    } finally { if (!signal.aborted && current === request) setBusy(false) }
  }

  async function command(path: string, body: object) {
    if (busy) return
    setBusy(true)
    content.querySelector('[role="alert"]')?.remove()
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
      if (mode === 'duplicates' && path === 'merge') await open('duplicates', true)
      else formDialog.close()
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) error(err instanceof Error ? err.message : t('colors.cleanup.failed'))
    } finally { if (!signal.aborted) setBusy(false) }
  }

  find('#btn-review-colors').hidden = !canMerge && !canDelete
  find('#btn-review-colors').addEventListener('click', () => { void open('duplicates') }, { signal })
  find('#color-delete-selected').addEventListener('click', () => { void open('delete') }, { signal })
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
      const survivor = content.querySelector<HTMLSelectElement>('#cleanup-survivor')!
      Array.from(survivor.options).forEach(option => { option.disabled = !mergeIds.has(Number(option.value)) })
      if (!mergeIds.has(Number(survivor.value))) {
        survivor.value = String([...mergeIds][0] ?? '')
        content.querySelector<HTMLInputElement>('#cleanup-name')!.value = groupColors().find(color => color.id === Number(survivor.value))?.name ?? ''
      }
    }
    if (!(target instanceof HTMLSelectElement)) return
    if (target.id === 'cleanup-survivor') content.querySelector<HTMLInputElement>('#cleanup-name')!.value = groupColors().find(color => color.id === Number(target.value))!.name
  }, { signal })
  content.addEventListener('submit', event => { event.preventDefault() }, { signal })
  content.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button || busy) return
    if (button.hasAttribute('data-cleanup-refresh')) { void open(mode, true); return }
    if (button.hasAttribute('data-cleanup-skip')) { skipped.add(snapshot.groups[groupIndex].join(',')); groupIndex++; renderGroup(); return }
    if (button.hasAttribute('data-cleanup-delete-one')) {
      deleteIds = new Set([Number(button.dataset.cleanupDeleteOne)])
      deleteRecords = groupColors().filter(color => deleteIds.has(color.id))
      mode = 'delete'; renderDelete(); return
    }
    if (button.hasAttribute('data-cleanup-confirm-delete') && canDelete) {
      void command('bulk-delete', { records: deleteRecords.map(record) }); return
    }
    if (!button.hasAttribute('data-cleanup-merge') || !canMerge) return
    const form = content.querySelector<HTMLFormElement>('[data-cleanup-merge-form]')!
    if (!form.reportValidity()) return
    if (mergeIds.size < 2) { error(t('colors.cleanup.selectTwo')); return }
    void command('merge', { records: groupColors().filter(color => mergeIds.has(color.id)).map(record),
      survivor_id: Number(content.querySelector<HTMLSelectElement>('#cleanup-survivor')!.value),
      name: content.querySelector<HTMLInputElement>('#cleanup-name')!.value })
  }, { signal })
  signal.addEventListener('abort', () => { request++; if (dialog.open) dialog.close() }, { once: true })
  syncSelection()
  return { syncSelection, getSelectedIds: () => [...selection] }
}
