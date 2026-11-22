export const HIDE_SEALED_STORAGE_KEY = 'filaman-hide-sealed-spools'

type StatusLike = { id: number; key: string }

export function readHideSealed(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(HIDE_SEALED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeHideSealed(hide: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try {
    if (hide) storage.setItem(HIDE_SEALED_STORAGE_KEY, '1')
    else storage.removeItem(HIDE_SEALED_STORAGE_KEY)
  } catch { /* storage unavailable: the choice just is not remembered */ }
}

/**
 * Status ids to send as `status_id` so sealed ("new") spools drop out server-side.
 * Archived spools stay excluded, as they are without any status filter. Returns null
 * when nothing should be added: toggle off, statuses not loaded, or the user picked
 * statuses explicitly (an explicit status filter always wins).
 */
export function sealedExclusionStatusIds(statuses: StatusLike[], explicitStatusIds: string[], hideSealed: boolean): string[] | null {
  if (!hideSealed || explicitStatusIds.length > 0 || !statuses.some(status => status.key === 'new')) return null
  return statuses.filter(status => status.key !== 'new' && status.key !== 'archived').map(status => String(status.id))
}
