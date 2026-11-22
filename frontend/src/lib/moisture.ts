/** Moisture tracking helpers: badge, wording and the drying request body. */

export type MoistureLevel = 'dry' | 'fair' | 'damp' | 'wet'

export interface Moisture {
  level: MoistureLevel
  days_exposed: number
  reference_at: string
  sensitivity: 'high' | 'medium' | 'low'
}

const LEVELS: readonly MoistureLevel[] = ['dry', 'fair', 'damp', 'wet']

export function isMoistureLevel(value: unknown): value is MoistureLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

/** Unknown or missing moisture never produces a badge. */
export function parseMoisture(value: unknown): Moisture | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!isMoistureLevel(item.level)) return null
  const days = Number(item.days_exposed)
  if (!Number.isFinite(days) || days < 0) return null
  return {
    level: item.level,
    days_exposed: Math.floor(days),
    reference_at: String(item.reference_at ?? ''),
    sensitivity: item.sensitivity === 'high' || item.sensitivity === 'medium' ? item.sensitivity : 'low',
  }
}

export function moistureLabelKey(level: MoistureLevel): string {
  return `moisture.level.${level}`
}

export function moistureBadgeClass(level: MoistureLevel): string {
  return `fm-moisture-badge fm-moisture-${level}`
}

/** Drying is worth doing from damp upwards. */
export function needsDrying(level: MoistureLevel): boolean {
  return level === 'damp' || level === 'wet'
}

/** Whether the reference point is the last drying run rather than the opening. */
export function referenceKind(
  moisture: Pick<Moisture, 'reference_at'>,
  lastDriedAt: string | null | undefined,
): 'dried' | 'opened' {
  if (!lastDriedAt) return 'opened'
  const reference = Date.parse(moisture.reference_at)
  const dried = Date.parse(lastDriedAt)
  return Number.isFinite(reference) && Number.isFinite(dried) && reference === dried ? 'dried' : 'opened'
}

function numberText(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  return value == null || value === '' || !Number.isFinite(num) || num <= 0 ? '' : String(num)
}

/** Dialog prefill from the filament's drying recommendation. */
export function dryDialogDefaults(
  filament: { drying_temp_c?: number | null; drying_time_hours?: number | null } | null | undefined,
): { temp: string; hours: string } {
  return { temp: numberText(filament?.drying_temp_c), hours: numberText(filament?.drying_time_hours) }
}

/** Request body for POST /spools/{id}/dry. Blank or invalid numbers are left out. */
export function buildDryPayload(input: { temp?: string; hours?: string; note?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const temp = Number(input.temp)
  const hours = Number(input.hours)
  if (input.temp?.trim() && Number.isFinite(temp) && temp >= 0) body.temp_c = temp
  if (input.hours?.trim() && Number.isFinite(hours) && hours > 0) body.duration_hours = hours
  const note = input.note?.trim()
  if (note) body.note = note
  return body
}
