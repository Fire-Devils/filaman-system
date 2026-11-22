export interface SlicerLinkStatusPrinter {
  printer_id: number
  printer_name: string
  last_contact_at: string | null
  script_version: string | null
  update_available: boolean
  slots: { index: number; slot_no: number; name: string | null }[]
}

export interface SlicerLinkStatus {
  latest_script_version: string
  printers: SlicerLinkStatusPrinter[]
  recent_jobs: { id: number; name: string; printer_id: number | null; status: string; created_at: string | null }[]
}

export interface CommandOptions {
  url: string
  printerId: number | null
  key?: string
  map?: string
  pythonPath?: string
  scriptPath?: string
}

export const KEY_PLACEHOLDER = '<API-KEY>'

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`
}

/** Accepts "0=1, 1=2" and returns the normalized form, or null when invalid. */
export function normalizeMap(text: string): string | null {
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean)
  if (!parts.length || !parts.every((part) => /^\d+\s*=\s*\d+$/.test(part))) return null
  return parts.map((part) => part.replace(/\s+/g, '')).join(',')
}

/** The command line for the slicer's post-processing field; the slicer appends the G-code path. */
export function buildCommand(options: CommandOptions): string {
  const parts = [
    quote(options.pythonPath || 'PYTHON_PATH'),
    quote(options.scriptPath || 'SCRIPT_PATH'),
    '--url', quote(options.url.replace(/\/+$/, '')),
    '--key', quote(options.key?.trim() || KEY_PLACEHOLDER),
    '--printer', options.printerId == null ? 'PRINTER_ID' : String(options.printerId),
  ]
  const map = options.map ? normalizeMap(options.map) : null
  if (map) parts.push('--map', map)
  return parts.join(' ')
}
