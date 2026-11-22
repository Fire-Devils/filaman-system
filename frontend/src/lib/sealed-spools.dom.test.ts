// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { HIDE_SEALED_STORAGE_KEY, readHideSealed, sealedExclusionStatusIds, writeHideSealed } from './sealed-spools'

const statuses = [
  { id: 1, key: 'new' }, { id: 2, key: 'opened' }, { id: 3, key: 'active' },
  { id: 4, key: 'empty' }, { id: 5, key: 'archived' },
]

afterEach(() => localStorage.clear())

it('is off by default and persists the choice', () => {
  expect(readHideSealed()).toBe(false)
  writeHideSealed(true)
  expect(localStorage.getItem(HIDE_SEALED_STORAGE_KEY)).toBe('1')
  expect(readHideSealed()).toBe(true)
  writeHideSealed(false)
  expect(localStorage.getItem(HIDE_SEALED_STORAGE_KEY)).toBeNull()
  expect(readHideSealed()).toBe(false)
})

it('adds every status except new and archived when hiding sealed spools', () => {
  expect(sealedExclusionStatusIds(statuses, [], true)).toEqual(['2', '3', '4'])
})

it('changes nothing when off, when statuses are missing, or when a status is chosen explicitly', () => {
  expect(sealedExclusionStatusIds(statuses, [], false)).toBeNull()
  expect(sealedExclusionStatusIds([], [], true)).toBeNull()
  expect(sealedExclusionStatusIds(statuses, ['1'], true)).toBeNull()
})
