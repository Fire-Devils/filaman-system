import { getAbortSignal } from './abort'

// Compare rendered/normalized payloads, not API values that a control may normalize.
export function changedNativeFields(baseline: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
    key !== 'custom_fields' && key !== 'custom_field_definitions'
    && JSON.stringify(value) !== JSON.stringify(baseline[key])))
}

export function setFormFieldValue(field: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  const text = value == null ? '' : String(value)
  if (field instanceof HTMLSelectElement && text && !Array.from(field.options).some(option => option.value === text)) {
    const option = document.createElement('option')
    option.value = option.textContent = text
    field.add(option)
  }
  field.value = text
}

export function createDetailEditSession<T>(path: string, failureMessage: () => string) {
  let generation = 0
  let pendingManage: Promise<void> | null = null

  function invalidate(): void {
    generation++
    pendingManage = null
  }

  async function read(): Promise<T> {
    const response = await fetch(path, { credentials: 'include', signal: getAbortSignal() })
    if (!response.ok) throw new Error(failureMessage())
    return response.json()
  }

  async function applyFresh(apply: (data: T) => void | Promise<void>): Promise<void> {
    const request = generation
    try {
      const data = await read()
      if (request === generation) await apply(data)
    } catch (error) {
      if (request === generation) throw error
    }
  }

  return {
    read,
    invalidate,
    edit(apply: (data: T) => void | Promise<void>) {
      invalidate()
      return applyFresh(apply)
    },
    manage(apply: (data: T) => void | Promise<void>) {
      if (pendingManage) return pendingManage
      const request = generation
      pendingManage = applyFresh(apply).finally(() => {
        if (request === generation) pendingManage = null
      })
      return pendingManage
    },
  }
}
