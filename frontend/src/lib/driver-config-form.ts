/**
 * Driver config forms are generated from a plugin's JSON `config_schema`.
 *
 * The form only ever had branches for enum, integer and number, so everything
 * else fell through to a text input rendered with String(value). For a property
 * whose type is `array` or `object` that reads "[object Object]", and saving the
 * form wrote that string back — destroying config the user never touched. The
 * bundled Moonraker driver's `slot_targets` is `"type": "array"`, so this was
 * not hypothetical.
 *
 * Such properties are rendered read-only and carried through the save unchanged.
 * Carrying them explicitly matters: the backend replaces `driver_config`
 * wholesale, so merely skipping the key would delete the property rather than
 * preserve it.
 *
 * Used by src/pages/printers/[id].astro (inline edit) and
 * src/pages/printers/index.astro (create/edit modal), which build their forms
 * separately but must agree on which properties are editable.
 */

export interface SchemaProperty {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  enumNames?: string[]
  minimum?: number
  maximum?: number
}

/**
 * Whether a property has no meaningful text-input representation.
 *
 * The schema type decides when it is present; the value is the fallback for
 * schemas that omit `type` but hold structured data anyway.
 */
export function isStructuredProp(
  prop: SchemaProperty | null | undefined,
  value: unknown
): boolean {
  if (prop?.type === 'array' || prop?.type === 'object') return true
  return typeof value === 'object' && value !== null
}

/** Value read off a form control, already normalised by the caller. */
export type FieldValue = string | number | boolean | null

/**
 * Build the driver_config payload for a save.
 *
 * `edited` holds the values read from the form controls; `current` is the config
 * as stored. Structured properties are taken from `current`, never from the
 * form, and are omitted when the stored config has no value for them.
 */
export function buildDriverConfigPayload(
  props: Record<string, SchemaProperty>,
  current: Record<string, unknown>,
  edited: Record<string, FieldValue>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(props)) {
    if (isStructuredProp(prop, current[key])) {
      if (current[key] !== undefined) payload[key] = current[key]
      continue
    }
    if (key in edited) payload[key] = edited[key]
  }

  return payload
}
