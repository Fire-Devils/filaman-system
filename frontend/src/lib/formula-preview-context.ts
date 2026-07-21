const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function hasNestedPath(context: Record<string, unknown>, segments: string[]): boolean {
  let current: unknown = context
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return true
}

function setNestedPath(
  context: Record<string, unknown>,
  segments: string[],
  value: unknown,
): void {
  let current = context
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {}
    }
    current = current[segment] as Record<string, unknown>
  }
  current[segments.at(-1)!] = value
}

export function scaffoldFormulaPreviewContext(
  context: Record<string, unknown>,
  paths: string[],
  placeholders: Record<string, unknown>,
): boolean {
  let changed = false
  for (const path of paths) {
    const segments = path.split('.').filter(Boolean)
    if (!segments.length || segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) continue

    const legacyFlatValue = context[path]
    if (segments.length > 1 && Object.prototype.hasOwnProperty.call(context, path)) {
      delete context[path]
      changed = true
    }
    if (hasNestedPath(context, segments)) continue

    const value = Object.prototype.hasOwnProperty.call(placeholders, path)
      ? placeholders[path]
      : legacyFlatValue ?? 0
    setNestedPath(context, segments, value)
    changed = true
  }
  return changed
}
