/**
 * Locations owned by a printer driver plugin.
 *
 * Driver plugins (Bambuddy, Moonraker, …) create one location per AMS slot /
 * toolhead and mark it by writing `managed_by` into the location's
 * custom_fields, e.g. {"managed_by": "bambuddy_plugin"}. Such a slot is only
 * claimed when the driver assigns a spool after it was physically placed, so
 * the UI never offers it as a target and the API rejects it on spool creation.
 *
 * This mirrors `Location.is_driver_managed` in backend/app/models/location.py —
 * keep both in sync.
 */

export const MANAGED_BY_FIELD = 'managed_by'
export const DRIVER_MANAGED_SUFFIX = '_plugin'

export interface LocationLike {
  id?: number
  name?: string
  custom_fields?: Record<string, unknown> | null
}

export function isDriverManagedLocation(location: LocationLike | null | undefined): boolean {
  const managed = location?.custom_fields?.[MANAGED_BY_FIELD]
  return typeof managed === 'string' && managed.endsWith(DRIVER_MANAGED_SUFFIX)
}

/**
 * Locations a user may pick as a target.
 *
 * `keepId` retains one driver-managed entry — the location a record is already
 * assigned to. Edit forms submit the whole selection, so dropping the current
 * value from the list would silently move the spool out of its slot on save.
 */
export function assignableLocations<T extends LocationLike>(
  locations: T[],
  keepId?: number | null
): T[] {
  return locations.filter(
    (location) =>
      !isDriverManagedLocation(location) ||
      (keepId != null && location.id === keepId)
  )
}
