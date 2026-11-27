/** Abschnitt „FilaMan-DB Community“ in den eigenen Einstellungen: Token setzen, testen, entfernen. */

import { ApiError, api } from './api'
import { contribErrorMessage, resetContribContext } from './filamentdb-contrib'
import { t } from './i18n'
import type { AppDialogs } from './form-dialog'

interface TokenStatus {
  saved: boolean
  display_name?: string | null
  scopes?: string[] | null
}

export function tokenStatusText(status: TokenStatus): string {
  if (!status.saved) return t('fdbContrib.settings.notSaved')
  return status.display_name
    ? t('fdbContrib.settings.savedAs', { name: status.display_name })
    : t('fdbContrib.settings.saved')
}

/** Blendet den Abschnitt nur ein, wenn der User die Berechtigung hat (sonst 403). */
export async function initFdbTokenSettings(wrap: HTMLElement): Promise<void> {
  const root = (wrap.querySelector('#fdb-token-section') as HTMLElement | null) ?? wrap
  const input = root.querySelector('[data-fdb-token-input]') as HTMLInputElement
  const statusEl = root.querySelector('[data-fdb-token-status]') as HTMLElement
  const messageEl = root.querySelector('[data-fdb-token-message]') as HTMLElement
  const saveButton = root.querySelector('[data-fdb-token-save]') as HTMLButtonElement
  const testButton = root.querySelector('[data-fdb-token-test]') as HTMLButtonElement
  const removeButton = root.querySelector('[data-fdb-token-remove]') as HTMLButtonElement

  function show(status: TokenStatus) {
    statusEl.textContent = tokenStatusText(status)
    testButton.disabled = !status.saved
    removeButton.disabled = !status.saved
  }

  function message(text: string, isError = false) {
    messageEl.textContent = text
    messageEl.classList.toggle('fm-alert-error', isError)
  }

  async function run(action: () => Promise<void>) {
    message('')
    try {
      await action()
    } catch (error) {
      message(contribErrorMessage(error), true)
    }
  }

  try {
    show(await api.get<TokenStatus>('/filamentdb/token'))
    wrap.hidden = false
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.code === 'filamentdb_token_user_required')) return
    wrap.hidden = false
    message(contribErrorMessage(error), true)
  }

  saveButton.addEventListener('click', () => run(async () => {
    const token = input.value.trim()
    if (!token) return
    const status = await api.put<TokenStatus>('/filamentdb/token', { token })
    input.value = ''
    resetContribContext()
    show(status)
    message(t('fdbContrib.settings.testOk', { name: status.display_name ?? '' }))
  }))

  testButton.addEventListener('click', () => run(async () => {
    const status = await api.post<TokenStatus>('/filamentdb/token/test')
    show(status)
    message(t('fdbContrib.settings.testOk', { name: status.display_name ?? '' }))
  }))

  removeButton.addEventListener('click', () => run(async () => {
    const dialogs = window as unknown as Partial<AppDialogs>
    if (dialogs.__fmConfirm && !(await dialogs.__fmConfirm(t('fdbContrib.settings.removeConfirm'), { isDanger: true }))) return
    show(await api.delete<TokenStatus>('/filamentdb/token'))
    resetContribContext()
    message(t('fdbContrib.settings.removed'))
  }))
}
