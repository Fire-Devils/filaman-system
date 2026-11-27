/** Spool event pill style and label, shared by the spool log and the dashboard. */

const MEASUREMENT = 'border-color: var(--accent-2); color: var(--accent-2);'
const ADJUSTMENT = 'border-color: var(--accent); color: var(--accent);'
const CONSUMPTION = 'border-color: var(--accent-3); color: var(--accent-3);'
const DELETED = 'border-color: var(--error-text); color: var(--error-text);'

const STYLES: Record<string, string> = {
  measurement: MEASUREMENT,
  adjustment: ADJUSTMENT,
  consumption: CONSUMPTION,
  status_change: CONSUMPTION,
  move_location: ADJUSTMENT,
  spool_deleted: DELETED,
  // Types the backend actually writes; status changes use the status key as type.
  print_consumption: CONSUMPTION,
  manual_adjust: ADJUSTMENT,
  spool_full: ADJUSTMENT,
  spool_full_undone: ADJUSTMENT,
  dried: MEASUREMENT,
  new: CONSUMPTION,
  opened: CONSUMPTION,
  drying: CONSUMPTION,
  active: CONSUMPTION,
  empty: CONSUMPTION,
  archived: CONSUMPTION,
}

export function getEventTypeStyle(type: string): string {
  return STYLES[type] || ''
}

/** Translated short label; unknown types (e.g. custom status keys) show the raw type. */
export function eventTypeLabel(type: string, translate: (key: string) => string): string {
  const key = `spoolLog.eventTypes.${type}`
  const label = translate(key)
  return label && label !== key ? label : type
}
