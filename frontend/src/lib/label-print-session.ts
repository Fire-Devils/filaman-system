interface ScopedLabelFields {
  entityId: string
  fields: unknown[]
}

function removeSessionValue(storageKey: string) {
  try {
    sessionStorage.removeItem(storageKey)
  } catch {
    // Ignore blocked storage.
  }
}

export function writeScopedLabelFields(
  storageKey: string,
  entityId: string | number,
  fields: unknown[],
) {
  try {
    const payload: ScopedLabelFields = {
      entityId: String(entityId),
      fields,
    }
    sessionStorage.setItem(storageKey, JSON.stringify(payload))
  } catch {
    // Printing still works without the optional session handoff.
  }
}

export function consumeScopedLabelFields<T = unknown>(
  storageKey: string,
  entityId: string | number,
): T[] {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(storageKey)
  } catch {
    return []
  }
  if (!raw) return []

  removeSessionValue(storageKey)
  try {
    const payload = JSON.parse(raw) as Partial<ScopedLabelFields>
    if (
      !payload ||
      Array.isArray(payload) ||
      typeof payload !== 'object' ||
      payload.entityId !== String(entityId) ||
      !Array.isArray(payload.fields)
    ) return []
    return payload.fields as T[]
  } catch {
    return []
  }
}
