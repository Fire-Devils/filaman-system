import { escapeHtml } from './extra-fields'
import { t } from './i18n'

/** Keep list actions identical without coupling their page-owned handlers. */
export function tableAction(action: 'edit' | 'delete', data: Record<string, string | number>, options: { disabled?: boolean; title?: string } = {}): string {
  const label = t(`common.${action}`)
  const path = action === 'edit'
    ? '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/>'
    : '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>'
  const attributes = Object.entries(data).map(([key, value]) => `data-${key}="${escapeHtml(String(value))}"`).join(' ')
  return `<button type="button" ${attributes} class="btn-${action} fm-row-action${action === 'delete' ? ' fm-row-action-danger' : ''}" aria-label="${escapeHtml(label)}" title="${escapeHtml(options.title || label)}" ${options.disabled ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg></button>`
}
