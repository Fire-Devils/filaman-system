import { escapeHtml } from './extra-fields'
import { t } from './i18n'

/** Keep list actions identical without coupling their page-owned handlers. */
export function tableAction(action: 'edit' | 'delete', data: Record<string, string | number>, options: { disabled?: boolean; title?: string } = {}): string {
  const label = t(`common.${action}`)
  const attributes = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(String(value))}"`).join(' ')
  return `<button type="button" ${attributes} class="btn-${action} fm-row-action${action === 'delete' ? ' fm-row-action-danger' : ''}" aria-label="${escapeHtml(label)}" title="${escapeHtml(options.title || label)}" ${options.disabled ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="/icons.svg#icon-${action === 'delete' ? 'trash' : 'edit'}" /></svg></button>`
}
