/**
 * Location types are free text. AMS and Storage are always offered; anything
 * a user has written in before shows up next to them so the next location can
 * reuse it instead of creating a near-duplicate. The backend also folds
 * case-only differences onto the existing spelling.
 */

export const BUILTIN_LOCATION_TYPES = ['AMS', 'Storage'] as const

/** Filter value for "show everything". */
export const TYPE_FILTER_ALL = ''
/** Filter value for locations with no type. */
export const TYPE_FILTER_NONE = '__none__'
/** Select value that reveals the write-in box. */
export const TYPE_WRITE_IN = '__write_in__'
/** Prefix on <option> values for actual types so user write-ins never collide with sentinels. */
export const TYPE_VALUE_PREFIX = 'type:'

export function encodeTypeOption(type: string): string {
  return `${TYPE_VALUE_PREFIX}${type}`
}

export function decodeTypeOption(value: string): string | null {
  return value.startsWith(TYPE_VALUE_PREFIX) ? value.slice(TYPE_VALUE_PREFIX.length) : null
}

export function locationTypeOptions(types: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const options: string[] = []
  const add = (value: string) => {
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    options.push(value)
  }
  BUILTIN_LOCATION_TYPES.forEach(add)
  const custom = [...types]
    .map(type => type?.trim() ?? '')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  custom.forEach(add)
  return options
}

export function resolveKnownType(
  types: Iterable<string>,
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const needle = trimmed.toLocaleLowerCase()
  for (const candidate of types) {
    if (candidate.toLocaleLowerCase() === needle) return candidate
  }
  return null
}

export function matchesTypeFilter(type: string | null | undefined, filter: string): boolean {
  if (filter === TYPE_FILTER_ALL) return true
  if (filter === TYPE_FILTER_NONE) return !type
  const target = decodeTypeOption(filter) ?? filter
  return Boolean(type) && type!.toLocaleLowerCase() === target.toLocaleLowerCase()
}
