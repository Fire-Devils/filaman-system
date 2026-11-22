export type PrintJobStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

export interface PrintUsage {
  id: number
  spool_id: number | null
  slot_no: number | null
  planned_weight_g: number
  used_weight_g: number | null
  cost: number | null
  spool_event_id: number | null
  spool_name: string | null
  material_type: string | null
}

export interface PrintJob {
  id: number
  name: string
  project_id: number | null
  project_name: string | null
  printer_id: number | null
  printer_name: string | null
  status: PrintJobStatus
  source: string
  started_at: string | null
  finished_at: string | null
  print_time_s: number | null
  notes: string | null
  has_photo: boolean
  total_weight_g: number
  total_cost: number | null
  created_at: string
  updated_at: string
  usages: PrintUsage[]
}

export interface PrintProject {
  id: number
  name: string
  description: string | null
  is_archived: boolean
  job_count: number
  total_weight_g: number
  total_cost: number | null
}

export const PRINT_JOB_STATUSES: PrintJobStatus[] = ['pending', 'completed', 'failed', 'cancelled']

const STATUS_COLORS: Record<PrintJobStatus, string> = {
  pending: 'var(--accent-3)',
  completed: '#10b981',
  failed: 'var(--error-text)',
  cancelled: 'var(--text-muted)',
}

export function statusPillStyle(status: string): string {
  const color = STATUS_COLORS[status as PrintJobStatus] ?? 'var(--text-muted)'
  return `border-color: ${color}; color: ${color};`
}

export function formatGrams(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '–'
  return `${Math.round(value * 10) / 10} g`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '–'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

/** Grams typed by a user ("12,5" or "12.5"); null for blank, negative or non-numeric input. */
export function parseGrams(raw: string): number | null {
  const text = raw.trim().replace(',', '.')
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export interface CompleteRow { usageId: number; value: string }

/** Body of POST /print-jobs/{id}/complete, or null when a weight is invalid. */
export function buildCompletePayload(success: boolean, rows: CompleteRow[]):
  { success: boolean; usages: { usage_id: number; used_weight_g: number }[] } | null {
  const usages: { usage_id: number; used_weight_g: number }[] = []
  for (const row of rows) {
    const grams = parseGrams(row.value)
    if (grams === null) return null
    usages.push({ usage_id: row.usageId, used_weight_g: grams })
  }
  return { success, usages }
}

export interface CreateForm {
  name: string
  projectId: string
  newProjectName: string
  printerId: string
  notes: string
  complete: boolean
  success: boolean
  rows: { spoolId: string; grams: string }[]
}

export interface CreatePayload {
  name: string
  project_id?: number
  printer_id?: number
  notes?: string
  complete: boolean
  success: boolean
  usages: { spool_id: number; planned_weight_g: number }[]
}

/** Body of POST /print-jobs from the capture dialog; null when the form is not valid. */
export function buildCreatePayload(form: CreateForm): CreatePayload | null {
  const name = form.name.trim()
  if (!name) return null
  const usages: CreatePayload['usages'] = []
  for (const row of form.rows) {
    if (!row.spoolId && !row.grams.trim()) continue // empty line
    const grams = parseGrams(row.grams)
    const spoolId = Number(row.spoolId)
    if (!spoolId || grams === null) return null
    usages.push({ spool_id: spoolId, planned_weight_g: grams })
  }
  const payload: CreatePayload = { name, complete: form.complete, success: form.success, usages }
  if (form.projectId && form.projectId !== 'new') payload.project_id = Number(form.projectId)
  if (form.printerId) payload.printer_id = Number(form.printerId)
  if (form.notes.trim()) payload.notes = form.notes.trim()
  return payload
}
