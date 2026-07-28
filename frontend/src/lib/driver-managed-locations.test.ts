import { describe, expect, it } from 'vitest'

import {
  assignableLocations,
  isDriverManagedLocation,
} from './driver-managed-locations'

describe('isDriverManagedLocation', () => {
  it.each([
    [undefined, false],
    [null, false],
    [{}, false],
    [{ custom_fields: null }, false],
    [{ custom_fields: {} }, false],
    [{ custom_fields: { managed_by: 'manual' } }, false],
    [{ custom_fields: { managed_by: 'bambuddy' } }, false],
    [{ custom_fields: { managed_by: 42 } }, false],
    [{ custom_fields: { managed_by: 'bambuddy_plugin' } }, true],
    [{ custom_fields: { managed_by: 'moonraker_plugin' } }, true],
  ])('%o -> %s', (location, expected) => {
    expect(isDriverManagedLocation(location as never)).toBe(expected)
  })
})

describe('assignableLocations', () => {
  const shelf = { id: 1, name: 'Shelf A' }
  const dryer = { id: 2, name: 'Dryer', custom_fields: { managed_by: 'manual' } }
  const slot1 = { id: 3, name: 'AMS 1 · Slot 1', custom_fields: { managed_by: 'bambuddy_plugin' } }
  const slot2 = { id: 4, name: 'AMS 1 · Slot 2', custom_fields: { managed_by: 'bambuddy_plugin' } }
  const all = [shelf, dryer, slot1, slot2]

  it('drops driver-managed locations', () => {
    expect(assignableLocations(all)).toEqual([shelf, dryer])
  })

  it('keeps the currently assigned slot so edit forms do not clear it', () => {
    expect(assignableLocations(all, slot2.id)).toEqual([shelf, dryer, slot2])
  })

  it('ignores keepId when it is not driver-managed', () => {
    expect(assignableLocations(all, shelf.id)).toEqual([shelf, dryer])
  })

  it.each([null, undefined])('treats %s keepId as no exception', (keepId) => {
    expect(assignableLocations(all, keepId)).toEqual([shelf, dryer])
  })
})
