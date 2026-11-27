import { escapeHtml } from './extra-fields'

/** Progress bar with status text. Label is escaped here. total <= 0 renders an indeterminate bar. */
export function progressBarHtml(done: number, total: number, label: string): string {
  const known = total > 0
  const pct = known ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
  const aria = known
    ? `aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${Math.max(0, Math.min(total, done))}"`
    : 'aria-valuemin="0"'
  const fill = known
    ? `<div class="fm-progress-fill" style="width:${pct}%"></div>`
    : '<div class="fm-progress-fill"></div>'
  return `<div class="fm-progress${known ? '' : ' fm-progress-indeterminate'}">
    <div class="fm-progress-track" role="progressbar" ${aria} aria-label="${escapeHtml(label)}">${fill}</div>
    <div class="fm-progress-row"><p class="fm-field-hint" role="status">${escapeHtml(label)}</p>${known ? `<span class="fm-progress-pct">${pct} %</span>` : ''}</div>
  </div>`
}

/**
 * Updates a bar already rendered in `container` in place, so the width change animates.
 * Returns false when there is no bar of the same kind (known/indeterminate); then render it fresh.
 */
export function updateProgressBar(container: ParentNode, done: number, total: number, label: string): boolean {
  const root = container.querySelector<HTMLElement>('.fm-progress')
  const known = total > 0
  if (!root || root.classList.contains('fm-progress-indeterminate') === known) return false
  const track = root.querySelector<HTMLElement>('.fm-progress-track')
  const status = root.querySelector<HTMLElement>('[role="status"]')
  if (!track || !status) return false
  track.setAttribute('aria-label', label)
  if (status.textContent !== label) status.textContent = label
  if (known) {
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)))
    track.setAttribute('aria-valuemax', String(total))
    track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(total, done))))
    const fill = root.querySelector<HTMLElement>('.fm-progress-fill')
    if (fill) fill.style.width = `${pct}%`
    const pctEl = root.querySelector<HTMLElement>('.fm-progress-pct')
    if (pctEl) pctEl.textContent = `${pct} %`
  }
  return true
}
